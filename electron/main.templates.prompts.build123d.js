'use strict';

module.exports = {
  expertise: 'You are an expert in **build123d** (Python OCCT-based CAD DSL).',
  validationPolicyLines: `
- Do **not** run \`python part.py\`, \`python asm.py\`, \`python -m\`, \`python -c\`, \`pytest\`, \`uv run\`, or \`poetry run\` for generated code validation.
- Local Python/build123d/OCP environments may be missing and produce misleading results outside viewer flow.
- The only valid path is: edit code -> \`rebuild_part\` -> inspect \`ok / stderr\` -> optional \`screenshot_part\` / \`get_part_info\`.
- If MCP is unavailable, ask the user to start AI CAD Companion Viewer instead of manual Python fallback.
`,
  mustFollowLines: `
## Must Follow

1. One model per directory: \`models/<model_name>/\`.
2. Each \`part.py\` / \`asm.py\` must define global variable \`result\` as build123d objects (Part / Solid / Compound / Sketch).
3. Do not call \`export_*()\` manually; exporting is handled by the Electron-side runner.
4. Default unit is millimeter (mm).
5. All tunable variables in the active source file must stay in the top \`# === Parameters ===\` block before geometry code.
6. Keep parameters simple: use flat variables or simple dicts/classes. Do not over-engineer with \`namedtuple\` unless strictly necessary.
7. Multi-entity build123d models must always use \`with BuildPart()\` plus \`add(...)\`; do not assemble multiple solids with ad-hoc free-form composition patterns.
8. Explicitly declare the coordinate frame before detailed geometry (e.g. +X right, +Y back, +Z up).
9. For simple parts, write geometry in a single pass. For complex models, use two passes (Pass 1 for primary structure, Pass 2 for details).
10. Geometry edits must stay inside \`# === Geometry ===\`.
11. Do not generate a README file unless the user explicitly requests one for a complex model.

## Mental Model & Troubleshooting (build123d)

- **Mental Model**: Context-based. Use \`with BuildPart() as bp:\` to create a context. Objects created inside are automatically added.
- **Troubleshooting "Fillet / Chamfer failed"**: Radius/length is likely too large for the edges, or wrong edges selected. Reduce size or refine selector (e.g., \`edges().filter_by(Axis.Z)\`).

## Quick API Reference / Ammunition (build123d)

- **2D Sketches**: \`Circle(radius)\`, \`Rectangle(width, height)\`, \`RegularPolygon(radius, side_count)\`, \`SlotCenterToCenter(distance, radius)\`
- **3D Primitives**: \`Box(l, w, h)\`, \`Cylinder(radius, height)\`, \`Sphere(radius)\`, \`Cone(bottom_radius, top_radius, height)\`
- **Operations**: \`extrude(amount)\`, \`revolve(axis=Axis.Y)\`, \`sweep(path)\`
- **Locations & Arrays**: \`Pos(x, y, z)\`, \`Rot(x, y, z)\`, \`GridLocations(x_sp, y_sp, x_cnt, y_cnt)\`, \`PolarLocations(radius, count)\`
- **Modifiers**: \`fillet(edges(), radius)\`, \`chamfer(edges(), length)\`, \`Hole(radius, depth)\`
- **Contexts & Booleans**: \`with BuildPart() as bp:\`, \`with BuildSketch(bp.faces().sort_by(Axis.Z)[-1]):\`, \`add(obj, mode=Mode.SUBTRACT)\`
`,
  modelSourceTemplate(kind, _name, desc) {
    const fileName = kind === 'asm' ? 'asm.py' : 'part.py';
    const kindLabel = kind === 'asm' ? 'assembly' : 'part';
    return [
      `"""${desc}`,
      '',
      'This file is managed by AI CAD Companion Viewer.',
      `This is the primary ${kindLabel} source: \`${fileName}\`.`,
      'Keep a global variable named `result` at the end of the file.',
      'Saving this file automatically rebuilds and refreshes the 3D preview.',
      '"""',
      'from build123d import *',
      '',
      '# === Parameters ===',
      'length = 40.0',
      'width = 30.0',
      'height = 20.0',
      '',
      '# === Derived Parameters ===',
      'half_length = length / 2',
      'half_width = width / 2',
      'half_height = height / 2',
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
      ''
    ].join('\n');
  },
  modelReadmeFaceNote() {
    return [
      '## Notes',
      '- Add modeling constraints and verification notes here.'
    ].join('\n');
  }
};
