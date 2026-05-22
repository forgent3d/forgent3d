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
  md += `Current CAD kernel: **build123d (Python)** with bundled **bd_warehouse** standard parts. Each model is a self-contained package at \`models/<model>/\` with root \`asm.xml\` + \`params.json\` and local parts under \`models/<model>/parts/<part>/part.py\` + \`params.json\`. Validate through the viewer MCP tools.\n\n`;
  md += `Parameter ownership: root \`models/<model>/params.json\` is for assembly-level placement, motion, constraints, anchors, and \`__viewer\` appearance only. Do not put local part geometry knobs such as teeth, bore, thickness, radius, hole sizes, or feature counts in root params for \`asm.xml\`; those belong in the matching \`models/<model>/parts/<part>/params.json\` and are read by \`part.py\`.\n\n`;
  md += `Use \`bd_warehouse\` for standard hardware such as screws, washers, bearings, gears, pipes, and flanges; use native build123d for custom brackets, plates, housings, and adapters.\n\n`;
  if (agentHint === 'Claude Code') {
     md += `Detailed rules are located in \`.claude/rules/\`.\n`;
  } else if (agentHint === 'OpenAI Codex') {
     md += `Detailed skills are located in \`.agents/skills/\`.\n`;
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
    '## Detailed Skills',
    '',
    'Read only the relevant project skill before substantial CAD work:',
    '',
    '- `.agents/skills/core/SKILL.md` - project layout, model selection, validation, and materials.',
    '- `.agents/skills/build123d/SKILL.md` - single-body build123d syntax and modeling policy.',
    '- `.agents/skills/mjcf/SKILL.md` - assembly, anchors, constraints, and motion rules.',
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
