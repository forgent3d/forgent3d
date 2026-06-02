## Core Rules

- CAD requests must produce editable source, not images.
- A single-part model is flat: `models/<model_name>/part.py` plus `models/<model_name>/params.json`. No `parts/` folder, no `asm.xml`.
- A multi-part assembly uses `models/<model_name>/assembly.py` (build123d) by default; each rigid body lives at `models/<model_name>/parts/<part_name>/part.py`.
- Add `models/<model_name>/asm.xml` (MJCF) only as an optional motion preview when the model needs MuJoCo features: joints, actuators, equality constraints, or simulation. The CAD source and export target remains `assembly.py`.
- Each part source assigns the final build123d object to global `result`. An `assembly.py` assigns the final build123d `Compound` to global `result` (or global `assembly`).
- The bundled build runtime includes `bd_warehouse`; use it for standard hardware and mechanical catalog parts, while keeping custom structural geometry in build123d source.
- Store only assembly-level values in root `params.json`: placement, motion, constraints, anchors, and `__viewer` appearance. Do not put local part geometry knobs in root params.
- Store each part's geometry knobs beside that part:
  - flat single-part model: `models/<model_name>/params.json`
  - multi-part assembly: `models/<model_name>/parts/<part_name>/params.json`
  Examples: teeth, bore, thickness, radii, hole sizes, feature counts, and local dimensions.
- Do not create project overview docs unless the user asks. The file tree and UI are the overview.
- For assembly-ready or feature-rich parts, expose derived anchors and meaningful semantic feature tags through global `metadata` in `part.py`. Use `tag_feature` for functional/user-visible topology that should produce good copied selectors later, such as mounting holes, slots, bosses, rims, connector cutouts, rails, hinge points, and gear bores. Do not tag every generic face or edge.
- Minimal feature tag pattern:
  ```python
  from aicad_select import holes, tag_feature

  metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": anchors}
  tag_feature(
      metadata,
      "mounting_holes",
      faces=holes(result, radius=3, axis=Axis.Z),
      selector="holes(radius=3, axis=Axis.Z)",
      kind="hole",
  )
  ```
- Feature tags are metadata hints, not persistent BREP IDs. Tag after the final `result` exists and pass the selector expression you would want the viewer/user to copy. Write the selector in the viewer's copy form — omit the part argument (`holes(radius=3, axis=Axis.Z)`, not `holes(part, ...)`) so it matches auto-synthesized selectors.

## Validation

- Validate only through AI CAD Companion Viewer MCP tools while the viewer is running.
- Do not run `python part.py`, `python -m`, `pytest`, `uv run`, `poetry run`, or local Python fallbacks for generated CAD validation.
- Standard flow: edit source -> `rebuild_model({ model })` -> inspect `ok/stderr` -> optional `screenshot_model`.
- Available CAD validation tools: `list_models`, `rebuild_model`, `screenshot_model`.
- `script` is available for auxiliary project automation and external tool extensions. Its input is a single command string: `build -component <name>`, `inspect -from <a> -to <b>`, or `inspect -meta <a>`. Do not call Python directly or use scripts as a substitute for CAD validation.
- If `rebuild_model` fails, fix the first deterministic error with the smallest change and rebuild again.
- Keep final responses brief. Do not narrate internal validation unless a blocker needs user input.

## Project Layout

Flat single-part model:

```
./
|- .aicad/project.json
|- models/
|  |- <model_name>/
|  |  |- part.py
|  |  |- params.json
|- .cache/                    (viewer cache, screenshots, transient artifacts)
```

build123d multi-part assembly:

```
./
|- .aicad/project.json
|- models/
|  |- <model_name>/
|  |  |- assembly.py
|  |  |- params.json
|  |  |- parts/
|  |  |  |- <part_name>/
|  |  |  |  |- part.py
|  |  |  |  |- params.json
|- .cache/
```

Add `models/<model_name>/asm.xml` alongside `assembly.py` and `parts/` only when the model needs MuJoCo motion-preview features.

## Viewer Materials

Use `params.json` `__viewer.materials` only for preview appearance. Never feed `__viewer` values into dimensions, topology, anchors, joints, or constraints.

Available presets: `cad_clay`, `matte_plastic`, `gloss_plastic`, `rubber`, `painted_metal`, `anodized_aluminum`, `brushed_steel`, `dark_steel`, `polished_metal`, `glass_clear`.

Preset materials must be objects, not bare strings. Use `{ "preset": "painted_metal" }` or `{ "preset": "painted_metal", "color": "#2f80ed" }`. Bare strings are reserved for explicit color values such as `"#2f80ed"`.

For build123d assemblies, `__viewer.materials.parts` keys must match each instance `label` in `assembly.py` (e.g. `front_arm`), not the `parts/<part_name>/` folder name (e.g. `arm`). Rebuild auto-writes `models/<model>/metadata.json` with `assembly_parts` from those labels; use it as reference, do not hand-edit. When `asm.xml` is present, keys may match MJCF body, geom, or mesh names instead.
