'use strict';

const MCP_TOOLS_SECTION_TEMPLATE = `## MCP Tools (viewer must be running)

The viewer exposes MCP server **aicad** on a local HTTP endpoint. Your IDE/agent loads that endpoint via its own project config; launch the matching agent from **AI CAD Companion Viewer** so those configs exist and the viewer is running.

| Tool | Purpose |
|---|---|
| \`list_parts()\` | List all models and the current active model |
| \`get_part_info({ part })\` | Bounding box (mm), face count, and cache state |
| \`screenshot_part({ part, view? })\` | Single-view PNG (\`iso/front/side/top\`, default \`iso\`) |
| \`rebuild_part({ part })\` | Synchronous build with ok/stderr/faceCount/cacheSize |

Suggested workflow:
\`\`\`
if visual style matters:
    extract visual recognition features first
    # silhouette, proportions, symmetry, edge language, signature motifs
    ->
for a new Python model:
    create scaffold in models/<name>/{sourceFileHint} + models/<name>/README.md
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
    rebuild_part({ part: name })
    ->
    screenshot_part({ part: name, view: "iso" })
    ->
    if Pass 1 read is unclear:
        reroute once before adding detail
    ->
    Pass 2: add details only after Pass 1 screenshots read correctly
    ->
edit models/<name>/{sourceFileHint}
    ->
rebuild_part({ part: name })    # if failed, fix using stderr then retry
    ->
screenshot_part({ part: name, view: "iso" }) # visual verification
    ->
if needed: get_part_info        # numeric checks
    ->
final answer: include a short style self-check based on screenshot_part / get_part_info / rebuild_part
\`\`\``;

// Do not create or depend on models/README.md. The file tree and UI already provide project overview.

const CODEX_MCP_QUICK_BLOCK = '\n> **Codex / MCP**: keep **AI CAD Companion Viewer** running while using MCP tools; launch Codex from the viewer so repo config stays in sync.\n';

const CODEX_INSTRUCTION_META = `## OpenAI Codex

Use Codex's documented flows for project instructions and MCP ([AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [MCP](https://developers.openai.com/codex/mcp)). This repo's **aicad** server is available once the viewer is running and you started Codex from it.
`;

module.exports = {
  MCP_TOOLS_SECTION_TEMPLATE,
  CODEX_MCP_QUICK_BLOCK,
  CODEX_INSTRUCTION_META
};
