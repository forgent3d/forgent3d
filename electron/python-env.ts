// @ts-nocheck
export {};
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

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

/* ---------------- Python detection ---------------- */

/**
 * Test whether a Python invocation spec is truly usable.
 * spec: {cmd, args}, e.g. {cmd:'python', args:[]} or {cmd:'py', args:['-3']}
 * Success: exit code 0 and stdout/stderr contains "Python " (avoid Windows Store shims).
 */
async function probePython(spec) {
  const res = await runCapture(spec.cmd, [...spec.args, '--version']);
  if (res.code !== 0) return null;
  const text = (res.stdout + res.stderr).trim();
  const m = /Python\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  return { ...spec, version: m[1], versionText: text };
}

async function detectPython(options = {}) {
  const requireBuild123d = !!options.requireBuild123d;
  const cfg = loadConfig();
  if (cfg.pythonPath && fs.existsSync(cfg.pythonPath)) {
    const ok = await probePython({ cmd: cfg.pythonPath, args: [] });
    if (ok && (!requireBuild123d || await checkModule(ok, 'build123d'))) {
      return { ...ok, source: 'user' };
    }
  }

  const candidates = process.platform === 'win32'
    ? [{ cmd: 'python', args: [] }, { cmd: 'python3', args: [] }, { cmd: 'py', args: ['-3'] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];

  for (const c of candidates) {
    const ok = await probePython(c);
    if (ok && (await checkModule(ok, 'build123d'))) {
      return { ...ok, source: 'path' };
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
      message: process.platform === 'win32'
        ? 'No available Python detected. Install Python or select python.exe manually.'
        : 'No available Python3 detected. Install Python3 or configure one manually.'
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
    hasBuild123d
  };
}

async function checkModule(spec, moduleName) {
  const res = await runCapture(spec.cmd, [...spec.args, '-c', `import ${moduleName}`]);
  return res.code === 0;
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
  setPythonPath,
  runCapture
};
