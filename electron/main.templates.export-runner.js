'use strict';

const EXPORT_RUNNER_PYTHON = `"""
export_runner.py - Auto-managed by AI CAD Companion Viewer (do not edit manually)
----------------------------------------------------------------------------
Responsibilities:
  * Accept --model <name> (and legacy --part <name>);
  * Optionally support on-demand exports via --export-format/--output (step/stl/brep);
  * Load models/<name>/part.py and read a geometry object named result;
  * Support both build123d and cadquery, exporting to .cache/<name>.brep via OCCT APIs;
  * Let the frontend parse BREP via occt-import-js for geometry inspection.
"""
import argparse
import os
import sys
import runpy

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = HERE
MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
MODEL_KINDS = ("part",)


def _looks_like_cadquery(obj) -> bool:
    return any(c.__module__.startswith("cadquery") for c in type(obj).__mro__)


def _looks_like_build123d(obj) -> bool:
    return any(c.__module__.startswith("build123d") for c in type(obj).__mro__)


def _write_brep(shape, path_out):
    if _looks_like_cadquery(shape):
        try:
            import cadquery as cq  # type: ignore
            cq.exporters.export(shape, path_out, exportType="BREP")
            return "cadquery.exporters.export(BREP)"
        except Exception as exc:
            try:
                inner = shape.val() if hasattr(shape, "val") else shape
                inner = getattr(inner, "wrapped", inner)
                from OCP.BRepTools import BRepTools  # type: ignore
                BRepTools.Write_s(inner, path_out)
                return "OCP.BRepTools.Write_s (cadquery fallback)"
            except Exception as exc2:
                raise RuntimeError(f"Failed to export BREP from cadquery: {exc} / {exc2}")

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
    if _looks_like_cadquery(shape):
        try:
            import cadquery as cq  # type: ignore
            cq.exporters.export(shape, path_out, exportType="STEP")
            return "cadquery.exporters.export(STEP)"
        except Exception as exc:
            raise RuntimeError(f"Failed to export STEP from cadquery: {exc}")

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
    if _looks_like_cadquery(shape):
        try:
            import cadquery as cq  # type: ignore
            cq.exporters.export(shape, path_out, exportType="STL")
            return "cadquery.exporters.export(STL)"
        except Exception:
            pass

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


def _resolve_model_source(model_name: str):
    for kind in MODEL_KINDS:
        source_path = os.path.join(MODELS_DIR, model_name, f"{kind}.py")
        if os.path.isfile(source_path):
            return source_path
    return None


def _build_namespace(model_name: str):
    source_path = _resolve_model_source(model_name)
    if not source_path:
        print(
            f"[export_runner] models/{model_name}/part.py does not exist",
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


def build_one(model_name: str, export_format: str = "brep", output: str = None) -> int:
    ns, source_path, err = _build_namespace(model_name)
    if err:
        return err
    result = ns.get("result", None)
    if result is None:
        print(f"[export_runner] {source_path} must define a global result object (build123d / cadquery).",
              file=sys.stderr)
        return 4

    fmt = (export_format or "brep").strip().lower()
    if fmt not in ("brep", "step", "stl"):
        print(f"[export_runner] Unsupported export format: {fmt}", file=sys.stderr)
        return 7

    if output:
        out = os.path.abspath(output)
        os.makedirs(os.path.dirname(out), exist_ok=True)
    else:
        os.makedirs(CACHE_DIR, exist_ok=True)
        out = os.path.join(CACHE_DIR, f"{model_name}.{fmt}")

    try:
        if fmt == "brep":
            method = _write_brep(result, out)
        elif fmt == "step":
            method = _write_step(result, out)
        else:
            method = _write_stl(result, out)
    except Exception as exc:
        print(f"[export_runner] Failed to export {fmt.upper()}: {exc}", file=sys.stderr)
        return 5

    size = os.path.getsize(out) if os.path.exists(out) else 0
    if size <= 0:
        print("[export_runner] Generated output file is empty", file=sys.stderr)
        return 6
    print(f"[export_runner] {model_name} export succeeded [{fmt.upper()}] ({method}): {out} ({size} bytes)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=None, help="Project root path (contains models/ and .cache/)")
    parser.add_argument("--model", default=None, help="Model directory name")
    parser.add_argument("--part", default=None, help="Legacy alias for --model")
    parser.add_argument("--export-format", default="brep", choices=["brep", "step", "stl"])
    parser.add_argument("--output", default=None, help="Optional absolute path for exported file")
    args = parser.parse_args()
    global PROJECT_ROOT, MODELS_DIR, CACHE_DIR
    PROJECT_ROOT = os.path.abspath(args.project) if args.project else HERE
    MODELS_DIR = os.path.join(PROJECT_ROOT, "models")
    CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
    model_name = args.model or args.part
    if not model_name:
        parser.error("one of --model / --part is required")
    return build_one(model_name, args.export_format, args.output)


if __name__ == "__main__":
    sys.exit(main())
`;

module.exports = {
  EXPORT_RUNNER_PYTHON
};
