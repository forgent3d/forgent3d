## Accuracy Contract (mandatory)

1. **Evidence before conclusion**: cite MCP tool output before any geometric claim.
2. **Build before validation**: after editing the active model source, `rebuild_model` must pass first.
3. **Traceability**: explicitly mention tool evidence (at least one from `rebuild_model` + `get_model_info` / `screenshot_model`).
4. **No guesswork**: never claim dimensions/structure are correct without tool evidence.
5. **Keep it Simple**: For simple parts (flanges, brackets, primitives), write geometry directly and concisely without over-analyzing.

## Visual Recognition Features & Routing

- **For simple parts (e.g. flanges, basic brackets, enclosures):** Skip deep visual analysis and routing. Just declare parameters and build the geometry directly in one pass.
- **For complex organic or appearance-critical parts:** Briefly extract key visual features (overall silhouette, main symmetry, primary masses, edge language) before modeling to ensure recognizability. Route as `profile-dominant` (sketch-first) or `mass-dominant` (body-first) as appropriate.

## Generation Protocol

- **Simple Models:** Generate all geometry in a single pass (e.g. cylinder + hole + polar array of holes) and rebuild.
- **Complex Models (Two-Pass):** When creating heavily detailed models, build primary structure in Pass 1, verify with rebuild_model and screenshot_model, then add secondary features (fillets, chamfers, small cutouts) in Pass 2.

## Phased Workflow

1. Understand requirements: target geometry, dimensions, constraints.
2. Plan parameters first, declare the coordinate frame and viewing orientation.
3. Generate the structure (use single pass for simple parts, two passes for complex).
4. Build with `rebuild_model({ model })`; if it fails, follow failure recovery.
5. Validate with screenshots and numeric checks silently.
6. In the final answer, be extremely brief. Do not summarize your internal self-checks.

## Failure Recovery (when rebuild_model fails)

Follow this exact order:
1. Read `stderr` and locate the first deterministic error.
2. Apply the smallest possible fix (no unrelated refactor).
3. Immediately run `rebuild_model({ model })` again.
4. If parameterization cleanup conflicts with rebuild fix, prioritize rebuild success first and postpone refactor.
5. After success, then re-check with `get_model_info` / `screenshot_model` before final answer and style self-check.

## MCP Tools (viewer must be running)

The viewer exposes MCP server **aicad** on a local HTTP endpoint. Your IDE/agent loads that endpoint via its own project config; launch the matching agent from **AI CAD Companion Viewer** so those configs exist and the viewer is running.

| Tool | Purpose |
|---|---|
| `list_models()` | List all models and the current active model |
| `get_model_info({ model })` | Bounding box (mm), face count, and cache state |
| `screenshot_model({ model, view? })` | Single-view PNG (`iso/front/side/top`, default `iso`) |
| `rebuild_model({ model })` | Synchronous build with ok/stderr/faceCount/cacheSize |

Suggested workflow:
```
if visual style matters:
    extract visual recognition features first
    # silhouette, proportions, symmetry, edge language, signature motifs
    ->
for a new Python model:
    decide model type first
    # single rigid body => models/<name>/part.py
    # complex multi-part / articulated / vehicle / robot / drone / separable components => models/<name>/asm.xacro + params.json plus reusable part.py models
    ->
    route the task
    # asm => body-first parts, then XACRO composition
    # part => profile-dominant => sketch-first
    # part => mass-dominant => body-first
    # if uncertain => body-first
    ->
    declare coordinate frame and viewing orientation
    # origin, +X, +Y, +Z, front/top/right
    ->
    Pass 1: generate only the primary structure
    ->
    rebuild_model({ model: "<model_name>" })
    ->
    screenshot_model({ model: "<model_name>", view: "iso" })
    ->
    if Pass 1 read is unclear:
        reroute once before adding detail
    ->
    Pass 2: add details only after Pass 1 screenshots read correctly
    ->
edit models/<name>/params.json plus models/<name>/part.py or asm.xacro
    ->
rebuild_model({ model: "<model_name>" })    # if failed, fix using stderr then retry
    ->
screenshot_model({ model: "<model_name>", view: "iso" }) # visual verification
    ->
if needed: get_model_info        # numeric checks
    ->
final answer: Just say "Model generated" and show the preview. Do not narrate internal checks.
```