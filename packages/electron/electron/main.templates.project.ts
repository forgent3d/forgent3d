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
    assembly: `assembly${ext}`,
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
  const fileName = kind === 'asm' ? 'asm.xml' : (kind === 'assembly' ? 'assembly.py' : 'part.py');
  const kindLabel = kind === 'asm' || kind === 'assembly' ? 'assembly' : 'part';
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
      `This is an optional MJCF motion-preview source: \`${fileName}\`.`,
      'The primary CAD assembly lives in assembly.py; local part geometry knobs live beside each part.py.',
      'Reference exported part meshes here only when composing bodies, joints, sites, constraints, or actuators.',
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
  if (kind === 'assembly') {
    const partNames = Array.isArray(options.partNames) && options.partNames.length
      ? options.partNames.map((partName) => String(partName))
      : [String(options.partName || name)];
    const partNameLines = partNames.map((partName) => `    ${JSON.stringify(partName)},`);
    return [
      `"""${desc}`,
      '',
      'Build123d assembly source. Local part geometry lives in parts/<part>/part.py.',
      'Keep a global variable named `result` at the end of the file.',
      '"""',
      'from copy import copy',
      'import importlib.util',
      'import json',
      'from pathlib import Path',
      '',
      'from build123d import *',
      '',
      'MODEL_DIR = Path(__file__).parent',
      'PARAMS = json.loads((MODEL_DIR / "params.json").read_text(encoding="utf-8"))',
      'PART_NAMES = [',
      ...partNameLines,
      ']',
      '',
      '',
      'def load_part(name):',
      '    part_path = MODEL_DIR / "parts" / name / "part.py"',
      '    module_name = "assembly_part_" + "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in name)',
      '    spec = importlib.util.spec_from_file_location(module_name, part_path)',
      '    module = importlib.util.module_from_spec(spec)',
      '    spec.loader.exec_module(module)',
      '    return module.result',
      '',
      '',
      'def placed(source, label, xyz=(0, 0, 0), rotation=(0, 0, 0)):',
      '    instance = copy(source).moved(Location(xyz, rotation))',
      '    instance.label = label',
      '    return instance',
      '',
      '',
      'loaded_parts = {part_name: load_part(part_name) for part_name in PART_NAMES}',
      'children = []',
      '',
      'if "mounting_plate" in loaded_parts:',
      '    children.append(placed(loaded_parts["mounting_plate"], "mounting_plate"))',
      '    if "fastener_stack" in loaded_parts:',
      '        sx = float(PARAMS.get("fastener_spacing_x", 52.0))',
      '        sy = float(PARAMS.get("fastener_spacing_y", 28.0))',
      '        z = float(PARAMS.get("fastener_z", 6.2))',
      '        for label, x, y in [',
      '            ("front_left_fastener", -sx / 2, -sy / 2),',
      '            ("front_right_fastener", sx / 2, -sy / 2),',
      '            ("back_left_fastener", -sx / 2, sy / 2),',
      '            ("back_right_fastener", sx / 2, sy / 2),',
      '        ]:',
      '            children.append(placed(loaded_parts["fastener_stack"], label, (x, y, z)))',
      '    for part_name in PART_NAMES:',
      '        if part_name not in ("mounting_plate", "fastener_stack"):',
      '            children.append(placed(loaded_parts[part_name], part_name))',
      'else:',
      '    spacing = float(PARAMS.get("assembly_spacing_x", 48.0))',
      '    start_x = -spacing * (len(PART_NAMES) - 1) / 2',
      '    for index, part_name in enumerate(PART_NAMES):',
      '        children.append(placed(loaded_parts[part_name], part_name, (start_x + index * spacing, 0, 0)))',
      '',
      'if not children:',
      '    raise RuntimeError("assembly.py did not place any parts")',
      '',
      'result = Compound(children=children)',
      `result.label = ${JSON.stringify(name)}`,
      'metadata = {',
      '    "schema": "aicad.assembly.metadata.v1",',
      '    "units": "mm",',
      '    "assembly_parts": [child.label for child in children],',
      '}',
      ''
    ].join('\n');
  }
  if (options.template === 'l_bracket') {
    return [
      `"""${desc}`,
      '',
      'Parametric right-angle bracket generated by the first-model wizard.',
      'Keep a global variable named `result` at the end of the file.',
      '"""',
      'import json',
      'from pathlib import Path',
      'from build123d import *',
      '',
      'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
      'length = float(PARAMS["length"])',
      'height = float(PARAMS["height"])',
      'width = float(PARAMS["width"])',
      'thickness = float(PARAMS["thickness"])',
      'hole_diameter = float(PARAMS["hole_diameter"])',
      'hole_offset = float(PARAMS["hole_offset"])',
      'edge_fillet = float(PARAMS.get("edge_fillet", 0.8))',
      '',
      'anchors = {',
      '    "origin": [0, 0, 0],',
      '    "base_holes": [[-length / 2 + hole_offset, -width / 4, thickness], [length / 2 - hole_offset, width / 4, thickness]],',
      '    "upright_face": [-length / 2, 0, height / 2],',
      '}',
      '',
      'def build():',
      '    with BuildPart() as bp:',
      '        with Locations(Pos(0, 0, thickness / 2)):',
      '            Box(length, width, thickness)',
      '        with Locations(Pos(-length / 2 + thickness / 2, 0, height / 2)):',
      '            Box(thickness, width, height)',
      '',
      '        with Locations(',
      '            Pos(-length / 2 + hole_offset, -width / 4, thickness),',
      '            Pos(length / 2 - hole_offset, width / 4, thickness),',
      '        ):',
      '            Cylinder(radius=hole_diameter / 2, height=thickness + 0.4, mode=Mode.SUBTRACT)',
      '',
      '        if edge_fillet > 0:',
      '            fillet(bp.part.edges(), edge_fillet)',
      '    return bp.part',
      '',
      'result = build()',
      'metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": anchors}',
      ''
    ].join('\n');
  }
  if (options.template === 'bearing_block') {
    return [
      `"""${desc}`,
      '',
      'Parametric pillow-block style bearing mount generated by the first-model wizard.',
      'Uses native build123d geometry (no bd_warehouse) so it builds reliably on all locales.',
      'Keep a global variable named `result` at the end of the file.',
      '"""',
      'import json',
      'from pathlib import Path',
      'from build123d import *',
      '',
      'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
      'length = float(PARAMS["length"])',
      'width = float(PARAMS["width"])',
      'height = float(PARAMS["height"])',
      'bore_diameter = float(PARAMS["bore_diameter"])',
      'mount_hole_spacing = float(PARAMS["mount_hole_spacing"])',
      'mount_hole_diameter = float(PARAMS["mount_hole_diameter"])',
      'bearing_outer_diameter = float(PARAMS.get("bearing_outer_diameter", bore_diameter + 6))',
      'bearing_pocket_depth = float(PARAMS.get("bearing_pocket_depth", max(6.0, height * 0.28)))',
      'base_thickness = float(PARAMS.get("base_thickness", max(6.0, height * 0.22)))',
      'edge_fillet = float(PARAMS.get("edge_fillet", 0.8))',
      '',
      'anchors = {',
      '    "origin": [0, 0, 0],',
      '    "bore_center": [0, 0, height * 0.55],',
      '    "mount_holes": [[-mount_hole_spacing / 2, 0, base_thickness], [mount_hole_spacing / 2, 0, base_thickness]],',
      '    "bearing": {',
      '        "bore_diameter": bore_diameter,',
      '        "outer_diameter": bearing_outer_diameter,',
      '        "pocket_depth": bearing_pocket_depth,',
      '    },',
      '}',
      '',
      'def build():',
      '    cap_radius = max(bearing_outer_diameter / 2 + 4, min(width * 0.46, height * 0.35))',
      '    pocket_radius = bearing_outer_diameter / 2 + 0.35',
      '    with BuildPart() as bp:',
      '        with Locations(Pos(0, 0, base_thickness / 2)):',
      '            Box(length, width, base_thickness)',
      '        with Locations(Pos(0, 0, height * 0.52)):',
      '            Cylinder(radius=cap_radius, height=length * 0.62)',
      '        with Locations(Pos(0, 0, height * 0.52)):',
      '            Cylinder(radius=pocket_radius, height=bearing_pocket_depth, mode=Mode.SUBTRACT)',
      '        with Locations(Pos(0, 0, height * 0.52)):',
      '            Cylinder(radius=bore_diameter / 2, height=length * 0.7, mode=Mode.SUBTRACT)',
      '        with Locations(Pos(-mount_hole_spacing / 2, 0, base_thickness), Pos(mount_hole_spacing / 2, 0, base_thickness)):',
      '            Cylinder(radius=mount_hole_diameter / 2, height=base_thickness + 0.4, mode=Mode.SUBTRACT)',
      '        if edge_fillet > 0:',
      '            try:',
      '                fillet(bp.part.edges(), edge_fillet)',
      '            except Exception:',
      '                pass',
      '    return bp.part',
      '',
      'result = build()',
      'metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": anchors}',
      ''
    ].join('\n');
  }
  if (options.template === 'gear') {
    return [
      `"""${desc}`,
      '',
      'Simple parametric spur gear blank generated by the first-model wizard.',
      'This is a lightweight visual starter, not a standards-grade involute gear.',
      '"""',
      'import json',
      'from pathlib import Path',
      'from build123d import *',
      'from bd_warehouse.gear import SpurGear',
      '',
      'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
      'teeth = int(PARAMS["teeth"])',
      'pitch_radius = float(PARAMS["pitch_radius"])',
      'thickness = float(PARAMS["thickness"])',
      'bore_diameter = float(PARAMS["bore_diameter"])',
      'hub_diameter = float(PARAMS["hub_diameter"])',
      'tooth_depth = float(PARAMS["tooth_depth"])',
      'pressure_angle = float(PARAMS.get("pressure_angle", 20.0))',
      '',
      'anchors = {"origin": [0, 0, 0], "bore_axis": [0, 0, 1]}',
      '',
      'def build():',
      '    module = (pitch_radius * 2) / max(teeth, 1)',
      '    root_fillet = max(0.05, min(tooth_depth * 0.2, module * 0.35))',
      '    with BuildPart() as bp:',
      '        SpurGear(',
      '            module=module,',
      '            tooth_count=teeth,',
      '            pressure_angle=pressure_angle,',
      '            root_fillet=root_fillet,',
      '            thickness=thickness,',
      '        )',
      '        Cylinder(radius=hub_diameter / 2, height=thickness * 1.18)',
      '        Cylinder(radius=bore_diameter / 2, height=thickness * 1.3, mode=Mode.SUBTRACT)',
      '    return bp.part',
      '',
      'result = build()',
      'metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": anchors}',
      ''
    ].join('\n');
  }
  if (options.template === 'knob') {
    return [
      `"""${desc}`,
      '',
      'Parametric control knob generated by the first-model wizard.',
      'Keep a global variable named `result` at the end of the file.',
      '"""',
      'import json',
      'from pathlib import Path',
      'from build123d import *',
      '',
      'PARAMS = json.loads((Path(__file__).with_name("params.json")).read_text(encoding="utf-8"))',
      'diameter = float(PARAMS["diameter"])',
      'height = float(PARAMS["height"])',
      'bore_diameter = float(PARAMS["bore_diameter"])',
      'groove_count = int(PARAMS["groove_count"])',
      'groove_depth = float(PARAMS["groove_depth"])',
      'top_chamfer = float(PARAMS["top_chamfer"])',
      '',
      'anchors = {"origin": [0, 0, 0], "bore_axis": [0, 0, 1], "top": [0, 0, height / 2]}',
      '',
      'def build():',
      '    radius = diameter / 2',
      '    groove_width = max(0.8, 6.28318 * radius / max(groove_count, 1) * 0.28)',
      '    with BuildPart() as bp:',
      '        Cylinder(radius=radius, height=height)',
      '        with PolarLocations(radius - groove_depth / 2, groove_count):',
      '            Box(groove_depth * 1.8, groove_width, height * 0.9, mode=Mode.SUBTRACT)',
      '        Cylinder(radius=bore_diameter / 2, height=height * 1.2, mode=Mode.SUBTRACT)',
      '        if top_chamfer > 0:',
      '            chamfer_len = min(top_chamfer, height * 0.08, radius * 0.035)',
      '            if chamfer_len >= 0.15:',
      '                try:',
      '                    top_edges = bp.part.edges().filter_by(GeomType.CIRCLE).filter_by_position(Axis.Z, height / 2 - 0.02, height / 2 + 0.02)',
      '                    if top_edges:',
      '                        chamfer(top_edges, chamfer_len)',
      '                except Exception:',
      '                    pass',
      '    return bp.part',
      '',
      'result = build()',
      'metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": anchors}',
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
  const kindLabel = kind === 'asm' || kind === 'assembly' ? 'assembly' : 'part';
  const desc = description || `${name} ${kindLabel}`;
  return build123dModelSourceTemplate(kind, name, desc, opts);
}

function modelParamsTemplate(kind, name, description, opts) {
  const options = opts || {};
  if (kind === 'assembly') {
    return JSON.stringify({
      description: description || `${name} assembly parameters`,
      assembly_spacing_x: 48.0,
      fastener_spacing_x: 52.0,
      fastener_spacing_y: 28.0,
      fastener_z: 6.2,
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
  if (options.template === 'l_bracket') {
    return JSON.stringify({
      description: description || 'L bracket parameters',
      length: 64.0,
      height: 48.0,
      width: 32.0,
      thickness: 5.0,
      hole_diameter: 5.0,
      hole_offset: 18.0,
      edge_fillet: 0.8
    }, null, 2) + '\n';
  }
  if (options.template === 'bearing_block') {
    return JSON.stringify({
      description: description || 'Bearing block parameters',
      length: 72.0,
      width: 34.0,
      height: 42.0,
      bore_diameter: 16.0,
      mount_hole_spacing: 52.0,
      mount_hole_diameter: 5.0,
      bearing_outer_diameter: 22.0,
      bearing_pocket_depth: 10.0,
      base_thickness: 8.0,
      edge_fillet: 0.8
    }, null, 2) + '\n';
  }
  if (options.template === 'gear') {
    return JSON.stringify({
      description: description || 'Gear parameters',
      teeth: 24,
      pitch_radius: 28.0,
      thickness: 8.0,
      bore_diameter: 8.0,
      hub_diameter: 22.0,
      tooth_depth: 3.0,
      pressure_angle: 20.0
    }, null, 2) + '\n';
  }
  if (options.template === 'knob') {
    return JSON.stringify({
      description: description || 'Knob parameters',
      diameter: 36.0,
      height: 18.0,
      bore_diameter: 6.0,
      groove_count: 18,
      groove_depth: 1.6,
      top_chamfer: 0.6
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
  const activeSource = kind === 'asm' ? fileNames.asm : (kind === 'assembly' ? fileNames.assembly : fileNames.part);
  const kindLabel = kind === 'asm' ? 'motion preview' : (kind === 'assembly' ? 'assembly' : 'part');
  const desc = description || `TODO: add one sentence describing ${name}.`;
  const previewLabel = kind === 'asm' ? 'MJCF' : meta.previewFormat;

  return [
    `# ${name}`,
    '',
    desc,
    '',
    `> Kernel: **${meta.label}** | Model type: **${kindLabel}** | Source: \`${activeSource}\` + \`params.json\` | Preview: \`${previewLabel}\``,
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
    ] : kind === 'assembly' ? [
      '| assembly_spacing_x | mm | 48 | Default X spacing when placing generic part instances. |',
      '| fastener_spacing_x | mm | 52 | X spacing for starter mount fastener instances. |',
      '| fastener_spacing_y | mm | 28 | Y spacing for starter mount fastener instances. |',
      '| fastener_z | mm | 6.2 | Placement height for starter mount fastener stacks. |',
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
