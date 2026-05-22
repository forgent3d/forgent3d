## build123d Source Rules

- **File & Output**: A single-part model lives at `models/<model_name>/part.py` (no `parts/` folder). A part inside a multi-part build123d assembly lives at `models/<model_name>/parts/<part_name>/part.py`, with the model's `models/<model_name>/assembly.py` composing them into a `Compound`. Either way, assign the final build123d object to the global `result` variable. Do not use manual `export_*()` calls. Unit: mm.
- **Parameterization**: Load only user-facing tunable variables from `params.json`. Keep defaults small: expose main dimensions and genuinely reusable knobs, compute derived values in source, and keep one-off construction constants local.
- **Viewer Materials**: Treat `__viewer` values as preview-only renderer settings. In `assembly.py`, give every placed instance a unique `label`; root `__viewer.materials.parts` keys must use those same instance labels (not `parts/<part_name>/` folder names). Keep a `parts = [...]` list before `result = Compound(parts)` so rebuild can emit `metadata.json` `assembly_parts`.
- **Standard Parts**: The bundled runtime includes `bd_warehouse`. Use it when a standard mechanical catalog part is a better fit than custom source.
- **Standard Threads**: Do not model real screw threads by default unless thread geometry is the core deliverable.

## Performance (CRITICAL)

- **Context-based modeling**: Always use `with BuildPart():` and `with BuildSketch():`. Avoid ad-hoc free-form object composition outside builders.
- **Orientation**: Declare the coordinate frame before geometry (+X right, +Y back, +Z up). Lay out features so ISO / front / top views expose key geometry cleanly.
- **2D booleans before 3D**: For flat parts with many cuts (e.g. keyboard plates), never extrude first and subtract 3D holes in a loop. Do subtractions in a 2D `BuildSketch`, then apply one `extrude()`.
- **Batch operations**: Never use `for` loops for `Hole`, `fillet`, or booleans. Pre-calculate lists of `Pos`, activate via `with Locations(*locs):`, and apply the operation once.
- **Do not fuse disjoint parts**: For separate items (e.g. individual keycaps or hardware stacks), use `Compound.make_compound([...])` or `add(..., mode=Mode.PRIVATE)`. Fusing non-intersecting solids with `Mode.ADD` causes severe performance crashes.

## Troubleshooting

- **Fillet / chamfer failures**: Usually radius too large or wrong edges. Reduce size or use precise selectors such as `.edges().filter_by(Axis.Z)`. Apply fillets and chamfers at the very end of the feature tree.

## API Quick Reference

- **2D**: `Circle(r)`, `Rectangle(w, h)`, `RegularPolygon(r, sides)`, `SlotCenterToCenter(dist, r)`
- **3D**: `Box(l, w, h)`, `Cylinder(r, h)`, `Sphere(r)`, `Cone(r_bottom, r_top, h)`
- **Ops**: `extrude(amount)`, `revolve(axis=Axis.Y)`, `sweep(path)`
- **Locations**: `Pos(x, y, z)`, `GridLocations(x_sp, y_sp, x_c, y_c)`, `with Locations(*list_of_pos):`
- **Mods**: `fillet(edges, r)`, `chamfer(edges, d)`, `Hole(r, depth)`
