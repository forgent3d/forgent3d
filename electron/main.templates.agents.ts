'use strict';

// @ts-nocheck
export {};
const {
  CODEX_INSTRUCTION_META
} = require('./main.templates.prompts.mcp');

const {
  ALL_SKILLS,
  agentBlocks
} = require('./main.templates.skills');

function getAgentSkills(agentHint) {
  return ALL_SKILLS.map(skill => {
    let relativePath, content;
    const name = skill.filename.replace('.mdc', '').replace('skill-', '');
    
    if (agentHint === 'Cursor') {
      relativePath = `.cursor/rules/${skill.filename}`;
      let frontmatter = `---\ndescription: "${skill.description}"\nglobs: "${skill.globs}"\n`;
      if (skill.alwaysApply) {
        frontmatter += `alwaysApply: true\n`;
      }
      frontmatter += `---\n\n`;
      content = frontmatter + `# ${skill.description.split(':')[0] || skill.filename}\n\n` + skill.content;
      
    } else if (agentHint === 'Claude Code') {
      relativePath = `.claude/rules/${name}.md`;
      let frontmatter = `---\ndescription: "${skill.description}"\npaths: "${skill.globs}"\n---\n\n`;
      content = frontmatter + `# ${skill.description.split(':')[0] || name}\n\n` + skill.content;
      
    } else if (agentHint === 'OpenAI Codex') {
      relativePath = `.agents/skills/${name}/SKILL.md`;
      content = [
        '---',
        `description: "${skill.description}"`,
        '---',
        '',
        `# ${skill.description.split(':')[0] || name}`,
        '',
        skill.content
      ].join('\n');
    }
    
    return { relativePath, content };
  });
}

function baseMarkdown(agentHint) {
  const { agentHintBlock, codexQuickBlock } = agentBlocks(agentHint);
  let md = `# AI CAD Project Rules (build123d)${agentHintBlock}${codexQuickBlock}\n`;
  md += `You are an expert in **build123d**.\n\n> **Current CAD kernel: build123d (Python)**\n> Geometry source: \`models/<name>/part.py\` + \`params.json\` for single bodies, \`models/<name>/asm.xml\` + \`params.json\` for assemblies; preview output format: \`BREP\` for parts.\n\n`;
  if (agentHint === 'Claude Code') {
     md += `> Detailed rules and workflows are located in \`.claude/rules/\`.\n`;
  } else if (agentHint === 'OpenAI Codex') {
     md += `> Detailed skills and workflows are located in \`.agents/skills/\`.\n`;
  }
  return md;
}

function combinedMarkdown(agentHint) {
  let md = baseMarkdown(agentHint);
  ALL_SKILLS.forEach(skill => {
    md += `---\n\n`;
    md += skill.content + `\n`;
  });
  return md;
}

function codexSkillsIndexMarkdown() {
  return [
    '## Core Operating Rules',
    '',
    '- The deliverable for CAD requests is editable geometry source code, not images.',
    '- Current CAD kernel: build123d (Python). Single-body source files live under `models/<name>/part.py` with tunable values in `models/<name>/params.json`.',
    '- Use `asm.xml` + `params.json` for complex multi-part systems, articulated mechanisms, vehicles, robots, drones, or separable components; do not collapse these into one monolithic `part.py`.',
    '- Validate generated CAD only through AI CAD Companion Viewer MCP tools: edit source -> `rebuild_model` -> inspect result -> optional screenshot/info.',
    '- Do not run `python part.py`, `python -m`, `pytest`, `uv run`, or other local Python validation for generated CAD code.',
    '- If MCP is unavailable, ask the user to start AI CAD Companion Viewer instead of using a local Python fallback.',
    '- Keep tunable dimensions in `params.json`; source files should read or substitute those values before geometry construction.',
    '- For assembly-ready parts, compute anchors/connection facts in `part.py` as a global `metadata` dict; the viewer export runner writes `models/<name>/metadata.json` after rebuild.',
    '',
    '## Detailed Skills',
    '',
    'Read the relevant project skill before substantial CAD work:',
    '',
    '- `.agents/skills/core/SKILL.md` - core project rules, layout, and validation policy.',
    '- `.agents/skills/build123d/SKILL.md` - build123d syntax, parameterization, and modeling policy.',
    '- `.agents/skills/mjcf/SKILL.md` - MJCF assembly and kinematic rules.',
    '- `.agents/skills/mcp-workflow/SKILL.md` - MCP tool workflow, accuracy contract, and failure recovery.',
    ''
  ].join('\n');
}

function agentsMdTemplate() {
  return baseMarkdown('OpenAI Codex') + codexSkillsIndexMarkdown() + CODEX_INSTRUCTION_META;
}

function claudeMdTemplate() {
  return baseMarkdown('Claude Code');
}

function copilotInstructionsTemplate() {
  return combinedMarkdown('GitHub Copilot');
}

module.exports = {
  getAgentSkills,
  agentsMdTemplate,
  claudeMdTemplate,
  copilotInstructionsTemplate
};
