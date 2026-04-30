## Most Important

When user says "make a gear" / "make a bracket", the deliverable is Python geometry code, not images:

- Build solid geometry in `models/<model_name>/part.py` using **build123d** and assign to global `result`.
- Store every tunable parameter in `models/<model_name>/params.json`; `part.py` and `asm.xacro` must read or substitute those values instead of hardcoding dimensions.
- Use `asm.xacro` for complex multi-part systems, articulated mechanisms, vehicles, robots, drones, tools with separable components, or anything whose intent implies multiple bodies. Do not collapse these into one monolithic `part.py`.
- In `asm.xacro`, visual geometry must reference exported meshes from existing part models through values in `params.json`; do not use URDF primitive shapes (`box/cylinder/sphere`) for final assembly deliverables.
- Do not create or rely on `models/README.md`; the file tree and UI are the project overview. Skip creating a README entirely unless the user explicitly requests documentation for a complex project.
- Do not ask user to create PNG/JPG as a substitute for CAD source.
- Preview flow is always code -> export_runner -> .brep; sequence is edit -> rebuild -> (optional) screenshot.
- **Silent Validation & Brief Response:** Validate your geometry silently using MCP tools. Do not narrate your validation steps, traceback, or internal reasoning to the user. Say "Model generated" and show the preview, only speaking up if you hit a design blocker requiring user input.

## Validation Policy (important)
- Do **not** run `python part.py`, `python -m`, `python -c`, `pytest`, `uv run`, or `poetry run` for generated code validation.
- Local Python/build123d/OCP environments may be missing and produce misleading results outside viewer flow.
- For assemblies, keep `asm.xacro` + `params.json` as the source of truth and validate through viewer rebuild/screenshot flow.
- The only valid path is: edit source -> `rebuild_model` -> inspect `ok / stderr` -> optional `screenshot_model` / `get_model_info`.
- If MCP is unavailable, ask the user to start AI CAD Companion Viewer instead of manual Python fallback.

## Project Layout

MCP is provided by **AI CAD Companion Viewer** while it is running. Any IDE-side MCP or companion rule files for a specific agent are created when you launch that agent from the viewer.

```
./
|- .aicad/project.json         (kernel metadata: kernel = build123d)
|- models/
|  |- <model_name>/
|  |  |- part.py or asm.xacro  (model source, must define global result for part.py)
|  |  |- params.json           (all tunable parameters for this model)
|  |  |- README.md             (model description)
|- .cache/                     (viewer screenshots and transient artifacts, auto-generated, ignore in git)
```