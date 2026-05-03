## Model Type Decision (explicit)

- Use `part.py` only for a single rigid body (brackets, gears, housings, standalone components).
- Use `asm.xml` for complex multi-part systems, articulated structures, vehicles, robots, drones, tools with separable components, or any model composed from multiple reusable sub-parts.
- If the request describes multiple distinct bodies, moving/rotating components, repeated subassemblies, or kinematic relationships, choose `asm.xml` by default.
- Do not satisfy complex multi-part requests by fusing everything into one monolithic `part.py`.
- In `asm.xml`, each visual mesh must come from an existing part export (`models/<part>/<part>.stl`) referenced through assembly `params.json`, then compose bodies, joints, sites, and constraints in MJCF.
- For articulated assemblies, part `metadata.json` values should provide reusable local anchors such as `anchors.origin`, `anchors.pin`, `anchors.hinge`, `anchors.link_end`, or `anchors.slide_axis`. Assembly params should copy those generated metadata anchors instead of inventing connection coordinates in `asm.xml`.

## Assembly Workflow

1. Create each reusable rigid body as its own `models/<part_name>/part.py`.
2. In each part `part.py`, compute part-local anchors from geometry parameters and expose them through the global `metadata` dict.
3. Rebuild each part so its exported mesh exists.
4. Confirm each assembly part has generated `metadata.json` with the anchors needed for mechanical connections.
5. Create the top-level `models/<assembly_name>/asm.xml` and `models/<assembly_name>/params.json`.
6. Copy generated anchors from part `metadata.json` into assembly params; attach meshes with geoms and expose connection points with `<site>`.
7. Rebuild the assembly model and inspect the viewer output.

## Must Follow (MJCF)

1. Assembly source uses `asm.xml` plus `params.json`.
2. `asm.xml` visual geometry must reference meshes exported from existing part models in this project; do not use primitive-only geoms for final assembly output.
3. Use `${...}` substitutions in `asm.xml` for names, mesh filenames, positions, scales, axes, and ranges that can change.
4. Use `<asset><mesh name="..." file="..."/></asset>` for reusable part meshes and `<geom type="mesh" mesh="..."/>` inside bodies.
5. For moving parts, use MJCF `hinge` or `slide` joints plus MuJoCo actuators/controls when motion is required. Do not rely on joint names to create animation.
6. Body origins should be meaningful anchors. If a body origin is placed at an anchor, set `<geom pos="...">` to the mesh offset from that anchor instead of moving the joint/site to compensate.
7. For closed-loop mechanisms such as slider-cranks, four-bars, scissors, or linkages, add named `<site>` elements at part-local anchors and connect branches with `<equality><connect site1="..." site2="..."/></equality>`.
8. Before adding equality constraints, calculate initial assembly poses so connected site world positions already coincide. Equality constraints maintain a closed loop; they do not choose the correct initial geometry.
9. If the preview should move without UI input, add an `<actuator>` and a `<custom><numeric name="aicad_default_ctrl" data="..."/></custom>` vector. The viewer applies that control vector to `data.ctrl` on every MuJoCo step.
10. Do not apply mechanism-specific formulas until the mechanism type is classified from the requested bodies and constraints. Use generic anchor-constraint modeling for unknown mechanisms.
11. Treat part `params.json` as input dimensions and part `metadata.json` as derived geometry facts. Do not duplicate derived anchors by hand when metadata is available.

## Generic Anchor-Constraint Workflow

Use this workflow for all articulated assemblies, including unknown or unusual mechanisms:

1. Identify rigid bodies and their intended degrees of freedom.
2. Define part-local anchors in each part's `metadata` dict in `part.py`, then rebuild so `metadata.json` is generated. Anchors must be in the same coordinate frame as the exported mesh.
3. Choose each MJCF body origin at a primary anchor when possible.
4. Attach visual meshes with `<geom type="mesh" pos="${parts.<name>.mesh_pos}"/>`, where `mesh_pos` is the offset from the body origin to the mesh origin.
5. Expose connection anchors with named `<site>` elements.
6. Add `hinge` or `slide` joints only for intended degrees of freedom.
7. Add equality constraints only when the kinematic graph contains a closed loop.
8. Verify initial connected site positions coincide before relying on equality constraints.
9. Add explicit inertial values for moving preview bodies when STL size is in mm or when mesh-derived inertia may be unstable.

Part metadata should use neutral, reusable anchor names. Avoid naming every anchor after one mechanism unless the part is truly single-purpose:

```json
{
  "anchors": {
    "origin": [0, 0, 0],
    "pin": [0, 0, 0],
    "link_end": [80, 0, 0],
    "slide_axis": [1, 0, 0]
  }
}
```

After rebuild, `models/<part>/metadata.json` will contain those anchors. Assembly params should copy the needed metadata anchors under each part entry and include solved initial poses:

```json
{
  "parts": {
    "link": {
      "mesh": "../link/link.stl",
      "scale": [1, 1, 1],
      "mesh_pos": [0, 0, 0],
      "pose": {
        "pos": [0, 0, 0],
        "euler": [0, 0, 0]
      },
      "anchors": {
        "pin": [0, 0, 0],
        "link_end": [80, 0, 0]
      }
    }
  }
}
```

Assembly MJCF should expose anchors as sites using generic names tied to the part role in this assembly:

```xml
<body name="moving_link" pos="${parts.link.pose.pos}" euler="${parts.link.pose.euler}">
  <joint name="moving_link_hinge" type="hinge" axis="0 0 1"/>
  <geom type="mesh" mesh="link_mesh" pos="${parts.link.mesh_pos}"/>
  <site name="moving_link_output_site" pos="${parts.link.anchors.link_end}" size="0.01"/>
</body>
```

For a closed loop:

```xml
<equality>
  <connect name="loop_closure" site1="moving_link_output_site" site2="driven_body_input_site"/>
</equality>
```

## Mechanism-Specific Solvers

Use mechanism-specific formulas only after classifying the mechanism type. These solvers are initialization helpers, not universal rules.

- Slider-crank: apply only when the assembly has a rotating crank, a connecting link, and a translating slider. Solve the initial crank pin, link angle, and slider position from crank radius, link length, slide axis, and initial crank angle. Do not apply this formula to generic linkages.
- Four-bar: apply only when there are two grounded pivots and two moving links forming a planar four-bar. Solve initial pose from circle intersection or reject impossible lengths.
- Gear pair: apply only when two rotating bodies share a known ratio. Use hinge joints and an appropriate coupling/actuation strategy; do not add slider-crank constraints.
- Rack-pinion: apply only when one rotating gear drives one translating rack. Couple rotation to translation with a clear ratio.
- Unknown mechanism: do not guess a solver. Use the generic anchor-constraint workflow and keep the model conservative.

When using a solver, keep all solved values in `params.json` with descriptive names such as `initial_angle`, `initial_slider_ref`, `initial_link_euler`, or `ground_pivot_distance`.

To make the mechanism move, add an actuator on the driving joint and a default control value:

```xml
<actuator>
  <velocity name="drive_motor" joint="drive_hinge" kv="100" ctrlrange="-3 3"/>
</actuator>
<custom>
  <numeric name="aicad_default_ctrl" data="1.0"/>
</custom>
```

The number of values in `aicad_default_ctrl` must match actuator order and should not exceed `nu`.
