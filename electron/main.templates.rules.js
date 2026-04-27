'use strict';

const { assertKernel, kernelMeta, kernelExpertise } = require('./main.templates.kernel');
const { kernelPromptBundle } = require('./main.templates.prompts.index');
const {
  MCP_TOOLS_SECTION_TEMPLATE,
  CODEX_MCP_QUICK_BLOCK,
  CODEX_INSTRUCTION_META
} = require('./main.templates.prompts.mcp');

/** Basename of the generated Cursor project rule (`.cursor/rules/<this file>`). */
const CURSOR_PROJECT_RULE_FILE = 'aicad-cad.mdc';

const CURSOR_MDC_FRONTMATTER_TEMPLATE = `---
description: "AI CAD companion project rules: geometry deliverables, MCP evidence, phased workflow (kernel: {label})"
alwaysApply: true
---

`;

const CORE_RULES_TEMPLATE = `# AI CAD Project Rules ({label}){agentHintBlock}{codexQuickBlock}
{expertise}

> **Current CAD kernel: {label} ({language})**
> Geometry source: \`models/<name>/{sourceFileHint}\`; preview output format: \`{previewFormat}\`.

## Most Important

When user says "make a gear" / "make a bracket", the deliverable is {language} geometry code, not images:

- Build solid geometry in \`models/<model_name>/{sourceFileHint}\` using **{label}** and assign to global \`result\`.
- For \`asm.urdf\`, visual geometry must reference exported meshes from existing part models; do not use URDF primitive shapes (\`box/cylinder/sphere\`) for final assembly deliverables.
- Do not create or rely on \`models/README.md\`; the file tree and UI are the project overview. Skip creating a README entirely unless the user explicitly requests documentation for a complex project.
- Do not ask user to create PNG/JPG as a substitute for CAD source.
- Preview flow is always code -> export_runner -> {cacheExt}; sequence is edit -> rebuild -> (optional) screenshot.
- **Silent Validation & Brief Response:** Validate your geometry silently using MCP tools. Do not narrate your validation steps, traceback, or internal reasoning to the user. Say "Model generated" and show the preview, only speaking up if you hit a design blocker requiring user input.

## Model Type Decision (explicit)

- Use \`part.py\` for a single rigid body (brackets, gears, housings, standalone components).
- Use \`asm.urdf\` for multi-body systems, articulated structures, or any model composed from multiple reusable sub-parts.
- If intent implies multiple distinct bodies or kinematic relationships, prefer \`asm.urdf\` by default.
- In \`asm.urdf\`, each visual mesh must come from an existing part export (\`models/<part>/<part>.stl\`), then connect links via joints.

## Accuracy Contract (mandatory)

1. **Evidence before conclusion**: cite MCP tool output before any geometric claim.
2. **Build before validation**: after editing the active model source, \`rebuild_model\` must pass first.
3. **Traceability**: explicitly mention tool evidence (at least one from \`rebuild_model\` + \`get_model_info\` / \`screenshot_model\`).
4. **No guesswork**: never claim dimensions/structure are correct without tool evidence.
5. **Keep it Simple**: For simple parts (flanges, brackets, primitives), write geometry directly and concisely without over-analyzing.

## Visual Recognition Features & Routing

- **For simple parts (e.g. flanges, basic brackets, enclosures):** Skip deep visual analysis and routing. Just declare parameters and build the geometry directly in one pass.
- **For complex organic or appearance-critical parts:** Briefly extract key visual features (overall silhouette, main symmetry, primary masses, edge language) before modeling to ensure recognizability. Route as \`profile-dominant\` (sketch-first) or \`mass-dominant\` (body-first) as appropriate.

## Parameterization & Structure Policy

1. All tunable variables must be declared at the top parameter block of the active model source file before any geometry construction.
2. All derived parameters must be defined after the top parameter block and before geometric modeling.
3. You may use flat variables, dicts, or simple classes for parameters. Do not over-engineer with \`namedtuple\` unless necessary.
4. For Python kernels, preserve the scaffold sections in this order: \`# === Parameters ===\`, \`# === Derived Parameters ===\`, \`# === Geometry ===\`.
5. For Python kernels, geometry implementation belongs in \`# === Geometry ===\`.
6. Before detailed geometry, explicitly declare the model coordinate frame and viewing orientation: origin meaning, +X, +Y, +Z.
7. The coordinate frame must be screenshot-friendly: front / side / top / iso views should expose the key features.
8. Conflict priority: if "fix rebuild" and "parameterization refactor" conflict, restore \`rebuild_model\` success first.

## Generation Protocol

- **Simple Models:** Generate all geometry in a single pass (e.g. cylinder + hole + polar array of holes) and rebuild.
- **Complex Models (Two-Pass):** When creating heavily detailed models, build primary structure in Pass 1, verify with rebuild_model and screenshot_model, then add secondary features (fillets, chamfers, small cutouts) in Pass 2.

## Phased Workflow

1. Understand requirements: target geometry, dimensions, constraints.
2. Plan parameters first, declare the coordinate frame and viewing orientation.
3. Generate the structure (use single pass for simple parts, two passes for complex).
4. Build with \`rebuild_model({ model })\`; if it fails, follow failure recovery.
5. Validate with screenshots and numeric checks silently.
6. In the final answer, be extremely brief. Do not summarize your internal self-checks.

## Failure Recovery (when rebuild_model fails)

Follow this exact order:
1. Read \`stderr\` and locate the first deterministic error.
2. Apply the smallest possible fix (no unrelated refactor).
3. Immediately run \`rebuild_model({ model })\` again.
4. If parameterization cleanup conflicts with rebuild fix, prioritize rebuild success first and postpone refactor.
5. After success, then re-check with \`get_model_info\` / \`screenshot_model\` before final answer and style self-check.

## Validation Policy (important)

{validationPolicy}

## Project Layout

MCP is provided by **AI CAD Companion Viewer** while it is running. Any IDE-side MCP or companion rule files for a specific agent are created when you launch that agent from the viewer (not listed here).

\`\`\`
./
|- .aicad/project.json         (kernel metadata: kernel = {label})
|- models/
|  |- <model_name>/
|  |  |- {sourceFileHint}      (model source, must define global result)
|  |  |- README.md             (model description)
|- .cache/                     (viewer screenshots and transient artifacts, auto-generated, ignore in git)
\`\`\`

{mustFollow}

{mcpToolsSection}
`;

function renderTemplate(template, vars) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

function buildVars(kernel, agentHint = '') {
  const k = assertKernel(kernel);
  const meta = kernelMeta(k);
  if (meta.previewFormat !== 'BREP') {
    throw new Error(`Unsupported kernel for rules template: ${meta.label} (BREP only)`);
  }
  const bundle = kernelPromptBundle(k);
  const ext = meta.sourceFile.replace(/^[^.]+/, '');
  const sourceFileHint = `part${ext} or asm.urdf`;
  return {
    label: meta.label,
    language: meta.language,
    sourceFileHint,
    previewFormat: meta.previewFormat,
    cacheExt: meta.cacheExt,
    expertise: kernelExpertise(k),
    validationPolicy: bundle.validationPolicyLines,
    mustFollow: bundle.mustFollowLines,
    mcpToolsSection: renderTemplate(MCP_TOOLS_SECTION_TEMPLATE, { sourceFileHint }),
    agentHintBlock: agentHint ? `\n> This file is generated by AI CAD Companion Viewer for **${agentHint}**.\n` : '',
    codexQuickBlock: agentHint === 'OpenAI Codex'
      ? CODEX_MCP_QUICK_BLOCK
      : ''
  };
}

function cursorRulesTemplate(kernel) {
  const vars = buildVars(kernel, 'Cursor');
  return (
    renderTemplate(CURSOR_MDC_FRONTMATTER_TEMPLATE, vars) +
    renderTemplate(CORE_RULES_TEMPLATE, vars)
  );
}

function coreRulesMarkdown(agentHint, kernel) {
  return renderTemplate(CORE_RULES_TEMPLATE, buildVars(kernel, agentHint));
}

function agentsMdTemplate(kernel) {
  return coreRulesMarkdown('AI Agent', kernel) + CODEX_INSTRUCTION_META;
}

function claudeMdTemplate(kernel) {
  return coreRulesMarkdown('Claude Code', kernel);
}

function geminiMdTemplate(kernel) {
  return coreRulesMarkdown('Gemini CLI', kernel);
}

function copilotInstructionsTemplate(kernel) {
  return coreRulesMarkdown('GitHub Copilot', kernel);
}

module.exports = {
  CURSOR_PROJECT_RULE_FILE,
  cursorRulesTemplate,
  agentsMdTemplate,
  claudeMdTemplate,
  geminiMdTemplate,
  copilotInstructionsTemplate
};
