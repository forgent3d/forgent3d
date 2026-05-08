## When To Use MJCF

- Use `asm.xml` for multi-body systems, articulated mechanisms, vehicles, robots, drones, repeated subassemblies, or separable components.
- Keep each rigid body as its own `models/<part_name>/part.py`; do not fuse an assembly into one monolithic `part.py`.
- Assembly source is `models/<assembly_name>/asm.xml` plus `params.json`.

## Assembly Rules

- Visual geometry must reference existing part meshes through `<asset><mesh ... file="..."/></asset>` and `<geom type="mesh" mesh="..."/>`.
- Mesh files should point at `models/<part>/<part>.stl`; the viewer can generate missing/stale STL assets from fresh BREP caches during rebuild.
- Use `${...}` substitutions for mesh filenames, positions, scales, axes, ranges, and other tunable values.
- Body origins should be meaningful anchors. If the body origin is an anchor, move the visual mesh with `geom pos`, not the joint/site.
- Copy derived anchors from part `metadata.json` into assembly `params.json`; do not hand-maintain duplicate anchor math in `params.json`.
- Keep `__viewer.materials` renderer-only. Material keys for assemblies should match MJCF body, geom, or mesh names. Presets must be objects like `{ "preset": "rubber" }`, not bare strings.

## Anchors And Constraints

- Define reusable part-local anchors in each part's `metadata`, for example `origin`, `pin`, `hinge`, `link_end`, or `slide_axis`.
- Anchors must be in the same local coordinate frame as the exported mesh.
- Expose connection points with named `<site>` elements.
- Add `hinge` or `slide` joints only for intended degrees of freedom.
- Add equality constraints only for closed loops, and only after the initial connected site world positions already coincide.
- Add explicit inertial values for moving bodies when mesh-derived inertia may be unstable.

## Motion

- For moving previews, use MJCF actuators/controls. Do not rely on joint names to create animation.
- If motion should run without UI input, add `<custom><numeric name="aicad_default_ctrl" data="..."/></custom>` with one value per actuator.

## Mechanism Solvers

- Use mechanism-specific formulas only after classifying the mechanism.
- Slider-crank: rotating crank + connecting link + translating slider.
- Four-bar: two grounded pivots + two moving links.
- Gear pair: two rotating bodies with known ratio.
- Rack-pinion: one rotating gear + one translating rack.
- Unknown mechanism: use generic anchor-constraint modeling and keep the model conservative.
