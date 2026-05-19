// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');

function readSkillHelper(filename) {
  const candidates = [
    path.join(__dirname, 'skill-helpers', filename),
    path.join(__dirname, '..', '..', 'electron', 'skill-helpers', filename),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'skill-helpers', filename),
  ];
  const filePath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!filePath) {
    throw new Error(`Missing bundled skill helper: electron/skill-helpers/${filename}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

const AICAD_SELECT_PYTHON = readSkillHelper('aicad_select.py');
const AICAD_SELECT_FILENAME = 'aicad_select.py';
const AICAD_ATTACH_PYTHON = readSkillHelper('aicad_attach.py');
const AICAD_ATTACH_FILENAME = 'aicad_attach.py';

/** @type {{ filename: string, source: string }[]} */
const SKILL_HELPER_MODULES = [
  { filename: AICAD_SELECT_FILENAME, source: AICAD_SELECT_PYTHON },
  { filename: AICAD_ATTACH_FILENAME, source: AICAD_ATTACH_PYTHON },
];

module.exports = {
  AICAD_SELECT_PYTHON,
  AICAD_SELECT_FILENAME,
  AICAD_ATTACH_PYTHON,
  AICAD_ATTACH_FILENAME,
  SKILL_HELPER_MODULES,
};
