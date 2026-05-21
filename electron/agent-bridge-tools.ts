// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { detectRunnerPython, pythonChildProcessEnv } = require('./python-env');

const TEXT_FILE_EXTENSIONS = new Set([
  '.py', '.xml', '.json', '.md', '.txt', '.toml', '.yaml', '.yml', '.js', '.ts', '.tsx',
]);
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'dist-electron', 'build-cache', '.cache', '__pycache__', 'vendor',
]);
const BLOCKED_WRITE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'dist-electron', 'build-cache', 'vendor',
]);
const GENERATED_TEXT_FILENAMES = new Set([
  'metadata.json',
]);
const READ_MAX_CHARS = 30000;
const LIST_MAX_ENTRIES_HARDCAP = 2000;
const GREP_MAX_FILE_BYTES = 2_000_000;
const GREP_LINE_PREVIEW_CHARS = 240;
const PYTHON_DEFAULT_TIMEOUT_MS = 15_000;
const PYTHON_MAX_TIMEOUT_MS = 120_000;
const PYTHON_DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const PYTHON_MAX_OUTPUT_CHARS = 120_000;

function textResult(text, isError) {
  const body = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  return {
    isError: !!isError,
    content: [{ type: 'text', text: body }],
  };
}

function safeFileSegment(value, fallback = 'screenshot') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

async function saveAgentScreenshot(projectRoot, model, view, mode, png) {
  if (!projectRoot) return '';
  const screenshotDir = path.join(projectRoot, '.aicad-agent', 'screenshots');
  await fsp.mkdir(screenshotDir, { recursive: true });
  const filename = [
    safeFileSegment(model, 'model'),
    safeFileSegment(mode, 'solid'),
    safeFileSegment(view, 'iso'),
    Date.now().toString(36),
  ].join('.') + '.png';
  const filePath = path.join(screenshotDir, filename);
  await fsp.writeFile(filePath, png);
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveProjectPath(projectRoot, userPath) {
  if (!projectRoot) throw new Error('No project is open in the previewer.');
  if (!userPath || typeof userPath !== 'string') throw new Error('path is required');
  if (path.isAbsolute(userPath)) throw new Error(`Use a relative path within the project, not an absolute path: ${userPath}`);
  const resolved = path.resolve(projectRoot, userPath);
  if (!isInside(projectRoot, resolved)) throw new Error(`Refusing to access outside project: ${userPath}`);
  return resolved;
}

function resolveProjectDir(projectRoot, userPath) {
  const dirPath = resolveProjectPath(projectRoot, userPath || '.');
  const stat = fs.existsSync(dirPath) ? fs.statSync(dirPath) : null;
  if (!stat || !stat.isDirectory()) throw new Error(`Directory does not exist: ${userPath || '.'}`);
  return dirPath;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function appendPythonPath(env, entries) {
  const key = process.platform === 'win32' ? 'PYTHONPATH' : 'PYTHONPATH';
  const existing = env[key] ? String(env[key]) : '';
  const sep = path.delimiter;
  return {
    ...env,
    [key]: [...entries.filter(Boolean), existing].filter(Boolean).join(sep),
  };
}

function trimCapturedOutput(text, maxChars) {
  const body = String(text || '');
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n...[truncated ${body.length - maxChars} chars]`;
}

function isProbablyTextFile(filePath) {
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isGeneratedTextArtifact(filePath) {
  return GENERATED_TEXT_FILENAMES.has(path.basename(filePath).toLowerCase());
}

async function listFiles(projectRoot, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const dir = typeof o.dir === 'string' && o.dir ? o.dir : '.';
  const root = resolveProjectPath(projectRoot, dir);
  const glob = typeof o.glob === 'string' ? o.glob : '';
  const depth = Number.isInteger(o.depth) ? Math.max(-1, o.depth) : 2;
  const limitRaw = Number.isInteger(o.maxResults) && o.maxResults > 0 ? o.maxResults : 200;
  const limit = Math.min(limitRaw, LIST_MAX_ENTRIES_HARDCAP);
  const matchGlob = buildGlobMatcher(glob);

  const entries = [];
  let extra = 0;
  async function walk(current, currentDepth) {
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (IGNORED_DIRS.has(child.name)) continue;
      const full = path.join(current, child.name);
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (child.isDirectory()) {
        if (depth === -1 || currentDepth < depth) await walk(full, currentDepth + 1);
        continue;
      }
      if (!isProbablyTextFile(full)) continue;
      if (isGeneratedTextArtifact(full)) continue;
      if (!matchGlob(rel)) continue;
      if (entries.length < limit) entries.push(rel);
      else extra++;
    }
  }
  await walk(root, 0);
  entries.sort();
  if (!entries.length && !extra) return '(no matching files)';
  let out = entries.join('\n');
  if (extra) out += `\n...[truncated, ${extra} more file${extra === 1 ? '' : 's'} not shown]`;
  return out;
}

async function readFile(projectRoot, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const userPath = typeof o.path === 'string' ? o.path : '';
  if (!userPath) throw new Error('path is required');
  const filePath = resolveProjectPath(projectRoot, userPath);
  if (!isProbablyTextFile(filePath)) throw new Error(`Refusing to read non-text file: ${userPath}`);
  const text = await fsp.readFile(filePath, 'utf8');
  const offset = Number.isInteger(o.offset) && o.offset > 0 ? o.offset : 1;
  const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 0;
  const allLines = text.split(/\r?\n/);
  const startIdx = Math.min(offset - 1, allLines.length);
  const endIdx = limit > 0 ? Math.min(allLines.length, startIdx + limit) : allLines.length;
  const slice = allLines.slice(startIdx, endIdx);
  let out = slice.map((line, i) => `${startIdx + i + 1}\t${line}`).join('\n');
  let charCapped = false;
  if (out.length > READ_MAX_CHARS) {
    out = out.slice(0, READ_MAX_CHARS);
    charCapped = true;
  }
  const more = allLines.length - endIdx;
  const notes = [];
  if (charCapped) notes.push(`output capped at ${READ_MAX_CHARS} chars`);
  if (more > 0) notes.push(`${more} more line${more === 1 ? '' : 's'} after this slice; pass offset=${endIdx + 1} to continue`);
  if (notes.length) out += `\n...[${notes.join('; ')}]`;
  return out;
}

function buildGlobMatcher(pattern) {
  if (!pattern) return () => true;
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { body += '(?:.*/)?'; i += 3; }
        else { body += '.*'; i += 2; }
      } else { body += '[^/]*'; i++; }
    } else if (c === '?') { body += '[^/]'; i++; }
    else if ('\\^$.|+()[]{}'.includes(c)) { body += `\\${c}`; i++; }
    else { body += c; i++; }
  }
  const re = new RegExp(`^${body}$`);
  return (rel) => re.test(rel);
}

async function grepProject(projectRoot, opts) {
  const pattern = String(opts?.pattern || '');
  if (!pattern) throw new Error('pattern is required');
  let re;
  try { re = new RegExp(pattern, opts?.caseInsensitive ? 'i' : ''); }
  catch (e) { throw new Error(`Invalid regex: ${e?.message || e}`); }
  const root = resolveProjectPath(projectRoot, opts?.path || '.');
  const matchGlob = buildGlobMatcher(opts?.glob || '');
  const limit = Number.isInteger(opts?.maxResults) && opts.maxResults > 0 ? opts.maxResults : 100;
  const ctx = Number.isInteger(opts?.context) && opts.context > 0 ? opts.context : 0;
  const results = [];
  let extra = 0;
  let scanned = 0;
  async function walk(current) {
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (IGNORED_DIRS.has(child.name)) continue;
      const full = path.join(current, child.name);
      if (child.isDirectory()) { await walk(full); continue; }
      if (!isProbablyTextFile(full)) continue;
      if (isGeneratedTextArtifact(full)) continue;
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (!matchGlob(rel)) continue;
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.size > GREP_MAX_FILE_BYTES) continue;
      let text;
      try { text = await fsp.readFile(full, 'utf8'); } catch { continue; }
      scanned++;
      const lines = text.split(/\r?\n/);
      if (ctx === 0) {
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (results.length < limit) {
            const raw = lines[i];
            const preview = raw.length > GREP_LINE_PREVIEW_CHARS ? `${raw.slice(0, GREP_LINE_PREVIEW_CHARS)}...` : raw;
            results.push(`${rel}:${i + 1}: ${preview}`);
          } else extra++;
        }
      } else {
        // collect match indices first, then emit groups with context
        const matchIdx = [];
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) matchIdx.push(i);
        }
        let gi = 0;
        while (gi < matchIdx.length) {
          if (results.length >= limit) { extra += matchIdx.length - gi; break; }
          // expand group: merge overlapping context windows
          const groupStart = Math.max(0, matchIdx[gi] - ctx);
          let groupEnd = Math.min(lines.length - 1, matchIdx[gi] + ctx);
          let gj = gi + 1;
          while (gj < matchIdx.length && matchIdx[gj] - ctx <= groupEnd + 1) {
            groupEnd = Math.min(lines.length - 1, matchIdx[gj] + ctx);
            gj++;
          }
          if (results.length > 0) results.push('--');
          for (let i = groupStart; i <= groupEnd; i++) {
            const isMatch = re.test(lines[i]);
            const prefix = isMatch ? `${rel}:${i + 1}:` : `${rel}-${i + 1}-`;
            const raw = lines[i];
            const preview = raw.length > GREP_LINE_PREVIEW_CHARS ? `${raw.slice(0, GREP_LINE_PREVIEW_CHARS)}...` : raw;
            results.push(`${prefix} ${preview}`);
          }
          gi = gj;
        }
      }
    }
  }
  await walk(root);
  if (!results.length) return `(no matches; scanned ${scanned} file${scanned === 1 ? '' : 's'})`;
  let out = results.join('\n');
  if (extra) out += `\n...[truncated, ${extra} more match${extra === 1 ? '' : 'es'}]`;
  return out;
}

function assertWritableTextPath(projectRoot, userPath) {
  const filePath = resolveProjectPath(projectRoot, userPath);
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  const first = rel.split('/')[0];
  if (BLOCKED_WRITE_DIRS.has(first)) throw new Error(`Refusing to write generated or dependency path: ${rel}`);
  if (isGeneratedTextArtifact(filePath)) throw new Error(`Refusing to write generated artifact: ${rel}`);
  if (!isProbablyTextFile(filePath)) throw new Error(`Refusing to write non-text file: ${rel}`);
  return { filePath, rel };
}

async function writeFile(projectRoot, userPath, content, overwrite) {
  const { filePath, rel } = assertWritableTextPath(projectRoot, userPath);
  if (overwrite === false && fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing file (overwrite=false): ${rel}`);
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const body = String(content ?? '');
  await fsp.writeFile(filePath, body, 'utf8');
  return `Wrote ${rel} (${body.length} chars)`;
}

async function replaceInFile(projectRoot, userPath, oldText, newText, replaceAll) {
  const { filePath, rel } = assertWritableTextPath(projectRoot, userPath);
  const search = String(oldText ?? '');
  if (!search) throw new Error('oldText is required and cannot be empty.');
  const current = await fsp.readFile(filePath, 'utf8');
  const matches = current.split(search).length - 1;
  if (matches === 0) throw new Error(`oldText was not found in ${rel}. Read the current file and try a more exact snippet.`);
  if (!replaceAll && matches > 1) throw new Error(`oldText matched ${matches} times in ${rel}. Provide a more specific snippet or set replaceAll=true.`);
  const replacement = String(newText ?? '');
  const firstIdx = current.indexOf(search);
  const next = replaceAll ? current.split(search).join(replacement) : current.replace(search, replacement);
  await fsp.writeFile(filePath, next, 'utf8');
  const n = replaceAll ? matches : 1;

  const startLineNum = current.slice(0, firstIdx).split(/\r?\n/).length;
  const endLineNum = next.slice(0, firstIdx + replacement.length).split(/\r?\n/).length;
  const nextLines = next.split(/\r?\n/);
  const CONTEXT = 2;
  const previewStart = Math.max(1, startLineNum - CONTEXT);
  const previewEnd = Math.min(nextLines.length, endLineNum + CONTEXT);
  const preview = nextLines
    .slice(previewStart - 1, previewEnd)
    .map((line, i) => `${previewStart + i}\t${line}`)
    .join('\n');

  let header = `Replaced ${n} occurrence${n === 1 ? '' : 's'} in ${rel} (${next.length} chars).`;
  if (replaceAll && matches > 1) header += ` First replacement site:`;
  else header += ` Edited region:`;
  return `${header}\n${preview}`;
}

function archetypesDir() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'cad-agent', 'lib', 'aicad-agent', 'skills', 'archetypes'),
    path.resolve(__dirname, '..', '..', '..', 'cad-agent', 'lib', 'aicad-agent', 'skills', 'archetypes'),
    process.resourcesPath ? path.join(process.resourcesPath, 'cad-agent-skills', 'archetypes') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readArchetype(name) {
  const dir = archetypesDir();
  if (!dir) return { ok: false, text: 'Archetypes directory not found. Looked under cad-agent/lib/aicad-agent/skills/archetypes/.' };
  if (!name) {
    let entries;
    try {
      entries = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    } catch (e) {
      return { ok: false, text: `Failed to read archetypes directory: ${e && e.message ? e.message : e}` };
    }
    if (!entries.length) return { ok: true, text: 'No archetypes available.' };
    const summaries = entries.map(file => {
      const slug = path.basename(file, '.md');
      let signals = '';
      try {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const match = text.match(/###\s*Match signals\s*\n([\s\S]*?)(?:\n###|$)/);
        if (match) {
          signals = match[1].trim().replace(/\s+/g, ' ').slice(0, 240);
        } else {
          const firstPara = text.split(/\n\s*\n/).find(p => p.trim() && !p.startsWith('##')) || '';
          signals = firstPara.trim().replace(/\s+/g, ' ').slice(0, 240);
        }
      } catch {}
      return `- **${slug}** — ${signals || '(no description)'}`;
    });
    return { ok: true, text: `Available archetypes (call archetype(name=<slug>) to load full recipe):\n${summaries.join('\n')}` };
  }
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) {
    return { ok: false, text: `Archetype '${name}' not found. Call archetype() with no name to list available archetypes.` };
  }
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { ok: false, text: `Failed to read archetype '${name}': ${e && e.message ? e.message : e}` };
  }
}

async function runPythonFile(projectRoot, scriptPath, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cwd = resolveProjectDir(projectRoot, typeof o.cwd === 'string' && o.cwd ? o.cwd : '.');
  const args = Array.isArray(o.args) ? o.args.map((v) => String(v)).slice(0, 50) : [];
  const timeoutMs = clampInt(o.timeoutMs, PYTHON_DEFAULT_TIMEOUT_MS, 1000, PYTHON_MAX_TIMEOUT_MS);
  const maxOutputChars = clampInt(o.maxOutputChars, PYTHON_DEFAULT_MAX_OUTPUT_CHARS, 1000, PYTHON_MAX_OUTPUT_CHARS);
  const stdin = typeof o.stdin === 'string' ? o.stdin : '';

  const py = await detectRunnerPython();
  if (!py) {
    throw new Error(
      'No Python with build123d found for script commands. Run `pnpm run build:runner` to create the embedded-runner venv, or set AICAD_PYTHON_BIN.'
    );
  }
  if (!fs.existsSync(scriptPath)) throw new Error('Python script does not exist: ' + scriptPath);

  const startedAt = Date.now();
  const env = appendPythonPath(pythonChildProcessEnv(), [
    projectRoot,
    path.dirname(scriptPath),
  ]);
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    for (const [key, value] of Object.entries(o.env)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(key) && value != null) env[key] = String(value);
    }
  }
  env.AICAD_PROJECT_ROOT = projectRoot;
  env.FORGENT3D_PROJECT_ROOT = projectRoot;

  let timedOut = false;
  const result = await new Promise((resolve) => {
    const child = spawn(py.cmd, [...(py.args || []), scriptPath, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      const message = String(error?.message || error || 'spawn failed');
      resolve({ code: -1, stdout, stderr: stderr || message, error });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (Number.isInteger(code) ? code : (signal ? -1 : -1));
      resolve({ code: exitCode, signal, stdout, stderr, error: null });
    });
    if (stdin) child.stdin?.end(stdin);
    else child.stdin?.end();
  });

  const elapsedMs = Date.now() - startedAt;
  const relCwd = path.relative(projectRoot, cwd).replace(/\\/g, '/') || '.';
  const stdout = trimCapturedOutput(result.stdout || '', maxOutputChars);
  const spawnDetail = result.error ? String(result.error?.message || result.error) : '';
  const stderr = trimCapturedOutput(result.stderr || spawnDetail, maxOutputChars);
  const exitCode = timedOut ? 124 : (Number.isInteger(result.code) ? result.code : -1);
  const codeLine = timedOut
    ? 'Python timed out after ' + timeoutMs + 'ms'
    : 'Python exited with code ' + exitCode + (result.signal ? ' (signal ' + result.signal + ')' : '');
  const body = [
    [codeLine + ' in ' + elapsedMs + 'ms', 'interpreter: ' + (py.versionText || py.version || py.cmd), 'cwd: ' + relCwd].join('\n'),
    'stdout:\n' + (stdout || '(empty)'),
    'stderr:\n' + (stderr || '(empty)'),
  ].join('\n\n');
  return {
    ok: !timedOut && exitCode === 0,
    text: body,
    stdout,
    stderr,
    exitCode,
    timedOut,
    elapsedMs,
    interpreter: py.versionText || py.version || py.cmd,
  };
}

function runnerCachePath(projectRoot, runnerId) {
  const id = String(runnerId || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error('runnerId must contain only letters, numbers, dots, underscores, and hyphens.');
  const dir = path.join(projectRoot, '.aicad-agent', 'runners');
  return path.join(dir, `${id}.py`);
}

async function writeRunnerSource(projectRoot, runnerId, source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('runnerSource is required.');
  if (source.length > 2_000_000) throw new Error('runnerSource is too large.');
  if (!/def\s+main\s*\(/m.test(source) || !/command_build/.test(source)) {
    throw new Error(
      'Invalid aicad-script runner source. Ensure cad-agent is logged in and /api/agent/runner returns script.py, not an HTML/JSON error page.'
    );
  }
  const filePath = runnerCachePath(projectRoot, runnerId);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  let current = null;
  try { current = await fsp.readFile(filePath, 'utf8'); } catch {}
  if (current !== source) await fsp.writeFile(filePath, source, 'utf8');
  return filePath;
}

async function runDesktopPython(projectRoot, payload, ctx) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const scriptPath = await writeRunnerSource(projectRoot, p.runnerId || 'runner', p.runnerSource);
  const active = (() => {
    try {
      const data = ctx?.mcpContext?.listParts?.();
      return String(data?.active || '');
    } catch {
      return '';
    }
  })();
  return runPythonFile(projectRoot, scriptPath, {
    args: Array.isArray(p.args) ? p.args : [],
    cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : '.',
    stdin: typeof p.stdin === 'string' ? p.stdin : '',
    timeoutMs: p.timeoutMs,
    maxOutputChars: p.maxOutputChars,
    env: {
      ...(p.env && typeof p.env === 'object' && !Array.isArray(p.env) ? p.env : {}),
      ...(active ? { AICAD_ACTIVE_MODEL: active } : {}),
    },
  });
}

function formatListModels(data) {
  if (!data || typeof data !== 'object') return String(data);
  if (data.error) return data.error;
  const models = Array.isArray(data.models) ? data.models : [];
  const header = `kernel: ${data.kernel || '?'}  active: ${data.active || '(none)'}`;
  if (!models.length) return `${header}\n(no models)`;
  const lines = models.map(m => {
    const name = String(m.name || '');
    const marker = name === data.active ? ' *' : '';
    const info = m.hasInfo ? 'info=yes' : 'info=no';
    const shot = m.hasScreenshot ? 'screenshot=yes' : 'screenshot=no';
    const faces = m.faceCount != null ? `  faces=${m.faceCount}` : '';
    return `  ${name}${marker}  ${info}  ${shot}${faces}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function formatRebuildModel(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (!r.ok) {
    const parts = [`error: ${r.error || 'build failed'}`];
    if (r.exitCode != null) parts.push(`exitCode: ${r.exitCode}`);
    if (r.stderr) parts.push(`stderr: ${r.stderr}`);
    if (r.stdout) parts.push(`stdout: ${r.stdout}`);
    return parts.join('\n');
  }
  const tags = [];
  if (r.faceCount != null) tags.push(`faces=${r.faceCount}`);
  if (r.cacheSize != null) tags.push(`cacheSize=${r.cacheSize}`);
  if (r.skipped) tags.push(`skipped (${r.reason || 'fresh'})`);
  return `ok${tags.length ? '  ' + tags.join('  ') : ''}`;
}

function formatGetModelInfo(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.error) {
    const stale = r.cacheStale ? '  stale=yes' : '';
    return `error: ${r.error}${stale}`;
  }
  const tags = [
    `kernel=${r.kernel || '?'}`,
    r.cacheStale ? 'stale=yes' : 'stale=no',
  ];
  if (r.faceCount != null) tags.push(`faces=${r.faceCount}`);
  const lines = [`${r.name || '?'}  ${tags.join('  ')}`];
  const b = r.bbox;
  if (b && typeof b === 'object') {
    const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : v);
    const axis = (lo, hi) => `[${fmt(lo)}, ${fmt(hi)}]`;
    lines.push(`bbox: x=${axis(b.xmin ?? b.min?.x, b.xmax ?? b.max?.x)}  y=${axis(b.ymin ?? b.min?.y, b.ymax ?? b.max?.y)}  z=${axis(b.zmin ?? b.min?.z, b.zmax ?? b.max?.z)}`);
  }
  if (r.capturedAt) lines.push(`captured: ${r.capturedAt}`);
  if (r.description) lines.push(`description: ${r.description}`);
  return lines.join('\n');
}

function toolLog(ctx, message, detail, level = 'info') {
  try {
    if (typeof ctx?.log === 'function') ctx.log(message, detail, level);
    else {
      const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
      console.log(`[agent-bridge:tools] ${message}${suffix}`);
    }
  } catch {}
}

async function dispatch(name, args, ctx) {
  const projectPath = ctx?.projectPath || '';
  const mcp = ctx?.mcpContext;
  const a = args || {};
  const startedAt = Date.now();
  toolLog(ctx, 'tool dispatch entered', { projectPath, hasMcpContext: !!mcp });
  try {
    switch (name) {
      case 'list_files':
        toolLog(ctx, 'list_files start', { dir: a.dir || '.', glob: a.glob || '', depth: a.depth, maxResults: a.maxResults });
        return textResult(await listFiles(projectPath, a));
      case 'read_file':
        toolLog(ctx, 'read_file start', { path: a.path, offset: a.offset, limit: a.limit });
        return textResult(await readFile(projectPath, a));
      case 'grep':
        toolLog(ctx, 'grep start', { pattern: a.pattern, path: a.path || '.', glob: a.glob || '' });
        return textResult(await grepProject(projectPath, a));
      case 'write_file':
        toolLog(ctx, 'write_file start', { path: a.path, chars: String(a.content ?? '').length, overwrite: a.overwrite });
        return textResult(await writeFile(projectPath, a.path, a.content, a.overwrite));
      case 'replace_in_file':
        toolLog(ctx, 'replace_in_file start', { path: a.path, replaceAll: !!a.replaceAll });
        return textResult(await replaceInFile(projectPath, a.path, a.oldText, a.newText, !!a.replaceAll));
      case 'desktop.python':
        toolLog(ctx, 'desktop.python start', {
          runnerId: a.runnerId || '',
          argCount: Array.isArray(a.args) ? a.args.length : 0,
          cwd: a.cwd || '.',
        });
        {
          const pyResult = await runDesktopPython(projectPath, a, ctx);
          toolLog(
            ctx,
            'desktop.python done',
            {
              elapsedMs: Date.now() - startedAt,
              ok: !!pyResult.ok,
              exitCode: pyResult.exitCode,
              stdoutLen: String(pyResult.stdout || '').length,
              stderrLen: String(pyResult.stderr || '').length,
            },
            pyResult.ok ? 'info' : 'warn',
          );
          return pyResult;
        }
      case 'archetype': {
        const name = String(a.name || '').trim();
        toolLog(ctx, 'archetype start', { name: name || '(list)' });
        const r = readArchetype(name);
        toolLog(ctx, 'archetype done', { elapsedMs: Date.now() - startedAt, ok: !!r.ok, name: name || '(list)' }, r.ok ? 'info' : 'warn');
        return textResult(r.text, !r.ok);
      }
      case 'list_models': {
        if (!mcp) return textResult('CAD context unavailable.', true);
        toolLog(ctx, 'list_models mcp.listParts start');
        const data = mcp.listParts();
        toolLog(ctx, 'list_models mcp.listParts done', {
          elapsedMs: Date.now() - startedAt,
          modelCount: Array.isArray(data?.models) ? data.models.length : null,
        });
        return textResult(formatListModels(data));
      }
      case 'rebuild_model': {
        if (!mcp) return textResult('CAD context unavailable.', true);
        toolLog(ctx, 'rebuild_model start', { model: String(a.model || '') });
        const r = await mcp.rebuildPartSync(String(a.model || ''));
        toolLog(ctx, 'rebuild_model done', { elapsedMs: Date.now() - startedAt, ok: !!r?.ok, error: r?.error || '' }, r?.ok ? 'info' : 'warn');
        return textResult(formatRebuildModel(r), !r?.ok);
      }
      case 'screenshot_model': {
        if (!mcp) return textResult('CAD context unavailable.', true);
        const view = a.view || 'iso';
        const mode = a.mode || 'solid';
        const model = String(a.model || '');
        const maxBytes = Number.isInteger(a.maxBytes) && a.maxBytes > 0 ? a.maxBytes : 800_000;
        toolLog(ctx, 'screenshot_model start', { model, view, mode, maxBytes });
        const png = await mcp.getPartScreenshot(model, view, mode);
        if (!png) {
          toolLog(ctx, 'screenshot_model missing cache', { elapsedMs: Date.now() - startedAt, model, view, mode }, 'warn');
          return textResult(
            `No screenshot cache for model "${model}" (view: ${view}, mode: ${mode}). Call rebuild_model first.`,
            true,
          );
        }
        if (png.length > maxBytes) {
          toolLog(ctx, 'screenshot_model too large', { elapsedMs: Date.now() - startedAt, bytes: png.length, maxBytes }, 'warn');
          return textResult(
            `Screenshot for "${model}" (${mode}/${view}) is ${png.length} bytes, exceeds maxBytes=${maxBytes}. Lower the viewer render resolution or pass a larger maxBytes if you really need the image in context.`,
            true,
          );
        }
        toolLog(ctx, 'screenshot_model done', { elapsedMs: Date.now() - startedAt, bytes: png.length });
        const savedPath = await saveAgentScreenshot(ctx.projectPath, model, view, mode, png);
        return {
          isError: false,
          content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            {
              type: 'text',
              text: [
                `${mode}/${view} screenshot for model "${model}" (${png.length} bytes).`,
                savedPath ? `Saved screenshot: ${savedPath}` : '',
              ].filter(Boolean).join('\n'),
            },
          ],
        };
      }
    }
    toolLog(ctx, 'unknown tool', { elapsedMs: Date.now() - startedAt }, 'warn');
    return textResult(`Unknown tool: ${name}`, true);
  } catch (e) {
    toolLog(ctx, 'tool dispatch caught error', { elapsedMs: Date.now() - startedAt, error: e?.message || String(e) }, 'error');
    return textResult(String(e?.message || e), true);
  }
}

module.exports = { dispatch };
