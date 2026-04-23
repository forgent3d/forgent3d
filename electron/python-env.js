/**
 * Python environment management module
 * ---------------------
 * - Auto-detect available Python interpreters (including Windows `python`/`py`/Store shims)
 * - If PATH Python lacks build123d, also try conda (configured env name + default aicad)
 * - Allow manual python.exe selection and persist to userData/aicad-config.json
 * - Detect conda availability and support one-click conda env creation with build123d install
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

/* ---------------- Config persistence ---------------- */

function configPath() {
  return path.join(app.getPath('userData'), 'aicad-config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

/* ---------------- Utility: run child process and capture output ---------------- */

function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? err.errno ?? -1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err || null
      });
    });
  });
}

/**
 * Stream command output via onLog callback in real time.
 * Returns Promise<{code, stderr}>.
 */
function runStream(cmd, args, { cwd, onLog, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true });
    let stderrBuf = '';
    child.stdout.on('data', (d) => onLog?.(d.toString().trimEnd(), 'info'));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrBuf += s;
      onLog?.(s.trimEnd(), 'warn');
    });
    child.on('error', (err) => {
      onLog?.(`Execution failed: ${err.message}`, 'error');
      resolve({ code: -1, stderr: err.message });
    });
    child.on('close', (code) => resolve({ code, stderr: stderrBuf }));
  });
}

/* ---------------- Python detection ---------------- */

/**
 * Test whether a Python invocation spec is truly usable.
 * spec: {cmd, args}, e.g. {cmd:'python', args:[]} or {cmd:'py', args:['-3']}
 * Success: exit code 0 and stdout/stderr contains "Python " (avoid Windows Store shims).
 */
async function probePython(spec) {
  const opts = spec.cmd === 'conda' ? { timeout: 25000 } : {};
  const res = await runCapture(spec.cmd, [...spec.args, '--version'], opts);
  if (res.code !== 0) return null;
  const text = (res.stdout + res.stderr).trim();
  const m = /Python\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  return { ...spec, version: m[1], versionText: text };
}

/**
 * Find available Python by priority:
 *   1. User-specified absolute path in config
 *   2. PATH Python that already has build123d (e.g. after conda activate)
 *   3. conda env from config condaEnvName, then default aicad
 *   4. Any PATH Python (used for guidance if build123d missing)
 *   5. Windows py -3
 * Returns null if nothing is found.
 */
async function detectPython(options = {}) {
  const requireBuild123d = !!options.requireBuild123d;
  const cfg = loadConfig();
  if (cfg.pythonPath && fs.existsSync(cfg.pythonPath)) {
    const ok = await probePython({ cmd: cfg.pythonPath, args: [] });
    if (ok && (!requireBuild123d || await checkModule(ok, 'build123d'))) {
      return { ...ok, source: 'user' };
    }
  }

  const candidates = IS_WIN
    ? [{ cmd: 'python', args: [] }, { cmd: 'python3', args: [] }, { cmd: 'py', args: ['-3'] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];

  for (const c of candidates) {
    const ok = await probePython(c);
    if (ok && (await checkModule(ok, 'build123d'))) {
      return { ...ok, source: 'path' };
    }
  }

  const conda = await detectConda();
  if (conda) {
    const envNames = [];
    const named = typeof cfg.condaEnvName === 'string' ? cfg.condaEnvName.trim() : '';
    if (named) envNames.push(named);
    envNames.push('aicad');
    const seen = new Set();
    for (const name of envNames) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const spec = {
        cmd: 'conda',
        args: ['run', '--no-capture-output', '-n', name, 'python']
      };
      const ok = await probePython(spec);
      if (ok && (await checkModule(spec, 'build123d'))) {
        return { ...ok, source: 'conda', condaEnv: name };
      }
    }
  }

  if (requireBuild123d) return null;

  for (const c of candidates) {
    const ok = await probePython(c);
    if (ok) return { ...ok, source: 'path' };
  }
  return null;
}

/**
 * Return full current Python status (for frontend panel display).
 */
async function getPythonStatus() {
  const spec = await detectPython();
  if (!spec) {
    return {
      ok: false,
      message: IS_WIN
        ? 'No available Python detected. Install Python, or create an environment with conda below.'
        : 'No available Python3 detected. Install Python3 or configure one below.'
    };
  }
  const hasBuild123d = await checkModule(spec, 'build123d');
  return {
    ok: true,
    cmd: spec.cmd,
    args: spec.args,
    version: spec.version,
    versionText: spec.versionText,
    source: spec.source,
    condaEnv: spec.condaEnv || null,
    hasBuild123d
  };
}

async function checkModule(spec, moduleName) {
  const opts = spec.cmd === 'conda' ? { timeout: 25000 } : {};
  const res = await runCapture(spec.cmd, [...spec.args, '-c', `import ${moduleName}`], opts);
  return res.code === 0;
}

/* ---------------- Conda ---------------- */

async function detectConda() {
  const res = await runCapture('conda', ['--version']);
  if (res.code !== 0) return null;
  const text = (res.stdout + res.stderr).trim();
  return { version: text };
}

/**
 * Create conda env and optionally install build123d, then save this env's python executable
 * path into config as default Python.
 */
async function createCondaEnv({ envName, pythonVersion, installBuild123d, onLog }) {
  envName = (envName || 'aicad').trim();
  pythonVersion = (pythonVersion || '3.11').trim();

  const conda = await detectConda();
  if (!conda) throw new Error('Conda not detected. Please install Miniconda or Anaconda and add it to PATH.');

  onLog?.(`[conda] ${conda.version}, preparing to create env "${envName}" (python=${pythonVersion})`);

  // 1) Create environment
  const r1 = await runStream('conda',
    ['create', '-n', envName, `python=${pythonVersion}`, '-y'],
    { onLog });
  if (r1.code !== 0) throw new Error(`conda create failed (exit code ${r1.code})`);

  // 2) Install build123d (optional)
  if (installBuild123d) {
    onLog?.('[conda] Installing build123d into new environment (first run may take longer)...');
    const r2 = await runStream('conda',
      ['run', '--no-capture-output', '-n', envName, 'pip', 'install', 'build123d'],
      { onLog });
    if (r2.code !== 0) {
      onLog?.('build123d installation failed, but environment was created. You can still install it manually.', 'warn');
    }
  }

  // 3) Get absolute Python path from new environment
  const r3 = await runCapture('conda',
    ['run', '--no-capture-output', '-n', envName, 'python', '-c',
      'import sys;print(sys.executable)']);
  const pyPath = r3.stdout.trim().split(/\r?\n/).pop();
  if (!pyPath || !fs.existsSync(pyPath)) {
    throw new Error('Environment was created but python.exe could not be found in it');
  }

  const cfg = loadConfig();
  cfg.pythonPath = pyPath;
  cfg.condaEnvName = envName;
  saveConfig(cfg);
  onLog?.(`[conda] Environment creation completed, switched to: ${pyPath}`, 'info');
  return pyPath;
}

/* ---------------- Manually set Python path ---------------- */

async function setPythonPath(pythonPath) {
  if (!pythonPath) {
    const cfg = loadConfig();
    delete cfg.pythonPath;
    saveConfig(cfg);
    return { ok: true, cleared: true };
  }
  if (!fs.existsSync(pythonPath)) throw new Error(`Path does not exist: ${pythonPath}`);
  const ok = await probePython({ cmd: pythonPath, args: [] });
  if (!ok) throw new Error('This path is not a valid Python interpreter (--version returned no output)');
  const cfg = loadConfig();
  cfg.pythonPath = pythonPath;
  saveConfig(cfg);
  return { ok: true, version: ok.version };
}

module.exports = {
  loadConfig,
  saveConfig,
  detectPython,
  getPythonStatus,
  detectConda,
  createCondaEnv,
  setPythonPath,
  runStream,
  runCapture
};
