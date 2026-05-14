'use strict';

// @ts-nocheck
export {};
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

function build123dModelSourceTemplate(kind, name, desc, opts) {
  const options = opts || {};
  const fileName = kind === 'asm' ? 'asm.xml' : 'part.py';
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  if (kind === 'asm') {
    const partNames = Array.isArray(options.partNames) && options.partNames.length
      ? options.partNames.map((partName) => String(partName))
      : [String(options.partName || name)];
    const mountingPlateName = partNames.includes('mounting_plate') ? 'mounting_plate' : partNames[0];
    const fastenerStackName = partNames.includes('fastener_stack') ? 'fastener_stack' : null;
    const assetLines = partNames.map((partName) => `    <mesh name="${partName}" file="parts/${partName}/${partName}.stl"/>`);
    const bodyLines = [
      `    <body name="${mountingPlateName}" pos="0 0 0">`,
      `      <geom name="${mountingPlateName}_geom" type="mesh" mesh="${mountingPlateName}"/>`,
      '      <site name="origin" pos="0 0 0" size="${site_radius}"/>',
      '      <site name="tool_clearance_axis" pos="0 0 ${site_lift}" size="${site_radius}"/>',
      '    </body>'
    ];
    if (fastenerStackName) {
      bodyLines.push(
        `    <body name="${fastenerStackName}_front_left" pos="\${-fastener_spacing_x / 2} \${-fastener_spacing_y / 2} \${fastener_z}">`,
        `      <geom name="${fastenerStackName}_front_left_geom" type="mesh" mesh="${fastenerStackName}"/>`,
        '    </body>',
        `    <body name="${fastenerStackName}_front_right" pos="\${fastener_spacing_x / 2} \${-fastener_spacing_y / 2} \${fastener_z}">`,
        `      <geom name="${fastenerStackName}_front_right_geom" type="mesh" mesh="${fastenerStackName}"/>`,
        '    </body>',
        `    <body name="${fastenerStackName}_back_left" pos="\${-fastener_spacing_x / 2} \${fastener_spacing_y / 2} \${fastener_z}">`,
        `      <geom name="${fastenerStackName}_back_left_geom" type="mesh" mesh="${fastenerStackName}"/>`,
        '    </body>',
        `    <body name="${fastenerStackName}_back_right" pos="\${fastener_spacing_x / 2} \${fastener_spacing_y / 2} \${fastener_z}">`,
        `      <geom name="${fastenerStackName}_back_right_geom" type="mesh" mesh="${fastenerStackName}"/>`,
        '    </body>'
      );
    }
    return [
      `<!-- ${desc}`,
      '',
      'This file is managed by AI CAD Companion Viewer.',
      `This is the primary ${kindLabel} source: \`${fileName}\`.`,
      'Assembly-level tunables live in root params.json; local part geometry knobs live beside each part.py.',
      'Reference exported part meshes here and compose bodies, joints, sites, and constraints as needed.',
      '-->',
      `<mujoco model="${name}">`,
      '  <asset>',
      ...assetLines,
      '  </asset>',
      '  <worldbody>',
      ...bodyLines,
      '  </worldbody>',
      '</mujoco>',
      ''
    ].join('\n');
  }
  if (options.template === 'fastener_stack' || name === 'fastener_stack') {
    return [
      `"""${desc}`,
      '',
      'A visible standard fastener stack generated with bd_warehouse.',
      'Keep a global variable named `result` at the end of the file.',
      '"""',
      'import json',
      'from pathlib import Path',
      'from build123d import *',
      'from bd_warehouse.fastener import PlainWasher, SocketHeadCapScrew',
      '',
      '# === Parameters ===',
      'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
      'screw_size = str(PARAMS["screw_size"])',
      'screw_type = str(PARAMS["screw_type"])',
      'screw_length = float(PARAMS["screw_length"])',
      'washer_size = str(PARAMS["washer_size"])',
      'washer_type = str(PARAMS["washer_type"])',
      'washer_drop = float(PARAMS["washer_drop"])',
      'simple_threads = bool(PARAMS.get("simple_threads", True))',
      '',
      '# === Derived Parameters ===',
      'screw = SocketHeadCapScrew(',
      '    size=screw_size,',
      '    fastener_type=screw_type,',
      '    length=screw_length * MM,',
      '    simple=simple_threads,',
      ')',
      'washer = PlainWasher(size=washer_size, fastener_type=washer_type)',
      'anchors = {',
      '    "origin": [0, 0, 0],',
      '    "screw_axis": [0, 0, 1],',
      '    "washer_seat": [0, 0, -washer_drop],',
      '}',
      '',
      '# === Coordinate Frame ===',
      '# +X: right, +Y: back, +Z: up. The screw axis is local +Z.',
      '',
      '# === Geometry ===',
      'def build():',
      '    parts = [screw, washer.moved(Location((0, 0, -washer_drop)))]',
      '    return Compound(parts)',
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
    'from bd_warehouse.fastener import ClearanceHole, SocketHeadCapScrew',
    '',
    '# === Parameters ===',
    'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
    'length = float(PARAMS["length"])',
    'width = float(PARAMS["width"])',
    'thickness = float(PARAMS["thickness"])',
    'corner_radius = float(PARAMS["corner_radius"])',
    'hole_spacing_x = float(PARAMS["hole_spacing_x"])',
    'hole_spacing_y = float(PARAMS["hole_spacing_y"])',
    'edge_fillet = float(PARAMS["edge_fillet"])',
    'screw_size = str(PARAMS["screw_size"])',
    'screw_type = str(PARAMS["screw_type"])',
    'screw_length = float(PARAMS["screw_length"])',
    'clearance_fit = str(PARAMS["clearance_fit"])',
    '',
    '# === Derived Parameters ===',
    'hole_positions = [',
    '    (-hole_spacing_x / 2, -hole_spacing_y / 2, 0),',
    '    (hole_spacing_x / 2, -hole_spacing_y / 2, 0),',
    '    (-hole_spacing_x / 2, hole_spacing_y / 2, 0),',
    '    (hole_spacing_x / 2, hole_spacing_y / 2, 0),',
    ']',
    'mount_screw = SocketHeadCapScrew(',
    '    size=screw_size,',
    '    fastener_type=screw_type,',
    '    length=screw_length * MM,',
    '    simple=True,',
    ')',
    'anchors = {',
    '    "origin": [0, 0, 0],',
    '    "mount_holes": [[x, y, thickness] for x, y, _ in hole_positions],',
    '    "x_min": [-length / 2, 0, thickness / 2],',
    '    "x_max": [length / 2, 0, thickness / 2],',
    '    "y_min": [0, -width / 2, thickness / 2],',
    '    "y_max": [0, width / 2, thickness / 2],',
    '}',
    '',
    '# === Coordinate Frame ===',
    '# +X: right, +Y: back, +Z: up.',
    '',
    '# === Geometry ===',
    'def build():',
    '    with BuildPart() as bp:',
    '        with BuildSketch():',
    '            RectangleRounded(length, width, corner_radius)',
    '        extrude(amount=thickness)',
    '',
    '        # bd_warehouse sizes the clearance holes from the real screw standard.',
    '        with Locations(*[Pos(x, y, thickness) for x, y, _ in hole_positions]):',
    '            ClearanceHole(',
    '                fastener=mount_screw,',
    '                fit=clearance_fit,',
    '                depth=thickness + 0.2,',
    '                counter_sunk=False,',
    '            )',
    '',
    '        if edge_fillet > 0:',
    '            fillet(bp.part.edges(), edge_fillet)',
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

function modelSourceTemplate(kernel, kind, name, description, opts) {
  assertKernel(kernel);
  const kindLabel = kind === 'asm' ? 'assembly' : 'part';
  const desc = description || `${name} ${kindLabel}`;
  return build123dModelSourceTemplate(kind, name, desc, opts);
}

function modelParamsTemplate(kind, name, description, opts) {
  const options = opts || {};
  if (kind === 'asm') {
    return JSON.stringify({
      description: description || `${name} model parameters`,
      fastener_spacing_x: 52.0,
      fastener_spacing_y: 28.0,
      fastener_z: 6.2,
      site_radius: 0.9,
      site_lift: 14.0,
      __viewer: {
        materials: {
          default: {
            preset: 'painted_metal',
            color: '#9fb3c8'
          },
          parts: {
            mounting_plate: {
              preset: 'anodized_aluminum',
              color: '#5f9ed1'
            },
            fastener_stack: {
              preset: 'brushed_steel',
              color: '#c7d0d8'
            }
          }
        }
      }
    }, null, 2) + '\n';
  }
  if (options.template === 'fastener_stack' || name === 'fastener_stack') {
    return JSON.stringify({
      description: description || 'Standard fastener stack parameters',
      screw_size: 'M4-0.7',
      screw_type: 'iso4762',
      screw_length: 16.0,
      washer_size: 'M4',
      washer_type: 'iso7089',
      washer_drop: 1.2,
      simple_threads: true
    }, null, 2) + '\n';
  }
  return JSON.stringify({
    description: description || 'Part parameters',
    length: 72.0,
    width: 44.0,
    thickness: 6.0,
    corner_radius: 5.0,
    hole_spacing_x: 52.0,
    hole_spacing_y: 28.0,
    edge_fillet: 0.8,
    screw_size: 'M4-0.7',
    screw_type: 'iso4762',
    screw_length: 16.0,
    clearance_fit: 'Normal'
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
    `> Kernel: **${meta.label}** | Model type: **${kindLabel}** | Source: \`${activeSource}\` + \`params.json\` | Preview: \`${kind === 'asm' ? 'MJCF' : meta.previewFormat}\``,
    '> This file is scaffold-first: keep the summary, parameter table, and validation notes aligned with the source file before large geometry changes.',
    '',
    '## Parameters',
    kind === 'asm'
      ? '| Name | Unit | Default | Description |'
      : '| Name | Unit | Default | Description |',
    '|---|---|---|---|',
    ...(kind === 'asm' ? [
      '| fastener_spacing_x | mm | 52 | Assembly X spacing for the four visible `fastener_stack` instances. |',
      '| fastener_spacing_y | mm | 28 | Assembly Y spacing for the four visible `fastener_stack` instances. |',
      '| fastener_z | mm | 6.2 | Placement height for standard fastener stacks. |',
      '| site_radius | mm | 0.9 | Visual size for MJCF reference sites. |',
      '| site_lift | mm | 14 | Z offset for the clearance-axis site in `asm.xml`. |',
      '| part geometry | - | - | Edit in `parts/<part>/params.json`, not root `params.json`. |'
    ] : [
      '| length | mm | 72 | Part length. |',
      '| width | mm | 44 | Part width. |',
      '| thickness | mm | 6 | Part thickness. |',
      '| screw_size | thread | M4-0.7 | Standard fastener size used by bd_warehouse. |'
    ]),
    '',
    '## Agent Notes',
    '- Keep names semantic: use the object role, not the primitive used to make it.',
    '- Put assembly tunables in root `params.json`; put part geometry tunables in each `parts/<part>/params.json`.',
    '- Use bd_warehouse for standard hardware such as screws, washers, bearings, gears, pipes, and flanges; keep custom load-bearing geometry in build123d.',
    '- Prefer `simple=True` for threaded fasteners unless the user explicitly needs modeled threads.',
    '- Use batched `Locations` for repeated features and expose assembly anchors through `metadata`.',
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
