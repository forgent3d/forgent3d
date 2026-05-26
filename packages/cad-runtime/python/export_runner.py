"""
export_runner.py - Auto-managed by AI CAD Companion Viewer (do not edit manually)
----------------------------------------------------------------------------
Responsibilities:
  * Accept --model <name> (and legacy --part <name>);
  * Optionally support on-demand exports via --export-format/--output (step/stl/obj/brep/glb/3mf);
  * Load models/<model>/assembly.py, part.py, or parts/<part-name>/part.py and read result;
  * Export build123d geometry to .cache/<name>.brep and requested exchange/mesh formats;
  * Let the frontend parse BREP via occt-import-js for geometry inspection.
"""
import os
import sys

# Must run before other imports / open() on Windows (locale default is often GBK).
if sys.platform == "win32":
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"

import argparse
import json
import struct
import tempfile
import time
import traceback
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = HERE
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
MODEL_KINDS = ("part",)


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


def _xml_escape_text(value):
    return (
        str(value if value is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _xml_escape_attr(value):
    return _xml_escape_text(value).replace('"', "&quot;").replace("'", "&apos;")


def _format_3mf_number(value):
    num = float(value)
    if abs(num) < 1e-9:
        num = 0.0
    if num.is_integer():
        return str(int(num))
    return f"{num:.6f}".rstrip("0").rstrip(".") or "0"


def _rgba_to_3mf_color(rgba):
    if not rgba:
        rgba = (0xb0 / 255, 0xb0 / 255, 0xb0 / 255, 1.0)
    values = []
    for i, fallback in enumerate((0.69, 0.69, 0.69, 1.0)):
        try:
            v = float(rgba[i])
        except Exception:
            v = fallback
        values.append(max(0, min(255, round(max(0.0, min(1.0, v)) * 255))))
    return "#" + "".join(f"{v:02X}" for v in values)


def _read_stl_triangles(path_in):
    with open(path_in, "rb") as f:
        data = f.read()
    if len(data) >= 84:
        tri_count = struct.unpack("<I", data[80:84])[0]
        expected = 84 + tri_count * 50
        if expected == len(data):
            triangles = []
            offset = 84
            for _ in range(tri_count):
                values = struct.unpack("<12fH", data[offset:offset + 50])
                triangles.append((
                    (values[3], values[4], values[5]),
                    (values[6], values[7], values[8]),
                    (values[9], values[10], values[11]),
                ))
                offset += 50
            return triangles

    text = data.decode("utf-8", errors="ignore")
    vertices = []
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 4 and parts[0].lower() == "vertex":
            try:
                vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                pass
    if len(vertices) < 3 or len(vertices) % 3 != 0:
        raise RuntimeError("Unable to parse STL triangles for mesh export")
    return [(vertices[i], vertices[i + 1], vertices[i + 2]) for i in range(0, len(vertices), 3)]


def _write_obj_mesh(triangles, path_out, title="Forgent3D model"):
    if not triangles:
        raise RuntimeError("OBJ export found no triangles")
    with open(path_out, "w", encoding="utf-8", newline="\n") as f:
        f.write("# Forgent3D OBJ export\n")
        f.write(f"o {_xml_escape_text(title or 'model')}\n")
        for tri in triangles:
            for vertex in tri:
                f.write(
                    f"v {_format_3mf_number(vertex[0])} "
                    f"{_format_3mf_number(vertex[1])} "
                    f"{_format_3mf_number(vertex[2])}\n"
                )
        for i in range(0, len(triangles) * 3, 3):
            f.write(f"f {i + 1} {i + 2} {i + 3}\n")


def _write_3mf_archive(triangles, path_out, title="Forgent3D model", color=None):
    if not triangles:
        raise RuntimeError("3MF export found no triangles")
    display_color = _rgba_to_3mf_color(color)
    vertices_xml = []
    triangles_xml = []
    vertex_index = 0
    for tri in triangles:
        indices = []
        for vertex in tri:
            indices.append(vertex_index)
            vertices_xml.append(
                f'          <vertex x="{_format_3mf_number(vertex[0])}" '
                f'y="{_format_3mf_number(vertex[1])}" '
                f'z="{_format_3mf_number(vertex[2])}" />'
            )
            vertex_index += 1
        triangles_xml.append(
            f'          <triangle v1="{indices[0]}" v2="{indices[1]}" v3="{indices[2]}" />'
        )

    safe_title = _xml_escape_text(str(title or "Forgent3D model")[:128])
    model_xml = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
        f'  <metadata name="Title">{safe_title}</metadata>',
        '  <resources>',
        '    <basematerials id="1">',
        f'      <base name="Default" displaycolor="{display_color}" />',
        '    </basematerials>',
        f'    <object id="2" type="model" name="{_xml_escape_attr(title or "model")}" pid="1" pindex="0">',
        '      <mesh>',
        '        <vertices>',
        *vertices_xml,
        '        </vertices>',
        '        <triangles>',
        *triangles_xml,
        '        </triangles>',
        '      </mesh>',
        '    </object>',
        '  </resources>',
        '  <build>',
        '    <item objectid="2" />',
        '  </build>',
        '</model>',
        '',
    ])
    content_types_xml = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />',
        '  <Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />',
        '</Types>',
        '',
    ])
    rels_xml = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />',
        '</Relationships>',
        '',
    ])
    with zipfile.ZipFile(path_out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types_xml)
        z.writestr("_rels/.rels", rels_xml)
        z.writestr("3D/3dmodel.model", model_xml)


# Keep in sync with packages/electron/src/viewer-materials.ts MATERIAL_PRESETS.
_VIEWER_PRESET_COLORS = {
    "cad_clay":         (0xc8 / 255, 0xd0 / 255, 0xdc / 255, 1.0),
    "matte_plastic":    (0xb9 / 255, 0xc2 / 255, 0xd0 / 255, 1.0),
    "gloss_plastic":    (0xb9 / 255, 0xc2 / 255, 0xd0 / 255, 1.0),
    "painted_metal":    (0x8f / 255, 0xa3 / 255, 0xb8 / 255, 1.0),
    "anodized_aluminum":(0x4f / 255, 0x8f / 255, 0xd8 / 255, 1.0),
    "brushed_steel":    (0xa7 / 255, 0xb0 / 255, 0xba / 255, 1.0),
    "dark_steel":       (0x4b / 255, 0x55 / 255, 0x63 / 255, 1.0),
    "polished_metal":   (0xd0 / 255, 0xd6 / 255, 0xdc / 255, 1.0),
    "rubber":           (0x24 / 255, 0x28 / 255, 0x32 / 255, 1.0),
    "glass_clear":      (0xd8 / 255, 0xec / 255, 0xff / 255, 0.34),
}


def _parse_hex_color(text):
    s = str(text or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) not in (6, 8):
        return None
    try:
        r = int(s[0:2], 16) / 255
        g = int(s[2:4], 16) / 255
        b = int(s[4:6], 16) / 255
        a = (int(s[6:8], 16) / 255) if len(s) == 8 else 1.0
        return (r, g, b, a)
    except ValueError:
        return None


def _resolve_material_color(spec):
    """Resolve a __viewer.materials entry to an (r, g, b, a) tuple of floats."""
    if spec is None:
        return None
    if isinstance(spec, bool):
        return None
    if isinstance(spec, int):
        v = spec & 0xffffff
        return (((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255, 1.0)
    if isinstance(spec, str):
        text = spec.strip()
        if text in _VIEWER_PRESET_COLORS:
            return _VIEWER_PRESET_COLORS[text]
        return _parse_hex_color(text)
    if isinstance(spec, dict):
        explicit = spec.get("color")
        if explicit is not None:
            resolved = _resolve_material_color(explicit)
            if resolved is not None:
                return resolved
        preset_name = str(spec.get("preset") or spec.get("material") or "").strip()
        if preset_name in _VIEWER_PRESET_COLORS:
            return _VIEWER_PRESET_COLORS[preset_name]
    return None


def _load_model_params(model_name: str):
    path = os.path.join(MODELS_DIR, model_name, "params.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _apply_viewer_colors(shape, params):
    """Stamp build123d .color from params.json __viewer.materials so export_gltf preserves it."""
    if not isinstance(params, dict):
        return
    viewer = params.get("__viewer") or params.get("viewer") or {}
    materials = viewer.get("materials") if isinstance(viewer, dict) else None
    if not isinstance(materials, dict):
        return
    parts_spec = materials.get("parts") if isinstance(materials.get("parts"), dict) else {}
    default_rgba = _resolve_material_color(materials.get("default"))

    try:
        from build123d import Color  # type: ignore
    except Exception:
        return

    def _set(node, rgba):
        if rgba is None:
            return
        try:
            node.color = Color(float(rgba[0]), float(rgba[1]), float(rgba[2]), float(rgba[3]))
        except Exception:
            pass

    try:
        children = list(getattr(shape, "children", []) or [])
    except TypeError:
        children = []

    if not children:
        # Single-shape model: apply default color if configured.
        _set(shape, default_rgba)
        return

    for child in children:
        label = str(getattr(child, "label", "") or "").strip()
        spec = parts_spec.get(label) if label else None
        rgba = _resolve_material_color(spec) if spec is not None else None
        if rgba is None:
            rgba = default_rgba
        _set(child, rgba)


def _write_glb(shape, path_out, params=None):
    try:
        from build123d import export_gltf, Unit  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"build123d.export_gltf unavailable: {exc}")
    try:
        _apply_viewer_colors(shape, params)
        export_gltf(shape, path_out, unit=Unit.MM, binary=True)
        return "build123d.export_gltf"
    except Exception as exc:
        raise RuntimeError(f"Unable to export GLB: {exc}")


def _write_3mf(shape, path_out, params=None, title="Forgent3D model"):
    fd, tmp_stl = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    try:
        _write_stl(shape, tmp_stl)
        triangles = _read_stl_triangles(tmp_stl)
    finally:
        try:
            os.unlink(tmp_stl)
        except OSError:
            pass

    color = None
    if isinstance(params, dict):
        viewer = params.get("__viewer") or params.get("viewer") or {}
        materials = viewer.get("materials") if isinstance(viewer, dict) else None
        if isinstance(materials, dict):
            color = _resolve_material_color(materials.get("default"))
    _write_3mf_archive(triangles, path_out, title=title, color=color)
    return "export_runner.3mf_from_stl_mesh"


def _write_obj(shape, path_out, title="Forgent3D model"):
    fd, tmp_stl = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    try:
        _write_stl(shape, tmp_stl)
        triangles = _read_stl_triangles(tmp_stl)
    finally:
        try:
            os.unlink(tmp_stl)
        except OSError:
            pass

    _write_obj_mesh(triangles, path_out, title=title)
    return "export_runner.obj_from_stl_mesh"


def _resolve_model_source(model_name: str, part_name: str, source_override: str = None):
    if source_override:
        candidate = source_override
        if not os.path.isabs(candidate):
            candidate = os.path.join(PROJECT_ROOT, candidate)
        return candidate if os.path.isfile(candidate) else None
    part_sub_path = os.path.join(MODELS_DIR, model_name, "parts", part_name, "part.py")
    # Sub-part builds must not fall back to assembly.py (would export the whole assembly for every mesh).
    if part_name != model_name:
        return part_sub_path if os.path.isfile(part_sub_path) else None
    candidates = [
        os.path.join(MODELS_DIR, model_name, "assembly.py"),
        os.path.join(MODELS_DIR, model_name, "part.py"),
        part_sub_path,
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
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


def _collect_compound_labels(shape, ns=None):
    labels = []
    children = getattr(shape, "children", None)
    if children is not None:
        try:
            iterable = list(children)
        except TypeError:
            iterable = []
        for child in iterable:
            label = getattr(child, "label", None)
            if label is None and hasattr(child, "part"):
                label = getattr(child.part, "label", None)
            text = str(label).strip() if label is not None else ""
            if text:
                labels.append(text)
    if labels:
        return labels
    if isinstance(ns, dict):
        parts_var = ns.get("parts")
        if isinstance(parts_var, (list, tuple)):
            for item in parts_var:
                text = str(getattr(item, "label", "") or "").strip()
                if text:
                    labels.append(text)
    return labels


def _ensure_assembly_metadata(ns: dict, result) -> None:
    labels = _collect_compound_labels(result, ns)
    if not labels:
        return
    metadata = ns.get("metadata")
    if metadata is None:
        metadata = {}
        ns["metadata"] = metadata
    if not isinstance(metadata, dict):
        return
    if not metadata.get("assembly_parts"):
        metadata["assembly_parts"] = labels


def _write_metadata(source_path: str, ns: dict):
    metadata = ns.get("metadata", None)
    if metadata is None:
        return
    try:
        payload = _json_safe(metadata)
    except Exception as exc:
        raise RuntimeError(f"Invalid metadata: {exc}")
    target_dir = os.path.dirname(source_path)
    os.makedirs(target_dir, exist_ok=True)
    metadata_path = os.path.join(target_dir, "metadata.json")
    tmp_path = metadata_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp_path, metadata_path)


def _build_namespace(model_name: str, part_name: str, source_override: str = None):
    source_path = _resolve_model_source(model_name, part_name, source_override)
    if not source_path:
        print(
            f"[export_runner] no source file found for model {model_name!r} "
            f"(looked for models/{model_name}/assembly.py, models/{model_name}/part.py, "
            f"models/{model_name}/parts/{part_name}/part.py)",
            file=sys.stderr
        )
        return None, None, 2

    model_dir = os.path.dirname(source_path)
    if model_dir not in sys.path:
        sys.path.insert(0, model_dir)

    run_name = f"__aicad_model_{model_name}__"
    try:
        with open(source_path, "r", encoding="utf-8") as f:
            source = f.read()
        code = compile(source, source_path, "exec")
        ns = {
            "__name__": run_name,
            "__file__": source_path,
            "__package__": None,
            "__cached__": None,
            "__spec__": None,
        }
        exec(code, ns, ns)
    except Exception as exc:
        print(f"[export_runner] Failed to execute {source_path}: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(traceback.format_exc(limit=12), file=sys.stderr)
        return None, None, 3
    return ns, source_path, 0


def build_one(model_name: str, part_name: str = None, export_format: str = "brep", output: str = None, source_override: str = None) -> int:
    part_name = part_name or model_name
    build_started = time.perf_counter()
    ns, source_path, err = _build_namespace(model_name, part_name, source_override)
    build_elapsed = time.perf_counter() - build_started
    if err:
        return err
    print(f"[export_runner] {model_name} build_model time: {build_elapsed:.3f}s")
    result = ns.get("result", None)
    if result is None:
        candidate = ns.get("assembly", None)
        if candidate is not None:
            result = candidate
    if result is None:
        print(f"[export_runner] {source_path} must define a global result (or assembly) object (build123d).",
              file=sys.stderr)
        return 4
    try:
        _ensure_assembly_metadata(ns, result)
        _write_metadata(source_path, ns)
    except Exception as exc:
        print(f"[export_runner] Failed to write metadata.json: {exc}", file=sys.stderr)
        return 8

    fmt = (export_format or "brep").strip().lower()
    if fmt not in ("brep", "step", "stl", "obj", "glb", "3mf"):
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
        elif fmt == "glb":
            method = _write_glb(result, out, _load_model_params(model_name))
        elif fmt == "obj":
            method = _write_obj(result, out, model_name)
        elif fmt == "3mf":
            method = _write_3mf(result, out, _load_model_params(model_name), model_name)
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
    parser.add_argument("--model", default=None, help="Model directory name")
    parser.add_argument("--part", default=None, help="Legacy alias for --model")
    parser.add_argument("--part-name", default=None, help="Part directory name inside models/<model>/parts/")
    parser.add_argument("--source", default=None, help="Optional project-relative or absolute source file path (overrides default lookup)")
    parser.add_argument("--export-format", default="brep", choices=["brep", "step", "stl", "obj", "glb", "3mf"])
    parser.add_argument("--output", default=None, help="Optional absolute path for exported file")
    args = parser.parse_args()
    global PROJECT_ROOT, MODELS_DIR, CACHE_DIR
    PROJECT_ROOT = os.path.abspath(args.project) if args.project else HERE
    MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
    CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
    model_name = args.model or args.part
    if not model_name:
        parser.error("one of --model / --part is required")
    return build_one(model_name, args.part_name or model_name, args.export_format, args.output, args.source)


if __name__ == "__main__":
    sys.exit(main())
