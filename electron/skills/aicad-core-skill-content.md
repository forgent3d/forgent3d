## Core Rules

- CAD requests must produce editable source, not images.
- A single-part model is flat: `models/<model_name>/part.py` plus `models/<model_name>/params.json`. No `parts/` folder, no `asm.xml`.
- A multi-part assembly uses `models/<model_name>/assembly.py` (build123d) by default; each rigid body lives at `models/<model_name>/parts/<part_name>/part.py`.
- Add `models/<model_name>/asm.xml` (MJCF) only when the model needs MuJoCo features: joints, actuators, equality constraints, or simulation. Otherwise use the build123d assembly form.
- Each part source assigns the final build123d object to global `result`. An `assembly.py` assigns the final build123d `Compound` to global `result` (or global `assembly`).
- The bundled build runtime includes `bd_warehouse`; use it for standard hardware and mechanical catalog parts, while keeping custom structural geometry in build123d source.
- Store only assembly-level values in root `params.json`: placement, motion, constraints, anchors derived from part source metadata, and `__viewer` appearance. Do not put local part geometry knobs in root params.
- Store each part's geometry knobs beside that part:
  - flat single-part model: `models/<model_name>/params.json`
  - multi-part assembly: `models/<model_name>/parts/<part_name>/params.json`
  Examples: teeth, bore, thickness, radii, hole sizes, feature counts, and local dimensions.
- For assembly-ready parts, expose derived anchors through global `metadata` in `part.py`.
- Treat `metadata.json` as a generated rebuild artifact. Do not read, edit, or create it unless the user explicitly asks or you are debugging rebuild output.
- Do not create project overview docs unless the user asks. The file tree and UI are the overview.

## Validation

- Validate only through AI CAD Companion Viewer MCP tools while the viewer is running.
- Do not run `python part.py`, `python -m`, `pytest`, `uv run`, `poetry run`, or local Python fallbacks for generated CAD validation.
- Standard flow: edit source -> `rebuild_model({ model })` -> inspect `ok/stderr` -> optional `screenshot_model`.
- Available CAD validation tools: `list_models`, `rebuild_model`, `screenshot_model`.
- `script` is available for auxiliary project automation and external tool extensions. Its input is a single command string: `build -component <name>`, `inspect -from <a> -to <b>`, `inspect -meta <a>`, or `probe -component <model/part> -expr "top_edges(part)"`. Do not call Python directly or use scripts as a substitute for CAD validation.
- **API lookup (error-only)**: do **not** call `api -module build123d` while planning or before a build attempt. Reserve it for *after* `rebuild_model` or `script build` reports an error, using `api -module build123d -search <keyword>` or `api -module build123d -name <Symbol>` to resolve the specific API/signature mistake in stderr — never a bare `api -module build123d` list. For selectors and topology use `probe`; for project patterns use `grep` and the build123d skill.
- **Selection debugging**: when a selector or boolean is non-obvious, call `script` with `probe -component <model/part> -expr "<expression>"` to evaluate a one-line Python expression against a fresh build and inspect what it returns (count, type, total length/area, center, bbox). Use it before committing an edit to verify intent, and after an unexpected build to localize which selector returned the wrong entities. The expression namespace has `part`, all `aicad_select` helpers, and `Axis/Plane/Vector/GeomType` pre-imported.
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

Add `models/<model_name>/asm.xml` alongside `parts/` only when the model needs MuJoCo features.

## Viewer Materials

Use `params.json` `__viewer.materials` only for preview appearance. Never feed `__viewer` values into dimensions, topology, anchors, joints, or constraints.

Available presets: `cad_clay`, `matte_plastic`, `gloss_plastic`, `rubber`, `painted_metal`, `anodized_aluminum`, `brushed_steel`, `dark_steel`, `polished_metal`, `glass_clear`.

Preset materials must be objects, not bare strings. Use `{ "preset": "painted_metal" }` or `{ "preset": "painted_metal", "color": "#2f80ed" }`. Bare strings are reserved for explicit color values such as `"#2f80ed"`.

For build123d assemblies, `__viewer.materials.parts` keys should match part labels in the compound. When `asm.xml` is present, keys may match MJCF body, geom, or mesh names instead. Use color to distinguish parts, not to replace correct geometry.
