'use strict';

const MCP_TOOLS_SECTION_TEMPLATE = `## MCP Tools (viewer must be running)

The viewer exposes MCP server **aicad** on a local HTTP endpoint. Your IDE/agent loads that endpoint via its own project config; launch the matching agent from **AI CAD Companion Viewer** so those configs exist and the viewer is running.

| Tool | Purpose |
|---|---|
| \`list_models()\` | List all models and the current active model |
| \`get_model_info({ model })\` | Bounding box (mm), face count, and cache state |
| \`screenshot_model({ model, view? })\` | Single-view PNG (\`iso/front/side/top\`, default \`iso\`) |
| \`rebuild_model({ model })\` | Synchronous build with ok/stderr/faceCount/cacheSize |

Suggested workflow:
\`\`\`
if visual style matters:
    extract visual recognition features first
    # silhouette, proportions, symmetry, edge language, signature motifs
    ->
for a new Python model:
    create scaffold in models/<name>/{sourceFileHint}
    ->
    route the task
    # asm => body-first
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
edit models/<name>/{sourceFileHint}
    ->
rebuild_model({ model: "<model_name>" })    # if failed, fix using stderr then retry
    ->
screenshot_model({ model: "<model_name>", view: "iso" }) # visual verification
    ->
if needed: get_model_info        # numeric checks
    ->
final answer: Just say "Model generated" and show the preview. Do not narrate internal checks.
\`\`\``;

// Do not create or depend on models/README.md. The file tree and UI already provide project overview.

const CODEX_MCP_QUICK_BLOCK = '\n> **Agent / MCP**: keep **AI CAD Companion Viewer** running while using MCP tools; launch your agent from the viewer so repo config stays in sync.\n';

const CODEX_INSTRUCTION_META = `## AI Agent Instructions

Use your documented flows for project instructions and MCP. This repo's **aicad** server is available once the viewer is running and you started the agent from it.
`;

module.exports = {
  MCP_TOOLS_SECTION_TEMPLATE,
  CODEX_MCP_QUICK_BLOCK,
  CODEX_INSTRUCTION_META
};
