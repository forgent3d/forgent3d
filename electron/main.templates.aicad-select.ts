// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');

function readAicadSelectPython() {
  const candidates = [
    path.join(__dirname, 'aicad_select.py'),
    path.join(__dirname, '..', '..', 'electron', 'aicad_select.py'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'aicad_select.py'),
  ];
  const filePath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!filePath) {
    throw new Error('Missing bundled selection helper: electron/aicad_select.py');
  }
  return fs.readFileSync(filePath, 'utf8');
}

const AICAD_SELECT_PYTHON = readAicadSelectPython();
const AICAD_SELECT_FILENAME = 'aicad_select.py';

module.exports = {
  AICAD_SELECT_PYTHON,
  AICAD_SELECT_FILENAME
};
