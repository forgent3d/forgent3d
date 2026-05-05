#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
function loadExportRunnerPython() {
  const compiledTemplate = path.join(__dirname, '..', 'dist-electron', 'electron', 'main.templates.export-runner.js');
  if (fs.existsSync(compiledTemplate)) {
    return require(compiledTemplate).EXPORT_RUNNER_PYTHON;
  }
  throw new Error('Missing compiled Electron templates. Run `npm run build:electron` before `npm run build:runner`.');
}

const EXPORT_RUNNER_PYTHON = loadExportRunnerPython();

const REPO_ROOT = path.resolve(__dirname, '..');
const PLATFORM_TAG = `${process.platform}-${process.arch}`;
const RUNNER_BASENAME = 'aicad-export-runner';
const RUNNER_FILENAME = process.platform === 'win32'
  ? `${RUNNER_BASENAME}.exe`
  : RUNNER_BASENAME;
const OUT_DIR = path.join(REPO_ROOT, 'vendor', 'export-runner', PLATFORM_TAG);
const OUT_BUNDLE_DIR = path.join(OUT_DIR, RUNNER_BASENAME);
const BUILD_ROOT = path.join(REPO_ROOT, 'build-cache', 'embedded-runner', PLATFORM_TAG);
const VENV_DIR = path.join(BUILD_ROOT, 'venv');
const SRC_DIR = path.join(BUILD_ROOT, 'src');
const WORK_DIR = path.join(BUILD_ROOT, 'pyinstaller-work');
const SPEC_DIR = path.join(BUILD_ROOT, 'pyinstaller-spec');
const SCRIPT_PATH = path.join(SRC_DIR, 'export_runner.py');
const REQUIREMENTS_PATH = path.join(__dirname, 'embedded-runner-requirements.txt');
const METADATA_PATH = path.join(OUT_DIR, 'metadata.json');

function log(message) {
  process.stdout.write(`[build:runner] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[build:runner] ${message}\n`);
  process.exit(1);
}

function runOrThrow(cmd, args, options = {}) {
  const printable = [cmd, ...args].join(' ');
  log(`> ${printable}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${printable} exited with code ${result.status}`);
  }
}

function canRun(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim();
}

function parsePythonVersion(versionText) {
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/i.exec(versionText || '');
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function isSupportedHostPython(versionText) {
  const parsed = parsePythonVersion(versionText);
  if (!parsed) return false;
  return parsed.major === 3 && parsed.minor === 13;
}

function findHostPython() {
  const override = (process.env.AICAD_PYTHON_BIN || '').trim();
  if (override) {
    const version = canRun(override, ['--version']);
    if (!version) fail(`AICAD_PYTHON_BIN is not usable: ${override}`);
    if (!isSupportedHostPython(version)) {
      fail(`AICAD_PYTHON_BIN points to unsupported Python (${version}). Please use Python 3.13.`);
    }
    return { cmd: override, args: [], version };
  }

  const candidates = process.platform === 'win32'
    ? [
        { cmd: 'py', args: ['-3.13'] },
        { cmd: 'python', args: [] },
        { cmd: 'python3', args: [] },
        { cmd: 'py', args: ['-3'] }
      ]
    : [
        { cmd: 'python3', args: [] },
        { cmd: 'python', args: [] }
      ];

  let fallback = null;
  for (const candidate of candidates) {
    const version = canRun(candidate.cmd, [...candidate.args, '--version']);
    if (!version) continue;
    if (isSupportedHostPython(version)) {
      return { ...candidate, version };
    }
    if (!fallback) fallback = { ...candidate, version };
  }
  if (fallback) {
    fail(`Detected unsupported Python for embedded runner: ${fallback.version}. Please install/use Python 3.13.`);
  }
  return null;
}

function venvPythonPath() {
  return process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python3');
}

function ensureRunnerSource() {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(SCRIPT_PATH, EXPORT_RUNNER_PYTHON, 'utf8');
}

function prepareVirtualenv(hostPython) {
  fs.mkdirSync(BUILD_ROOT, { recursive: true });
  runOrThrow(hostPython.cmd, [...hostPython.args, '-m', 'venv', '--clear', VENV_DIR], {
    cwd: REPO_ROOT
  });
  const py = venvPythonPath();
  runOrThrow(py, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
    cwd: REPO_ROOT
  });
  runOrThrow(py, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH], {
    cwd: REPO_ROOT
  });
  return py;
}

function buildRunner(venvPython) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(SPEC_DIR, { recursive: true, force: true });

  const args = [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--name',
    RUNNER_BASENAME,
    '--distpath',
    OUT_DIR,
    '--workpath',
    WORK_DIR,
    '--specpath',
    SPEC_DIR,
    '--collect-all',
    'build123d',
    '--collect-all',
    'OCP',
    '--collect-all',
    'lib3mf',
    SCRIPT_PATH
  ];

  runOrThrow(venvPython, args, { cwd: REPO_ROOT });
}

function writeMetadata(hostPython) {
  fs.writeFileSync(METADATA_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    bundleMode: 'onedir',
    runner: RUNNER_FILENAME,
    runnerPath: path.join(RUNNER_BASENAME, RUNNER_FILENAME),
    hostPython: {
      cmd: hostPython.cmd,
      args: hostPython.args,
      version: hostPython.version
    },
    requirementsFile: path.basename(REQUIREMENTS_PATH)
  }, null, 2));
}

function main() {
  const hostPython = findHostPython();
  if (!hostPython) {
    fail('No usable Python 3 found for building the embedded runner.');
  }

  log(`Using host Python: ${hostPython.version}`);
  ensureRunnerSource();
  const venvPython = prepareVirtualenv(hostPython);
  buildRunner(venvPython);
  writeMetadata(hostPython);

  const builtRunner = path.join(OUT_BUNDLE_DIR, RUNNER_FILENAME);
  if (!fs.existsSync(builtRunner)) {
    fail(`Runner was not generated: ${builtRunner}`);
  }
  log(`Embedded runner ready: ${builtRunner}`);
}

main();
