// @ts-nocheck
export {};
'use strict';

const EXPORT_RUNNER_PYTHON = `"""
export_runner.py - Auto-managed by AI CAD Companion Viewer (do not edit manually)
----------------------------------------------------------------------------
Responsibilities:
  * Accept --model <name> (and legacy --part <name>);
  * Optionally support on-demand exports via --export-format/--output (step/stl/brep);
  * Load models/<model>/parts/<part-name>/part.py and read a geometry object named result;
  * Export build123d geometry to .cache/<name>.brep (and STEP/STL) via OCCT APIs;
  * Let the frontend parse BREP via occt-import-js for geometry inspection.
"""
import argparse
import fnmatch
import importlib
import inspect
import json
import os
import pkgutil
import re
import sys
import runpy
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = HERE
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
MODEL_KINDS = ("part",)
CAD_API_MODULES = (
    "build123d",
    "bd_warehouse",
    "bd_warehouse.fastener",
    "bd_warehouse.bearing",
    "bd_warehouse.gear",
    "bd_warehouse.sprocket",
    "bd_warehouse.thread",
    "bd_warehouse.pipe",
    "bd_warehouse.flange",
    "bd_warehouse.material",
    "bd_warehouse.profile",
)
CAD_API_ALLOWED_PREFIXES = ("build123d", "bd_warehouse")


def _looks_like_build123d(obj) -> bool:
    return any(c.__module__.startswith("build123d") for c in type(obj).__mro__)


def _write_brep(shape, path_out):
    if _looks_like_build123d(shape):
        try:
            from build123d import export_brep  # type: ignore
            export_brep(shape, path_out)
            return "build123d.export_brep"
        except Exception:
            pass

    try:
        from OCP.BRepTools import BRepTools  # type: ignore
        inner = getattr(shape, "wrapped", shape)
        BRepTools.Write_s(inner, path_out)
        return "OCP.BRepTools.Write_s"
    except Exception as exc:
        raise RuntimeError(f"Unable to export BREP: {exc}")


def _write_step(shape, path_out):
    if _looks_like_build123d(shape):
        try:
            from build123d import export_step  # type: ignore
            export_step(shape, path_out)
            return "build123d.export_step"
        except Exception:
            pass

    try:
        from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs  # type: ignore
        from OCP.IFSelect import IFSelect_RetDone  # type: ignore
        inner = getattr(shape, "wrapped", shape)
        writer = STEPControl_Writer()
        writer.Transfer(inner, STEPControl_AsIs)
        status = writer.Write(path_out)
        if status != IFSelect_RetDone:
            raise RuntimeError(f"STEP write failed with status: {status}")
        return "OCP.STEPControl_Writer"
    except Exception as exc:
        raise RuntimeError(f"Unable to export STEP: {exc}")


def _write_stl(shape, path_out):
    if _looks_like_build123d(shape):
        try:
            from build123d import export_stl  # type: ignore
            export_stl(shape, path_out)
            return "build123d.export_stl"
        except Exception:
            pass

    try:
        from OCP.BRepMesh import BRepMesh_IncrementalMesh  # type: ignore
        from OCP.StlAPI import StlAPI_Writer  # type: ignore
        inner = getattr(shape, "wrapped", shape)
        BRepMesh_IncrementalMesh(inner, 0.1, False, 0.5, True)
        writer = StlAPI_Writer()
        writer.Write(inner, path_out)
        return "OCP.StlAPI_Writer"
    except Exception as exc:
        raise RuntimeError(f"Unable to export STL: {exc}")


def _resolve_model_source(model_name: str, part_name: str):
    source_path = os.path.join(MODELS_DIR, model_name, "parts", part_name, "part.py")
    if os.path.isfile(source_path):
        return source_path
    return None


def _json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if hasattr(value, "to_tuple"):
        try:
            return _json_safe(value.to_tuple())
        except Exception:
            pass
    if all(hasattr(value, attr) for attr in ("X", "Y", "Z")):
        try:
            return [float(value.X), float(value.Y), float(value.Z)]
        except Exception:
            pass
    if all(hasattr(value, attr) for attr in ("x", "y", "z")):
        try:
            return [float(value.x), float(value.y), float(value.z)]
        except Exception:
            pass
    raise TypeError(f"metadata contains non-JSON value of type {type(value).__name__}")


def _safe_text(value, limit=4000):
    try:
        text = str(value or "")
    except Exception as exc:
        text = f"<unprintable: {exc}>"
    text = re.sub(r"\\s+", " ", text).strip()
    return text[:limit] + ("..." if len(text) > limit else "")


def _cad_api_allowed_module(name):
    return any(name == prefix or name.startswith(prefix + ".") for prefix in CAD_API_ALLOWED_PREFIXES)


def _cad_api_public_name(name):
    return bool(name) and not name.startswith("_")


def _cad_api_import_module(name):
    if not _cad_api_allowed_module(name):
        raise ValueError(f"module is not allowed: {name}")
    return importlib.import_module(name)


def _cad_api_signature(obj):
    try:
        return str(inspect.signature(obj))
    except Exception:
        return ""


def _cad_api_kind(obj):
    if inspect.ismodule(obj):
        return "module"
    if inspect.isclass(obj):
        return "class"
    if inspect.isfunction(obj):
        return "function"
    if inspect.ismethod(obj):
        return "method"
    if inspect.isbuiltin(obj):
        return "builtin"
    if isinstance(obj, property):
        return "property"
    return type(obj).__name__


def _cad_api_doc(obj, limit=2400):
    return _safe_text(inspect.getdoc(obj) or "", limit)


def _cad_api_summarize(module_name, name, obj):
    qualname = module_name if not name else module_name + "." + name
    return {
        "symbol": qualname,
        "name": name or module_name,
        "module": module_name,
        "kind": _cad_api_kind(obj),
    }


def _cad_api_visible_module_names(root_name):
    curated = [name for name in CAD_API_MODULES if name == root_name or name.startswith(root_name + ".")]
    if curated:
        return curated
    names = [root_name]
    try:
        root = _cad_api_import_module(root_name)
        paths = getattr(root, "__path__", None)
        if paths:
            for info in pkgutil.iter_modules(paths):
                fullname = root_name + "." + info.name
                if _cad_api_allowed_module(fullname):
                    names.append(fullname)
    except Exception:
        pass
    return names


def _cad_api_resolve(symbol=None, module_name=None):
    if module_name:
        module = _cad_api_import_module(module_name)
        obj = module
        qualname = module_name
        member = str(symbol or "").strip()
        if member == module_name:
            member = ""
        elif member.startswith(module_name + "."):
            member = member[len(module_name) + 1:]
        if member:
            for part in member.split("."):
                obj = getattr(obj, part)
                qualname += "." + part
        return module_name, qualname, obj

    parts = str(symbol or "").strip().split(".")
    for i in range(len(parts), 0, -1):
        candidate = ".".join(parts[:i])
        if not _cad_api_allowed_module(candidate):
            continue
        try:
            module = importlib.import_module(candidate)
        except Exception:
            continue
        obj = module
        qualname = candidate
        for part in parts[i:]:
            obj = getattr(obj, part)
            qualname += "." + part
        return candidate, qualname, obj
    raise ValueError(f"could not resolve symbol: {symbol}")


def _cad_api_query_matcher(query):
    query = str(query or "").strip()
    if not query:
        return None
    lower_query = query.lower()
    if lower_query.startswith("re:") or lower_query.startswith("regex:"):
        pattern = query.split(":", 1)[1].strip()
        if not pattern:
            return None
        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            raise ValueError(f"invalid query regex: {exc}")
        return {
            "needs_doc": False,
            "matches_name": lambda qualname, name_haystack: bool(compiled.search(qualname)),
            "matches_doc": lambda haystack: bool(compiled.search(haystack)),
        }
    if any(ch in query for ch in "*?[]"):
        compiled = re.compile(fnmatch.translate(query), re.IGNORECASE)
        return {
            "needs_doc": False,
            "matches_name": lambda qualname, name_haystack: bool(compiled.search(qualname)),
            "matches_doc": lambda haystack: bool(compiled.search(haystack)),
        }
    terms = [term for term in re.split(r"\\s+", lower_query) if term]
    return {
        "needs_doc": True,
        "matches_name": lambda qualname, name_haystack: all(term in name_haystack for term in terms),
        "matches_doc": lambda haystack: all(term in haystack for term in terms),
    }


def _cad_api_search(payload):
    query_matcher = _cad_api_query_matcher(payload.get("query"))
    max_results = max(1, min(int(payload.get("maxResults") or 50), 200))
    modules = payload.get("modules") or CAD_API_MODULES
    expand_packages = bool(payload.get("expandPackages", False))

    module_names = []
    for module_name in modules:
        module_name = str(module_name or "").strip()
        if not module_name or not _cad_api_allowed_module(module_name):
            continue
        module_names.extend(_cad_api_visible_module_names(module_name) if expand_packages else [module_name])
    module_names = list(dict.fromkeys(module_names))

    results = []
    errors = []
    for module_name in module_names:
        try:
            module = _cad_api_import_module(module_name)
        except Exception as exc:
            errors.append({"module": module_name, "error": _safe_text(exc, 500)})
            continue
        for name in dir(module):
            if not _cad_api_public_name(name):
                continue
            qualname = module_name + "." + name
            try:
                obj = getattr(module, name)
            except Exception:
                continue
            kind = _cad_api_kind(obj)
            name_haystack = (qualname + " " + kind).lower()
            if query_matcher and not query_matcher["matches_name"](qualname, name_haystack):
                if not query_matcher["needs_doc"]:
                    continue
                doc = inspect.getdoc(obj) or ""
                haystack = (name_haystack + " " + doc[:500]).lower()
                if not query_matcher["matches_doc"](haystack):
                    continue
            results.append(_cad_api_summarize(module_name, name, obj))
            if len(results) >= max_results:
                return {"ok": True, "results": results, "errors": errors, "truncated": True}
    return {"ok": True, "results": results, "errors": errors, "truncated": False}


def _cad_api_members(obj, qualname, limit=80):
    rows = []
    for name in dir(obj):
        if not _cad_api_public_name(name):
            continue
        try:
            member = getattr(obj, name)
        except Exception:
            continue
        if inspect.ismodule(member):
            continue
        rows.append({
            "name": name,
            "symbol": qualname + "." + name,
            "kind": _cad_api_kind(member),
            "signature": _cad_api_signature(member),
        })
        if len(rows) >= limit:
            break
    return rows


def _cad_api_read(payload):
    module_name = str(payload.get("module") or "").strip()
    symbol = str(payload.get("symbol") or "").strip()
    if not module_name and not symbol:
        raise ValueError("symbol is required")
    resolved_module, qualname, obj = _cad_api_resolve(symbol=symbol, module_name=module_name or None)
    item = {
        "ok": True,
        "symbol": qualname,
        "module": resolved_module,
        "kind": _cad_api_kind(obj),
        "signature": _cad_api_signature(obj),
        "doc": _cad_api_doc(obj, max(500, min(int(payload.get("maxDocChars") or 6000), 20000))),
    }
    if inspect.isclass(obj):
        item["initSignature"] = _cad_api_signature(getattr(obj, "__init__", None))
    if inspect.ismodule(obj) or inspect.isclass(obj):
        item["members"] = _cad_api_members(obj, qualname, max(0, min(int(payload.get("maxMembers") or 80), 200)))
    return item


def inspect_cad_api() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        action = payload.get("action")
        if action == "search":
            output = _cad_api_search(payload)
        elif action == "read":
            output = _cad_api_read(payload)
        else:
            raise ValueError(f"unknown action: {action}")
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": _safe_text(exc, 2000)}, ensure_ascii=False))
        return 1


def _write_metadata(model_name: str, part_name: str, ns: dict):
    metadata = ns.get("metadata", None)
    if metadata is None:
        return
    try:
        payload = _json_safe(metadata)
    except Exception as exc:
        raise RuntimeError(f"Invalid metadata: {exc}")
    model_dir = os.path.join(MODELS_DIR, model_name, "parts", part_name)
    os.makedirs(model_dir, exist_ok=True)
    metadata_path = os.path.join(model_dir, "metadata.json")
    tmp_path = metadata_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\\n")
    os.replace(tmp_path, metadata_path)


def _build_namespace(model_name: str, part_name: str):
    source_path = _resolve_model_source(model_name, part_name)
    if not source_path:
        print(
            f"[export_runner] models/{model_name}/parts/{part_name}/part.py does not exist",
            file=sys.stderr
        )
        return None, None, 2

    model_dir = os.path.dirname(source_path)
    if model_dir not in sys.path:
        sys.path.insert(0, model_dir)

    try:
        ns = runpy.run_path(source_path, run_name=f"__aicad_model_{model_name}__")
    except Exception as exc:
        print(f"[export_runner] Failed to execute {source_path}: {exc}", file=sys.stderr)
        return None, None, 3
    return ns, source_path, 0


def build_one(model_name: str, part_name: str = None, export_format: str = "brep", output: str = None) -> int:
    part_name = part_name or model_name
    build_started = time.perf_counter()
    ns, source_path, err = _build_namespace(model_name, part_name)
    build_elapsed = time.perf_counter() - build_started
    if err:
        return err
    print(f"[export_runner] {model_name} build_model time: {build_elapsed:.3f}s")
    result = ns.get("result", None)
    if result is None:
        print(f"[export_runner] {source_path} must define a global result object (build123d).",
              file=sys.stderr)
        return 4
    try:
        _write_metadata(model_name, part_name, ns)
    except Exception as exc:
        print(f"[export_runner] Failed to write metadata.json: {exc}", file=sys.stderr)
        return 8

    fmt = (export_format or "brep").strip().lower()
    if fmt not in ("brep", "step", "stl"):
        print(f"[export_runner] Unsupported export format: {fmt}", file=sys.stderr)
        return 7

    if output:
        out = os.path.abspath(output)
        os.makedirs(os.path.dirname(out), exist_ok=True)
    else:
        os.makedirs(CACHE_DIR, exist_ok=True)
        out = os.path.join(CACHE_DIR, f"{model_name}__{part_name}.{fmt}")

    try:
        export_started = time.perf_counter()
        if fmt == "brep":
            method = _write_brep(result, out)
        elif fmt == "step":
            method = _write_step(result, out)
        else:
            method = _write_stl(result, out)
        export_elapsed = time.perf_counter() - export_started
    except Exception as exc:
        print(f"[export_runner] Failed to export {fmt.upper()}: {exc}", file=sys.stderr)
        return 5

    size = os.path.getsize(out) if os.path.exists(out) else 0
    if size <= 0:
        print("[export_runner] Generated output file is empty", file=sys.stderr)
        return 6
    print(f"[export_runner] {model_name}/{part_name} {fmt.upper()} export time: {export_elapsed:.3f}s")
    print(f"[export_runner] {model_name}/{part_name} export succeeded [{fmt.upper()}] ({method}): {out} ({size} bytes)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=None, help="Project root path (contains models/ and .cache/)")
    parser.add_argument("--inspect-cad-api", action="store_true", help="Inspect bundled build123d/bd_warehouse APIs from JSON stdin")
    parser.add_argument("--model", default=None, help="Model directory name")
    parser.add_argument("--part", default=None, help="Legacy alias for --model")
    parser.add_argument("--part-name", default=None, help="Part directory name inside models/<model>/parts/")
    parser.add_argument("--export-format", default="brep", choices=["brep", "step", "stl"])
    parser.add_argument("--output", default=None, help="Optional absolute path for exported file")
    args = parser.parse_args()
    global PROJECT_ROOT, MODELS_DIR, CACHE_DIR
    PROJECT_ROOT = os.path.abspath(args.project) if args.project else HERE
    MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
    CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
    if args.inspect_cad_api:
        return inspect_cad_api()
    model_name = args.model or args.part
    if not model_name:
        parser.error("one of --model / --part is required")
    return build_one(model_name, args.part_name or model_name, args.export_format, args.output)


if __name__ == "__main__":
    sys.exit(main())
`;

module.exports = {
  EXPORT_RUNNER_PYTHON
};
