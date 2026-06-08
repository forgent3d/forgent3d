"""
print_check.py - Auto-managed by AI CAD Companion Viewer (do not edit manually)
----------------------------------------------------------------------------
Kernel-accurate 3D-printability analysis. Runs against the *built* build123d /
OCP solid (the same kernel that produced the model), never a tessellated
approximation handed to the frontend. Reuses export_runner's namespace build so
the warm rebuild daemon can serve it without a second OCP import.

The returned dict is the single source of truth consumed by:
  * cf-sandbox  -> agent tool `print_check`
  * the agent   -> reads `issues[].code` and fixes the parametric source
  * the cloud UI-> renders `verdict` / metrics / `issues`

Geometry math (all on the real BREP, not the mesh):
  * volume / surface area : GProp_GProps
  * solid validity        : BRepCheck_Analyzer
  * wall thickness        : inward ray casting via IntCurvesFace_ShapeIntersector
  * overhang              : per-facet outward normal vs build axis (+Z)
  * small features        : edge length / face area below the printable minimum
Tessellation is used ONLY to seed ray origins (centroids) and facet normals;
the thickness/clearance measurement itself intersects the analytic surfaces.
"""
import math
import os
import sys

# Defaults mirror a 0.4mm-nozzle FDM machine; the caller (printer profile) overrides them.
DEFAULT_PROFILE = {
    "buildVolumeMm": {"x": 256.0, "y": 256.0, "z": 256.0},
    "marginMm": 2.0,
    "nozzleMm": 0.4,
    "layerHeightMm": 0.2,
    # Min printable wall ~ 2 perimeters; below this the wall is unreliable, below 1 perimeter it fails.
    "minWallMm": 0.8,
    "minFeatureMm": 0.4,
    # Surfaces whose angle from the build plate is below this need support (deg from horizontal,
    # measured so a flat downward face = 0deg = worst, a vertical wall = 90deg = fine).
    "supportFreeAngleDeg": 45.0,
    "material": {"name": "PLA", "densityGCm3": 1.24},
    # Rough volumetric throughput for the print-time estimate (mm^3/s).
    "volumetricRateMm3S": 11.0,
}

# Penalties feeding the 0-100 score. Errors block printability; warnings only dock score.
_SEVERITY_PENALTY = {"error": 35, "warning": 12, "info": 0}


def _profile(printer):
    p = dict(DEFAULT_PROFILE)
    if isinstance(printer, dict):
        for k, v in printer.items():
            if k == "material" and isinstance(v, dict):
                mat = dict(DEFAULT_PROFILE["material"])
                mat.update({mk: mv for mk, mv in v.items() if mv is not None})
                p["material"] = mat
            elif k == "buildVolumeMm" and isinstance(v, dict):
                vol = dict(DEFAULT_PROFILE["buildVolumeMm"])
                vol.update({ak: float(av) for ak, av in v.items() if _is_num(av)})
                p["buildVolumeMm"] = vol
            elif v is not None:
                p[k] = v
    return p


def _is_num(v):
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _round(v, n=3):
    try:
        f = float(v)
        return round(f, n) if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _wrapped(shape):
    return getattr(shape, "wrapped", shape)


# --------------------------------------------------------------------------- #
# Bounding box / fit
# --------------------------------------------------------------------------- #
def _bbox(shape):
    if shape is None or not hasattr(shape, "bounding_box"):
        return None
    try:
        bb = shape.bounding_box()
        return {
            "min": [float(bb.min.X), float(bb.min.Y), float(bb.min.Z)],
            "max": [float(bb.max.X), float(bb.max.Y), float(bb.max.Z)],
            "size": [
                float(bb.max.X - bb.min.X),
                float(bb.max.Y - bb.min.Y),
                float(bb.max.Z - bb.min.Z),
            ],
        }
    except Exception:
        return None


def _fit(bbox, profile):
    if not bbox:
        return None
    vol = profile["buildVolumeMm"]
    margin = max(0.0, float(profile.get("marginMm") or 0.0))
    limits = [float(vol["x"]), float(vol["y"]), float(vol["z"])]
    usable = [max(0.0, lim - 2 * margin) for lim in limits]
    size = bbox["size"]
    axes = {}
    fits = True
    for i, name in enumerate(("x", "y", "z")):
        over = size[i] - usable[i]
        axis_fits = over <= 1e-6
        fits = fits and axis_fits
        axes[name] = {
            "modelMm": _round(size[i]),
            "usableMm": _round(usable[i]),
            "limitMm": _round(limits[i]),
            "overMm": _round(max(0.0, over)),
            "fits": axis_fits,
        }
    # Any axis-permutation that fits (largest model dim into largest usable dim, etc.).
    rotated = sorted(size, reverse=True)
    cap = sorted(usable, reverse=True)
    rotated_fits = all(rotated[i] <= cap[i] + 1e-6 for i in range(3))
    return {"fits": fits, "axes": axes, "rotatedFits": rotated_fits, "marginMm": margin}


# --------------------------------------------------------------------------- #
# Mass properties
# --------------------------------------------------------------------------- #
def _mass_props(shape):
    try:
        from OCP.GProp import GProp_GProps  # type: ignore
        from OCP.BRepGProp import BRepGProp  # type: ignore
    except Exception:
        return None
    inner = _wrapped(shape)
    out = {}
    try:
        vp = GProp_GProps()
        BRepGProp.VolumeProperties_s(inner, vp)
        out["volumeMm3"] = abs(float(vp.Mass()))
        com = vp.CentreOfMass()
        out["centerOfMass"] = [float(com.X()), float(com.Y()), float(com.Z())]
    except Exception:
        out["volumeMm3"] = None
        out["centerOfMass"] = None
    try:
        sp = GProp_GProps()
        BRepGProp.SurfaceProperties_s(inner, sp)
        out["surfaceAreaMm2"] = abs(float(sp.Mass()))
    except Exception:
        out["surfaceAreaMm2"] = None
    return out


# --------------------------------------------------------------------------- #
# Solid validity / watertightness
# --------------------------------------------------------------------------- #
def _count_subshapes(inner, enum):
    from OCP.TopExp import TopExp_Explorer  # type: ignore
    n = 0
    exp = TopExp_Explorer(inner, enum)
    while exp.More():
        n += 1
        exp.Next()
    return n


def _validity(shape):
    inner = _wrapped(shape)
    out = {"isValid": None, "isClosed": None, "solidCount": None, "shellCount": None}
    try:
        from OCP.TopAbs import TopAbs_ShapeEnum  # type: ignore
        out["solidCount"] = _count_subshapes(inner, TopAbs_ShapeEnum.TopAbs_SOLID)
        out["shellCount"] = _count_subshapes(inner, TopAbs_ShapeEnum.TopAbs_SHELL)
    except Exception:
        pass
    try:
        from OCP.BRepCheck import BRepCheck_Analyzer  # type: ignore
        out["isValid"] = bool(BRepCheck_Analyzer(inner).IsValid())
    except Exception:
        pass
    # Watertight ~ every shell is closed. A printable part must be a closed solid.
    try:
        from OCP.TopAbs import TopAbs_ShapeEnum  # type: ignore
        from OCP.TopExp import TopExp_Explorer  # type: ignore
        from OCP.BRep import BRep_Tool  # type: ignore
        from OCP.TopoDS import TopoDS  # type: ignore
        closed = True
        any_shell = False
        exp = TopExp_Explorer(inner, TopAbs_ShapeEnum.TopAbs_SHELL)
        while exp.More():
            any_shell = True
            shell = TopoDS.Shell_s(exp.Current())
            if not BRep_Tool.IsClosed_s(shell):
                closed = False
                break
            exp.Next()
        out["isClosed"] = bool(closed) if any_shell else False
    except Exception:
        pass
    return out


# --------------------------------------------------------------------------- #
# Tessellation -> facet centroids + outward normals (ray-origin seeds only)
# --------------------------------------------------------------------------- #
def _facets(shape, deflection):
    """Yield (centroid(gp_Pnt-like tuple), outward_unit_normal tuple, area) per triangle."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh  # type: ignore
    from OCP.TopAbs import TopAbs_ShapeEnum, TopAbs_Orientation  # type: ignore
    from OCP.TopExp import TopExp_Explorer  # type: ignore
    from OCP.BRep import BRep_Tool  # type: ignore
    from OCP.TopoDS import TopoDS  # type: ignore
    from OCP.TopLoc import TopLoc_Location  # type: ignore

    inner = _wrapped(shape)
    BRepMesh_IncrementalMesh(inner, deflection, False, 0.5, True)

    facets = []
    exp = TopExp_Explorer(inner, TopAbs_ShapeEnum.TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        reversed_face = face.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            nb = tri.NbTriangles()
            for i in range(1, nb + 1):
                t = tri.Triangle(i)
                i1, i2, i3 = t.Get()
                p1 = tri.Node(i1).Transformed(trsf)
                p2 = tri.Node(i2).Transformed(trsf)
                p3 = tri.Node(i3).Transformed(trsf)
                ax, ay, az = p1.X(), p1.Y(), p1.Z()
                bx, by, bz = p2.X(), p2.Y(), p2.Z()
                cx, cy, cz = p3.X(), p3.Y(), p3.Z()
                ux, uy, uz = bx - ax, by - ay, bz - az
                vx, vy, vz = cx - ax, cy - ay, cz - az
                nx = uy * vz - uz * vy
                ny = uz * vx - ux * vz
                nz = ux * vy - uy * vx
                mag = math.sqrt(nx * nx + ny * ny + nz * nz)
                if mag <= 1e-12:
                    continue
                area = 0.5 * mag
                nx, ny, nz = nx / mag, ny / mag, nz / mag
                if reversed_face:
                    nx, ny, nz = -nx, -ny, -nz
                centroid = ((ax + bx + cx) / 3.0, (ay + by + cy) / 3.0, (az + bz + cz) / 3.0)
                facets.append((centroid, (nx, ny, nz), area))
        exp.Next()
    return facets


# --------------------------------------------------------------------------- #
# Wall thickness via inward ray casting against the analytic BREP
# --------------------------------------------------------------------------- #
def _wall_thickness(shape, facets, profile, diag):
    min_wall = float(profile.get("minWallMm") or DEFAULT_PROFILE["minWallMm"])
    try:
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector  # type: ignore
        from OCP.gp import gp_Pnt, gp_Dir, gp_Lin  # type: ignore
        from OCP.Precision import Precision  # type: ignore
    except Exception:
        return {"minMm": None, "thresholdMm": _round(min_wall), "thinSpots": [], "available": False}

    inner = _wrapped(shape)
    inter = IntCurvesFace_ShapeIntersector()
    inter.Load(inner, Precision.Confusion_s())

    # Nudge the ray origin just inside the surface so it does not register the originating face.
    eps = max(1e-4, diag * 1e-5)
    far = diag * 2.0 + 1.0
    thin_threshold = min_wall * 1.5  # collect spots approaching the limit, not only failures

    overall_min = None
    spots = []
    for centroid, normal, _area in facets:
        # Origin nudged just inside the surface; ray travels inward, so the first hit is the
        # opposite wall and its distance (minus the nudge) is the local wall thickness.
        ox = centroid[0] - normal[0] * eps
        oy = centroid[1] - normal[1] * eps
        oz = centroid[2] - normal[2] * eps
        best = None
        try:
            line = gp_Lin(gp_Pnt(ox, oy, oz), gp_Dir(-normal[0], -normal[1], -normal[2]))
            inter.Perform(line, 0.0, far)
            nb = inter.NbPnt()
            for i in range(1, nb + 1):
                w = inter.WParameter(i)
                if w > eps * 2 and (best is None or w < best):
                    best = w
        except Exception:
            continue
        if best is None:
            continue
        thickness = best + eps  # add back the nudge
        if overall_min is None or thickness < overall_min:
            overall_min = thickness
        if thickness < thin_threshold:
            spots.append({"point": [_round(centroid[0]), _round(centroid[1]), _round(centroid[2])],
                          "thicknessMm": _round(thickness)})

    spots.sort(key=lambda s: (s["thicknessMm"] if s["thicknessMm"] is not None else 1e9))
    return {
        "minMm": _round(overall_min),
        "thresholdMm": _round(min_wall),
        "thinSpots": spots[:24],
        "available": overall_min is not None,
    }


# --------------------------------------------------------------------------- #
# Overhang detection from facet normals vs build axis (+Z)
# --------------------------------------------------------------------------- #
def _overhang(facets, profile, bbox):
    support_free = float(profile.get("supportFreeAngleDeg") or DEFAULT_PROFILE["supportFreeAngleDeg"])
    # surfaceAngle = angle of the (downward) face from the horizontal bed:
    #   flat-down face = 0deg (worst), vertical wall = 90deg (fine).
    # A face needs support when surfaceAngle < (90 - support_free), i.e. it overhangs
    # by more than `support_free` degrees from vertical.
    flag_below = max(0.0, 90.0 - support_free)
    z_min = bbox["min"][2] if bbox else None
    bed_eps = 1e-3
    total_area = 0.0
    overhang_area = 0.0
    spots = []
    for centroid, normal, area in facets:
        total_area += area
        nz = normal[2]
        if nz >= 0:
            continue  # upward / side faces never need support
        surface_angle = math.degrees(math.acos(max(0.0, min(1.0, -nz))))
        if surface_angle >= flag_below:
            continue
        # A near-flat face resting on the build plate does not need support.
        if z_min is not None and abs(centroid[2] - z_min) <= bed_eps and surface_angle < 1.0:
            continue
        overhang_area += area
        spots.append({"point": [_round(centroid[0]), _round(centroid[1]), _round(centroid[2])],
                      "angleDeg": _round(surface_angle, 1)})
    spots.sort(key=lambda s: (s["angleDeg"] if s["angleDeg"] is not None else 1e9))
    ratio = (overhang_area / total_area) if total_area > 1e-9 else 0.0
    return {
        "thresholdDeg": _round(support_free, 1),
        "buildAxis": "z",
        "areaMm2": _round(overhang_area),
        "areaRatio": _round(ratio, 4),
        "spots": spots[:24],
    }


# --------------------------------------------------------------------------- #
# Small features (edges / faces below the printable minimum)
# --------------------------------------------------------------------------- #
def _small_features(shape, profile):
    min_feature = float(profile.get("minFeatureMm") or DEFAULT_PROFILE["minFeatureMm"])
    out = {"minFeatureMm": _round(min_feature), "shortEdges": 0, "tinyFaces": 0, "items": []}
    try:
        from OCP.TopAbs import TopAbs_ShapeEnum  # type: ignore
        from OCP.TopExp import TopExp_Explorer  # type: ignore
        from OCP.TopoDS import TopoDS  # type: ignore
        from OCP.GProp import GProp_GProps  # type: ignore
        from OCP.BRepGProp import BRepGProp  # type: ignore
    except Exception:
        return out
    inner = _wrapped(shape)
    area_threshold = min_feature * min_feature
    try:
        exp = TopExp_Explorer(inner, TopAbs_ShapeEnum.TopAbs_EDGE)
        while exp.More():
            edge = TopoDS.Edge_s(exp.Current())
            lp = GProp_GProps()
            BRepGProp.LinearProperties_s(edge, lp)
            length = abs(float(lp.Mass()))
            if 0 < length < min_feature:
                out["shortEdges"] += 1
                if len(out["items"]) < 16:
                    com = lp.CentreOfMass()
                    out["items"].append({"kind": "edge", "valueMm": _round(length),
                                         "point": [_round(com.X()), _round(com.Y()), _round(com.Z())]})
            exp.Next()
    except Exception:
        pass
    try:
        exp = TopExp_Explorer(inner, TopAbs_ShapeEnum.TopAbs_FACE)
        while exp.More():
            face = TopoDS.Face_s(exp.Current())
            sp = GProp_GProps()
            BRepGProp.SurfaceProperties_s(face, sp)
            area = abs(float(sp.Mass()))
            if 0 < area < area_threshold:
                out["tinyFaces"] += 1
                if len(out["items"]) < 24:
                    com = sp.CentreOfMass()
                    out["items"].append({"kind": "face", "valueMm2": _round(area),
                                         "point": [_round(com.X()), _round(com.Y()), _round(com.Z())]})
            exp.Next()
    except Exception:
        pass
    return out


# --------------------------------------------------------------------------- #
# Estimate (rough, honest) + verdict
# --------------------------------------------------------------------------- #
def _estimate(mass_props, profile):
    vol = (mass_props or {}).get("volumeMm3")
    material = profile.get("material") or {}
    density = float(material.get("densityGCm3") or DEFAULT_PROFILE["material"]["densityGCm3"])
    rate = float(profile.get("volumetricRateMm3S") or DEFAULT_PROFILE["volumetricRateMm3S"])
    out = {"approximate": True, "filamentGrams": None, "printMinutes": None,
           "material": material.get("name"), "densityGCm3": density}
    if _is_num(vol) and vol > 0:
        # Solid-volume upper bound; real prints use infill < 100%, so this over-estimates.
        out["filamentGrams"] = _round(vol / 1000.0 * density, 1)
        out["printMinutes"] = _round(vol / rate / 60.0, 1) if rate > 0 else None
    return out


def _verdict(issues):
    penalty = sum(_SEVERITY_PENALTY.get(i.get("severity"), 0) for i in issues)
    printable = all(i.get("severity") != "error" for i in issues)
    return {"printable": printable, "score": max(0, min(100, 100 - penalty))}


def _issues(fit, validity, wall, overhang, small, profile):
    """Machine-actionable issue list the agent maps to build123d fixes."""
    out = []
    # Fit
    if fit and not fit["fits"]:
        for axis, info in fit["axes"].items():
            if not info["fits"]:
                out.append({
                    "code": "DOES_NOT_FIT", "severity": "error", "axis": axis,
                    "overMm": info["overMm"], "modelMm": info["modelMm"], "usableMm": info["usableMm"],
                    "rotatable": bool(fit.get("rotatedFits")),
                    "message": f"{axis.upper()} exceeds the usable build volume by {info['overMm']} mm.",
                })
    # Solid integrity
    if validity:
        if validity.get("isValid") is False:
            out.append({"code": "NOT_SOLID", "severity": "error",
                        "message": "BREP is not a valid solid (BRepCheck failed); printing needs a clean closed solid."})
        elif validity.get("isClosed") is False:
            out.append({"code": "NOT_WATERTIGHT", "severity": "error",
                        "message": "Model is not a closed watertight solid; a slicer cannot fill it reliably."})
    # Walls
    if wall and wall.get("available") and _is_num(wall.get("minMm")):
        min_mm = float(wall["minMm"])
        thr = float(wall["thresholdMm"])
        if min_mm < thr:
            sev = "error" if min_mm < thr * 0.6 else "warning"
            spot = wall["thinSpots"][0]["point"] if wall.get("thinSpots") else None
            out.append({"code": "THIN_WALL", "severity": sev, "valueMm": wall["minMm"],
                        "thresholdMm": wall["thresholdMm"], "point": spot,
                        "message": f"Thinnest wall is {wall['minMm']} mm (min printable {wall['thresholdMm']} mm)."})
    # Overhangs
    if overhang and _is_num(overhang.get("areaRatio")) and overhang["areaRatio"] > 0.01:
        sev = "warning"
        out.append({"code": "OVERHANG", "severity": sev, "thresholdDeg": overhang["thresholdDeg"],
                    "areaMm2": overhang["areaMm2"], "areaRatio": overhang["areaRatio"],
                    "point": overhang["spots"][0]["point"] if overhang.get("spots") else None,
                    "message": f"{overhang['areaMm2']} mm^2 of down-facing surface exceeds the {overhang['thresholdDeg']} deg overhang limit and needs support."})
    # Small features
    if small and (small.get("shortEdges") or small.get("tinyFaces")):
        out.append({"code": "SMALL_FEATURE", "severity": "warning",
                    "minFeatureMm": small["minFeatureMm"],
                    "shortEdges": small["shortEdges"], "tinyFaces": small["tinyFaces"],
                    "point": small["items"][0]["point"] if small.get("items") else None,
                    "message": f"{small['shortEdges']} edge(s) and {small['tinyFaces']} face(s) are below the {small['minFeatureMm']} mm printable minimum."})
    if not out:
        out.append({"code": "PRINT_OK", "severity": "info",
                    "message": "No printability issues found for the selected printer."})
    return out


def _analyze_solid(shape, profile, options):
    """Per-solid metrics. For an assembly this runs on ONE isolated part so the ray-cast
    wall thickness never crosses into a neighbouring/mating part."""
    bbox = _bbox(shape)
    diag = 1.0
    if bbox:
        s = bbox["size"]
        diag = max(1.0, math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]))

    fit = _fit(bbox, profile)
    validity = _validity(shape)
    mass_props = _mass_props(shape)

    # One tessellation drives both wall + overhang. Fine enough to seed rays without being slow.
    deflection = max(0.05, min(0.5, diag * float(options.get("deflectionRatio") or 0.002)))
    facets = []
    facet_error = None
    try:
        facets = _facets(shape, deflection)
    except Exception as exc:
        facet_error = f"{type(exc).__name__}: {exc}"

    wall = _wall_thickness(shape, facets, profile, diag) if facets else {
        "minMm": None, "thresholdMm": _round(profile["minWallMm"]), "thinSpots": [], "available": False}
    overhang = _overhang(facets, profile, bbox) if facets else {
        "thresholdDeg": _round(profile["supportFreeAngleDeg"], 1), "buildAxis": "z",
        "areaMm2": None, "areaRatio": None, "spots": []}
    small = _small_features(shape, profile)

    fill_ratio = None
    if mass_props and _is_num(mass_props.get("volumeMm3")) and bbox:
        s = bbox["size"]
        box_vol = s[0] * s[1] * s[2]
        if box_vol > 1e-9:
            fill_ratio = _round(mass_props["volumeMm3"] / box_vol, 4)

    issues = _issues(fit, validity, wall, overhang, small, profile)
    metrics = {
        "bbox": bbox,
        "fit": fit,
        "solid": validity,
        "volume": {
            "mm3": _round((mass_props or {}).get("volumeMm3")),
            "surfaceAreaMm2": _round((mass_props or {}).get("surfaceAreaMm2")),
            "fillRatio": fill_ratio,
            "centerOfMass": (mass_props or {}).get("centerOfMass"),
        },
        "wall": wall,
        "overhang": overhang,
        "smallFeatures": small,
        "estimate": _estimate(mass_props, profile),
        "issues": issues,
        "verdict": _verdict(issues),
    }
    if facet_error:
        metrics["facetError"] = facet_error
    return metrics


def _decompose_parts(result):
    """Return [(label, shape)] for an assembly's printable parts, or [] for a single part.
    An assembly prints per-part (each oriented/laid out separately), so we analyze each child
    in isolation rather than the assembled blob."""
    children = getattr(result, "children", None)
    parts = []
    if children:
        try:
            child_list = list(children)
        except TypeError:
            child_list = []
        for i, child in enumerate(child_list):
            label = str(getattr(child, "label", "") or "").strip() or f"part_{i + 1}"
            parts.append((label, child))
    # Treat as an assembly only when there is genuinely more than one part to print.
    return parts if len(parts) >= 2 else []


def _printer_echo(profile):
    return {
        "buildVolumeMm": profile["buildVolumeMm"],
        "marginMm": _round(profile.get("marginMm")),
        "nozzleMm": _round(profile.get("nozzleMm")),
        "minWallMm": _round(profile.get("minWallMm")),
        "minFeatureMm": _round(profile.get("minFeatureMm")),
        "supportFreeAngleDeg": _round(profile.get("supportFreeAngleDeg"), 1),
        "material": profile.get("material"),
    }


def analyze(result, printer=None, options=None):
    """Analyze a built build123d/OCP shape. Returns the print_check contract dict.
    Single part -> flat report. Assembly -> { isAssembly, parts[], aggregate }."""
    profile = _profile(printer)
    options = options if isinstance(options, dict) else {}
    parts = _decompose_parts(result)

    if not parts:
        payload = {"ok": True, "script": "print_check", "isAssembly": False,
                   "printer": _printer_echo(profile)}
        payload.update(_analyze_solid(result, profile, options))
        return payload

    # Assembly: analyze each part in isolation, then roll up.
    part_reports = []
    total_volume = 0.0
    total_grams = 0.0
    all_fit = True
    all_printable = True
    min_score = 100
    issues = []
    for label, shape in parts:
        metrics = _analyze_solid(shape, profile, options)
        part_reports.append({"label": label, **metrics})

        vol = (metrics.get("volume") or {}).get("mm3")
        if _is_num(vol):
            total_volume += float(vol)
        grams = (metrics.get("estimate") or {}).get("filamentGrams")
        if _is_num(grams):
            total_grams += float(grams)
        if metrics.get("fit") and not metrics["fit"].get("fits"):
            all_fit = False
        verdict = metrics.get("verdict") or {}
        if not verdict.get("printable"):
            all_printable = False
        min_score = min(min_score, int(verdict.get("score") or 0))
        # Roll part issues up to the assembly level, labeled so the agent knows which part to fix.
        for issue in metrics.get("issues") or []:
            if issue.get("code") == "PRINT_OK":
                continue
            rolled = dict(issue)
            rolled["part"] = label
            rolled["message"] = f"[{label}] {issue.get('message', '')}"
            issues.append(rolled)
    if not issues:
        issues.append({"code": "PRINT_OK", "severity": "info",
                       "message": "No printability issues found for any part."})

    return {
        "ok": True,
        "script": "print_check",
        "isAssembly": True,
        "printer": _printer_echo(profile),
        "parts": part_reports,
        "aggregate": {
            "partCount": len(part_reports),
            "allFit": all_fit,
            "totalVolumeMm3": _round(total_volume),
            "totalFilamentGrams": _round(total_grams, 1),
        },
        "issues": issues,
        "verdict": {"printable": all_printable, "score": min_score},
    }


# --------------------------------------------------------------------------- #
# CLI fallback (cold path; mirrors export_runner's argument handling)
# --------------------------------------------------------------------------- #
def run_for_source(project, model, part=None, source=None, printer=None, options=None):
    """Build the model namespace via export_runner, then analyze its `result`."""
    import export_runner as er  # reuse the exact build/metadata logic

    project = os.path.abspath(project or os.getcwd())
    er.PROJECT_ROOT = project
    er.MODELS_DIR = os.path.join(project, "models")
    er.CACHE_DIR = os.path.join(project, ".cache")
    part = part or model
    ns, source_path, err = er._build_namespace(model, part, source)
    if err or ns is None:
        return {"ok": False, "script": "print_check", "model": model, "part": part,
                "error": f"build failed (export_runner code {err})"}
    result = ns.get("result", None)
    if result is None:
        result = ns.get("assembly", None)
    if result is None:
        return {"ok": False, "script": "print_check", "model": model, "part": part,
                "hasResult": False, "error": "part.py must define a global result before print_check."}
    payload = analyze(result, printer, options)
    payload["model"] = model
    payload["part"] = part
    payload["source"] = os.path.relpath(source_path, project).replace(os.sep, "/") if source_path else None
    return payload


def main(argv):
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--part", default=None)
    parser.add_argument("--part-name", default=None)
    parser.add_argument("--source", default=None)
    parser.add_argument("--printer", default=None, help="JSON printer profile")
    parser.add_argument("--options", default=None, help="JSON options")
    args = parser.parse_args(argv)
    model = args.model or args.part
    if not model:
        parser.error("--model is required")
    printer = json.loads(args.printer) if args.printer else None
    options = json.loads(args.options) if args.options else None
    payload = run_for_source(args.project, model, args.part_name or model, args.source, printer, options)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
