'use strict';

const { EXPORT_RUNNER_PYTHON } = require('./main.templates.export-runner');
const { assertKernel, kernelMeta } = require('./main.templates.kernel');

function sourceExtension(meta) {
  const m = /(\.[^.]+)$/.exec(meta.sourceFile);
  return m ? m[1] : '';
}

function sourceFileOptions(kernel) {
  const meta = kernelMeta(kernel);
  const ext = sourceExtension(meta);
  return {
    part: `part${ext}`,
    asm: 'asm.xml',
    params: 'params.json'
  };
}

function cursorMcpJson(MCP_PORT) {
  return JSON.stringify({
    mcpServers: { aicad: { type: 'http', url: `http://127.0.0.1:${MCP_PORT}/mcp` } }
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

function build123dModelSourceTemplate(kind, _name, desc) {
  const fileName = kind === 'asm' ? 'asm.xml' : 'part.py';
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  if (kind === 'asm') {
    return [
      `<!-- ${desc}`,
      '',
      'This file is managed by AI CAD Companion Viewer.',
      `This is the primary ${kindLabel} source: \`${fileName}\`.`,
      'Tunable values live in params.json and are substituted into parameter expressions before preview.',
      'Reference exported meshes and part-local anchors from params.json; compose bodies, joints, sites, and constraints here.',
      '-->',
      '<mujoco model="${modelName}">',
      '  <asset>',
      '    <mesh name="cuboid" file="${parts.cuboid.mesh}" scale="${parts.cuboid.scale}"/>',
      '  </asset>',
      '  <worldbody>',
      '    <body name="base" pos="${parts.cuboid.pose.pos}" euler="${parts.cuboid.pose.euler}">',
      '      <geom type="mesh" mesh="cuboid" pos="${parts.cuboid.mesh_pos}"/>',
      '      <site name="base_origin" pos="${parts.cuboid.anchors.origin}" size="0.01"/>',
      '    </body>',
      '  </worldbody>',
      '</mujoco>',
      ''
    ].join('\n');
  }
  return [
    `"""${desc}`,
    '',
    'This file is managed by AI CAD Companion Viewer.',
    `This is the primary ${kindLabel} source: \`${fileName}\`.`,
    'Keep a global variable named `result` at the end of the file.',
    'Saving this file automatically rebuilds and refreshes the 3D preview.',
    '"""',
    'import json',
    'from pathlib import Path',
    'from build123d import *',
    '',
    '# === Parameters ===',
    'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
    'length = float(PARAMS["length"])',
    'width = float(PARAMS["width"])',
    'height = float(PARAMS["height"])',
    '',
    '# === Derived Parameters ===',
    'half_length = length / 2',
    'half_width = width / 2',
    'half_height = height / 2',
    'anchors = {',
    '    "origin": [0, 0, 0],',
    '    "x_min": [-half_length, 0, 0],',
    '    "x_max": [half_length, 0, 0],',
    '}',
    '',
    '# === Coordinate Frame ===',
    '# +X: right, +Y: back, +Z: up.',
    '',
    '# === Geometry ===',
    'def build():',
    '    # For simple parts, build everything in one pass.',
    '    # For complex parts, build primary structure first, validate, then add details.',
    '    with BuildPart() as bp:',
    '        add(Box(length, width, height))',
    '    return bp.part',
    '',
    'result = build()',
    'metadata = {',
    '    "schema": "aicad.part.metadata.v1",',
    '    "units": "mm",',
    '    "anchors": anchors,',
    '}',
    ''
  ].join('\n');
}

function modelSourceTemplate(kernel, kind, name, description) {
  assertKernel(kernel);
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  const desc = description || `${name} ${kindLabel}`;
  return build123dModelSourceTemplate(kind, name, desc);
}

function modelParamsTemplate(kind, _name, description) {
  if (kind === 'asm') {
    return JSON.stringify({
      description: description || 'Assembly parameters',
      modelName: 'assembly',
      parts: {
        cuboid: {
          mesh: '../cuboid/cuboid.stl',
          scale: [1, 1, 1],
          pose: {
            pos: [0, 0, 0],
            euler: [0, 0, 0]
          },
          mesh_pos: [0, 0, 0],
          anchors: {
            origin: [0, 0, 0],
            x_min: [-20, 0, 0],
            x_max: [20, 0, 0]
          }
        }
      }
    }, null, 2) + '\n';
  }
  return JSON.stringify({
    description: description || 'Part parameters',
    length: 40.0,
    width: 30.0,
    height: 20.0
  }, null, 2) + '\n';
}

function modelReadmeTemplate(kernel, kind, name, description) {
  const meta = kernelMeta(kernel);
  const fileNames = sourceFileOptions(kernel);
  const activeSource = kind === 'asm' ? fileNames.asm : fileNames.part;
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  const desc = description || `TODO: add one sentence describing ${name}.`;

  return [
    `# ${name}`,
    '',
    desc,
    '',
    `> Kernel: **${meta.label}** | Model type: **${kindLabel}** | Source: \`${activeSource}\` + \`params.json\` | Preview: \`${meta.previewFormat}\``,
    '> This file is scaffold-first: keep the summary, parameter table, and validation notes aligned with the source file before large geometry changes.',
    '',
    '## Parameters',
    '| Name | Unit | Default | Description |',
    '|---|---|---|---|',
    '| LENGTH | mm | 40 | Length |',
    '| WIDTH | mm | 30 | Width |',
    '| HEIGHT | mm | 20 | Height |',
    '',
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
  modelParamsTemplate,
  modelReadmeTemplate,
  exportRunnerTemplate,
  exportRunnerFilename,
  aicadProjectJson,
  sourceFileOptions
};
