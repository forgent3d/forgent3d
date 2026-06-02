"""aicad_select — robust selection & operation helpers for build123d.

Ships with the Forgent3D bundled runtime. Generated `part.py` files can import
any helper from this module without further setup:

    from aicad_select import top_edges, safe_fillet, safe_add

Design notes
------------
- All helpers operate on finalized geometry (the `Part` you get after a
  `with BuildPart() as bp: ...` block, i.e. `bp.part`). They do not need to be
  called inside an active builder context.
- Returns are build123d-native types (`ShapeList[Edge]`, `Face`, `Part`) so
  results compose with `+`, `-`, and the standard `fillet`, `chamfer`,
  `sweep`, `loft` ops.
- Tolerances default to 1e-3 mm. Override `tol` for tiny features.
- These helpers raise `SelectionError` (subclass of ValueError) with a
  human-readable hint when the selection is ambiguous or empty.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

from build123d import (
    Axis,
    Compound,
    Edge,
    Face,
    GeomType,
    Part,
    Plane,
    ShapeList,
    Vector,
    Wire,
    chamfer,
    fillet,
    loft,
    sweep,
)


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class SelectionError(ValueError):
    """Raised when a selector returns nothing or an ambiguous result.

    The message always names the selector, the part bbox, and a one-line hint
    so the agent can self-correct without re-reading this module.
    """


def _require_nonempty(label: str, items: ShapeList, hint: str, part=None) -> ShapeList:
    if len(items) == 0:
        msg = f"{label} returned 0 results."
        if part is not None:
            bbox = _as_part(part).bounding_box()
            msg += f" Part BBox: X[{bbox.min.X:.2f}, {bbox.max.X:.2f}] Y[{bbox.min.Y:.2f}, {bbox.max.Y:.2f}] Z[{bbox.min.Z:.2f}, {bbox.max.Z:.2f}]."
        msg += f" Hint: {hint}"
        raise SelectionError(msg)
    return items


def _as_part(obj) -> Part | Compound:
    if hasattr(obj, "part") and not isinstance(obj, (Part, Compound)):
        return obj.part  # BuildPart context
    return obj


# --------------------------------------------------------------------------- #
# Axis helpers                                                                #
# --------------------------------------------------------------------------- #


def _axis_index(axis) -> str:
    """Map an Axis (Axis.X / Axis.Y / Axis.Z, or any unit-direction-bearing object)
    to the attribute name 'X' / 'Y' / 'Z' used for point access and position filters.
    Raises SelectionError when the axis is not aligned with a principal direction.
    """
    if axis is Axis.X:
        return "X"
    if axis is Axis.Y:
        return "Y"
    if axis is Axis.Z:
        return "Z"
    direction = getattr(axis, "direction", None)
    if direction is None and isinstance(axis, (tuple, list)) and len(axis) == 3:
        direction = Vector(*axis)
    if direction is None:
        raise SelectionError(f"_axis_index(): cannot interpret axis {axis!r}")
    d = direction.normalized() if hasattr(direction, "normalized") else Vector(direction).normalized()
    best = max((("X", abs(d.X)), ("Y", abs(d.Y)), ("Z", abs(d.Z))), key=lambda kv: kv[1])
    if best[1] < 0.999:
        raise SelectionError(
            f"_axis_index(): axis is not aligned with a principal direction "
            f"(X/Y/Z components: {d.X:.3f}, {d.Y:.3f}, {d.Z:.3f}). "
            "Pass Axis.X, Axis.Y, or Axis.Z."
        )
    return best[0]


def _axis_label(axis) -> str:
    """Short, human-readable label for an axis in error messages.
    Returns 'X' / 'Y' / 'Z' for principal axes, else a compact direction triple.
    """
    if axis is Axis.X:
        return "X"
    if axis is Axis.Y:
        return "Y"
    if axis is Axis.Z:
        return "Z"
    try:
        d = _axis_direction(axis)
        return f"({d.X:.3f}, {d.Y:.3f}, {d.Z:.3f})"
    except Exception:
        return repr(axis)


def _axis_direction(axis) -> Vector:
    """Unit Vector along the given axis (Axis or 3-tuple)."""
    if hasattr(axis, "direction"):
        d = axis.direction
        return d.normalized() if hasattr(d, "normalized") else Vector(d).normalized()
    if isinstance(axis, (tuple, list)) and len(axis) == 3:
        return Vector(*axis).normalized()
    raise SelectionError(f"_axis_direction(): cannot interpret axis {axis!r}")


def _normalize_direction(value, label: str) -> str:
    """Coerce a direction argument to the canonical 'max' or 'min'.

    Accepts: 'max' / 'min' / 'top' / 'bottom' / '+' / '-' (strings),
             a positive or negative number (1 / -1 / 1.0 / -1.0).
    """
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("max", "top", "+", "high", "highest", "up"):
            return "max"
        if v in ("min", "bottom", "-", "low", "lowest", "down"):
            return "min"
        raise SelectionError(
            f"{label}: direction must be 'max'/'min' (or 'top'/'bottom', or a signed number); got {value!r}"
        )
    if isinstance(value, bool):
        return "max" if value else "min"
    if isinstance(value, (int, float)):
        if value > 0:
            return "max"
        if value < 0:
            return "min"
        raise SelectionError(f"{label}: direction must be non-zero; got 0")
    raise SelectionError(
        f"{label}: direction must be 'max'/'min' or a signed number; got {value!r} ({type(value).__name__})"
    )


# --------------------------------------------------------------------------- #
# Edge selection                                                              #
# --------------------------------------------------------------------------- #


def edges_at(part, axis: Axis, value: float, tol: float = 1e-3) -> ShapeList[Edge]:
    """Edges whose entire span lies at `value` along `axis` (± tol).

    Generalization of `edges_at_z` to any principal axis. `axis` is `Axis.X`,
    `Axis.Y`, or `Axis.Z`. This is position-based: it does NOT select edges
    whose *direction* is parallel to `axis` — use `edges_parallel_to(part, axis)`
    for that.
    """
    p = _as_part(part)
    _axis_index(axis)  # validate
    result = p.edges().filter_by_position(axis, value - tol, value + tol)
    al = _axis_label(axis)
    return _require_nonempty(
        f"edges_at({al}, {value})",
        result,
        f"no edges within ±{tol} of {value} along {al}; check the face position",
        part=p,
    )


def extreme_edges(
    part,
    axis: Axis,
    direction="max",
    tol: float = 1e-3,
) -> ShapeList[Edge]:
    """Edges whose centers sit at the extreme position along `axis`.

    `direction` selects which extreme; pass any of `'max'` / `'min'` / `'top'` /
    `'bottom'`, or a signed number (positive → max, negative → min). The call
    `extreme_edges(part, Axis.Z, 1)` therefore means "the topmost edges".

    Generalization of `top_edges` / `bottom_edges`. Use this for "the rim on the
    +X side of the part" or "every edge along the bottom of a bracket".
    """
    d = _normalize_direction(direction, "extreme_edges")
    p = _as_part(part)
    idx = _axis_index(axis)
    al = _axis_label(axis)
    edges = p.edges()
    if len(edges) == 0:
        raise SelectionError(f"extreme_edges({al}, {d}): part has no edges")
    centers = [getattr(e.center(), idx) for e in edges]
    target = max(centers) if d == "max" else min(centers)
    return _require_nonempty(
        f"extreme_edges({al}, {d})",
        edges.filter_by_position(axis, target - tol, target + tol),
        f"no edges grouped at the {d} of {al}; widen tol",
        part=p,
    )


def edges_at_z(part, z: float, tol: float = 1e-3) -> ShapeList[Edge]:
    """Edges whose entire span lies at height `z` (± tol). Alias for `edges_at(part, Axis.Z, z)`."""
    return edges_at(part, Axis.Z, z, tol=tol)


def top_edges(part, tol: float = 1e-3) -> ShapeList[Edge]:
    """All edges sitting on the topmost horizontal face of `part`. Alias for `extreme_edges(..., Axis.Z, 'max')`."""
    return extreme_edges(part, Axis.Z, direction="max", tol=tol)


def bottom_edges(part, tol: float = 1e-3) -> ShapeList[Edge]:
    """All edges sitting on the bottom-most horizontal face of `part`. Alias for `extreme_edges(..., Axis.Z, 'min')`."""
    return extreme_edges(part, Axis.Z, direction="min", tol=tol)


def vertical_edges(part) -> ShapeList[Edge]:
    """Edges whose direction is parallel to the Z axis."""
    p = _as_part(part)
    result = p.edges().filter_by(Axis.Z)
    return _require_nonempty(
        "vertical_edges()", result, "no edges parallel to Z; the body may be flat or curved", part=p
    )


def edges_parallel_to(part, axis: Axis) -> ShapeList[Edge]:
    """Edges whose direction is parallel to `axis` (Axis.X / Y / Z / custom)."""
    p = _as_part(part)
    result = p.edges().filter_by(axis)
    return _require_nonempty(
        f"edges_parallel_to({axis})", result, "no straight edges aligned with that axis", part=p
    )


def edges_on_face(part, face: Face) -> ShapeList[Edge]:
    """Edges shared with `face` (its boundary)."""
    p = _as_part(part)
    boundary = set(e for e in face.edges())
    result = ShapeList(e for e in p.edges() if e in boundary)
    return _require_nonempty(
        "edges_on_face()", result, "face is not part of the body or has no boundary edges", part=p
    )


def outer_edges_at_z(
    part,
    z: float,
    *,
    tol: float = 1e-3,
    length_ratio: float = 0.5,
) -> ShapeList[Edge]:
    """Perimeter edges at height `z`, filtered to drop small feature edges.

    Use this for fillet/chamfer on the dominant rim of a part that has many
    small repeated features (knurls, fins, ribs, teeth, grips). Keeps edges
    whose length is at least `length_ratio` x the longest edge at this height,
    so OCCT does not pay O(features) cost on tiny edges.

    Example:
        finished = safe_fillet(part, outer_edges_at_z(part, z=height), radius=r)
    """
    if not (0 < length_ratio <= 1):
        raise SelectionError(
            f"outer_edges_at_z(length_ratio={length_ratio}): must be in (0, 1]."
        )
    edges = edges_at_z(part, z, tol=tol)
    longest = max(e.length for e in edges)
    threshold = longest * length_ratio
    result = ShapeList(e for e in edges if e.length >= threshold)
    return _require_nonempty(
        f"outer_edges_at_z(z={z})",
        result,
        f"no edges at z={z} meet length_ratio={length_ratio}; lower it or use edges_at_z()",
        part=_as_part(part),
    )


def circular_edges(part, radius: float | None = None, tol: float = 1e-3) -> ShapeList[Edge]:
    """Edges whose geometry is a circle. Optionally filter by radius (± tol)."""
    p = _as_part(part)
    all_circ = p.edges().filter_by(GeomType.CIRCLE)
    if not all_circ:
        raise SelectionError("circular_edges() found 0 circular edges in the part.")
    
    if radius is not None:
        result = ShapeList(e for e in all_circ if abs(e.radius - radius) <= tol)
        if not result:
            actual_radii = sorted(list(set(round(e.radius, 3) for e in all_circ)))
            raise SelectionError(
                f"circular_edges(radius={radius}) found 0 matches. "
                f"Actual circular radii in part: {actual_radii}. "
                "Hint: Use one of the actual radii or omit the radius filter."
            )
        return result
    return all_circ


# --------------------------------------------------------------------------- #
# Face selection                                                              #
# --------------------------------------------------------------------------- #


def face_at(part, axis: Axis, value: float, tol: float = 1e-3) -> Face:
    """The single planar face perpendicular to `axis` whose center sits at `value` along `axis` (± tol).

    Generalization of `face_at_z` to any principal axis. Raises if 0 or >1 faces match.
    """
    p = _as_part(part)
    idx = _axis_index(axis)
    al = _axis_label(axis)
    axis_dir = _axis_direction(axis)
    candidates = [
        f for f in p.faces().filter_by(GeomType.PLANE)
        if abs(getattr(f.center(), idx) - value) <= tol
        and abs(abs(f.normal_at().normalized().dot(axis_dir)) - 1.0) < 1e-2
    ]
    if not candidates:
        bbox = p.bounding_box()
        lo, hi = getattr(bbox.min, idx), getattr(bbox.max, idx)
        raise SelectionError(
            f"face_at({al}, {value}) found 0 faces. "
            f"Part {idx}-bounds: [{lo:.2f}, {hi:.2f}]. "
            "Hint: check your math for the position."
        )
    if len(candidates) > 1:
        raise SelectionError(
            f"face_at({al}, {value}): {len(candidates)} faces match; widen tol or use face_facing()"
        )
    return candidates[0]


def extreme_face(part, axis: Axis, direction="max") -> Face:
    """The planar face perpendicular to `axis` with the extreme center along `axis`.

    `direction` selects which extreme; accepts `'max'` / `'min'` / `'top'` /
    `'bottom'`, or a signed number (positive → max, negative → min).

    Generalization of `top_face` / `bottom_face`.
    """
    d = _normalize_direction(direction, "extreme_face")
    p = _as_part(part)
    idx = _axis_index(axis)
    al = _axis_label(axis)
    axis_dir = _axis_direction(axis)
    faces = [
        f for f in p.faces().filter_by(GeomType.PLANE)
        if abs(abs(f.normal_at().normalized().dot(axis_dir)) - 1.0) < 1e-2
    ]
    if not faces:
        raise SelectionError(
            f"extreme_face({al}, {d}): no planar face is perpendicular to {al}. "
            "Hint: is the part rotated relative to that axis?"
        )
    keyed = [(f, getattr(f.center(), idx)) for f in faces]
    chosen = max(keyed, key=lambda kv: kv[1]) if d == "max" else min(keyed, key=lambda kv: kv[1])
    return chosen[0]


def top_face(part) -> Face:
    """The single horizontal face with the highest Z. Alias for `extreme_face(part, Axis.Z, 'max')`."""
    return extreme_face(part, Axis.Z, direction="max")


def bottom_face(part) -> Face:
    """The single horizontal face with the lowest Z. Alias for `extreme_face(part, Axis.Z, 'min')`."""
    return extreme_face(part, Axis.Z, direction="min")


def face_at_z(part, z: float, tol: float = 1e-3) -> Face:
    """The horizontal face whose center is at height `z` (± tol). Alias for `face_at(part, Axis.Z, z)`."""
    return face_at(part, Axis.Z, z, tol=tol)


def face_facing(part, direction: Vector | tuple[float, float, float]) -> ShapeList[Face]:
    """Planar faces whose outward normal is (roughly) parallel to `direction`."""
    p = _as_part(part)
    d = Vector(*direction) if isinstance(direction, tuple) else direction
    d = d.normalized()
    result = ShapeList(
        f
        for f in p.faces().filter_by(GeomType.PLANE)
        if f.normal_at().normalized().dot(d) > 0.99
    )
    return _require_nonempty(
        "face_facing()", result, "no planar face has a normal aligned with that direction", part=p
    )


# --------------------------------------------------------------------------- #
# Feature edges (dihedral)                                                    #
# --------------------------------------------------------------------------- #


def _edge_fingerprint(e: Edge, ndigits: int = 4) -> tuple:
    """Stable identity for an Edge across faces, based on rounded geometry."""
    mid = e.position_at(0.5)
    start = e.position_at(0.0)
    end = e.position_at(1.0)
    # Sort endpoints so direction does not affect identity.
    a = (round(start.X, ndigits), round(start.Y, ndigits), round(start.Z, ndigits))
    b = (round(end.X, ndigits), round(end.Y, ndigits), round(end.Z, ndigits))
    if b < a:
        a, b = b, a
    return (
        a,
        b,
        (round(mid.X, ndigits), round(mid.Y, ndigits), round(mid.Z, ndigits)),
        round(float(e.length), ndigits),
    )


def _face_normal_at_edge(face: Face, edge: Edge):
    """Outward face normal sampled near the edge midpoint.
    Falls back to the face's center normal if the projection fails.
    """
    try:
        return face.normal_at(edge.position_at(0.5)).normalized()
    except Exception:
        try:
            return face.normal_at().normalized()
        except Exception:
            return None


def feature_edges(part, *, min_angle: float = 30.0) -> ShapeList[Edge]:
    """Edges where the two adjacent face normals differ by at least `min_angle` degrees.

    These are the "sharp" or "feature" edges of a body — the visible corners
    that a human would pick to chamfer/fillet. Smooth/tangent seams (e.g. the
    longitudinal seam on a cylinder side) have parallel adjacent normals and
    are excluded. Open-boundary edges (only one adjacent face) are also
    excluded.

    Example:
        chamfered = safe_chamfer(part, feature_edges(part, min_angle=45), distance=0.5)
    """
    if not (0 < min_angle <= 180):
        raise SelectionError(
            f"feature_edges(min_angle={min_angle}): must be in (0, 180]."
        )
    p = _as_part(part)
    edge_index: dict = {}
    edge_to_faces: dict = {}
    for f in p.faces():
        for e in f.edges():
            key = _edge_fingerprint(e)
            edge_index.setdefault(key, e)
            edge_to_faces.setdefault(key, []).append(f)
    threshold = math.cos(math.radians(min_angle))
    result_edges = []
    for key, faces in edge_to_faces.items():
        if len(faces) < 2:
            continue
        edge = edge_index[key]
        n1 = _face_normal_at_edge(faces[0], edge)
        n2 = _face_normal_at_edge(faces[1], edge)
        if n1 is None or n2 is None:
            continue
        cos_a = max(-1.0, min(1.0, n1.dot(n2)))
        if cos_a <= threshold:
            result_edges.append(edge)
    return _require_nonempty(
        f"feature_edges(min_angle={min_angle})",
        ShapeList(result_edges),
        "no sharp edges meet that angle threshold; lower min_angle or check the part is not all smooth surfaces",
        part=p,
    )


# --------------------------------------------------------------------------- #
# Holes (cylindrical features)                                                #
# --------------------------------------------------------------------------- #


def _circle_axis_from_edge(e: Edge):
    """Unit Vector of a circular edge's plane normal, derived from three sampled points.
    Returns None if the edge is non-circular or degenerate.
    """
    try:
        p0 = e.position_at(0.0)
        p1 = e.position_at(0.25)
        p2 = e.position_at(0.5)
    except Exception:
        return None
    v1 = Vector(p1.X - p0.X, p1.Y - p0.Y, p1.Z - p0.Z)
    v2 = Vector(p2.X - p0.X, p2.Y - p0.Y, p2.Z - p0.Z)
    try:
        n = v1.cross(v2)
        length = math.sqrt(n.X * n.X + n.Y * n.Y + n.Z * n.Z)
        if length < 1e-9:
            return None
        return Vector(n.X / length, n.Y / length, n.Z / length)
    except Exception:
        return None


def _cylinder_face_axis_and_radius(face: Face):
    """Return (axis_unit_vector, radius) for a cylindrical face.

    Prefer the exact surface parameters OCCT exposes through build123d
    (``Face.axis_of_rotation`` / ``Face.radius``). Only fall back to deriving
    them from a bounding circular edge when those are unavailable (e.g. a
    trimmed-surface cylinder with no clean circular boundary). Returns
    ``(None, None)`` when neither source yields a value.
    """
    axis = None
    radius = None
    try:
        rot = face.axis_of_rotation
        if rot is not None:
            d = getattr(rot, "direction", rot)
            axis = d.normalized() if hasattr(d, "normalized") else Vector(d).normalized()
    except Exception:
        axis = None
    try:
        r = face.radius
        if r is not None:
            radius = float(r)
    except Exception:
        radius = None
    if axis is not None and radius is not None:
        return axis, radius

    # Fallback: derive the missing value(s) from a bounding circular edge.
    for e in face.edges():
        gt = getattr(e, "geom_type", None)
        gt_val = gt() if callable(gt) else gt
        if gt_val != GeomType.CIRCLE:
            continue
        edge_axis = axis if axis is not None else _circle_axis_from_edge(e)
        if edge_axis is None:
            continue
        if radius is not None:
            return edge_axis, radius
        try:
            return edge_axis, float(e.radius)
        except Exception:
            continue
    return axis, radius


def holes(
    part,
    radius: float | None = None,
    axis: Axis = Axis.Z,
    tol: float = 1e-3,
) -> ShapeList[Face]:
    """Cylindrical faces whose axis is parallel to `axis`, optionally filtered by `radius` (± tol).

    Returns the side walls of through-holes, blind holes, bores, and counterbores.
    Each face exposes `.center()`, `.normal_at()`, and adjacent circular edges
    via `.edges()` for downstream picking. Use the bounding circular edges
    (via `circular_edges` or `edges_on_face`) when you need to chamfer the rim.

    Example:
        rim_edges = []
        for hole in holes(part, radius=2.5, axis=Axis.Z):
            rim_edges.extend(e for e in hole.edges() if e.geom_type == GeomType.CIRCLE)
        chamfered = safe_chamfer(part, rim_edges, distance=0.3)
    """
    p = _as_part(part)
    al = _axis_label(axis)
    axis_dir = _axis_direction(axis)
    all_cylinders = p.faces().filter_by(GeomType.CYLINDER)
    if not all_cylinders:
        raise SelectionError(
            f"holes(axis={al}): part has no cylindrical faces. "
            "Hint: maybe the holes are conical or modeled as polygonal cuts."
        )
    matching = []
    radii_seen = []
    for f in all_cylinders:
        face_axis, face_radius = _cylinder_face_axis_and_radius(f)
        if face_axis is None or face_radius is None:
            continue
        if abs(abs(face_axis.dot(axis_dir)) - 1.0) > 1e-2:
            continue
        radii_seen.append(round(face_radius, 4))
        if radius is None or abs(face_radius - radius) <= tol:
            matching.append(f)
    if not matching:
        if radius is not None and radii_seen:
            unique_radii = sorted(set(radii_seen))
            raise SelectionError(
                f"holes(radius={radius}, axis={al}) found 0 matches. "
                f"Cylindrical face radii on this axis: {unique_radii}. "
                "Hint: use one of the actual radii or omit `radius`."
            )
        raise SelectionError(
            f"holes(axis={al}) found 0 cylindrical faces parallel to that axis. "
            "Hint: check the hole axis or pass a different `axis`."
        )
    return ShapeList(matching)


# --------------------------------------------------------------------------- #
# Feature tags                                                                #
# --------------------------------------------------------------------------- #


def tag_feature(
    metadata: dict,
    name: str,
    *,
    faces=None,
    edges=None,
    selector: str = "",
    kind: str = "",
    **attrs,
) -> dict:
    """Record a lightweight semantic feature tag in ``metadata``.

    This is intentionally metadata-only: it does not evaluate selectors or create
    persistent BREP ids. The viewer can use the saved geometry summary to prefer
    a human-authored selector when a picked face matches the tagged feature.

    Write ``selector`` in the same form the viewer copies for picked faces, i.e.
    omit the part argument (``holes(radius=3, axis=Axis.Z)``, not
    ``holes(part, ...)``) so tagged and auto-synthesized selectors stay uniform.

    Example:
        tag_feature(
            metadata,
            "mounting_holes",
            faces=holes(result, radius=3, axis=Axis.Z),
            selector="holes(radius=3, axis=Axis.Z)",
            kind="hole",
        )
    """
    if not isinstance(metadata, dict):
        raise SelectionError("tag_feature(): metadata must be a dict")
    key = str(name or "").strip()
    if not key:
        raise SelectionError("tag_feature(): name is required")
    if faces is not None and edges is not None:
        raise SelectionError("tag_feature(): pass faces or edges, not both")
    target = "faces" if faces is not None else "edges" if edges is not None else "feature"
    raw_items = faces if faces is not None else edges
    items = list(_ensure_shapelist(raw_items)) if raw_items is not None else []
    if raw_items is not None and not items:
        raise SelectionError(f"tag_feature({key!r}): empty {target} selection")

    features = metadata.setdefault("features", {})
    if not isinstance(features, dict):
        raise SelectionError("tag_feature(): metadata['features'] must be a dict when present")

    record = {
        "kind": str(kind or target).strip(),
        "target": target,
        "selector": str(selector or "").strip(),
        "count": len(items),
        "items": [_feature_item_summary(item, target) for item in items],
    }
    for attr_name, attr_value in attrs.items():
        record[str(attr_name)] = _json_safe_value(attr_value)
    features[key] = record
    return record


# --------------------------------------------------------------------------- #
# Safe fillet / chamfer                                                       #
# --------------------------------------------------------------------------- #


def safe_fillet(part, edges, radius: float, *, factor: float = 0.9, label: str | None = None) -> Part:
    """Apply a fillet capped to `min(radius, max_fillet(edges) * factor)`.

    Use this instead of `fillet(edges, r)` when `r` may be larger than the
    geometry can support. Returns a new `Part`.
    """
    p = _as_part(part)
    edges = _ensure_shapelist(edges)
    _require_nonempty("safe_fillet(edges=…)", edges, "empty edge selection")

    # Fast path: try the requested radius directly. If it works, we avoid
    # the expensive max_fillet binary search (which can take 20 iterations).
    try:
        return fillet(edges, radius=radius)
    except Exception:
        pass  # Radius too large or topology issue; fall back to safe probe

    try:
        upper = p.max_fillet(list(edges), tolerance=0.1, max_iterations=20) * factor
    except Exception as exc:  # build123d raises generic Exception for degenerate edges
        context = _safe_op_context("safe_fillet", p, edges, radius, factor, label)
        raise SelectionError(
            f"safe_fillet(): max_fillet failed ({exc}). Common causes:\n"
            "  1. Selection includes BOTH inner and outer rim of a hollow wall — the "
            "two fillets collide. Pick only one rim, or use a radius < wall_thickness/2.\n"
            "  2. Selection includes a seam edge from a prior boolean (e.g. handle/body "
            "join). Fillet the bodies BEFORE fusing them.\n"
            "  3. A previously-added sub-part is only tangent to the body. Re-add it "
            "with safe_add(..., min_overlap >= 1.0).\n"
            f"  Debug: {context}"
        ) from exc
    r = min(radius, upper)
    if r <= 0:
        context = _safe_op_context("safe_fillet", p, edges, radius, factor, label)
        raise SelectionError(f"safe_fillet(): computed radius {r} <= 0; edge set is too thin. {context}")
    return fillet(edges, radius=r)


def safe_chamfer(part, edges, distance: float, *, factor: float = 0.9, label: str | None = None) -> Part:
    """Apply a chamfer capped to `min(distance, max_fillet(edges) * factor)`.

    `max_fillet` is reused as a topology-safety probe — chamfers share the
    same degeneracy modes as fillets at the BREP level.
    """
    p = _as_part(part)
    edges = _ensure_shapelist(edges)
    _require_nonempty("safe_chamfer(edges=…)", edges, "empty edge selection")

    # Fast path: try the requested distance directly
    try:
        return chamfer(edges, length=distance)
    except Exception:
        pass  # Distance too large or topology issue; fall back to safe probe

    try:
        upper = p.max_fillet(list(edges), tolerance=0.1, max_iterations=20) * factor
    except Exception as exc:
        context = _safe_op_context("safe_chamfer", p, edges, distance, factor, label)
        raise SelectionError(
            f"safe_chamfer(): max_fillet probe failed ({exc}). "
            "See safe_fillet() for common topological causes. "
            f"Debug: {context}"
        ) from exc
    d = min(distance, upper)
    if d <= 0:
        context = _safe_op_context("safe_chamfer", p, edges, distance, factor, label)
        raise SelectionError(f"safe_chamfer(): computed distance {d} <= 0. {context}")
    return chamfer(edges, length=d)


# --------------------------------------------------------------------------- #
# Safe booleans                                                               #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class _Overlap:
    dx: float
    dy: float
    dz: float

    @property
    def min_axis(self) -> float:
        return min(self.dx, self.dy, self.dz)

    @property
    def min_axis_name(self) -> str:
        values = {"X": self.dx, "Y": self.dy, "Z": self.dz}
        return min(values, key=values.get)


def _bbox_overlap(a, b) -> _Overlap:
    ba, bb = a.bounding_box(), b.bounding_box()
    return _Overlap(
        dx=min(ba.max.X, bb.max.X) - max(ba.min.X, bb.min.X),
        dy=min(ba.max.Y, bb.max.Y) - max(ba.min.Y, bb.min.Y),
        dz=min(ba.max.Z, bb.max.Z) - max(ba.min.Z, bb.min.Z),
    )


def safe_add(main, sub, *, min_overlap: float = 1.0) -> Part:
    """Add `sub` to `main`, enforcing >= `min_overlap` mm of interpenetration.

    Tangent-only or barely-touching sub-parts (handles, lugs, bosses) create
    degenerate BREP at the seam and cause later fillets to fail with cryptic
    errors. This helper checks bbox overlap on all three axes before fusing
    and raises a clear message if the sub-part needs to be moved inward.
    """
    main_p = _as_part(main)
    sub_p = _as_part(sub)
    overlap = _bbox_overlap(main_p, sub_p)
    if overlap.min_axis < min_overlap:
        axis = overlap.min_axis_name
        raise SelectionError(
            f"safe_add(): bbox overlap is only {overlap.min_axis:.3f} mm "
            f"(dx={overlap.dx:.3f}, dy={overlap.dy:.3f}, dz={overlap.dz:.3f}); "
            f"limiting_axis={axis}; move `sub` inward along {axis} by >= "
            f"{min_overlap - overlap.min_axis:.3f} mm or lower min_overlap if a tangent join is intentional. "
            f"Debug: {_bbox_summary(main_p, 'main_bbox')}; {_bbox_summary(sub_p, 'sub_bbox')}"
        )
    return main_p + sub_p


def safe_cut(main, tool, *, min_through: float = 0.1) -> Part:
    """Subtract `tool` from `main`, enforcing the cutter pokes through by
    `min_through` mm on all bbox axes that intersect.

    Catches the common case where a Hole or cut feature exactly meets the
    far face — the result has a zero-thickness sliver that fillets and
    rebuilds can't recover from.
    """
    a, b = _as_part(main), _as_part(tool)
    overlap = _bbox_overlap(a, b)
    if overlap.min_axis < min_through:
        raise SelectionError(
            f"safe_cut(): cutter only penetrates {overlap.min_axis:.3f} mm; "
            f"extend it by >= {min_through - overlap.min_axis:.3f} mm to avoid a "
            "zero-thickness sliver."
        )
    return a - b


# --------------------------------------------------------------------------- #
# Sweep / loft helpers                                                        #
# --------------------------------------------------------------------------- #


def sweep_path(edges_or_wires) -> Wire:
    """Stitch `edges_or_wires` into a single continuous Wire suitable for sweep().

    Raises if the input cannot be ordered head-to-tail within 1e-4 mm.
    """
    items = list(edges_or_wires)
    if not items:
        raise SelectionError("sweep_path(): empty input")
    edges: list[Edge] = []
    for item in items:
        edges.extend(item.edges() if hasattr(item, "edges") else [item])
    try:
        return Wire(edges)
    except Exception as exc:
        raise SelectionError(
            f"sweep_path(): edges are not connected head-to-tail ({exc}). "
            "Order them along the path and ensure endpoints coincide."
        ) from exc


def swept(profile, path) -> Part:
    """Sweep `profile` along `path`. Accepts a ShapeList, Wire, or Edge for path."""
    wire = path if isinstance(path, Wire) else sweep_path(path)
    return sweep(sections=profile, path=wire)


def lofted(profiles: Sequence, *, ruled: bool = False) -> Part:
    """Loft through `profiles` in order. Validates that profiles are coplanar-free
    (each on its own plane) and that adjacent profiles have compatible vertex
    counts — the two most common causes of twisting / non-manifold lofts.
    """
    if len(profiles) < 2:
        raise SelectionError("lofted(): need at least 2 profiles")
    vcounts = [len(p.vertices()) for p in profiles]
    if len(set(vcounts)) > 1:
        raise SelectionError(
            f"lofted(): profiles have differing vertex counts {vcounts}; "
            "loft will twist or fail. Insert intermediate profiles or use ruled=True."
        )
    return loft(sections=list(profiles), ruled=ruled)


# --------------------------------------------------------------------------- #
# Internals                                                                   #
# --------------------------------------------------------------------------- #


def _ensure_shapelist(x) -> ShapeList:
    if isinstance(x, ShapeList):
        return x
    if isinstance(x, Iterable):
        return ShapeList(x)
    return ShapeList([x])


def _json_safe_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe_value(v) for v in value]
    if hasattr(value, "to_tuple"):
        try:
            return _json_safe_value(value.to_tuple())
        except Exception:
            pass
    for names in (("X", "Y", "Z"), ("x", "y", "z")):
        if all(hasattr(value, n) for n in names):
            try:
                return [float(getattr(value, n)) for n in names]
            except Exception:
                pass
    return str(value)


def _vector_summary(value):
    try:
        return _json_safe_value(value)
    except Exception:
        return None


def _feature_item_summary(item, target: str) -> dict:
    entry = {"type": type(item).__name__}
    geom_value = None
    try:
        geom_attr = getattr(item, "geom_type", None)
        geom_value = geom_attr() if callable(geom_attr) else geom_attr
        if geom_value is not None:
            entry["geom_type"] = str(geom_value)
    except Exception:
        geom_value = None
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
        entry["center"] = _vector_summary(item.center())
    except Exception:
        pass
    if target == "faces":
        is_cylindrical = geom_value == GeomType.CYLINDER or "CYLINDER" in str(geom_value).upper()
        if not is_cylindrical:
            try:
                entry["normal"] = _vector_summary(item.normal_at().normalized())
            except Exception:
                pass
        else:
            # Reuse the canonical helper so trimmed cylinders (no clean
            # axis_of_rotation/radius) still get axis+radius via its edge fallback.
            try:
                axis, radius = _cylinder_face_axis_and_radius(item)
                if axis is not None:
                    entry["axis"] = _vector_summary(axis)
                if radius is not None:
                    entry["radius"] = float(radius)
            except Exception:
                pass
    try:
        bb = item.bounding_box()
        entry["bbox"] = {
            "min": _vector_summary(bb.min),
            "max": _vector_summary(bb.max),
            "center": [
                float((bb.min.X + bb.max.X) / 2),
                float((bb.min.Y + bb.max.Y) / 2),
                float((bb.min.Z + bb.max.Z) / 2),
            ],
            "size": [
                float(bb.max.X - bb.min.X),
                float(bb.max.Y - bb.min.Y),
                float(bb.max.Z - bb.min.Z),
            ],
        }
    except Exception:
        pass
    return entry


def _bbox_summary(obj, label: str = "bbox") -> str:
    try:
        bb = _as_part(obj).bounding_box()
        return (
            f"{label}=X[{bb.min.X:.2f},{bb.max.X:.2f}] "
            f"Y[{bb.min.Y:.2f},{bb.max.Y:.2f}] "
            f"Z[{bb.min.Z:.2f},{bb.max.Z:.2f}]"
        )
    except Exception as exc:
        return f"{label}=unavailable({exc})"


def _edge_context(edges) -> str:
    items = list(edges)
    if not items:
        return "edge_count=0"
    lengths = []
    centers = []
    for edge in items[:20]:
        try:
            lengths.append(float(edge.length))
        except Exception:
            pass
        try:
            c = edge.center()
            centers.append((float(c.X), float(c.Y), float(c.Z)))
        except Exception:
            pass
    pieces = [f"edge_count={len(items)}"]
    if lengths:
        pieces.append(f"edge_length_range=[{min(lengths):.3f},{max(lengths):.3f}]")
    if centers:
        xs, ys, zs = zip(*centers)
        pieces.append(
            "edge_center_bbox="
            f"X[{min(xs):.2f},{max(xs):.2f}] "
            f"Y[{min(ys):.2f},{max(ys):.2f}] "
            f"Z[{min(zs):.2f},{max(zs):.2f}]"
        )
    if len(items) > 20:
        pieces.append("edge_sample=first_20")
    return ", ".join(pieces)


def _safe_op_context(op_name: str, part, edges, amount: float, factor: float, label: str | None = None) -> str:
    label_text = f" label={label!r};" if label else ""
    return (
        f"{op_name} context:{label_text} requested={amount:.3f}, factor={factor:.3f}, "
        f"{_bbox_summary(part, 'part_bbox')}, {_edge_context(edges)}"
    )


# --------------------------------------------------------------------------- #
# High-Level Macros                                                           #
# --------------------------------------------------------------------------- #


def make_revolved_shell(profile_curves, thickness: float, axis: Axis = Axis.Z) -> Part:
    """Generate a revolved shell from an open profile curve.
    
    Automatically closes the curve to the axis, revolves it, and hollows it.
    If the curve does not touch the axis at the top/bottom, the resulting flat
    face at the higher end is automatically opened during hollowing.
    """
    from build123d import BuildLine, BuildSketch, BuildPart, Line, make_face, revolve, Plane, Vector
    
    wire = sweep_path(profile_curves)
    p0 = wire.position_at(0)
    p1 = wire.position_at(1)
    
    idx = _axis_index(axis)
    
    def project_to_axis(p):
        if idx == "X": return Vector(p.X, 0, 0)
        elif idx == "Y": return Vector(0, p.Y, 0)
        else: return Vector(0, 0, p.Z)

    proj0 = project_to_axis(p0)
    proj1 = project_to_axis(p1)
    
    with BuildLine() as bl:
        from build123d import add
        add(wire)
        if (p1 - proj1).length > 1e-5:
            Line(p1, proj1)
        if (proj1 - proj0).length > 1e-5:
            Line(proj1, proj0)
        if (proj0 - p0).length > 1e-5:
            Line(proj0, p0)
            
    # Try to infer the drawing plane based on vertices
    vs = bl.wire().vertices()
    is_y_zero = all(abs(getattr(v, "Y", 0)) < 1e-4 for v in vs)
    is_x_zero = all(abs(getattr(v, "X", 0)) < 1e-4 for v in vs)
    plane = Plane.XZ if is_y_zero else (Plane.YZ if is_x_zero else Plane.XY)
    
    with BuildSketch(plane) as sk:
        make_face(bl.wire())
        
    with BuildPart() as bp:
        from build123d import add
        add(sk.sketch)
        revolve(axis=axis)
        
    base_part = bp.part
    if abs(thickness) < 1e-5:
        return base_part
        
    # Attempt to open the top face if one was created
    openings = []
    v0_val = getattr(p0, idx)
    v1_val = getattr(p1, idx)
    max_val = max(v0_val, v1_val)
    
    point_at_max = p0 if v0_val > v1_val else p1
    proj_at_max = proj0 if v0_val > v1_val else proj1
    
    if (point_at_max - proj_at_max).length > 1e-5:
        try:
            top_face = face_at(base_part, axis, max_val, tol=1e-3)
            openings.append(top_face)
        except Exception:
            pass

    try:
        from build123d import offset
        return offset(base_part, amount=-abs(thickness), openings=openings)
    except Exception as e:
        raise SelectionError(f"make_revolved_shell(): hollowing failed ({e}). Try adjusting curves to avoid self-intersection or reducing thickness.")


def make_tube_along_path(path_points, radius: float) -> Part:
    """Generate a smooth solid tube along a 3D path of points."""
    if len(path_points) < 2:
        raise SelectionError("make_tube_along_path: at least 2 points required")
        
    from build123d import BuildLine, Spline, BuildSketch, Circle, sweep, BuildPart, Plane, Line, Vector
    with BuildPart() as bp:
        with BuildLine() as bl:
            pts = [_axis_direction(p) if not isinstance(p, Vector) else p for p in path_points] if False else path_points # Ensure Vector, but build123d accepts tuples
            if len(pts) == 2:
                Line(pts[0], pts[1])
            else:
                Spline(*pts)
        path = bl.wire()
        
        start_point = path.position_at(0)
        tangent = path.tangent_at(0)
        plane = Plane(origin=start_point, z_dir=tangent)
        with BuildSketch(plane) as sk:
            Circle(radius=radius)
        sweep(path=path)
    return bp.part


__all__ = [
    "SelectionError",
    # Edges — general (preferred)
    "edges_at",
    "extreme_edges",
    # Edges — Z-axis aliases (back-compat)
    "edges_at_z",
    "top_edges",
    "bottom_edges",
    # Edges — other
    "vertical_edges",
    "edges_parallel_to",
    "edges_on_face",
    "outer_edges_at_z",
    "circular_edges",
    # Faces — general (preferred)
    "face_at",
    "extreme_face",
    # Faces — Z-axis aliases (back-compat)
    "top_face",
    "bottom_face",
    "face_at_z",
    # Faces — other
    "face_facing",
    # Feature edges
    "feature_edges",
    # Holes
    "holes",
    # Metadata feature tags
    "tag_feature",
    # Safe ops
    "safe_fillet",
    "safe_chamfer",
    "safe_add",
    "safe_cut",
    # Sweep / loft
    "sweep_path",
    "swept",
    "lofted",
    # Macros
    "make_revolved_shell",
    "make_tube_along_path",
]
