// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');

const runnerPath = path.join(
  path.dirname(require.resolve('@forgent3d/cad-runtime/package.json')),
  'python',
  'export_runner.py'
);

const EXPORT_RUNNER_PYTHON = fs.readFileSync(runnerPath, 'utf8');

module.exports = {
  EXPORT_RUNNER_PYTHON
};
