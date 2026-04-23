'use strict';

const { EXPORT_RUNNER_PYTHON } = require('./main.templates.export-runner');
const { assertKernel, kernelMeta } = require('./main.templates.kernel');
const { kernelProjectPromptBundle } = require('./main.templates.prompts.index');

function sourceExtension(meta) {
  const m = /(\.[^.]+)$/.exec(meta.sourceFile);
  return m ? m[1] : '';
}

function sourceFileOptions(kernel) {
  const meta = kernelMeta(kernel);
  const ext = sourceExtension(meta);
  return {
    part: `part${ext}`,
    asm: `asm${ext}`
  };
}

function cursorMcpJson(MCP_PORT) {
  return JSON.stringify({
    mcpServers: { aicad: { url: `http://127.0.0.1:${MCP_PORT}/mcp` } }
  }, null, 2) + '\n';
}

function claudeMcpJson(MCP_PORT) {
  return JSON.stringify({
    mcpServers: { aicad: { type: 'http', url: `http://127.0.0.1:${MCP_PORT}/mcp` } }
  }, null, 2) + '\n';
}

function codexConfigToml(MCP_PORT) {
  return [
    '# AI CAD Companion Viewer - MCP (Streamable HTTP)',
    '# Start the viewer first so Codex can connect to the local endpoint.',
    '# Docs: https://developers.openai.com/codex/mcp',
    '',
    '[mcp_servers.aicad]',
    `url = "http://127.0.0.1:${MCP_PORT}/mcp"`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    'enabled = true',
    ''
  ].join('\n');
}

function modelSourceTemplate(kernel, kind, name, description) {
  const k = assertKernel(kernel);
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  const desc = description || `${name} ${kindLabel}`;
  return kernelProjectPromptBundle(k).modelSourceTemplate(kind, name, desc);
}

function modelReadmeTemplate(kernel, kind, name, description) {
  const meta = kernelMeta(kernel);
  const fileNames = sourceFileOptions(kernel);
  const activeSource = kind === 'asm' ? fileNames.asm : fileNames.part;
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  const desc = description || `TODO: add one sentence describing ${name}.`;
  const faceNote = kernelProjectPromptBundle(assertKernel(kernel)).modelReadmeFaceNote(meta);

  return [
    `# ${name}`,
    '',
    desc,
    '',
    `> Kernel: **${meta.label}** | Model type: **${kindLabel}** | Source: \`${activeSource}\` | Preview: \`${meta.previewFormat}\``,
    '> This file is scaffold-first: keep the summary, parameter table, and validation notes aligned with the source file before large geometry changes.',
    '',
    '## Parameters',
    '| Name | Unit | Default | Description |',
    '|---|---|---|---|',
    '| LENGTH | mm | 40 | Length |',
    '| WIDTH | mm | 30 | Width |',
    '| HEIGHT | mm | 20 | Height |',
    '',
    faceNote,
    '',
    '## Validation',
    '- Rebuild after geometry edits.',
    '- Update this README if parameter names or behavior change.',
    '',
    '## Change Log',
    `- ${new Date().toISOString().slice(0, 10)}: Initial version`,
    ''
  ].join('\n');
}

function exportRunnerTemplate(kernel) {
  assertKernel(kernel);
  return EXPORT_RUNNER_PYTHON;
}

function exportRunnerFilename(kernel) {
  assertKernel(kernel);
  return 'export_runner.py';
}

function aicadProjectJson(kernel) {
  return JSON.stringify({
    schemaVersion: 1,
    kernel: assertKernel(kernel),
    createdAt: new Date().toISOString()
  }, null, 2) + '\n';
}

module.exports = {
  cursorMcpJson,
  claudeMcpJson,
  codexConfigToml,
  modelSourceTemplate,
  modelReadmeTemplate,
  exportRunnerTemplate,
  exportRunnerFilename,
  aicadProjectJson,
  sourceFileOptions
};
