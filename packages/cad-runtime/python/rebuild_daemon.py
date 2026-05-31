"""
rebuild_daemon.py - warm build123d/OCP worker for cf-sandbox rebuilds.

A plain `python3 export_runner.py` pays ~2.2s to `import build123d` (CPU-bound OCP
type registration, not just .so paging) on *every* call. This long-lived daemon
imports build123d/OCP once and then serves build+export requests over a localhost
HTTP port, so each rebuild only pays the actual geometry cost (single-digit to low
hundreds of ms for typical parts).

It is a single-process server (build123d/OCP is not thread-safe and a session's
rebuilds are sequential). The caller (cf-sandbox) treats it as a best-effort fast
path and falls back to one-shot export_runner.py on any failure, so this never has
to be bulletproof — if it crashes, the next request relaunches and re-warms it.

Protocol (newline JSON bodies):
  GET  /health        -> {"ok": true, "pid": <int>, "ready": <bool>}
  POST /build_export  -> body {project, model, part?, output, format?, source?}
                         returns the export_runner build-summary dict
                         {ok, model, part, source, resultType, hasResult, bbox,
                          metadataKeys, metadataAnchors, error?}, requested artifact written to `output`.
"""
import argparse
import importlib.util
import json
import os
import sys
import traceback
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import export_runner as er  # reuse the exact build/export/metadata logic


def _load_module(filename: str, modname: str):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# aicad-script.py has a hyphen -> load it by path under an importable name so we can
# reuse its probe helpers (split_target, load_namespace, build_probe_namespace, ...).
aicad_script = _load_module("aicad-script.py", "aicad_script")

# Modules + sys.path present right after warmup. Anything a request adds (the user's
# part.py and its local imports) is rolled back afterwards so edits rebuild fresh and
# sys.path/sys.modules don't grow unbounded across requests.
_BASE_MODULES: set = set()
_BASE_SYS_PATH: list = []

# Built namespaces cached for probe, keyed by (project, model, part). Probes are bursty
# on the same unchanged model, so this lets the 2nd..Nth probe skip the rebuild entirely
# (not just the import). Invalidated when part.py or any project-local import it pulled in
# changes (mtime+size), so editing code still probes fresh.
_PROBE_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_PROBE_CACHE_MAX = 8


def _warmup() -> None:
    global _BASE_MODULES, _BASE_SYS_PATH
    import build123d  # noqa: F401
    from build123d import export_gltf, Unit  # noqa: F401  (load the GLB export path too)
    for optional in ("aicad_select", "aicad_attach"):
        try:
            __import__(optional)
        except Exception:
            pass
    _BASE_MODULES = set(sys.modules)
    _BASE_SYS_PATH = list(sys.path)


def _reset_after_request() -> None:
    for name in list(sys.modules):
        if name not in _BASE_MODULES:
            sys.modules.pop(name, None)
    sys.path[:] = _BASE_SYS_PATH


def _build_export(req: dict) -> dict:
    project = os.path.abspath(str(req.get("project") or os.getcwd()))
    er.PROJECT_ROOT = project
    er.MODELS_DIR = os.path.join(project, "models")
    er.CACHE_DIR = os.path.join(project, ".cache")

    model = str(req.get("model") or "").strip()
    part = str(req.get("part") or model).strip()
    fmt = str(req.get("format") or "brep").strip().lower()
    output = req.get("output")
    source = req.get("source")
    if not model:
        return {"ok": False, "model": "", "part": "", "hasResult": False, "error": "model is required."}

    ns, source_path, err = er._build_namespace(model, part, source)
    if err:
        return {"ok": False, "model": model, "part": part, "hasResult": False,
                "error": f"build failed (export_runner code {err}); see daemon stderr"}

    result = ns.get("result", None)
    if result is None:
        result = ns.get("assembly", None)
    payload = er._build_summary_payload(model, part, source_path, ns, result)
    if result is None:
        return payload  # ok=False, hasResult=False -> caller emits "must define a global result"

    try:
        er._ensure_assembly_metadata(ns, result)
        er._write_metadata(source_path, ns)
    except Exception as exc:
        payload["ok"] = False
        payload["error"] = f"metadata write failed: {exc}"
        return payload

    out = os.path.abspath(output) if output else os.path.join(er.CACHE_DIR, f"{model}__{part}.{fmt}")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        if fmt == "glb":
            er._write_glb(result, out, er._load_model_params(model))
        elif fmt == "brep":
            er._write_brep(result, out)
        elif fmt == "step":
            er._write_step(result, out)
        elif fmt == "stl":
            er._write_stl(result, out)
        elif fmt == "obj":
            er._write_obj(result, out, model)
        elif fmt == "3mf":
            er._write_3mf(result, out, er._load_model_params(model), model)
        else:
            payload["ok"] = False
            payload["error"] = f"unsupported export format: {fmt}"
            return payload
    except Exception as exc:
        payload["ok"] = False
        payload["error"] = f"{fmt} export failed: {exc}"
        return payload

    size = os.path.getsize(out) if os.path.exists(out) else 0
    if size <= 0:
        payload["ok"] = False
        payload["error"] = "exported file is empty"
        return payload
    payload["outputSize"] = size
    return payload


def _file_sig(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _deps_fresh(deps: dict) -> bool:
    return all(_file_sig(f) == sig for f, sig in deps.items())


def _load_ns_with_deps(model: str, part: str):
    """exec the model source and record the project-local files it pulled in, so the
    cached namespace can be invalidated when part.py or any local helper changes."""
    before = set(sys.modules)
    ns, source = aicad_script.load_namespace(model, part)
    deps = {source: _file_sig(source)}
    # params.json is read at build time (dims/materials) but isn't a Python import, so
    # track it explicitly; otherwise a params edit would serve a stale cached namespace.
    params = os.path.join(aicad_script.MODELS_DIR, model, "params.json")
    if os.path.isfile(params):
        deps[params] = _file_sig(params)
    root = os.path.abspath(aicad_script.PROJECT_ROOT) + os.sep
    for name in set(sys.modules) - before:
        mod = sys.modules.get(name)
        f = getattr(mod, "__file__", None)
        if f and os.path.abspath(f).startswith(root):
            deps[f] = _file_sig(f)
    return ns, deps


def _cached_ns(model: str, part: str):
    key = (aicad_script.PROJECT_ROOT, model, part)
    entry = _PROBE_CACHE.get(key)
    if entry and _deps_fresh(entry["deps"]):
        _PROBE_CACHE.move_to_end(key)
        return entry["ns"], True
    ns, deps = _load_ns_with_deps(model, part)
    _PROBE_CACHE[key] = {"ns": ns, "deps": deps}
    _PROBE_CACHE.move_to_end(key)
    while len(_PROBE_CACHE) > _PROBE_CACHE_MAX:
        _PROBE_CACHE.popitem(last=False)
    return ns, False


def _probe(req: dict) -> dict:
    """Mirror aicad-script.py command_probe, but reuse the warm interpreter and the
    cached built namespace. Returns the same payload shape command_probe does."""
    project = os.path.abspath(str(req.get("project") or os.getcwd()))
    aicad_script.PROJECT_ROOT = project
    aicad_script.MODELS_DIR = os.path.join(project, "models")

    argv = req.get("argv") or []
    try:
        flags, positionals = aicad_script.parse_flags(argv)
        if positionals:
            raise ValueError('probe expects flags, e.g. -component model/part -expr "top_edges(part)"')
        component = aicad_script.flag_value(flags, "component", "target", "part")
        component_b = aicad_script.flag_value(flags, "component-b", "componentB", "other-component", "other", "b")
        expression = str(aicad_script.flag_value(flags, "expr", "expression") or "").strip()
        if not expression:
            expression = "bbox_relation(part_a, part_b)" if component_b else "part"

        model, part = aicad_script.split_target(component or "")
        ns, hit_a = _cached_ns(model, part)
        if ns.get("result", None) is None:
            raise ValueError("part.py must define a global result before probing")

        ns_b = None
        model_b = part_b = None
        cache_hits = [hit_a]
        if component_b:
            model_b, part_b = aicad_script.split_target(component_b)
            ns_b, hit_b = _cached_ns(model_b, part_b)
            cache_hits.append(hit_b)
            if ns_b.get("result", None) is None:
                raise ValueError("componentB part.py must define a global result before probing")

        probe_ns = aicad_script.build_probe_namespace(ns, ns_b)
        value = eval(expression, probe_ns, probe_ns)
        payload = {
            "ok": True,
            "script": "probe",
            "model": model,
            "part": part,
            "expression": expression,
            "value": aicad_script.summarize_value(value),
            "cached": all(cache_hits),
        }
        if model_b and part_b:
            payload["componentB"] = {"model": model_b, "part": part_b}
        return payload
    except Exception as exc:
        # Deterministic error (bad expression / missing result / model build error): return
        # it with the traceback so the agent gets the same info the cold path would give —
        # re-running cold would only repeat it after paying the import.
        return {"ok": False, "script": "probe", "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(limit=8)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silence default request logging
        pass

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._send(200, {"ok": True, "pid": os.getpid(), "ready": bool(_BASE_MODULES)})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        route = self.path.rstrip("/")
        handlers = {"/build_export": _build_export, "/probe": _probe}
        handler = handlers.get(route)
        if handler is None:
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self._send(400, {"ok": False, "error": f"bad request: {exc}"})
            return
        try:
            self._send(200, handler(req))
        except Exception as exc:
            print(f"[rebuild_daemon] handler error: {exc}", file=sys.stderr)
            traceback.print_exc()
            self._send(200, {"ok": False, "error": f"daemon error: {exc}"})
        finally:
            _reset_after_request()


def client_main(argv) -> int:
    """`rebuild_daemon.py client <METHOD> <PATH> [<base64-json-body>] [<port>]`

    A dependency-free way for cf-sandbox to reach the daemon: a bare `python3`
    spawn (no build123d import) that POSTs to the localhost daemon and prints the
    response JSON. On connection failure it prints {"__client_error__": ...} so the
    caller can fall back to one-shot export_runner.py.
    """
    import base64
    import urllib.request

    method = argv[0] if argv else "GET"
    path = argv[1] if len(argv) > 1 else "/health"
    body = base64.b64decode(argv[2]) if len(argv) > 2 and argv[2] else None
    port = int(argv[3]) if len(argv) > 3 and argv[3] else 8765
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=body, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        sys.stdout.write(urllib.request.urlopen(req, timeout=125).read().decode())
        return 0
    except Exception as exc:
        sys.stdout.write(json.dumps({"__client_error__": str(exc)}))
        return 3


# Written after warmup so a cheap files.exists() check (no python spawn) tells the
# cf-sandbox Worker the daemon is up. Keep in sync with SANDBOX_DAEMON_READY_MARKER.
READY_MARKER = "/tmp/.aicad-rebuild-daemon.ready"


def _remove_ready_marker() -> None:
    try:
        os.unlink(READY_MARKER)
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "client":
        return client_main(sys.argv[2:])

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    # Bind FIRST so a duplicate launch (two prewarm/resolve calls racing) fails fast on
    # the busy port instead of running a second ~2.2s warmup — the existing daemon keeps
    # serving. The socket is listening immediately, so requests that arrive during warmup
    # queue in the backlog and block until serve_forever() handles them — callers wait
    # through warmup rather than being refused (and racing their own cold import).
    try:
        server = HTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(f"[rebuild_daemon] port {args.port} busy ({exc}); another daemon owns it", file=sys.stderr)
        return 0

    _warmup()

    import atexit
    import signal
    atexit.register(_remove_ready_marker)
    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(_sig, lambda *_: sys.exit(0))
        except Exception:
            pass
    try:
        with open(READY_MARKER, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass

    print(f"[rebuild_daemon] ready on {args.host}:{args.port} pid={os.getpid()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _remove_ready_marker()
    return 0


if __name__ == "__main__":
    sys.exit(main())
