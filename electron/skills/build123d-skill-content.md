## 1. Architecture & Scaffold
- **File & Output**: Code lives in `models/<model_name>/parts/<part_name>/part.py`. The final build123d object must be assigned to the global `result` variable. Do NOT use manual `export_*()` calls. Unit: mm.
- **Scaffold**: Strictly enforce this block order: `# === Parameters ===` -> `# === Derived Parameters ===` -> `# === Geometry ===`.
- **Parameterization**: Load only user-facing tunable variables from `params.json` in the Parameters block. Keep defaults small: expose the main dimensions and genuinely reusable knobs, but compute derived values in the Derived Parameters block and keep one-off construction constants local in source. Do not move every numeric literal into `params.json`.
- **Viewer Materials**: Treat `__viewer` values as preview-only renderer metadata.
- **Assembly Metadata**: For parts intended for assemblies, compute local connection anchors in `part.py` from the same geometry parameters used to build the shape, then expose them through a global `metadata` dict. Do not hand-maintain derived anchors in `params.json`.
- **Metadata Format**: Use `metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": {...}}`. Anchor names should be reusable and mechanism-neutral when possible (for example `origin`, `pin`, `hinge`, `link_end`, `slide_axis`). Keep anchors in the same local coordinate frame as the exported mesh so `asm.xml` can reference them directly for body origins, sites, joints, and equality constraints.
- **bd_warehouse Standard Parts**: The bundled runtime includes `bd_warehouse`. Use it for standard mechanical parts such as screws, washers, nuts, bearings, gears, sprockets, pipes, flanges, and standard holes. Keep custom load-bearing bodies, brackets, housings, plates, and adapters in build123d.
- **Fastener Pattern**: For common bolted features, import `SocketHeadCapScrew`, `PlainWasher`, and `ClearanceHole` from `bd_warehouse.fastener`. Instantiate screws with `simple=True` unless the user explicitly requests modeled threads, for example `SocketHeadCapScrew(size="M4-0.7", fastener_type="iso4762", length=16 * MM, simple=True)`.
- **Conflict Priority**: If "fix rebuild" conflicts with "parameter refactor", prioritize restoring a successful build.

## 2. build123d Rules & Performance Optimization (CRITICAL)
- **Context-Based**: Always use `with BuildPart()`, `with BuildSketch()`. Avoid ad-hoc free-form object composition.
- **Orientation**: Explicitly declare coordinate frame before geometry (+X right, +Y back, +Z up). Ensure ISO/front/top views expose key features cleanly.
- **2D Booleans > 3D (Performance)**: For flat parts with many cuts (e.g., keyboard plates), NEVER extrude first and subtract 3D holes in a loop. Do subtractions in a 2D `BuildSketch`, then apply ONE `extrude()`.
- **Batch Operations**: NEVER use `for` loops for `Hole`, `fillet`, or booleans. Pre-calculate lists of `Pos`, activate via `with Locations(*locs):`, and apply the operation ONCE.
- **Do Not Fuse Disjoint Parts**: For separate items (e.g., individual keycaps or hardware stacks), use `Compound([...])` or `add(..., mode=Mode.PRIVATE)`. Fusing non-intersecting solids (`Mode.ADD`) causes massive performance crashes.
- **Standard Threads**: Do not model real screw threads by default. In `bd_warehouse.fastener`, keep `simple=True` for fit checks and visual assemblies unless thread geometry is the core deliverable.

## 3. Troubleshooting & API Ammunition
- **Fillet/Chamfer Crashes**: Usually caused by radius being too large or wrong edges. Reduce size or use precise selectors like `.edges().filter_by(Axis.Z)`. Apply fillets at the very end.
- **2D**: `Circle(r)`, `Rectangle(w, h)`, `RegularPolygon(r, sides)`, `SlotCenterToCenter(dist, r)`
- **3D**: `Box(l, w, h)`, `Cylinder(r, h)`, `Sphere(r)`, `Cone(r_bottom, r_top, h)`
- **bd_warehouse**: `SocketHeadCapScrew(size, fastener_type, length, simple=True)`, `PlainWasher(size, fastener_type)`, `ClearanceHole(fastener, fit="Normal", depth=None, counter_sunk=True)`
- **Ops**: `extrude(amount)`, `revolve(axis=Axis.Y)`, `sweep(path)`
- **Locs**: `Pos(x, y, z)`, `GridLocations(x_sp, y_sp, x_c, y_c)`, `with Locations(*list_of_pos):`
- **Mods**: `fillet(edges, r)`, `chamfer(edges, d)`, `Hole(r, depth)`
