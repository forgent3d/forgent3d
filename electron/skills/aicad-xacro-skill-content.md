## Model Type Decision (explicit)

- Use `part.py` only for a single rigid body (brackets, gears, housings, standalone components).
- Use `asm.xacro` for complex multi-part systems, articulated structures, vehicles, robots, drones, tools with separable components, or any model composed from multiple reusable sub-parts.
- If the request describes multiple distinct bodies, moving/rotating components, repeated subassemblies, or kinematic relationships, choose `asm.xacro` by default.
- Do not satisfy complex multi-part requests by fusing everything into one monolithic `part.py`.
- In `asm.xacro`, each visual mesh must come from an existing part export (`models/<part>/<part>.stl`) referenced through `params.json`, then connect links via joints.

## Assembly Workflow

1. Create each reusable rigid body as its own `models/<part_name>/part.py`.
2. Rebuild each part so its exported mesh exists.
3. Create the top-level `models/<assembly_name>/asm.xacro` and `models/<assembly_name>/params.json`.
4. Reference part meshes from XACRO and connect links with joints.
5. Rebuild the assembly model and inspect the viewer output.

## Must Follow (XACRO)

1. Assembly source uses `asm.xacro` plus `params.json`.
2. `asm.xacro` visual geometry must reference meshes exported from existing part models in this project; do not use URDF primitive geometry tags (`box`, `cylinder`, `sphere`) in final assembly output.
3. Use `\${...}` substitutions in `asm.xacro` for names, mesh filenames, origins, scales, axes, and limits that can change.
4. For `asm.xacro`, define at least one non-fixed joint (`continuous`, `revolute`, or `prismatic`) whenever motion/actuation is part of the intent.
5. For rotating components in `asm.xacro`, prefer joint names that include `prop`, `rotor`, `wheel`, `fan`, or `spin` to improve preview animation defaults.
