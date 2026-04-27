'use strict';

module.exports = {
  expertise: 'You are an expert in **CadQuery** (Python OCCT-based CAD DSL).',
  validationPolicyLines: `
- Do **not** run \`python part.py\`, \`python -m\`, \`python -c\`, \`pytest\`, \`uv run\`, or \`poetry run\` for generated code validation.
- Local Python/CadQuery/OCP environments may be missing and produce misleading results outside viewer flow.
- For assemblies, keep \`asm.urdf\` as the source of truth and validate through viewer rebuild/screenshot flow.
- The only valid path is: edit source -> \`rebuild_model\` -> inspect \`ok / stderr\` -> optional \`screenshot_model\` / \`get_model_info\`.
- If MCP is unavailable, ask the user to start AI CAD Companion Viewer instead of manual Python fallback.
`,
  mustFollowLines: `
## Must Follow

1. One model per directory: \`models/<model_name>/\`.
2. \`part.py\` must define global variable \`result\` as cadquery objects (cq.Workplane / cq.Compound...). Assembly source uses \`asm.urdf\`.
3. \`asm.urdf\` visual geometry must reference meshes exported from existing part models in this project; do not use URDF primitive geometry tags (\`box\`, \`cylinder\`, \`sphere\`) in final assembly output.
4. Do not call \`cq.exporters.export()\` manually; exporting is handled by the Electron-side runner.
5. Default unit is millimeter (mm).
6. All tunable variables in the active source file must stay in the top \`# === Parameters ===\` block before geometry code.
7. Keep parameters simple: use flat variables or simple dicts/classes. Do not over-engineer with \`namedtuple\` unless strictly necessary.
8. Explicitly declare the coordinate frame before detailed geometry (e.g. +X right, +Y back, +Z up).
9. For simple parts, write geometry in a single pass. For complex models, use two passes (Pass 1 for primary structure, Pass 2 for details).
10. Geometry edits must stay inside \`# === Geometry ===\`. Do not hardcode dimensions here.
11. Do not generate a README file unless the user explicitly requests one for a complex model.
12. Model type decision is mandatory: use \`part.py\` for single rigid bodies; use \`asm.urdf\` for multi-body systems or articulated structures. If intent implies multiple bodies or kinematic relationships, default to \`asm.urdf\`.
13. For \`asm.urdf\`, define at least one non-fixed joint (\`continuous\`, \`revolute\`, or \`prismatic\`) whenever motion/actuation is part of the intent.
14. For rotating components in \`asm.urdf\`, prefer joint names that include \`prop\`, \`rotor\`, \`wheel\`, \`fan\`, or \`spin\` to improve preview animation defaults.

## Mental Model & Troubleshooting (CadQuery)

- **Mental Model**: Fluent chaining. Operations return a new Workplane. Maintain the chain or reassign.
- **Troubleshooting "Empty Workplane"**: A selector (like \`>Z\`) found no faces/edges. Check if the previous solid generated correctly or if the selector direction is wrong.

## Quick API Reference / Ammunition (CadQuery)

- **2D Sketches**: \`.rect(w, h)\`, \`.circle(radius)\`, \`.polygon(sides, radius)\`, \`.slot2D(length, diameter)\`
- **3D Primitives**: \`cq.Workplane("XY").box(l, w, h)\`, \`.cylinder(height, radius)\`, \`.sphere(radius)\`
- **Operations**: \`.extrude(distance)\`, \`.revolve(angle)\`, \`.sweep(path)\`
- **Booleans**: \`.union(other)\`, \`.cut(other)\`, \`.intersect(other)\`
- **Arrays**: \`.rarray(xSpacing, ySpacing, xCount, yCount)\`, \`.polarArray(radius, startAngle, angle, count)\`
- **Modifiers**: \`.edges("|Z").fillet(radius)\`, \`.edges(">Z").chamfer(length)\`, \`.hole(diameter, depth)\`
- **Selectors**: \`>Z\` (top face), \`<Z\` (bottom), \`|Z\` (parallel to Z), \`#Z\` (perpendicular to Z), \`%Plane\` (type)
`,
  modelSourceTemplate(kind, _name, desc) {
    const fileName = kind === 'asm' ? 'asm.urdf' : 'part.py';
    const kindLabel = kind === 'asm' ? 'assembly' : 'part';
    if (kind === 'asm') {
      return [
        `<!-- ${desc}`,
        '',
        'This file is managed by AI CAD Companion Viewer.',
        `This is the primary ${kindLabel} source: \`${fileName}\`.`,
        'Reference exported meshes from parts in this project and compose links/joints here.',
        '-->',
        '<robot name="assembly">',
        '  <link name="base_link">',
        '    <visual>',
        '      <origin xyz="0 0 0" rpy="0 0 0"/>',
        '      <geometry>',
        '        <mesh filename="../cuboid/cuboid.stl" scale="1 1 1"/>',
        '      </geometry>',
        '    </visual>',
        '  </link>',
        '</robot>',
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
      'import cadquery as cq',
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
      '    return cq.Workplane("XY").box(length, width, height)',
      '',
      'result = build()',
      ''
    ].join('\n');
  },
  modelReadmeFaceNote() {
    return '';
  }
};
