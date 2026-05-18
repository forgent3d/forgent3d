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
- Available MCP tools: `list_models`, `rebuild_model`, `screenshot_model`, `get_model_info`.
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
