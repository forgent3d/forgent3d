'use strict';


// Do not create or depend on models/README.md. The file tree and UI already provide project overview.

const CODEX_MCP_QUICK_BLOCK = '\n> **Agent / MCP**: keep **AI CAD Companion Viewer** running while using MCP tools; launch your agent from the viewer so repo config stays in sync.\n';

const CODEX_INSTRUCTION_META = `## AI Agent Instructions

Use your documented flows for project instructions and MCP. This repo's **aicad** server is available once the viewer is running and you started the agent from it.
`;

module.exports = {
  CODEX_MCP_QUICK_BLOCK,
  CODEX_INSTRUCTION_META
};
