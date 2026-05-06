// @ts-nocheck
export {};
/**
 * Forgent3D Forgent3D companion previewer -- embedded terminal manager
 * --------------------------------------------------
 * Create pseudo-terminal (PTY) sessions in main process via node-pty, and communicate with renderer xterm.js through IPC.
 *
 * IPC handlers（invoke）：
 *   terminal:create  → { agent, projectPath, cols?, rows? } → { termId, cmd }
 *   terminal:write   → { termId, data }
 *   terminal:resize  → { termId, cols, rows }
 *   terminal:kill    → { termId }
 *
 * Optional third argument: hooks.onBeforeTerminalCreate({ agent, projectPath }) — runs after PATH
 * checks, before the PTY is spawned (e.g. to write agent-specific project files).
 *
 * Push events (sendToRenderer):
 *   TERM_DATA  { termId, data }      PTY output chunk
 *   TERM_EXIT  { termId, exitCode }  PTY process exited
 */

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** All agents here run through the same PTY flow. */
const AGENT_CMDS = {
  codex:  'codex',
  claude: 'claude',
  cli:    'agent'
};

const AGENT_FALLBACK_SHELL_CMDS = {
  claude: 'npx -y @anthropic-ai/claude-code'
};

/** Friendly name + official install/setup docs when the executable is missing from PATH */
const AGENT_CLI_DOCS = {
  cli:    { label: 'Cursor CLI', url: 'https://cursor.com/cli' },
  claude: { label: 'Claude Code', url: 'https://code.claude.com/docs/en/setup' },
  codex:  { label: 'OpenAI Codex CLI', url: 'https://developers.openai.com/codex/cli' }
};

function buildProcessEnvWithWindowsPathFixes(baseEnv = process.env) {
  if (process.platform !== 'win32') return { ...baseEnv };

  const env = { ...baseEnv };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const currentPath = String(env[pathKey] || '');
  const sep = ';';
  const currentEntries = currentPath.split(sep).map((p) => p.trim()).filter(Boolean);
  const normalized = new Set(currentEntries.map((p) => p.toLowerCase()));
  if (!_windowsPathPatchCache) {
    const candidates = [
      // npm -g default bin (most common install location for `agent`)
      env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
      env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming', 'npm') : ''
    ].filter(Boolean);

    // Merge PATH entries from Windows registry as desktop-launched Electron may miss refreshed user PATH.
    const regQueries = [
      ['query', 'HKCU\\Environment', '/v', 'Path'],
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path']
    ];
    for (const args of regQueries) {
      try {
        const out = spawnSync('reg', args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8'
        });
        if (out.status !== 0 || !out.stdout) continue;
        const lines = String(out.stdout).split(/\r?\n/);
        for (const line of lines) {
          if (!/\bPath\b/i.test(line) || !/\bREG_/i.test(line)) continue;
          const m = line.match(/\bREG_\w+\s+(.+)$/i);
          if (!m?.[1]) continue;
          const regPathRaw = m[1].trim();
          if (!regPathRaw) continue;
          const expanded = regPathRaw.replace(/%([^%]+)%/g, (_, name) => env[name] || `%${name}%`);
          for (const p of expanded.split(sep).map((v) => v.trim()).filter(Boolean)) {
            candidates.push(p);
          }
        }
      } catch {
        // Ignore registry read failures and continue with best-effort PATH merge.
      }
    }
    _windowsPathPatchCache = candidates;
  }

  for (const dir of _windowsPathPatchCache) {
    if (normalized.has(dir.toLowerCase())) continue;
    currentEntries.push(dir);
    normalized.add(dir.toLowerCase());
  }

  env[pathKey] = currentEntries.join(sep);
  return env;
}

function missingCliErrorMessage(agent, cmd) {
  const meta = AGENT_CLI_DOCS[agent];
  const label = meta?.label ?? agent;
  const urlLine = meta?.url
    ? `\nInstall & docs: ${meta.url}`
    : '';
  return (
    `Command "${cmd}" (${label}) was not found on PATH. Install the matching CLI and ensure this app can run that command. If it works in an external terminal but fails here, the app often inherits a different PATH when launched from the desktop (for example, missing the npm global bin directory).` +
    urlLine
  );
}

/** termId → { ptyProcess, agent } */
const sessions = new Map();

let _sendToRenderer = null;
let nodePty = null;
let fixedSpawnHelper = false;
let _windowsPathPatchCache = null;

// Cached PATH resolved from the user's login shell (computed once, async-safely).
let _loginShellPath = null;

// Well-known bin dirs that should be on PATH on macOS/Linux but are often missed
// when the app is launched from Finder/Dock (which inherits launchd's minimal PATH).
// Most importantly nvm: the official installer wires nvm into ~/.zshrc, which is NOT
// sourced by `zsh -lc` (non-interactive), so a desktop-launched Electron app can't
// see node/codex/claude installed via `nvm install -g ...`.
function getUnixCandidatePathDirs() {
  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ];
  try {
    const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      const versions = fs.readdirSync(versionsDir).sort().reverse();
      for (const ver of versions) {
        const binDir = path.join(versionsDir, ver, 'bin');
        if (fs.existsSync(binDir)) candidates.push(binDir);
      }
    }
  } catch {
    // Best-effort enumeration; ignore failures.
  }
  return candidates;
}

const _PATH_MARK_START = '___AICAD_PATH_START___';
const _PATH_MARK_END = '___AICAD_PATH_END___';

function probeShellPath(shell, shellArgs) {
  try {
    const r = spawnSync(shell, shellArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      env: process.env,
      timeout: 5000
    });
    if (!r.stdout) return '';
    const out = String(r.stdout);
    const start = out.indexOf(_PATH_MARK_START);
    const end = out.indexOf(_PATH_MARK_END, start + _PATH_MARK_START.length);
    if (start !== -1 && end !== -1) {
      return out.slice(start + _PATH_MARK_START.length, end).trim();
    }
    if (r.status === 0) return out.trim();
    return '';
  } catch {
    return '';
  }
}

function getLoginShellPath() {
  if (_loginShellPath !== null) return _loginShellPath;
  const shell = process.env.SHELL || '/bin/zsh';
  // Markers let us extract PATH cleanly even if .zshrc/.bashrc prints other stuff.
  const probeCmd = `printf '%s%s%s' '${_PATH_MARK_START}' "$PATH" '${_PATH_MARK_END}'`;

  // Try interactive+login first so .zshrc / .bashrc (where nvm typically lives)
  // is sourced. Fall back to plain login shell, then to process.env.PATH.
  let probed = probeShellPath(shell, ['-ilc', probeCmd]);
  if (!probed) probed = probeShellPath(shell, ['-lc', probeCmd]);
  if (!probed) probed = process.env.PATH || '';

  const sep = ':';
  const entries = probed.split(sep).map((p) => p.trim()).filter(Boolean);
  const seen = new Set(entries.map((p) => p));
  for (const dir of getUnixCandidatePathDirs()) {
    if (seen.has(dir)) continue;
    try {
      if (!fs.existsSync(dir)) continue;
    } catch {
      continue;
    }
    entries.push(dir);
    seen.add(dir);
  }
  _loginShellPath = entries.join(sep);
  return _loginShellPath;
}

function hasCommandOnWindows(command) {
  try {
    const r = spawnSync('where', [command], {
      windowsHide: true,
      stdio: 'ignore',
      env: buildProcessEnvWithWindowsPathFixes(process.env)
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function hasCommand(command) {
  if (!command) return false;
  if (process.platform === 'win32') return hasCommandOnWindows(command);
  return hasCommandOnUnix(command);
}

function resolveAgentCommand(agent) {
  const primary = AGENT_CMDS[agent];
  if (!primary) throw new Error(`Unknown agent: ${agent}`);
  if (hasCommand(primary)) return primary;

  const fallbackShellCmd = AGENT_FALLBACK_SHELL_CMDS[agent];
  if (!fallbackShellCmd) {
    throw new Error(missingCliErrorMessage(agent, primary));
  }

  // Fallback shell commands may be compound commands (e.g. npx ...),
  // so we only check whether the executable exists on PATH.
  const fallbackExecutable = fallbackShellCmd.trim().split(/\s+/)[0];
  if (hasCommand(fallbackExecutable)) return fallbackShellCmd;

  throw new Error(missingCliErrorMessage(agent, primary));
}

function pickWindowsShell() {
  // Prefer pwsh (PowerShell 7, more consistent UTF-8) and fallback to Windows PowerShell.
  return hasCommandOnWindows('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
}

function canUseAsCwd(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pickCwd(projectPath) {
  if (canUseAsCwd(projectPath)) return projectPath;
  return os.homedir();
}

function hasCommandOnUnix(command) {
  if (!command) return false;
  // Resolve against the same PATH we'll actually inject into the PTY, instead of
  // re-spawning a shell (which can miss nvm-installed CLIs depending on how the
  // user's rc files are wired up).
  const loginPath = getLoginShellPath();
  const dirs = loginPath.split(':').map((p) => p.trim()).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (canExecuteFile(candidate)) return true;
  }
  return false;
}

function canExecuteFile(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pickUnixShell(defaultShell) {
  const candidates = [
    process.env.SHELL,
    defaultShell,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh'
  ].filter(Boolean);
  for (const sh of candidates) {
    if (canExecuteFile(sh)) return sh;
  }
  throw new Error(`No executable shell found. Tried: ${candidates.join(', ')}`);
}

function ensureNodePtySpawnHelperExecutable() {
  if (fixedSpawnHelper || process.platform === 'win32') return;
  fixedSpawnHelper = true;
  try {
    // node-pty on macOS/Linux uses a helper binary; missing +x causes posix_spawnp failed.
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js');
    const nodePtyRoot = path.resolve(path.dirname(unixTerminalPath), '..');
    const helperPath = path.join(
      nodePtyRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );
    if (fs.existsSync(helperPath)) {
      const st = fs.statSync(helperPath);
      const mode = st.mode & 0o777;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, mode | 0o755);
      }
    }
  } catch {
    // Non-fatal: if this fails, later spawn error will still be surfaced.
  }
}

function tryLoadPty() {
  if (nodePty) return nodePty;
  try {
    nodePty = require('node-pty');
    ensureNodePtySpawnHelperExecutable();
    return nodePty;
  } catch (e) {
    throw new Error(
      `Failed to load node-pty: ${e.message}\n` +
      `Please run: pnpm rebuild node-pty`
    );
  }
}

function init(ipcMain, sendToRenderer, hooks = {}) {
  _sendToRenderer = sendToRenderer;
  const { onBeforeTerminalCreate } = hooks;

  ipcMain.handle('terminal:create', async (_evt, { agent, projectPath, cols = 120, rows = 30 }) => {
    const pty = tryLoadPty();
    const cmd = resolveAgentCommand(agent);
    if (onBeforeTerminalCreate) {
      await onBeforeTerminalCreate({ agent, projectPath });
    }
    const cwd = pickCwd(projectPath);

    let shell, args;
    if (process.platform === 'win32') {
      // UTF-8 encoding fixes on Windows:
      //   1) chcp 65001 -> switch active console codepage to UTF-8.
      //   2) [Console]::OutputEncoding/InputEncoding -> PowerShell I/O in UTF-8.
      //   3) $OutputEncoding -> pipeline strings to child process in UTF-8.
      // -ExecutionPolicy Bypass allows codex/claude to run their own .ps1 scripts.
      // This only fixes encoding, not shell appearance.
      const psInit = [
        'chcp.com 65001 > $null',
        '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
        '[Console]::OutputEncoding = $utf8NoBom',
        '[Console]::InputEncoding  = $utf8NoBom',
        '$OutputEncoding           = $utf8NoBom',
        // Do not force UTF-8 on reads; let PowerShell auto-detect BOM and fallback by system defaults.
        '$PSDefaultParameterValues["Set-Content:Encoding"] = "utf8"',
        '$PSDefaultParameterValues["Add-Content:Encoding"] = "utf8"',
        '$PSDefaultParameterValues["Out-File:Encoding"]    = "utf8"',
        '$PSDefaultParameterValues["Export-Csv:Encoding"]  = "utf8"',
        '$env:PYTHONUTF8           = "1"',
        '$env:PYTHONIOENCODING     = "utf-8"',
        '$env:LANG                 = "C.UTF-8"',
        '$env:LC_ALL               = "C.UTF-8"'
      ].join('; ');
      shell = pickWindowsShell();
      args  = [
        '-NoExit', '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', `${psInit}; & ${cmd}`
      ];
    } else if (process.platform === 'darwin') {
      shell = pickUnixShell('/bin/zsh');
      args  = ['-lc', `${cmd}; exec "${shell}"`];
    } else {
      shell = pickUnixShell('/bin/bash');
      args  = ['-lc', `${cmd}; exec "${shell}"`];
    }

    let ptyProcess;
    try {
      const mergedEnv = buildProcessEnvWithWindowsPathFixes({
        ...process.env,
        // On macOS/Linux the packaged app may inherit a minimal PATH when launched from
        // the Finder/Dock rather than a terminal.  Expand it using the login shell so
        // tools like `claude` and `codex` (installed via npm/brew) are discoverable.
        ...(process.platform !== 'win32' && { PATH: getLoginShellPath() }),
        TERM:             'xterm-256color',
        COLORTERM:        'truecolor',
        // Force Python tools to use UTF-8
        PYTHONUTF8:       '1',
        PYTHONIOENCODING: 'utf-8',
        // Unix/macOS locale encoding
        ...(process.platform !== 'win32' && {
          LANG:   'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8'
        })
      });
      const ptyOptions = {
        name: 'xterm-256color',
        cols: Math.max(40, cols),
        rows: Math.max(10, rows),
        cwd,
        env: mergedEnv
      };
      // node-pty on Windows does not support setting encoding.
      if (process.platform !== 'win32') {
        // Explicit UTF-8 decoding (default, but set explicitly to avoid being overridden)
        ptyOptions.encoding = 'utf8';
      }
      ptyProcess = pty.spawn(shell, args, ptyOptions);
    } catch (e) {
      throw new Error(
        `Failed to create terminal for ${agent}: ${e.message}` +
        ` (shell=${shell}, cwd=${cwd})`
      );
    }

    const termId = randomUUID();
    sessions.set(termId, { ptyProcess, agent });

    ptyProcess.onData((data) => {
      sendToRenderer('TERM_DATA', { termId, data });
    });

    ptyProcess.onExit(({ exitCode }) => {
      sessions.delete(termId);
      sendToRenderer('TERM_EXIT', { termId, exitCode });
    });

    return { termId, agent, cmd };
  });

  ipcMain.handle('terminal:write', (_evt, { termId, data }) => {
    sessions.get(termId)?.ptyProcess.write(data);
  });

  ipcMain.handle('terminal:resize', (_evt, { termId, cols, rows }) => {
    const s = sessions.get(termId);
    const c = Math.max(40, cols);
    const r = Math.max(10, rows);
    if (s) {
      try { s.ptyProcess.resize(c, r); } catch {}
    }
  });

  ipcMain.handle('terminal:kill', (_evt, { termId }) => {
    const s = sessions.get(termId);
    if (s) {
      try { s.ptyProcess.kill(); } catch {}
      sessions.delete(termId);
    }
  });
}

function stopAll() {
  for (const { ptyProcess } of sessions.values()) {
    try { ptyProcess.kill(); } catch {}
  }
  sessions.clear();
}

module.exports = { init, stopAll };
