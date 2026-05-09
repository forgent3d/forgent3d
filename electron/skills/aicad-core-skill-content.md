## Core Rules

- CAD requests must produce editable source, not images.
- Single rigid bodies live in `parts/<model_name>/part.py` and assign the final build123d object to global `result`.
- Complex multi-part systems, articulated mechanisms, vehicles, robots, drones, and separable tools use `assemblies/<model_name>/asm.xml` plus reusable part models.
- Store tunable dimensions in the model's adjacent `params.json`; source files must read or substitute those values instead of hardcoding them in geometry.
- For assembly-ready parts, expose derived anchors through global `metadata`; the viewer writes `metadata.json` after rebuild.
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
|- parts/
|  |- <part_name>/
|  |  |- part.py
|- assemblies/
|  |- <assembly_name>/
|  |  |- asm.xml
|  |  |- params.json
|  |  |- metadata.json        (auto-generated when `metadata` exists)
|- .cache/                    (viewer cache, screenshots, transient artifacts)
```

## Viewer Materials

Use `params.json` `__viewer.materials` only for preview appearance. Never feed `__viewer` values into dimensions, topology, anchors, joints, or constraints.

Available presets: `cad_clay`, `matte_plastic`, `gloss_plastic`, `rubber`, `painted_metal`, `anodized_aluminum`, `brushed_steel`, `dark_steel`, `polished_metal`, `glass_clear`.

Preset materials must be objects, not bare strings. Use `{ "preset": "painted_metal" }` or `{ "preset": "painted_metal", "color": "#2f80ed" }`. Bare strings are reserved for explicit color values such as `"#2f80ed"`.

For assemblies, `__viewer.materials.parts` keys should match MJCF body, geom, or mesh names. Use color to distinguish parts, not to replace correct geometry.
