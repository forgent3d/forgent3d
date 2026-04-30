## 1. Architecture & Scaffold
- **File & Output**: Code lives in `models/<model_name>/part.py`. The final build123d object must be assigned to the global `result` variable. Do NOT use manual `export_*()` calls. Unit: mm.
- **Scaffold**: Strictly enforce this block order: `# === Parameters ===` -> `# === Derived Parameters ===` -> `# === Geometry ===`.
- **Parameterization**: Load tunable variables from `params.json` in the Parameters block. No hardcoded dimensions in the Geometry block. Use flat vars/dicts; avoid over-engineering.
- **Conflict Priority**: If "fix rebuild" conflicts with "parameter refactor", prioritize restoring a successful build.

## 2. build123d Rules & Performance Optimization (CRITICAL)
- **Context-Based**: Always use `with BuildPart()`, `with BuildSketch()`. Avoid ad-hoc free-form object composition.
- **Orientation**: Explicitly declare coordinate frame before geometry (+X right, +Y back, +Z up). Ensure ISO/front/top views expose key features cleanly.
- **2D Booleans > 3D (Performance)**: For flat parts with many cuts (e.g., keyboard plates), NEVER extrude first and subtract 3D holes in a loop. Do subtractions in a 2D `BuildSketch`, then apply ONE `extrude()`.
- **Batch Operations**: NEVER use `for` loops for `Hole`, `fillet`, or booleans. Pre-calculate lists of `Pos`, activate via `with Locations(*locs):`, and apply the operation ONCE.
- **Do Not Fuse Disjoint Parts**: For separate items (e.g., individual keycaps), use `Compound.make_compound([...])` or `add(..., mode=Mode.PRIVATE)`. Fusing non-intersecting solids (`Mode.ADD`) causes massive performance crashes.

## 3. Troubleshooting & API Ammunition
- **Fillet/Chamfer Crashes**: Usually caused by radius being too large or wrong edges. Reduce size or use precise selectors like `.edges().filter_by(Axis.Z)`. Apply fillets at the very end.
- **2D**: `Circle(r)`, `Rectangle(w, h)`, `RegularPolygon(r, sides)`, `SlotCenterToCenter(dist, r)`
- **3D**: `Box(l, w, h)`, `Cylinder(r, h)`, `Sphere(r)`, `Cone(r_bottom, r_top, h)`
- **Ops**: `extrude(amount)`, `revolve(axis=Axis.Y)`, `sweep(path)`
- **Locs**: `Pos(x, y, z)`, `GridLocations(x_sp, y_sp, x_c, y_c)`, `with Locations(*list_of_pos):`
- **Mods**: `fillet(edges, r)`, `chamfer(edges, d)`, `Hole(r, depth)`