'use strict';

module.exports = {
  expertise: 'You are an expert in **CadQuery** (Python OCCT-based CAD DSL).',
  validationPolicyLines: `
- Do **not** run \`python part.py\`, \`python asm.py\`, \`python -m\`, \`python -c\`, \`pytest\`, \`uv run\`, or \`poetry run\` for generated code validation.
- Local Python/CadQuery/OCP environments may be missing and produce misleading results outside viewer flow.
- The only valid path is: edit code -> \`rebuild_model\` -> inspect \`ok / stderr\` -> optional \`screenshot_model\` / \`get_model_info\`.
- If MCP is unavailable, ask the user to start AI CAD Companion Viewer instead of manual Python fallback.
`,
  mustFollowLines: `
## Must Follow

1. One model per directory: \`models/<model_name>/\`.
2. Each \`part.py\` / \`asm.py\` must define global variable \`result\` as cadquery objects (cq.Workplane / cq.Compound...).
3. Do not call \`cq.exporters.export()\` manually; exporting is handled by the Electron-side runner.
4. Default unit is millimeter (mm).
5. All tunable variables in the active source file must stay in the top \`# === Parameters ===\` block before geometry code.
6. Keep parameters simple: use flat variables or simple dicts/classes. Do not over-engineer with \`namedtuple\` unless strictly necessary.
7. Explicitly declare the coordinate frame before detailed geometry (e.g. +X right, +Y back, +Z up).
8. For simple parts, write geometry in a single pass. For complex models, use two passes (Pass 1 for primary structure, Pass 2 for details).
    9. Geometry edits must stay inside \`# === Geometry ===\`. Do not hardcode dimensions here.
10. Do not generate a README file unless the user explicitly requests one for a complex model.

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
