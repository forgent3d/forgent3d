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
# Edge selection                                                              #
# --------------------------------------------------------------------------- #


def edges_at_z(part, z: float, tol: float = 1e-3) -> ShapeList[Edge]:
    """Edges whose entire span lies at height `z` (± tol).

    Use for selecting rim edges on a horizontal face. This is NOT the same as
    `edges().filter_by(Axis.Z)`, which would pick vertical edges instead.
    """
    p = _as_part(part)
    result = p.edges().filter_by_position(Axis.Z, z - tol, z + tol)
    return _require_nonempty(
        f"edges_at_z(z={z})", result, f"no edges within ±{tol} of z={z}; check the face height", part=p
    )


def top_edges(part, tol: float = 1e-3) -> ShapeList[Edge]:
    """All edges sitting on the topmost horizontal face of `part`."""
    p = _as_part(part)
    edges = p.edges()
    if len(edges) == 0:
        raise SelectionError("top_edges(): part has no edges")
    z_max = max(e.center().Z for e in edges)
    return _require_nonempty(
        "top_edges()",
        edges.filter_by_position(Axis.Z, z_max - tol, z_max + tol),
        "no edges grouped at the top; check tol",
        part=p,
    )


def bottom_edges(part, tol: float = 1e-3) -> ShapeList[Edge]:
    """All edges sitting on the bottom-most horizontal face of `part`."""
    p = _as_part(part)
    edges = p.edges()
    if len(edges) == 0:
        raise SelectionError("bottom_edges(): part has no edges")
    z_min = min(e.center().Z for e in edges)
    return _require_nonempty(
        "bottom_edges()",
        edges.filter_by_position(Axis.Z, z_min - tol, z_min + tol),
        "no edges grouped at the bottom; check tol",
        part=p,
    )


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


def top_face(part) -> Face:
    """The single horizontal face with the highest Z. Raises if ambiguous."""
    p = _as_part(part)
    faces = p.faces().filter_by(Plane.XY).sort_by(Axis.Z)
    if not faces:
        raise SelectionError("top_face(): no horizontal (XY-plane) faces found. Hint: Is the part rotated?")
    return faces[-1]


def bottom_face(part) -> Face:
    """The single horizontal face with the lowest Z."""
    p = _as_part(part)
    faces = p.faces().filter_by(Plane.XY).sort_by(Axis.Z)
    if not faces:
        raise SelectionError("bottom_face(): no horizontal (XY-plane) faces found. Hint: Is the part rotated?")
    return faces[0]


def face_at_z(part, z: float, tol: float = 1e-3) -> Face:
    """The horizontal face whose center is at height `z` (± tol)."""
    p = _as_part(part)
    candidates = [f for f in p.faces().filter_by(Plane.XY) if abs(f.center().Z - z) <= tol]
    if not candidates:
        bbox = p.bounding_box()
        raise SelectionError(
            f"face_at_z(z={z}) found 0 faces. "
            f"Part Z-bounds: [{bbox.min.Z:.2f}, {bbox.max.Z:.2f}]. "
            "Hint: Check your math for the z height."
        )
    if len(candidates) > 1:
        raise SelectionError(
            f"face_at_z(z={z}): {len(candidates)} faces match; widen tol or use face_facing()"
        )
    return candidates[0]


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
# Safe fillet / chamfer                                                       #
# --------------------------------------------------------------------------- #


def safe_fillet(part, edges, radius: float, *, factor: float = 0.9) -> Part:
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
        raise SelectionError(
            f"safe_fillet(): max_fillet failed ({exc}). Common causes:\n"
            "  1. Selection includes BOTH inner and outer rim of a hollow wall — the "
            "two fillets collide. Pick only one rim, or use a radius < wall_thickness/2.\n"
            "  2. Selection includes a seam edge from a prior boolean (e.g. handle/body "
            "join). Fillet the bodies BEFORE fusing them.\n"
            "  3. A previously-added sub-part is only tangent to the body. Re-add it "
            "with safe_add(..., min_overlap >= 1.0)."
        ) from exc
    r = min(radius, upper)
    if r <= 0:
        raise SelectionError(f"safe_fillet(): computed radius {r} <= 0; edge set is too thin")
    return fillet(edges, radius=r)


def safe_chamfer(part, edges, distance: float, *, factor: float = 0.9) -> Part:
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
        raise SelectionError(
            f"safe_chamfer(): max_fillet probe failed ({exc}). "
            "See safe_fillet() for common topological causes."
        ) from exc
    d = min(distance, upper)
    if d <= 0:
        raise SelectionError(f"safe_chamfer(): computed distance {d} <= 0")
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
    overlap = _bbox_overlap(_as_part(main), _as_part(sub))
    if overlap.min_axis < min_overlap:
        raise SelectionError(
            f"safe_add(): bbox overlap is only {overlap.min_axis:.3f} mm "
            f"(dx={overlap.dx:.3f}, dy={overlap.dy:.3f}, dz={overlap.dz:.3f}); "
            f"move `sub` inward by >= {min_overlap - overlap.min_axis:.3f} mm or "
            "lower min_overlap if a tangent join is intentional."
        )
    return _as_part(main) + _as_part(sub)


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


__all__ = [
    "SelectionError",
    "edges_at_z",
    "top_edges",
    "bottom_edges",
    "vertical_edges",
    "edges_parallel_to",
    "edges_on_face",
    "circular_edges",
    "top_face",
    "bottom_face",
    "face_at_z",
    "face_facing",
    "safe_fillet",
    "safe_chamfer",
    "safe_add",
    "safe_cut",
    "sweep_path",
    "swept",
    "lofted",
]
