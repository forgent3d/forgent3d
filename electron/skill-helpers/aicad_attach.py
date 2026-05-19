"""aicad_attach — verifiable part-to-body connections for build123d.

Ships with the Forgent3D bundled runtime. Prefer the three typed helpers over
ad-hoc ``Location`` math:

    from aicad_attach import attach_pad, attach_handle, attach_tube
    from aicad_select import top_face, holes

    out = attach_pad(body, bracket, top_face(body), inset=1.0)
    out = attach_handle(body, grip, host_point=(40, 0, 20), host_normal=(1, 0, 0))
    out = attach_tube(body, sleeve, holes(body, radius=6, axis=Axis.Z)[0])

Each helper builds a :class:`Connection`, runs ``verify_attach`` (probe-friendly),
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
    """Return the ``Location`` that aligns ``guest`` to ``host`` for ``conn``."""
    guest_flip = conn.mate != "coincident"
    host_plane = conn.host.plane(flip_normal=False)
    guest_plane = conn.guest.plane(flip_normal=guest_flip)
    loc = host_plane.location * guest_plane.location.inverse()
    if conn.inset > 0:
        n = _unit(conn.host.normal, label="placement.inset")
        loc = loc * Location(n * (-conn.inset))
    return loc


def _transform_point(loc: Location, point: Vector) -> Vector:
    for candidate in (point, (point.X, point.Y, point.Z)):
        try:
            out = loc * candidate
            if isinstance(out, Vector):
                return out
            if hasattr(out, "X"):
                return Vector(out.X, out.Y, out.Z)
        except Exception:
            continue
    raise AttachError("_transform_point(): Location does not transform points in this build123d build")


def _transform_direction(loc: Location, direction: Vector) -> Vector:
    try:
        orient = loc.orientation
        rotated = orient * direction
        if isinstance(rotated, Vector):
            return _unit(rotated, label="transformed normal")
    except Exception:
        pass
    base = _transform_point(loc, Vector(0, 0, 0))
    tip = _transform_point(loc, direction)
    return _unit(tip - base, label="transformed normal")


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
# Typed attach helpers                                                        #
# --------------------------------------------------------------------------- #


def attach_pad(
    host,
    guest,
    host_face: Face,
    *,
    guest_origin: Sequence[float] | Vector = (0, 0, 0),
    guest_normal: Sequence[float] | Vector = (0, 0, -1),
    guest_x_hint: Sequence[float] | Vector | None = None,
    inset: float = 1.0,
    min_overlap: float = 1.0,
    name: str = "pad",
    fuse: bool = True,
    verify: bool = True,
) -> AttachResult:
    """Flush-mount a flat guest (pad, foot, cover) onto a planar host face.

  ``guest_normal`` should point from the guest toward the host (default ``(0,0,-1)``
  when the guest is modeled with its mating face on the XY plane at ``z=0``).
  ``inset`` pushes the guest into the host along the face inward normal so
  ``safe_add`` has real overlap instead of a tangent seam.
    """
    if inset <= 0:
        raise AttachError("attach_pad(): inset must be > 0 for a fused pad mount")
    host_frame = frame_from_face(host_face)
    guest_frame = mount_frame(guest_origin, guest_normal, x_hint=guest_x_hint)
    conn = define_connection(
        name,
        host=host_frame,
        guest=guest_frame,
        min_overlap=min_overlap,
        inset=inset,
        mate="flush",
        kind="pad",
    )
    return attach_part(host, guest, conn, fuse=fuse, verify=verify)


def attach_handle(
    host,
    guest,
    *,
    host_point: Sequence[float] | Vector,
    host_normal: Sequence[float] | Vector,
    guest_origin: Sequence[float] | Vector = (0, 0, 0),
    guest_axis: Sequence[float] | Vector = (0, 0, 1),
    penetration: float = 2.0,
    min_overlap: float = 0.5,
    name: str = "handle",
    fuse: bool = True,
    verify: bool = True,
) -> AttachResult:
    """Mount a handle/lug whose stem penetrates the host wall.

  ``host_normal`` is outward from the host at the mount site. ``guest_axis`` is
  the direction the stem enters the body in guest-local coords (defaults to
  ``+Z``). The helper aligns ``guest_axis`` with ``-host_normal`` and applies
  ``penetration`` inset so the stem is buried in solid material before fuse.
    """
    if penetration <= 0:
        raise AttachError("attach_handle(): penetration must be > 0")
    host_frame = mount_frame(host_point, host_normal)
    guest_inward = _unit(_vec3(guest_axis, label="attach_handle.guest_axis"), label="guest_axis")
    guest_frame = mount_frame(guest_origin, guest_inward)
    conn = define_connection(
        name,
        host=host_frame,
        guest=guest_frame,
        min_overlap=min_overlap,
        inset=penetration,
        mate="flush",
        kind="handle",
    )
    return attach_part(host, guest, conn, fuse=fuse, verify=verify)


def attach_tube(
    host,
    guest,
    host_socket: Face,
    *,
    guest_origin: Sequence[float] | Vector = (0, 0, 0),
    guest_axis: Sequence[float] | Vector = (0, 0, 1),
    socket: Literal["bore", "boss"] = "bore",
    overlap: float = 2.0,
    min_overlap: float = 1.0,
    name: str = "tube",
    fuse: bool = True,
    verify: bool = True,
) -> AttachResult:
    """Coaxially mount a tube, bushing, or liner on a cylindrical host feature.

  Pass a cylindrical face from ``holes()`` (``socket='bore'``) or an external
  boss side wall (``socket='boss'``). ``guest_axis`` is the tube centerline in
  guest-local coords. ``overlap`` slides the guest along the shared axis into
  the host before fuse.
    """
    if overlap <= 0:
        raise AttachError("attach_tube(): overlap must be > 0")
    direction = "into" if socket == "bore" else "out"
    host_frame = frame_from_cylinder(host_socket, direction=direction)
    guest_frame = mount_frame(guest_origin, guest_axis)
    conn = define_connection(
        name,
        host=host_frame,
        guest=guest_frame,
        min_overlap=min_overlap,
        inset=overlap,
        mate="coincident",
        kind="tube",
    )
    return attach_part(host, guest, conn, fuse=fuse, verify=verify)


__all__ = [
    "AttachError",
    "AttachReport",
    "AttachResult",
    "Connection",
    "MountFrame",
    "attach_handle",
    "attach_pad",
    "attach_part",
    "attach_tube",
    "define_connection",
    "frame_from_cylinder",
    "frame_from_face",
    "frame_from_metadata",
    "mount_frame",
    "placement",
    "preview_attach",
    "verify_attach",
]
