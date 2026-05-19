## Core Rules

- CAD requests must produce editable source, not images.
- Models live in `models/<model_name>/` and use root `asm.xml` plus root `params.json`.
- Each rigid body lives inside the model package at `models/<model_name>/parts/<part_name>/part.py` and assigns the final build123d object to global `result`.
- The bundled build runtime includes `bd_warehouse`; use it for standard hardware and mechanical catalog parts, while keeping custom structural geometry in build123d source.
- Store only assembly-level values in root `params.json`: placement, motion, constraints, anchors derived from part source metadata, and `__viewer` appearance. Do not put local part geometry knobs in root params for `asm.xml`.
- Store each part's geometry knobs beside that part in `models/<model_name>/parts/<part_name>/params.json`, including single-part models. Examples: teeth, bore, thickness, radii, hole sizes, feature counts, and local dimensions.
- For assembly-ready parts, expose derived anchors through global `metadata` in `part.py`.
- Treat `metadata.json` as a generated rebuild artifact. Do not read, edit, or create it unless the user explicitly asks or you are debugging rebuild output.
- Do not create project overview docs unless the user asks. The file tree and UI are the overview.

## Validation

- Validate only through AI CAD Companion Viewer MCP tools while the viewer is running.
- Do not run `python part.py`, `python -m`, `pytest`, `uv run`, `poetry run`, or local Python fallbacks for generated CAD validation.
- Standard flow: edit source -> `rebuild_model({ model })` -> inspect `ok/stderr` -> optional `screenshot_model` or `get_model_info`.
- Available CAD validation tools: `list_models`, `rebuild_model`, `screenshot_model`, `get_model_info`.
- `script` is available for auxiliary project automation and external tool extensions. Its input is a single command string: `build -component <name>`, `inspect -from <a> -to <b>`, `inspect -meta <a>`, or `probe -component <model/part> -expr "top_edges(part)"`. Do not call Python directly or use scripts as a substitute for CAD validation.
- **API lookup (error-only)**: do **not** call `api -module build123d` while planning or before a build attempt. Reserve it for *after* `rebuild_model` or `script build` reports an error, using `api -module build123d -search <keyword>` or `api -module build123d -name <Symbol>` to resolve the specific API/signature mistake in stderr — never a bare `api -module build123d` list. For selectors and topology use `probe`; for project patterns use `grep` and the build123d skill.
- **Selection debugging**: when a selector or boolean is non-obvious, call `script` with `probe -component <model/part> -expr "<expression>"` to evaluate a one-line Python expression against a fresh build and inspect what it returns (count, type, total length/area, center, bbox). Use it before committing an edit to verify intent, and after an unexpected build to localize which selector returned the wrong entities. The expression namespace has `part`, all `aicad_select` helpers, and `Axis/Plane/Vector/GeomType` pre-imported.
- If `rebuild_model` fails, fix the first deterministic error with the smallest change and rebuild again.
- Keep final responses brief. Do not narrate internal validation unless a blocker needs user input.

## Project Layout

```
./
|- .aicad/project.json
|- models/
|  |- <model_name>/
|  |  |- asm.xml
|  |  |- params.json
|  |  |- parts/
|  |  |  |- <part_name>/
|  |  |  |  |- part.py
|  |  |  |  |- params.json
|- .cache/                    (viewer cache, screenshots, transient artifacts)
```

## Viewer Materials

Use `params.json` `__viewer.materials` only for preview appearance. Never feed `__viewer` values into dimensions, topology, anchors, joints, or constraints.

Available presets: `cad_clay`, `matte_plastic`, `gloss_plastic`, `rubber`, `painted_metal`, `anodized_aluminum`, `brushed_steel`, `dark_steel`, `polished_metal`, `glass_clear`.

Preset materials must be objects, not bare strings. Use `{ "preset": "painted_metal" }` or `{ "preset": "painted_metal", "color": "#2f80ed" }`. Bare strings are reserved for explicit color values such as `"#2f80ed"`.

For assemblies, `__viewer.materials.parts` keys should match MJCF body, geom, or mesh names. Use color to distinguish parts, not to replace correct geometry.
