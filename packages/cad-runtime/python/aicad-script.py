import base64
import contextlib
import importlib
import inspect
import io
import json
import math
import os
import re
import sys
import traceback

PROJECT_ROOT = os.path.abspath(os.environ.get("AICAD_PROJECT_ROOT") or os.getcwd())
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
API_LIST_LIMIT = 180
API_SEARCH_LIMIT = 80
API_MEMBER_LIMIT = 80
API_DOC_LIMIT = 1400
EXEC_OUTPUT_LIMIT = 16000


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def fail(message, **extra):
    emit({"ok": False, "error": message, **extra})
    return 1


def safe_name(value, label):
    value = str(value or "").strip()
    if not value or not NAME_RE.match(value):
        raise ValueError(f"{label} can only contain letters, numbers, underscores, and hyphens: {value!r}")
    return value


def default_part_for(model):
    flat = os.path.join(MODELS_DIR, model, "part.py")
    if os.path.isfile(flat):
        return model
    assembly = os.path.join(MODELS_DIR, model, "assembly.py")
    if os.path.isfile(assembly):
        return model
    parts_dir = os.path.join(MODELS_DIR, model, "parts")
    same_name = os.path.join(parts_dir, model, "part.py")
    if os.path.isfile(same_name):
        return model
    if os.path.isdir(parts_dir):
        parts = [
            name for name in os.listdir(parts_dir)
            if NAME_RE.match(name) and os.path.isfile(os.path.join(parts_dir, name, "part.py"))
        ]
        if len(parts) == 1:
            return parts[0]
    return model


def split_target(raw):
    raw = str(raw or "").strip()
    if not raw:
        active = os.environ.get("AICAD_ACTIVE_MODEL", "").strip()
        if active:
            model = safe_name(active, "model")
            return model, default_part_for(model)
        models = [
            name for name in os.listdir(MODELS_DIR)
            if os.path.isdir(os.path.join(MODELS_DIR, name))
        ] if os.path.isdir(MODELS_DIR) else []
        if len(models) == 1:
            model = safe_name(models[0], "model")
            return model, default_part_for(model)
        raise ValueError("target is required when there is no active model")
    if "/" in raw:
        model, part = raw.split("/", 1)
        return safe_name(model, "model"), safe_name(part, "part")
    name = safe_name(raw, "model")
    return name, default_part_for(name)


def part_source(model, part):
    if model == part:
        flat = os.path.join(MODELS_DIR, model, "part.py")
        if os.path.isfile(flat):
            return flat
        assembly = os.path.join(MODELS_DIR, model, "assembly.py")
        if os.path.isfile(assembly):
            return assembly
    source = os.path.join(MODELS_DIR, model, "parts", part, "part.py")
    if not os.path.isfile(source):
        raise FileNotFoundError(
            f"no source file found for {model}/{part} "
            f"(looked for models/{model}/part.py, models/{model}/assembly.py, "
            f"models/{model}/parts/{part}/part.py)"
        )
    return source


def json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if hasattr(value, "to_tuple"):
        try:
            return json_safe(value.to_tuple())
        except Exception:
            pass
    for names in (("X", "Y", "Z"), ("x", "y", "z")):
        if all(hasattr(value, n) for n in names):
            try:
                return [float(getattr(value, names[0])), float(getattr(value, names[1])), float(getattr(value, names[2]))]
            except Exception:
                pass
    return str(value)


def load_namespace(model, part):
    source = part_source(model, part)
    part_dir = os.path.dirname(source)
    if part_dir not in sys.path:
        sys.path.insert(0, part_dir)
    if PROJECT_ROOT not in sys.path:
        sys.path.insert(0, PROJECT_ROOT)
    ns = {
        "__name__": f"__aicad_script_{model}_{part}__",
        "__file__": source,
        "__package__": None,
        "__cached__": None,
        "__spec__": None,
    }
    with open(source, "r", encoding="utf-8") as f:
        code = compile(f.read(), source, "exec")
    exec(code, ns, ns)
    return ns, source


def metadata_from(ns):
    meta = ns.get("metadata", None)
    return meta if isinstance(meta, dict) else ({} if meta is None else {"value": meta})


def bbox_of(shape):
    if shape is None or not hasattr(shape, "bounding_box"):
        return None
    try:
        bb = shape.bounding_box()
        return {
            "min": json_safe(bb.min),
            "max": json_safe(bb.max),
            "size": [
                float(bb.max.X - bb.min.X),
                float(bb.max.Y - bb.min.Y),
                float(bb.max.Z - bb.min.Z),
            ],
        }
    except Exception:
        return None


def literal_value(value, depth=0):
    if depth > 4:
        return repr(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        out = {}
        for i, (key, item) in enumerate(value.items()):
            if i >= 50:
                out["..."] = f"+{len(value) - 50} more"
                break
            safe = literal_value(item, depth + 1)
            if safe is None and item is not None:
                return None
            out[str(key)] = safe
        return out
    if isinstance(value, (list, tuple)):
        if not value:
            return None
        out = []
        for item in value[:50]:
            safe = literal_value(item, depth + 1)
            if safe is None and item is not None:
                return None
            out.append(safe)
        if len(value) > 50:
            out.append(f"... +{len(value) - 50} more")
        return out
    try:
        return xyz(value)
    except Exception:
        return None


def distance(a, b):
    point_a = xyz(a)
    point_b = xyz(b)
    return math.sqrt(sum((point_b[i] - point_a[i]) ** 2 for i in range(3)))


def bbox_relation(a, b):
    bbox_a = bbox_of(a)
    bbox_b = bbox_of(b)
    if not bbox_a or not bbox_b:
        raise ValueError("both values must provide bounding_box()")
    min_a, max_a = bbox_a["min"], bbox_a["max"]
    min_b, max_b = bbox_b["min"], bbox_b["max"]
    center_a = [(min_a[i] + max_a[i]) / 2 for i in range(3)]
    center_b = [(min_b[i] + max_b[i]) / 2 for i in range(3)]
    axes = ("x", "y", "z")
    gap = {}
    overlap = {}
    for i, axis in enumerate(axes):
        if max_a[i] < min_b[i]:
            gap[axis] = min_b[i] - max_a[i]
        elif max_b[i] < min_a[i]:
            gap[axis] = min_a[i] - max_b[i]
        else:
            gap[axis] = 0.0
        overlap[axis] = min(max_a[i], max_b[i]) - max(min_a[i], min_b[i])
    center_delta = [center_b[i] - center_a[i] for i in range(3)]
    return {
        "a_bbox": bbox_a,
        "b_bbox": bbox_b,
        "center_a": center_a,
        "center_b": center_b,
        "center_delta_b_minus_a": center_delta,
        "center_distance": math.sqrt(sum(v * v for v in center_delta)),
        "axis_gap": gap,
        "axis_overlap": overlap,
        "bbox_gap_distance": math.sqrt(sum(v * v for v in gap.values())),
        "bbox_intersects": all(v >= 0 for v in overlap.values()),
    }


def summarize_one(item, index):
    entry = {"index": index, "type": type(item).__name__}
    geom = getattr(item, "geom_type", None)
    if geom is not None:
        entry["geom_type"] = str(geom() if callable(geom) else geom)
    for attr in ("length", "area", "radius"):
        val = getattr(item, attr, None)
        if callable(val):
            try:
                val = val()
            except Exception:
                val = None
        if isinstance(val, (int, float)):
            entry[attr] = float(val)
    try:
        center = item.center()
        entry["center"] = json_safe(center)
    except Exception:
        pass
    bb = bbox_of(item)
    if bb is not None:
        entry["bbox"] = bb
    return entry


def summarize_value(value, per_item_limit=12):
    report = {"py_type": type(value).__name__}
    literal = literal_value(value)
    if literal is not None or value is None:
        report["value"] = literal
        return report
    if hasattr(value, "__iter__") and not isinstance(value, (str, bytes, dict)):
        try:
            items = list(value)
        except Exception:
            items = None
        if items is not None:
            report["count"] = len(items)
            if items:
                report["item_type"] = type(items[0]).__name__
            total_length = 0.0
            total_area = 0.0
            for item in items:
                length = getattr(item, "length", None)
                if callable(length):
                    try:
                        length = length()
                    except Exception:
                        length = None
                if isinstance(length, (int, float)):
                    total_length += float(length)
                area = getattr(item, "area", None)
                if callable(area):
                    try:
                        area = area()
                    except Exception:
                        area = None
                if isinstance(area, (int, float)):
                    total_area += float(area)
            if total_length > 0:
                report["total_length"] = total_length
            if total_area > 0:
                report["total_area"] = total_area
            report["items"] = [summarize_one(item, i) for i, item in enumerate(items[:per_item_limit])]
            if len(items) > per_item_limit:
                report["items_truncated"] = len(items) - per_item_limit
            return report
    report.update(summarize_one(value, 0))
    return report


def build_probe_namespace(ns, secondary_ns=None):
    probe_ns = dict(ns)
    result = ns.get("result", None)
    probe_ns["result"] = result
    probe_ns["part"] = result
    probe_ns["result_a"] = result
    probe_ns["part_a"] = result
    probe_ns["a"] = result
    probe_ns["metadata_a"] = metadata_from(ns)
    if secondary_ns is not None:
        result_b = secondary_ns.get("result", None)
        probe_ns["result_b"] = result_b
        probe_ns["part_b"] = result_b
        probe_ns["b"] = result_b
        probe_ns["metadata_b"] = metadata_from(secondary_ns)
    probe_ns["distance"] = distance
    probe_ns["bbox_relation"] = bbox_relation
    try:
        import aicad_select  # type: ignore[import-not-found]
        probe_ns["aicad_select"] = aicad_select
        for name in getattr(aicad_select, "__all__", []):
            probe_ns[name] = getattr(aicad_select, name)
    except Exception as exc:
        probe_ns["aicad_select_error"] = str(exc)
    try:
        import aicad_attach  # type: ignore[import-not-found]
        probe_ns["aicad_attach"] = aicad_attach
        for name in getattr(aicad_attach, "__all__", []):
            probe_ns[name] = getattr(aicad_attach, name)
    except Exception as exc:
        probe_ns["aicad_attach_error"] = str(exc)
    try:
        import build123d as build123d_module
        probe_ns["build123d"] = build123d_module
        for name in ("Axis", "Plane", "Vector", "GeomType"):
            if hasattr(build123d_module, name):
                probe_ns.setdefault(name, getattr(build123d_module, name))
    except Exception:
        pass
    return probe_ns


def lookup_path(root, path_text):
    if path_text in ("", "."):
        return root
    current = root
    for segment in str(path_text).split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, (list, tuple)) and segment.isdigit() and int(segment) < len(current):
            current = current[int(segment)]
        else:
            raise KeyError(path_text)
    return current


def lookup_metadata(meta, key):
    candidates = [
        key,
        f"anchors.{key}",
        f"points.{key}",
        f"measurements.{key}",
    ]
    last_error = None
    for candidate in candidates:
        try:
            return candidate, lookup_path(meta, candidate)
        except Exception as exc:
            last_error = exc
    raise KeyError(str(last_error or key))


def xyz(value):
    if isinstance(value, dict):
        if all(k in value for k in ("x", "y", "z")):
            return [float(value["x"]), float(value["y"]), float(value["z"])]
        for key in ("point", "position", "origin", "center"):
            if key in value:
                return xyz(value[key])
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return [float(value[0]), float(value[1]), float(value[2])]
    for names in (("X", "Y", "Z"), ("x", "y", "z")):
        if all(hasattr(value, n) for n in names):
            return [float(getattr(value, names[0])), float(getattr(value, names[1])), float(getattr(value, names[2]))]
    raise TypeError(f"value is not a 3D point: {value!r}")


def parse_flags(args):
    flags = {}
    positionals = []
    i = 0
    while i < len(args):
        token = str(args[i])
        if token.startswith("-"):
            key = token.lstrip("-")
            if not key:
                raise ValueError("empty flag")
            if i + 1 >= len(args) or str(args[i + 1]).startswith("-"):
                raise ValueError(f"flag {token} requires a value")
            flags[key] = args[i + 1]
            i += 2
        else:
            positionals.append(token)
            i += 1
    return flags, positionals


def flag_value(flags, *names):
    for name in names:
        if name in flags:
            return flags[name]
    return None


def trim_text(value, limit):
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n...[truncated {len(text) - limit} chars]"


def public_names(obj):
    try:
        names = getattr(obj, "__all__", None)
        if names:
            return sorted(str(name) for name in names if not str(name).startswith("_"))
    except Exception:
        pass
    return sorted(name for name in dir(obj) if not name.startswith("_"))


def symbol_kind(obj):
    if inspect.isclass(obj):
        return "class"
    if inspect.ismodule(obj):
        return "module"
    if inspect.isfunction(obj) or inspect.ismethod(obj) or inspect.isbuiltin(obj):
        return "function"
    if callable(obj):
        return "callable"
    return type(obj).__name__


def signature_for(obj):
    try:
        return str(inspect.signature(obj))
    except Exception:
        return ""


def import_module_checked(module_name):
    module_name = str(module_name or "").strip()
    if not module_name or not MODULE_RE.match(module_name):
        raise ValueError(f"invalid module name: {module_name!r}")
    return importlib.import_module(module_name)


def resolve_symbol(module, name):
    current = module
    for segment in str(name or "").split("."):
        if not segment:
            raise ValueError("empty symbol segment")
        current = getattr(current, segment)
    return current


def command_api(args):
    flags, positionals = parse_flags(args)
    if positionals:
        raise ValueError("script/api expects flags, e.g. api -module build123d -search fillet")
    module_name = flag_value(flags, "module", "m")
    if not module_name:
        raise ValueError("script/api expects -module <module>")
    module = import_module_checked(module_name)
    name = flag_value(flags, "name", "symbol")
    search = flag_value(flags, "search", "q")

    if name:
        obj = resolve_symbol(module, name)
        members = []
        if inspect.isclass(obj) or inspect.ismodule(obj):
            for member_name in public_names(obj):
                try:
                    member = getattr(obj, member_name)
                except Exception:
                    continue
                members.append({
                    "name": member_name,
                    "kind": symbol_kind(member),
                    "signature": signature_for(member),
                })
                if len(members) >= API_MEMBER_LIMIT:
                    break
        return {
            "ok": True,
            "script": "api",
            "module": module_name,
            "name": name,
            "kind": symbol_kind(obj),
            "signature": signature_for(obj),
            "doc": trim_text(inspect.getdoc(obj) or "", API_DOC_LIMIT),
            "members": members,
            "membersTruncated": max(0, len(public_names(obj)) - len(members)) if (inspect.isclass(obj) or inspect.ismodule(obj)) else 0,
        }

    lowered = str(search or "").lower()
    symbols = []
    for symbol_name in public_names(module):
        if lowered and lowered not in symbol_name.lower():
            continue
        try:
            obj = getattr(module, symbol_name)
        except Exception:
            continue
        symbols.append({
            "name": symbol_name,
            "kind": symbol_kind(obj),
            "signature": signature_for(obj),
        })
        limit = API_SEARCH_LIMIT if lowered else API_LIST_LIMIT
        if len(symbols) >= limit:
            break
    total_public = len(public_names(module))
    return {
        "ok": True,
        "script": "api",
        "module": module_name,
        "search": search or "",
        "symbols": symbols,
        "totalPublicSymbols": total_public,
        "truncated": len(symbols) < total_public if not lowered else len(symbols) >= API_SEARCH_LIMIT,
    }


def command_build(args):
    flags, positionals = parse_flags(args)
    if positionals:
        raise ValueError("script/build expects command: build -component <name>")
    component = flag_value(flags, "component", "c")
    if not component:
        raise ValueError("script/build expects command: build -component <name>")
    model, part = split_target(component)
    ns, source = load_namespace(model, part)
    result = ns.get("result", None)
    meta = metadata_from(ns)
    return {
        "ok": True,
        "script": "build",
        "model": model,
        "part": part,
        "source": os.path.relpath(source, PROJECT_ROOT).replace(os.sep, "/"),
        "resultType": type(result).__name__ if result is not None else None,
        "hasResult": result is not None,
        "bbox": bbox_of(result),
        "metadataKeys": sorted([str(k) for k in meta.keys()]),
    }


def command_probe(args):
    flags, positionals = parse_flags(args)
    if positionals:
        raise ValueError('script/probe expects flags, e.g. probe -component model/part -expr "top_edges(part)"')
    component = flag_value(flags, "component", "target", "part")
    component_b = flag_value(flags, "component-b", "componentB", "other-component", "other", "b")
    expression = str(flag_value(flags, "expr", "expression") or "").strip()
    if not expression:
        expression = "bbox_relation(part_a, part_b)" if component_b else "part"
    model, part = split_target(component or "")
    ns, _source = load_namespace(model, part)
    if ns.get("result", None) is None:
        raise ValueError("part.py must define a global result before probing")
    ns_b = None
    model_b = None
    part_b = None
    if component_b:
        model_b, part_b = split_target(component_b)
        ns_b, _source_b = load_namespace(model_b, part_b)
        if ns_b.get("result", None) is None:
            raise ValueError("componentB part.py must define a global result before probing")
    probe_ns = build_probe_namespace(ns, ns_b)
    value = eval(expression, probe_ns, probe_ns)
    payload = {
        "ok": True,
        "script": "probe",
        "model": model,
        "part": part,
        "expression": expression,
        "value": summarize_value(value),
    }
    if model_b and part_b:
        payload["componentB"] = {"model": model_b, "part": part_b}
    return payload


def code_from_flags(flags):
    """Read the user script. -code-b64 is the robust transport (no shell-quoting or
    flag-parser '-' collisions); -code is accepted as a plain-text fallback."""
    b64 = flag_value(flags, "code-b64", "codeB64")
    if b64:
        try:
            return base64.b64decode(b64).decode("utf-8")
        except Exception as exc:
            raise ValueError(f"invalid -code-b64 payload: {exc}")
    raw = flag_value(flags, "code")
    if raw is not None:
        return str(raw)
    raise ValueError("exec expects -code-b64 <base64> (the script to run)")


def run_user_code(code, ns):
    """exec the agent's script with stdout captured. Returns (stdout, error, traceback).
    On error the partial stdout printed before the exception is still returned so the agent
    sees whatever it managed to print."""
    buf = io.StringIO()
    error = None
    tb = None
    try:
        compiled = compile(code, "<run_script>", "exec")
        with contextlib.redirect_stdout(buf):
            exec(compiled, ns)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        tb = traceback.format_exc(limit=8)
    out = buf.getvalue()
    if len(out) > EXEC_OUTPUT_LIMIT:
        out = out[:EXEC_OUTPUT_LIMIT].rstrip() + f"\n...[truncated {len(out) - EXEC_OUTPUT_LIMIT} chars]"
    return out, error, tb


def command_exec(args):
    flags, positionals = parse_flags(args)
    if positionals:
        raise ValueError("script/exec expects flags, e.g. exec -component model/part -code-b64 <base64>")
    component = flag_value(flags, "component", "target", "part")
    component_b = flag_value(flags, "component-b", "componentB", "other-component", "other", "b")
    code = code_from_flags(flags)
    model, part = split_target(component or "")
    ns, _source = load_namespace(model, part)
    if ns.get("result", None) is None:
        raise ValueError("part.py must define a global result before running a script")
    ns_b = None
    model_b = None
    part_b = None
    if component_b:
        model_b, part_b = split_target(component_b)
        ns_b, _source_b = load_namespace(model_b, part_b)
        if ns_b.get("result", None) is None:
            raise ValueError("componentB part.py must define a global result before running a script")
    probe_ns = build_probe_namespace(ns, ns_b)
    stdout, error, tb = run_user_code(code, probe_ns)
    payload = {
        "ok": error is None,
        "script": "exec",
        "model": model,
        "part": part,
        "stdout": stdout,
    }
    if model_b and part_b:
        payload["componentB"] = {"model": model_b, "part": part_b}
    if error is not None:
        payload["error"] = error
        payload["traceback"] = tb
    return payload


def main(argv):
    if not argv:
        return fail("script is required")
    script = argv[0].strip().strip("/")
    args = argv[1:]
    try:
        if script == "build":
            emit(command_build(args))
        elif script == "probe":
            emit(command_probe(args))
        elif script == "exec":
            emit(command_exec(args))
        elif script == "api":
            emit(command_api(args))
        else:
            return fail(f"unknown script: {script}", available=["build", "probe", "exec", "api"])
        return 0
    except Exception as exc:
        return fail(f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc(limit=8))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
