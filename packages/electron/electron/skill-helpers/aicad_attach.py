"""aicad_attach — verifiable part-to-body connections for build123d.

Ships with the Forgent3D bundled runtime. Use :func:`attach` as the default
substitute for ``safe_add(host, guest.moved(Location(...)))``. It dispatches on
the geometry of ``where``:

    from aicad_attach import attach
    from aicad_select import top_face, holes, face_facing

    out = attach(body, bracket, top_face(body), inset=1.0)               # planar face → pad
    out = attach(body, sleeve, holes(body, radius=6)[0])                 # cylinder → coaxial
    out = attach(body, grip, ((40, 0, 20), (1, 0, 0)))                   # (point, normal) → stem

Each call builds a :class:`Connection`, runs ``verify_attach`` (probe-friendly),
then ``safe_add``. Use ``.report.summary()`` or ``preview_attach`` before fusing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Sequence

from build123d import Compound, Edge, Face, GeomType, Location, Part, Plane, Vector

from aicad_select import safe_add


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class AttachError(ValueError):
    """Raised when a connection cannot be satisfied before or after placement."""


# --------------------------------------------------------------------------- #
# Frames & connections                                                        #
# --------------------------------------------------------------------------- #


def _vec3(value: Sequence[float] | Vector, *, label: str = "point") -> Vector:
    if isinstance(value, Vector):
        return value
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return Vector(float(value[0]), float(value[1]), float(value[2]))
    if isinstance(value, Mapping):
        for keys in (("x", "y", "z"), ("X", "Y", "Z")):
            if all(k in value for k in keys):
                return Vector(float(value[keys[0]]), float(value[keys[1]]), float(value[keys[2]]))
        for key in ("point", "position", "origin", "center"):
            if key in value:
                return _vec3(value[key], label=label)
    raise AttachError(f"{label}: expected [x,y,z] or Vector, got {value!r}")


def _unit(v: Vector, *, label: str) -> Vector:
    length = v.length
    if length < 1e-9:
        raise AttachError(f"{label}: zero-length direction {v!r}")
    return v / length


@dataclass(frozen=True)
class MountFrame:
    """A mount point: origin on a body and outward-facing normal (+Z of the mating plane)."""

    origin: Vector
    normal: Vector
    x_hint: Vector | None = None

    def plane(self, *, flip_normal: bool = False) -> Plane:
        z_dir = -self.normal if flip_normal else self.normal
        if self.x_hint is not None:
            return Plane(origin=self.origin, z_dir=z_dir, x_dir=self.x_hint)
        return Plane(origin=self.origin, z_dir=z_dir)


@dataclass(frozen=True)
class Connection:
    """Declarative host↔guest mount intent."""

    name: str
    host: MountFrame
    guest: MountFrame
    min_overlap: float = 1.0
    inset: float = 0.0
    mate: str = "flush"  # "flush" | "coincident" (guest normal // host normal)
    kind: str = "custom"

    def to_metadata(self) -> dict[str, Any]:
        def _frame_dict(frame: MountFrame) -> dict[str, Any]:
            out: dict[str, Any] = {
                "origin": [frame.origin.X, frame.origin.Y, frame.origin.Z],
                "normal": [frame.normal.X, frame.normal.Y, frame.normal.Z],
            }
            if frame.x_hint is not None:
                out["x_hint"] = [frame.x_hint.X, frame.x_hint.Y, frame.x_hint.Z]
            return out

        return {
            "schema": "aicad.connection.v1",
            "name": self.name,
            "kind": self.kind,
            "mate": self.mate,
            "min_overlap": self.min_overlap,
            "inset": self.inset,
            "host": _frame_dict(self.host),
            "guest": _frame_dict(self.guest),
        }


@dataclass
class AttachReport:
    """Outcome of :func:`verify_attach` — safe to log / return from ``probe``."""

    ok: bool
    name: str
    anchor_gap_mm: float
    normal_angle_deg: float
    overlap_mm: float
    overlap_axes: tuple[float, float, float]
    messages: list[str] = field(default_factory=list)

    def summary(self) -> str:
        status = "OK" if self.ok else "FAIL"
        lines = [
            f"[{status}] connection '{self.name}'",
            f"  anchor_gap={self.anchor_gap_mm:.4f} mm",
            f"  normal_angle={self.normal_angle_deg:.3f} deg",
            f"  bbox_overlap=({self.overlap_axes[0]:.3f}, {self.overlap_axes[1]:.3f}, {self.overlap_axes[2]:.3f}) min={self.overlap_mm:.3f} mm",
        ]
        lines.extend(f"  - {msg}" for msg in self.messages)
        return "\n".join(lines)


@dataclass(frozen=True)
class AttachResult:
    part: Part | Compound
    connection: Connection
    placement: Location
    report: AttachReport
    placed_guest: Part | Compound


# --------------------------------------------------------------------------- #
# Construction helpers                                                        #
# --------------------------------------------------------------------------- #


def mount_frame(
    origin: Sequence[float] | Vector,
    normal: Sequence[float] | Vector = (0, 0, 1),
    *,
    x_hint: Sequence[float] | Vector | None = None,
) -> MountFrame:
    """Define a mount frame from an origin and outward normal (mm, part-local)."""
    o = _vec3(origin, label="mount_frame.origin")
    n = _unit(_vec3(normal, label="mount_frame.normal"), label="mount_frame.normal")
    hint = None if x_hint is None else _vec3(x_hint, label="mount_frame.x_hint")
    return MountFrame(origin=o, normal=n, x_hint=hint)


def frame_from_metadata(
    metadata: Mapping[str, Any],
    anchor_key: str,
    *,
    normal_key: str | None = None,
    x_hint_key: str | None = None,
    default_normal: Sequence[float] = (0, 0, 1),
) -> MountFrame:
    """Build a :class:`MountFrame` from ``metadata['anchors'][...]`` entries."""
    anchors = metadata.get("anchors") or metadata.get("points") or {}
    if anchor_key not in anchors:
        raise AttachError(f"frame_from_metadata(): anchor '{anchor_key}' not in metadata")
    origin = anchors[anchor_key]
    normal = default_normal
    if normal_key and normal_key in anchors:
        normal = anchors[normal_key]
    x_hint = anchors[x_hint_key] if x_hint_key and x_hint_key in anchors else None
    return mount_frame(origin, normal, x_hint=x_hint)


def define_connection(
    name: str,
    *,
    host: MountFrame,
    guest: MountFrame,
    min_overlap: float = 1.0,
    inset: float = 0.0,
    mate: str = "flush",
    kind: str = "custom",
) -> Connection:
    """Describe how ``guest`` should mate to ``host`` before any boolean fuse."""
    mate_norm = str(mate).strip().lower()
    if mate_norm not in ("flush", "coincident"):
        raise AttachError(f"define_connection(): unknown mate {mate!r}; use 'flush' or 'coincident'")
    if min_overlap < 0:
        raise AttachError("define_connection(): min_overlap must be >= 0")
    if inset < 0:
        raise AttachError("define_connection(): inset must be >= 0")
    return Connection(
        name=name,
        host=host,
        guest=guest,
        min_overlap=min_overlap,
        inset=inset,
        mate=mate_norm,
        kind=kind,
    )


# --------------------------------------------------------------------------- #
# Geometry → frames                                                         #
# --------------------------------------------------------------------------- #


def _circle_axis_from_edge(e: Edge) -> Vector | None:
    try:
        p0 = e.position_at(0.0)
        p1 = e.position_at(0.25)
        p2 = e.position_at(0.5)
    except Exception:
        return None
    v1 = Vector(p1.X - p0.X, p1.Y - p0.Y, p1.Z - p0.Z)
    v2 = Vector(p2.X - p0.X, p2.Y - p0.Y, p2.Z - p0.Z)
    n = v1.cross(v2)
    length = math.sqrt(n.X * n.X + n.Y * n.Y + n.Z * n.Z)
    if length < 1e-9:
        return None
    return Vector(n.X / length, n.Y / length, n.Z / length)


def _cylinder_axis_radius(face: Face) -> tuple[Vector, float]:
    for e in face.edges():
        gt = getattr(e, "geom_type", None)
        gt_val = gt() if callable(gt) else gt
        if gt_val != GeomType.CIRCLE:
            continue
        axis = _circle_axis_from_edge(e)
        try:
            radius = float(e.radius)
        except Exception:
            continue
        if axis is not None:
            return axis, radius
    raise AttachError("_cylinder_axis_radius(): face has no circular edge with a usable axis")


def frame_from_face(face: Face) -> MountFrame:
    """Mount frame on a planar host face (origin at face center, normal outward)."""
    normal = face.normal_at().normalized()
    return mount_frame(face.center(), normal)


def frame_from_cylinder(face: Face, *, direction: Literal["into", "out"] = "into") -> MountFrame:
    """Mount frame on a cylindrical socket (hole wall or boss side).

    ``direction='into'`` points along the bore axis (for plugs / liners).
    ``direction='out'`` reverses the axis (for sleeves over an external boss).
    """
    axis, _radius = _cylinder_axis_radius(face)
    if direction == "out":
        axis = -axis
    return mount_frame(face.center(), axis)


# --------------------------------------------------------------------------- #
# Placement & verification                                                    #
# --------------------------------------------------------------------------- #


def _as_part(obj) -> Part | Compound:
    if hasattr(obj, "part") and not isinstance(obj, (Part, Compound)):
        return obj.part
    return obj


def _bbox_overlap(a, b) -> tuple[float, float, float]:
    ba, bb = a.bounding_box(), b.bounding_box()
    return (
        min(ba.max.X, bb.max.X) - max(ba.min.X, bb.min.X),
        min(ba.max.Y, bb.max.Y) - max(ba.min.Y, bb.min.Y),
        min(ba.max.Z, bb.max.Z) - max(ba.min.Z, bb.min.Z),
    )


def placement(conn: Connection) -> Location:
    """Return the ``Location`` that aligns ``guest`` to ``host`` for ``conn``.

    The inset translation is in *world* coordinates (along ``conn.host.normal``),
    so it must be left-multiplied — ``loc * Location(t)`` would treat ``t`` as
    a guest-local offset and produce a diagonal anchor gap.
    """
    guest_flip = conn.mate != "coincident"
    host_plane = conn.host.plane(flip_normal=False)
    guest_plane = conn.guest.plane(flip_normal=guest_flip)
    loc = host_plane.location * guest_plane.location.inverse()
    if conn.inset > 0:
        n = _unit(conn.host.normal, label="placement.inset")
        loc = Location((-n.X * conn.inset, -n.Y * conn.inset, -n.Z * conn.inset)) * loc
    return loc


def _transform_point(loc: Location, point: Vector) -> Vector:
    """Apply a Location to a point, returning the world-space position.

    Uses ``Plane(loc).from_local_coords`` since ``Location * Vector`` is not a
    supported operation in build123d (it tries to call ``Vector.moved``).
    """
    try:
        plane = Plane(loc)
        out = plane.from_local_coords((float(point.X), float(point.Y), float(point.Z)))
    except Exception as exc:
        raise AttachError(f"_transform_point(): Plane(loc).from_local_coords failed: {exc}") from exc
    if isinstance(out, Vector):
        return out
    if hasattr(out, "X"):
        return Vector(out.X, out.Y, out.Z)
    raise AttachError("_transform_point(): unexpected return type from Plane.from_local_coords")


def _transform_direction(loc: Location, direction: Vector) -> Vector:
    """Apply a Location's rotation to a direction (translation cancels out)."""
    base = _transform_point(loc, Vector(0, 0, 0))
    tip = _transform_point(loc, direction)
    return _unit(tip - base, label="transformed direction")


def verify_attach(
    host,
    guest,
    conn: Connection,
    *,
    loc: Location | None = None,
    anchor_tol: float = 0.05,
    normal_tol_deg: float = 0.5,
) -> AttachReport:
    """Check anchor coincidence, normal alignment, and bbox overlap without fusing."""
    host_p = _as_part(host)
    guest_p = _as_part(guest)
    loc = loc if loc is not None else placement(conn)
    placed = guest_p.moved(loc)

    guest_origin_world = _transform_point(loc, conn.guest.origin)
    expected_origin = conn.host.origin - _unit(conn.host.normal, label="host.normal") * conn.inset
    anchor_gap = (guest_origin_world - expected_origin).length

    guest_normal_world = _transform_direction(loc, conn.guest.normal)
    target_normal = conn.host.normal if conn.mate == "coincident" else -conn.host.normal
    target_normal = _unit(target_normal, label="verify.target_normal")
    guest_n = _unit(guest_normal_world, label="verify.guest_normal")
    dot = max(-1.0, min(1.0, target_normal.dot(guest_n)))
    normal_angle = math.degrees(math.acos(dot))

    ox, oy, oz = _bbox_overlap(host_p, placed)
    overlap_min = min(ox, oy, oz)

    messages: list[str] = []
    ok = True
    if anchor_gap > anchor_tol:
        ok = False
        messages.append(
            f"anchor gap {anchor_gap:.4f} mm > {anchor_tol} mm; adjust guest frame or host mount"
        )
    if normal_angle > normal_tol_deg:
        ok = False
        messages.append(
            f"normal misalignment {normal_angle:.3f}° > {normal_tol_deg}°; check mate mode or x_hint"
        )
    if overlap_min < conn.min_overlap:
        ok = False
        messages.append(
            f"bbox overlap {overlap_min:.3f} mm < min_overlap {conn.min_overlap} mm; "
            "increase inset or move guest frame inward"
        )

    return AttachReport(
        ok=ok,
        name=conn.name,
        anchor_gap_mm=anchor_gap,
        normal_angle_deg=normal_angle,
        overlap_mm=overlap_min,
        overlap_axes=(ox, oy, oz),
        messages=messages,
    )


def preview_attach(host, guest, conn: Connection) -> Compound:
    """Return host + positioned guest without boolean fuse (for visual probe)."""
    loc = placement(conn)
    return Compound([_as_part(host), _as_part(guest).moved(loc)])


def attach_part(
    host,
    guest,
    conn: Connection,
    *,
    fuse: bool = True,
    verify: bool = True,
) -> AttachResult:
    """Place ``guest`` on ``host``, verify, then optionally ``safe_add`` fuse."""
    loc = placement(conn)
    report = verify_attach(host, guest, conn, loc=loc)
    placed = _as_part(guest).moved(loc)
    if verify and not report.ok:
        raise AttachError(report.summary())
    if fuse:
        part = safe_add(host, placed, min_overlap=conn.min_overlap)
    else:
        part = Compound([_as_part(host), placed])
    return AttachResult(
        part=part,
        connection=conn,
        placement=loc,
        report=report,
        placed_guest=placed,
    )


# --------------------------------------------------------------------------- #
# General dispatcher                                                          #
# --------------------------------------------------------------------------- #


def _face_geom_type(face: Face):
    gt = getattr(face, "geom_type", None)
    return gt() if callable(gt) else gt


def _resolve_where(where, *, socket: Literal["bore", "boss"] = "bore"):
    """Map a ``where`` argument to (kind, host_frame, default_guest_normal, default_inset, mate)."""
    if isinstance(where, MountFrame):
        return "custom", where, (0, 0, -1), 1.0, "flush"
    if isinstance(where, Face):
        gt = _face_geom_type(where)
        if gt == GeomType.PLANE:
            return "pad", frame_from_face(where), (0, 0, -1), 1.0, "flush"
        if gt == GeomType.CYLINDER:
            direction = "into" if socket == "bore" else "out"
            return (
                "tube",
                frame_from_cylinder(where, direction=direction),
                (0, 0, 1),
                2.0,
                "coincident",
            )
        raise AttachError(
            f"attach(): unsupported face geom_type {gt!r}; pass a planar or cylindrical face, "
            "a (point, normal) tuple, a MountFrame, or call attach_part() with a custom Connection"
        )
    if isinstance(where, (tuple, list)) and len(where) == 2:
        point, normal = where
        return "handle", mount_frame(point, normal), (0, 0, 1), 2.0, "flush"
    raise AttachError(
        f"attach(): could not interpret where={where!r}; pass a Face (planar or cylindrical), "
        "a (point, normal) tuple, or a MountFrame"
    )


def attach(
    host,
    guest,
    where,
    *,
    guest_origin: Sequence[float] | Vector = (0, 0, 0),
    guest_normal: Sequence[float] | Vector | None = None,
    guest_x_hint: Sequence[float] | Vector | None = None,
    inset: float | None = None,
    min_overlap: float = 1.0,
    socket: Literal["bore", "boss"] = "bore",
    name: str | None = None,
    fuse: bool = True,
    verify: bool = True,
) -> AttachResult:
    """General sub-part mount: place ``guest`` on ``host`` at ``where``, verify, fuse.

    The default for any time you would otherwise write
    ``safe_add(host, guest.moved(Location(...)))``. ``where`` selects the host
    mount geometry and the placement strategy:

      - planar :class:`Face` (``top_face``, ``face_at``, ``face_facing`` …) →
        flush flat mount (pad / foot / bracket / cover). Default ``inset=1.0``.
      - cylindrical :class:`Face` (``holes(host)[0]``) → coaxial mount
        (tube / bushing / liner / sleeve). Default ``inset=2.0``. Use
        ``socket='boss'`` for an external boss instead of a bore.
      - ``(point, normal)`` tuple → stem / lug mount at an arbitrary point with
        the stem buried into the wall. Default ``inset=2.0``.
      - :class:`MountFrame` (from ``mount_frame`` / ``frame_from_metadata``) →
        direct frame mount for custom anchors. Default ``inset=1.0``.

    Guest defaults assume the mating feature is modeled at the guest's local
    origin: flat mounts expect the mating face on XY at ``z=0`` (normal
    ``(0,0,-1)`` pointing toward host); coaxial and stem mounts expect the
    centerline along ``+Z``. Override via ``guest_origin``, ``guest_normal``,
    ``guest_x_hint`` when the guest is modeled differently.

    Verifies anchor coincidence, normal alignment, and bbox overlap before
    fusing; raises :class:`AttachError` with a hint on failure. To probe a
    placement without raising or fusing, call with ``fuse=False, verify=False``
    and inspect ``result.report.summary()`` and ``result.part`` (a
    :class:`Compound` of host + positioned guest). ``result.connection`` exposes
    the underlying :class:`Connection` for use with :func:`preview_attach` /
    :func:`verify_attach` if more detailed inspection is needed.
    """
    kind, host_frame, default_normal, default_inset, mate = _resolve_where(
        where, socket=socket
    )
    guest_n = guest_normal if guest_normal is not None else default_normal
    inset_val = inset if inset is not None else default_inset
    guest_frame = mount_frame(guest_origin, guest_n, x_hint=guest_x_hint)
    conn = define_connection(
        name or kind,
        host=host_frame,
        guest=guest_frame,
        min_overlap=min_overlap,
        inset=inset_val,
        mate=mate,
        kind=kind,
    )
    return attach_part(host, guest, conn, fuse=fuse, verify=verify)


def attach_tube_to_surface(host, tube_part, start_point, direction, min_penetration: float = 5.0, bore_radius: float = 0.0) -> Part:
    """
    Attach a tube (e.g. handle, spout) to a curved surface.
    
    Automatically extrudes the base of the tube backward by `min_penetration` to ensure 
    deep intersection (avoiding Z-fighting/coincident face issues), then fuses it to the host.
    If `bore_radius` > 0, it will also drill a passage through the host wall to open the port.
    """
    from build123d import extrude, Cylinder, Plane, Vector
    from aicad_select import safe_add, safe_cut
    
    host_p = _as_part(host)
    tube_p = _as_part(tube_part)
    
    sp = _vec3(start_point, label="attach_tube_to_surface.start_point")
    d = _unit(_vec3(direction, label="direction"), label="attach_tube_to_surface.direction")
    
    tube_faces = tube_p.faces()
    # Find the planar face closest to the start point
    planar_faces = [f for f in tube_faces if getattr(f, "geom_type", lambda: None)() == "PLANE" or getattr(f, "geom_type", lambda: None) == GeomType.PLANE]
    if not planar_faces:
        planar_faces = tube_faces
    base_face = min(planar_faces, key=lambda f: (f.center() - sp).length)
    
    try:
        # Extrude backwards along the negative direction
        extension = extrude(base_face, amount=min_penetration, dir=-d)
        extended_tube = safe_add(tube_p, extension, min_overlap=0.0)
    except Exception:
        # Fallback if extrude fails
        extended_tube = tube_p
        
    result = safe_add(host_p, extended_tube, min_overlap=0.1)
    
    if bore_radius > 0:
        drill_plane = Plane(origin=sp, z_dir=-d)
        drill = Cylinder(radius=bore_radius, height=min_penetration * 3)
        drill = drill.moved(drill_plane.location)
        result = safe_cut(result, drill, min_through=0.1)
        
    return result


__all__ = [
    "AttachError",
    "AttachReport",
    "AttachResult",
    "Connection",
    "MountFrame",
    "attach",
    "attach_part",
    "attach_tube_to_surface",
    "define_connection",
    "frame_from_cylinder",
    "frame_from_face",
    "frame_from_metadata",
    "mount_frame",
    "placement",
    "preview_attach",
    "verify_attach",
]
