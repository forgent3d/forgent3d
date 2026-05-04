## Most Important

When user says "make a gear" / "make a bracket", the deliverable is Python geometry code, not images:

- Build solid geometry in `models/<model_name>/part.py` using **build123d** and assign to global `result`.
- Store every tunable parameter in `models/<model_name>/params.json`; `part.py` and `asm.xml` must read or substitute those values instead of hardcoding dimensions.
- Preview-only material styling may live in `params.json` under `__viewer.materials`; source geometry should ignore `__viewer` and must not use those values for dimensions or constraints.
- For assembly-ready parts, compute derived anchors and connection metadata in `part.py` and expose a global `metadata` dict. The export runner writes it to `models/<model_name>/metadata.json`.
- Use `asm.xml` for complex multi-part systems, articulated mechanisms, vehicles, robots, drones, tools with separable components, or anything whose intent implies multiple bodies. Do not collapse these into one monolithic `part.py`.
- In `asm.xml`, visual geometry must reference exported meshes from existing part models through values in `params.json`; do not use primitive-only geoms for final assembly deliverables.
- Do not create or rely on `models/README.md`; the file tree and UI are the project overview. Skip creating a README entirely unless the user explicitly requests documentation for a complex project.
- Do not ask user to create PNG/JPG as a substitute for CAD source.
- Preview flow is always code -> export_runner -> .brep; sequence is edit -> rebuild -> (optional) screenshot.
- **Silent Validation & Brief Response:** Validate your geometry silently using MCP tools. Do not narrate your validation steps, traceback, or internal reasoning to the user. Say "Model generated" and show the preview, only speaking up if you hit a design blocker requiring user input.

## Validation Policy (important)
- Do **not** run `python part.py`, `python -m`, `python -c`, `pytest`, `uv run`, or `poetry run` for generated code validation.
- Local Python/build123d/OCP environments may be missing and produce misleading results outside viewer flow.
- For assemblies, keep `asm.xml` + `params.json` as the source of truth and validate through viewer rebuild/screenshot flow.
- The only valid path is: edit source -> `rebuild_model` -> inspect `ok / stderr` -> optional `screenshot_model` / `get_model_info`.
- If MCP is unavailable, ask the user to start AI CAD Companion Viewer instead of manual Python fallback.

## Project Layout

MCP is provided by **AI CAD Companion Viewer** while it is running. Any IDE-side MCP or companion rule files for a specific agent are created when you launch that agent from the viewer.

```
./
|- .aicad/project.json         (kernel metadata: kernel = build123d)
|- models/
|  |- <model_name>/
|  |  |- part.py or asm.xml    (model source, must define global result for part.py)
|  |  |- params.json           (all tunable parameters for this model)
|  |  |- metadata.json         (derived part anchors/metadata from part.py, auto-generated when metadata exists)
|  |  |- README.md             (model description)
|- .cache/                     (viewer screenshots and transient artifacts, auto-generated, ignore in git)
```

## Viewer Materials

Use `params.json` `__viewer.materials` for preview material colors and presets. This is renderer metadata, not geometry input:

```json
{
  "__viewer": {
    "materials": {
      "default": { "preset": "cad_clay", "color": "#c8d0dc" },
      "parts": {
        "base": { "preset": "painted_metal", "color": "#2f80ed" },
        "link": { "preset": "brushed_steel", "color": "#9aa3ad" },
        "rubber_pad": { "preset": "rubber", "color": "#20242a" }
      }
    }
  }
}
```

Available presets: `cad_clay`, `matte_plastic`, `gloss_plastic`, `rubber`, `painted_metal`, `anodized_aluminum`, `brushed_steel`, `dark_steel`, `polished_metal`, `glass_clear`.

Preferred choices: structural painted parts use `painted_metal` or `cad_clay`; aluminum parts use `anodized_aluminum`; shafts, pins, rods, and rails use `brushed_steel` or `polished_metal`; plastic housings use `matte_plastic` or `gloss_plastic`; tires, pads, gaskets, and seals use `rubber`; transparent guards or windows use `glass_clear`.

Single-body BREP/STL previews use only the `default` material. Part-specific material keys are for assemblies and should match MJCF body, geom, or mesh names. Keep material choices descriptive and physically plausible; use color to distinguish parts, not to replace correct geometry.
