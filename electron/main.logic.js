'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { XacroParser } = require('xacro-parser');
const { spawn } = require('child_process');

global.DOMParser = DOMParser;
global.XMLSerializer = XMLSerializer;

function createMainLogicTools({ state, deps }) {
  function writeIfChanged(filePath, content) {
    try {
      const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
      if (prev === content) return false;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      if (prev !== null) deps.sendLog(`Updated: ${path.relative(state.currentProjectPath() || '', filePath)}`);
      return true;
    } catch (e) {
      deps.sendLog(`Failed to write ${filePath}: ${e.message}`, 'error');
      return false;
    }
  }

  function writeIfMissing(filePath, content) {
    if (fs.existsSync(filePath)) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }

  function bootstrapAgentWorkspace(projectPath, agent) {
    const k = deps.readProjectKernel(projectPath);
    switch (agent) {
      case 'cli':
        const cursorSkills = deps.getAgentSkills('Cursor');
        for (const rule of cursorSkills) {
          writeIfMissing(path.join(projectPath, rule.relativePath), rule.content);
        }
        writeIfChanged(path.join(projectPath, '.cursor', 'mcp.json'), deps.cursorMcpJson(deps.MCP_PORT));
        break;
      case 'codex':
        writeIfChanged(path.join(projectPath, '.codex', 'config.toml'), deps.codexConfigToml(deps.MCP_PORT));
        writeIfMissing(path.join(projectPath, 'AGENTS.md'), deps.agentsMdTemplate());
        const codexSkills = deps.getAgentSkills('OpenAI Codex');
        for (const rule of codexSkills) {
          writeIfMissing(path.join(projectPath, rule.relativePath), rule.content);
        }
        break;
      case 'claude':
        writeIfChanged(path.join(projectPath, '.mcp.json'), deps.claudeMcpJson(deps.MCP_PORT));
        writeIfMissing(path.join(projectPath, 'CLAUDE.md'), deps.claudeMdTemplate());
        const claudeSkills = deps.getAgentSkills('Claude Code');
        for (const rule of claudeSkills) {
          writeIfMissing(path.join(projectPath, rule.relativePath), rule.content);
        }
        break;
      default:
        throw new Error(`Unknown agent: ${agent}`);
    }
  }

  function initProjectLayout(projectPath, kernel) {
    const k = deps.assertKernel(kernel);
    const meta = deps.kernelMeta(k);

    writeIfChanged(deps.projectMetaPath(projectPath), deps.aicadProjectJson(k));
    writeIfChanged(path.join(projectPath, '.gitignore'), '# AI CAD Companion Preview\n.cache/\n__pycache__/\n*.pyc\n');
    fs.mkdirSync(path.join(projectPath, deps.MODELS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });

    const samplePartName = 'cuboid';
    const sampleAsmName = 'assembly_demo';
    const cuboidSrcPath = deps.partSource(projectPath, samplePartName, k, 'part');
    const asmSrcPath = deps.partSource(projectPath, sampleAsmName, k, 'asm');
    fs.mkdirSync(path.dirname(cuboidSrcPath), { recursive: true });
    fs.mkdirSync(path.dirname(asmSrcPath), { recursive: true });
    writeIfMissing(
      deps.modelParamsPath(projectPath, samplePartName),
      deps.modelParamsTemplate('part', samplePartName, 'Default cuboid model parameters.')
    );
    writeIfMissing(
      cuboidSrcPath,
      deps.modelSourceTemplate(k, 'part', samplePartName, `Default cuboid model. Edit ${meta.sourceFile} to preview changes.`)
    );
    writeIfMissing(
      deps.modelParamsPath(projectPath, sampleAsmName),
      deps.modelParamsTemplate('asm', sampleAsmName, 'Sample assembly parameters.')
    );
    const asmTemplate = deps.modelSourceTemplate(k, 'asm', sampleAsmName, 'Sample assembly that references the cuboid part mesh.');
    writeIfMissing(asmSrcPath, asmTemplate.replace(/cuboid/g, samplePartName));
    deps.sendLog(`Sample models created: models/${samplePartName}/${deps.modelSourceFilename(k, 'part')} + models/${samplePartName}/params.json + models/${sampleAsmName}/asm.xacro + models/${sampleAsmName}/params.json`);
  }

  function ensureRuntimeDirs(projectPath) {
    fs.mkdirSync(path.join(projectPath, deps.MODELS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });
  }

  function listPartsRaw(projectPath, kernel = state.currentKernel()) {
    const k = deps.assertKernel(kernel);
    const dir = path.join(projectPath, deps.MODELS_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .map((name) => ({ name, source: deps.resolveModelSource(projectPath, name, k) }))
      .filter(({ source }) => !!source)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, source }) => ({
        name,
        kind: source.kind,
        sourceFile: source.fileName,
        description: readPartDescription(projectPath, name, k)
      }));
  }

  function readPartDescription(projectPath, name, kernel = state.currentKernel()) {
    const k = deps.assertKernel(kernel);
    try {
      const md = fs.readFileSync(deps.partReadme(projectPath, name), 'utf-8');
      const lines = md.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        if (l.startsWith('#')) continue;
        if (l.startsWith('>')) continue;
        return l.replace(/^[*-]\s*/, '').slice(0, 120);
      }
    } catch {}
    try {
      const source = deps.resolveModelSource(projectPath, name, k);
      if (!source) return '';
      const src = fs.readFileSync(source.sourcePath, 'utf-8');
      const m = /^\s*"""([\s\S]*?)"""/.exec(src);
      if (m) return m[1].trim().split(/\r?\n/)[0].slice(0, 120);
    } catch {}
    try {
      const paramsPath = deps.modelParamsPath(projectPath, name);
      if (fs.existsSync(paramsPath)) {
        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf-8'));
        if (params?.description) return String(params.description).trim().slice(0, 120);
      }
    } catch {}
    return '';
  }

  function listParts(projectPath, kernel = state.currentKernel()) {
    const k = deps.assertKernel(kernel);
    return listPartsRaw(projectPath, k).map((p) => {
      const source = deps.resolveModelSource(projectPath, p.name, k);
      const cache = deps.modelCacheFile(projectPath, p.name, source, k);
      let size = 0; let mtime = 0;
      if (cache && fs.existsSync(cache)) {
        const st = fs.statSync(cache);
        size = st.size;
        mtime = st.mtimeMs;
      }
      return {
        name: p.name,
        kind: p.kind,
        sourceFile: p.sourceFile,
        description: p.description,
        hasCache: size > 0,
        cacheSize: size,
        cacheMtime: mtime,
        building: state.buildingParts().has(p.name) || state.pendingParts().has(p.name)
      };
    });
  }

  function broadcastPartsList() {
    if (!state.currentProjectPath()) return;
    deps.sendToRenderer('PARTS_LIST', {
      active: state.activePart(),
      kernel: state.currentKernel(),
      parts: listParts(state.currentProjectPath(), state.currentKernel())
    });
  }

  function partNameFromPath(filePath) {
    const rel = path.relative(state.currentProjectPath() || '', filePath).replace(/\\/g, '/');
    const ext = deps.sourceExt(state.currentKernel()).replace(/^\./, '');
    const partRe = new RegExp(`^models/([^/]+)/part\\.${ext}$`, 'i');
    const partMatch = partRe.exec(rel);
    if (partMatch) return { name: partMatch[1], kind: 'part', fileName: `part${deps.sourceExt(state.currentKernel())}` };
    const asmMatch = /^models\/([^/]+)\/asm\.xacro$/i.exec(rel);
    if (asmMatch) return { name: asmMatch[1], kind: 'asm', fileName: 'asm.xacro' };
    const paramsMatch = /^models\/([^/]+)\/params\.json$/i.exec(rel);
    if (paramsMatch) {
      const source = deps.resolveModelSource(state.currentProjectPath(), paramsMatch[1], state.currentKernel());
      return { name: paramsMatch[1], kind: source?.kind || 'part', fileName: 'params.json' };
    }
    return null;
  }

  function stopWatcher() {
    const watcher = state.watcher();
    if (watcher) {
      watcher.close().catch(() => {});
      state.setWatcher(null);
    }
  }

  async function openProject(projectPath, { runImmediately = false } = {}) {
    const resolvedProjectPath = path.resolve(projectPath);
    const nextKernel = deps.readProjectKernel(resolvedProjectPath);
    ensureRuntimeDirs(resolvedProjectPath);

    stopWatcher();
    state.setCurrentProjectPath(resolvedProjectPath);
    state.setCurrentKernel(nextKernel);
    state.partInfoCache().clear();
    state.buildWaiters().clear();
    state.partLoadedWaiters().clear();

    deps.saveLastProjectPath(resolvedProjectPath);
    deps.sendLog(`Project kernel: ${deps.kernelMeta(state.currentKernel()).label} (${state.currentKernel()})`);

    const parts = listPartsRaw(resolvedProjectPath, state.currentKernel());
    const preferred = parts.find((p) => p.kind === 'part') || parts[0];
    state.setActivePart(preferred ? preferred.name : null);

    deps.sendToRenderer('PROJECT_OPENED', {
      path: resolvedProjectPath,
      kernel: state.currentKernel(),
      kernelLabel: deps.kernelMeta(state.currentKernel()).label,
      sourceFile: deps.kernelMeta(state.currentKernel()).sourceFile,
      sourceFiles: Object.values(deps.sourceFileOptions(state.currentKernel())),
      previewFormat: deps.kernelMeta(state.currentKernel()).previewFormat
    });
    deps.sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus(state.currentKernel()));
    broadcastPartsList();
    deps.rebuildAppMenu();

    const globs = deps.MODEL_KINDS.map((kind) =>
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', deps.modelSourceFilename(state.currentKernel(), kind)).replace(/\\/g, '/')
    );
    globs.push(path.join(resolvedProjectPath, deps.MODELS_DIR, '*', 'params.json').replace(/\\/g, '/'));
    const watcher = chokidar.watch(globs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    state.setWatcher(watcher);

    watcher.on('change', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (!entry) return;
      deps.sendLog(`Model changed: models/${entry.name}/${entry.fileName}`);
      scheduleBuild(entry.name);
    });
    watcher.on('add', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        broadcastPartsList();
        scheduleBuild(entry.name);
      }
    });
    watcher.on('unlink', () => {
      broadcastPartsList();
    });
    watcher.on('error', (err) => deps.sendLog(`watcher error: ${err.message}`, 'error'));

    if (runImmediately && state.activePart()) {
      const source = deps.resolveModelSource(state.currentProjectPath(), state.activePart(), state.currentKernel());
      const cache = deps.modelCacheFile(state.currentProjectPath(), state.activePart(), source, state.currentKernel());
      if (fs.existsSync(cache)) deps.sendModelUpdated(state.activePart());
      else scheduleBuild(state.activePart());
    }
  }

  async function selectPart(name) {
    if (!state.currentProjectPath()) return;
    if (!deps.resolveModelSource(state.currentProjectPath(), name)) {
      throw new Error(`Model does not exist: ${name}`);
    }
    state.setActivePart(name);
    deps.sendToRenderer('ACTIVE_PART_CHANGED', { name });
    broadcastPartsList();

    const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    const cache = deps.modelCacheFile(state.currentProjectPath(), name, source, state.currentKernel());
    if (fs.existsSync(cache)) deps.sendModelUpdated(name);
    else scheduleBuild(name);
  }

  function scheduleBuild(partName) {
    if (!state.currentProjectPath() || !partName) return;
    if (state.buildingParts().has(partName)) {
      state.pendingParts().add(partName);
      return;
    }
    runBuild(partName);
  }

  async function runBuild(partName) {
    if (!state.currentProjectPath() || !partName) return;
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    if (!source) {
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: `Model source not found: ${partName}` });
      return;
    }
    state.buildingParts().add(partName);
    state.pendingParts().delete(partName);
    deps.sendToRenderer('BUILD_STARTED', { part: partName });
    broadcastPartsList();
    return source.kind === 'asm' ? runBuildUrdf(partName, source) : runBuildPython(partName);
  }

  async function runBuildPython(partName) {
    const runtime = await deps.detectBuildRuntime(state.currentKernel());
    if (!runtime) {
      state.buildingParts().delete(partName);
      const msg = deps.missingRuntimeMessage(state.currentKernel());
      deps.sendLog(msg, 'error');
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: msg, reason: 'NO_RUNTIME' });
      deps.sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus(state.currentKernel()));
      broadcastPartsList();
      resolveBuildWaiters(partName, { ok: false, part: partName, error: msg, reason: 'NO_RUNTIME' });
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const cacheOut = deps.partCache(state.currentProjectPath(), partName, state.currentKernel());
    const cmd = deps.buildRuntimeSpawn(runtime, [
      '--project', state.currentProjectPath(),
      '--model', partName,
      '--output', cacheOut
    ]);
    deps.sendLog(
      runtime.kind === 'bundled-runner'
        ? `[${partName}] Build using bundled build123d runtime`
        : `[${partName}] Build using Python ${runtime.cmd} (v${runtime.version}) with ${deps.kernelMeta(state.currentKernel()).label}`
    );
    const child = spawn(cmd.cmd, cmd.args, { cwd: state.currentProjectPath(), shell: false, windowsHide: true });
    finalizeBuildChild(child, partName, runtime.kind === 'bundled-runner' ? 'bundled build123d runtime' : 'electron/export_runner.py');
  }

  function readParamsForSource(sourcePath) {
    const paramsPath = path.join(path.dirname(sourcePath), 'params.json');
    if (!fs.existsSync(paramsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(paramsPath, 'utf-8'));
    } catch (e) {
      throw new Error(`params.json for "${path.basename(path.dirname(sourcePath))}" is invalid JSON: ${e.message}`);
    }
  }

  const XACRO_PARAM_SEGMENT_RE = /^[A-Za-z_$][\w$]*$/;

  function formatXacroParamValue(value) {
    if (Array.isArray(value)) return value.map((item) => formatXacroParamValue(item)).join(' ');
    return String(value ?? '');
  }

  function escapeXmlAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function collectXacroParamProperties(value, prefix = '', out = []) {
    if (Array.isArray(value)) {
      if (prefix) out.push([prefix, formatXacroParamValue(value)]);
      return out;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (!XACRO_PARAM_SEGMENT_RE.test(key)) continue;
        collectXacroParamProperties(child, prefix ? `${prefix}.${key}` : key, out);
      }
      return out;
    }
    if (prefix) out.push([prefix, formatXacroParamValue(value)]);
    return out;
  }

  function injectXacroParamProperties(xacroText, params = {}, sourceLabel = 'asm.xacro') {
    const properties = collectXacroParamProperties(params);
    if (!properties.length) return xacroText;

    const rootMatch = /<robot\b[^>]*>/i.exec(xacroText);
    if (!rootMatch) throw new Error(`${sourceLabel} must contain a <robot> root element`);

    let rootTag = rootMatch[0];
    if (!/\sxmlns:xacro\s*=/.test(rootTag)) {
      rootTag = rootTag.replace(/>$/, ' xmlns:xacro="http://www.ros.org/wiki/xacro">');
    }

    const propertyText = properties
      .map(([name, value]) => `  <xacro:property name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(value)}"/>`)
      .join('\n');
    return `${xacroText.slice(0, rootMatch.index)}${rootTag}\n${propertyText}${xacroText.slice(rootMatch.index + rootMatch[0].length)}`;
  }

  function resolveXacroIncludePath(includePath, sourcePath) {
    const normalized = String(includePath || '').replace(/^package:\/\//i, '');
    if (path.isAbsolute(normalized)) return normalized;
    return path.resolve(path.dirname(sourcePath), normalized);
  }

  async function expandXacroText(text, params, sourceLabel = 'asm.xacro', sourcePath = '') {
    try {
      const parser = new XacroParser();
      parser.workingPath = sourcePath ? path.dirname(sourcePath) : '';
      parser.getFileContents = async (includePath) => {
        const resolvedPath = resolveXacroIncludePath(includePath, sourcePath);
        return fs.promises.readFile(resolvedPath, 'utf-8');
      };
      const document = await parser.parse(injectXacroParamProperties(String(text || ''), params, sourceLabel));
      return new XMLSerializer().serializeToString(document);
    } catch (e) {
      throw new Error(`${sourceLabel} xacro expansion failed: ${e.message || String(e)}`);
    }
  }

  async function readAssemblyUrdfText(sourcePath) {
    const text = fs.readFileSync(sourcePath, 'utf-8');
    return expandXacroText(text, readParamsForSource(sourcePath), path.basename(sourcePath), sourcePath);
  }

  async function validateUrdfAssemblyReferences(sourcePath, asmName) {
    let text;
    try {
      text = await readAssemblyUrdfText(sourcePath);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
    const sourceLabel = 'asm.xacro';
    const primitiveRe = /<\s*(box|cylinder|sphere)\b/ig;
    if (primitiveRe.test(text)) {
      return { ok: false, error: `${sourceLabel} for "${asmName}" must reference part meshes only; primitive geometry tags are not allowed.` };
    }
    const meshMatches = Array.from(text.matchAll(/<\s*mesh\b[^>]*\bfilename\s*=\s*"([^"]+)"/ig));
    if (meshMatches.length === 0) {
      return { ok: false, error: `${sourceLabel} for "${asmName}" must include at least one <mesh filename=\"...\"> reference to a part export.` };
    }
    const asmDir = path.dirname(sourcePath);
    const projectRoot = path.resolve(state.currentProjectPath());
    const referencedParts = new Set();
    for (const m of meshMatches) {
      const meshRef = String(m[1] || '').trim();
      if (!meshRef) return { ok: false, error: `${sourceLabel} for "${asmName}" has an empty mesh filename.` };
      const normalized = meshRef.replace(/^package:\/\//i, '').replace(/\\/g, '/');
      const abs = path.resolve(asmDir, normalized);
      if (abs !== projectRoot && !abs.startsWith(`${projectRoot}${path.sep}`)) return { ok: false, error: `${sourceLabel} mesh path escapes project root: ${meshRef}` };
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: `${sourceLabel} mesh file not found: ${meshRef}` };
      if (path.extname(abs).toLowerCase() !== '.stl') return { ok: false, error: `${sourceLabel} currently supports STL meshes only: ${meshRef}` };
      const base = path.basename(abs, path.extname(abs));
      const partSourcePath = path.join(deps.modelDir(state.currentProjectPath(), base), deps.modelSourceFilename(state.currentKernel(), 'part'));
      if (!fs.existsSync(partSourcePath)) {
        return { ok: false, error: `${sourceLabel} mesh "${meshRef}" is not linked to an existing part model "${base}" (expected models/${base}/part${deps.sourceExt(state.currentKernel())}).` };
      }
      referencedParts.add(base);
    }
    return { ok: true, meshCount: meshMatches.length, referencedParts: Array.from(referencedParts) };
  }

  async function runBuildUrdf(partName, source) {
    const sourcePath = source?.sourcePath || deps.partSource(state.currentProjectPath(), partName, state.currentKernel(), 'asm');
    if (!fs.existsSync(sourcePath)) {
      const message = `asm.xacro was not generated for model "${partName}"`;
      state.buildingParts().delete(partName);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: message });
      broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const urdfValidation = await validateUrdfAssemblyReferences(sourcePath, partName);
    if (!urdfValidation.ok) {
      state.buildingParts().delete(partName);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: urdfValidation.error });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: urdfValidation.error });
      broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const size = fs.statSync(sourcePath).size;
    const sourceLabel = path.basename(sourcePath);
    deps.sendLog(`[${partName}] ${sourceLabel} assembly updated (${(size / 1024).toFixed(1)} KB, ${urdfValidation.meshCount} meshes from parts: ${urdfValidation.referencedParts.join(', ')})`);
    deps.sendToRenderer('PART_BUILT', { part: partName, size });
    if (partName === state.activePart()) deps.sendModelUpdated(partName);
    resolveBuildWaiters(partName, {
      ok: true, part: partName, kernel: state.currentKernel(), cacheFile: path.basename(sourcePath), cacheSize: size, faceCount: null
    });
    state.buildingParts().delete(partName);
    broadcastPartsList();
    if (state.pendingParts().has(partName)) runBuild(partName);
  }

  function finalizeBuildChild(child, partName, label) {
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d) => { const s = d.toString(); stdout += s; deps.sendLog(s.trimEnd()); });
    child.stderr?.on('data', (d) => { const s = d.toString(); stderr += s; deps.sendLog(s.trimEnd(), 'warn'); });
    child.on('error', (err) => {
      state.buildingParts().delete(partName);
      const friendlyMsg = err.message;
      deps.sendLog(`[${partName}] ${label} failed: ${friendlyMsg}`, 'error');
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: friendlyMsg });
      broadcastPartsList();
      resolveBuildWaiters(partName, { ok: false, part: partName, error: friendlyMsg });
    });
    child.on('close', (code) => {
      state.buildingParts().delete(partName);
      const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
      const cacheFile = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
      const cacheBase = cacheFile ? path.basename(cacheFile) : `${partName}.cache`;
      if (code !== 0) {
        deps.sendLog(`[${partName}] ${label} exited with code ${code}`, 'error');
        deps.sendToRenderer('BUILD_FAILED', { part: partName, code, stderr });
        resolveBuildWaiters(partName, { ok: false, part: partName, exitCode: code, stderr: stderr.trim(), stdout: stdout.trim() });
      } else if (cacheFile && fs.existsSync(cacheFile)) {
        const size = fs.statSync(cacheFile).size;
        const finalizeSuccess = async () => {
          // Temporarily disable synchronous STL artifact generation for faster rebuild iteration.
          // if (source?.kind === 'part') await deps.ensurePartStlArtifact(partName);
          deps.sendLog(`[${partName}] Model cache updated (${(size / 1024).toFixed(1)} KB)`);
          deps.sendToRenderer('PART_BUILT', { part: partName, size });
          if (partName === state.activePart()) deps.sendModelUpdated(partName);
          resolveBuildWaiters(partName, {
            ok: true,
            part: partName,
            kernel: state.currentKernel(),
            cacheFile: cacheBase,
            cacheSize: size,
            faceCount: source?.kind === 'asm' ? null : (state.partInfoCache().get(partName)?.faceCount ?? null),
            stdout: stdout.trim()
          });
        };
        finalizeSuccess().catch((err) => {
          const msg = `Failed to generate STL artifact for "${partName}": ${err.message || err}`;
          deps.sendLog(msg, 'error');
          deps.sendToRenderer('BUILD_FAILED', { part: partName, message: msg });
          resolveBuildWaiters(partName, { ok: false, part: partName, error: msg });
        });
      } else {
        deps.sendToRenderer('BUILD_FAILED', { part: partName, message: `${cacheBase} was not generated` });
        resolveBuildWaiters(partName, { ok: false, part: partName, error: `${cacheBase} was not generated`, stderr: stderr.trim() });
      }
      broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
    });
  }

  function resolveBuildWaiters(name, payload) {
    const arr = state.buildWaiters().get(name);
    if (!arr || arr.length === 0) return;
    state.buildWaiters().delete(name);
    for (const resolve of arr) {
      try { resolve(payload); } catch {}
    }
  }

  function resolvePartLoadedWaiters(name, payload) {
    const arr = state.partLoadedWaiters().get(name);
    if (!arr || arr.length === 0) return;
    state.partLoadedWaiters().delete(name);
    for (const resolve of arr) {
      try { resolve(payload); } catch {}
    }
  }

  function waitForPartLoaded(name, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!state.partLoadedWaiters().has(name)) state.partLoadedWaiters().set(name, []);
      const arr = state.partLoadedWaiters().get(name);
      let done = false;
      const onLoaded = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const idx = arr.indexOf(onLoaded);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) state.partLoadedWaiters().delete(name);
        resolve(null);
      }, timeoutMs);
      arr.push(onLoaded);
    });
  }

  async function refreshViewerCachesAfterBuild(partName) {
    if (!state.currentProjectPath() || !partName) return { cacheRefresh: 'skipped' };
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    const cacheFile = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
    if (!cacheFile || !fs.existsSync(cacheFile)) return { cacheRefresh: 'skipped', cacheRefreshReason: 'cache-missing' };
    deps.sendModelUpdated(partName);
    const loaded = await waitForPartLoaded(partName, 5000);
    if (!loaded) return { cacheRefresh: 'timeout' };
    return { cacheRefresh: 'ok', faceCount: state.partInfoCache().get(partName)?.faceCount ?? null };
  }

  function sendModelUpdated(partName) {
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    const cache = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
    if (!cache || !fs.existsSync(cache)) return;
    const ts = Date.now();
    const size = fs.statSync(cache).size;
    const ext = path.extname(cache).replace(/^\./, '');
    const format = deps.modelPreviewFormat(source, state.currentKernel());
    const sourceFile = source?.fileName || path.basename(cache);
    const suffix = source?.kind === 'asm' ? path.extname(sourceFile) : deps.kernelMeta(state.currentKernel()).cacheExt;
    const url = source?.kind === 'asm'
      ? `aicad://asset/models/${encodeURIComponent(partName)}/${encodeURIComponent(sourceFile)}?t=${ts}`
      : `aicad://model/${encodeURIComponent(partName)}${suffix}?t=${ts}`;
    const paramsPath = deps.modelParamsPath(state.currentProjectPath(), partName);
    const paramsUrl = source?.kind === 'asm' && fs.existsSync(paramsPath)
      ? `aicad://asset/models/${encodeURIComponent(partName)}/params.json?t=${ts}`
      : null;
    deps.sendToRenderer('MODEL_UPDATED', {
      part: partName,
      url,
      paramsUrl,
      format,
      extension: ext,
      kernel: state.currentKernel(),
      kind: source?.kind || 'part',
      size,
      ts
    });
  }

  function buildMcpContext() {
    return {
      listParts() {
        if (!state.currentProjectPath()) return { error: 'No project is open in the preview app.', parts: [], active: null };
        const meta = deps.kernelMeta(state.currentKernel());
        const list = listParts(state.currentProjectPath(), state.currentKernel()).map((p) => {
          const info = state.partInfoCache().get(p.name);
          return {
            ...p,
            hasScreenshot: fs.existsSync(deps.partPng(state.currentProjectPath(), p.name)),
            hasInfo: !!info,
            faceCount: info?.faceCount ?? null
          };
        });
        return {
          projectPath: state.currentProjectPath(),
          kernel: state.currentKernel(),
          kernelLabel: meta.label,
          sourceFile: meta.sourceFile,
          sourceFiles: Object.values(deps.sourceFileOptions(state.currentKernel())),
          previewFormat: 'MIXED',
          supportsFaceIndex: meta.previewFormat === 'BREP',
          active: state.activePart(),
          parts: list
        };
      },
      async getPartInfo(name) {
        if (!state.currentProjectPath()) return { error: 'No project is open in the preview app.' };
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return { error: `Model does not exist: ${name}` };
        const info = state.partInfoCache().get(name);
        const source = deps.resolveModelSource(state.currentProjectPath(), name);
        const cache = deps.modelCacheFile(state.currentProjectPath(), name, source, state.currentKernel());
        const src = source?.sourcePath || deps.partSource(state.currentProjectPath(), name);
        const cacheStale = !!cache && fs.existsSync(cache) && fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(cache).mtimeMs;
        if (!info) {
          return {
            name,
            kernel: state.currentKernel(),
            error: `Geometry info for "${name}" is not cached yet. Run rebuild_model({"model":"${name}"}) first, then verify status with list_models and try again.`,
            cacheStale
          };
        }
        return {
          name,
          kernel: state.currentKernel(),
          kind: source?.kind || null,
          sourceFile: source?.fileName || null,
          description: readPartDescription(state.currentProjectPath(), name, state.currentKernel()),
          faceCount: source?.kind === 'asm' ? null : info.faceCount,
          bbox: info.bbox,
          cacheStale,
          capturedAt: new Date(info.capturedAt).toISOString()
        };
      },
      async getPartScreenshot(name, view = 'iso') {
        if (!state.currentProjectPath()) return null;
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return null;
        try { await selectPart(name); } catch { return null; }
        const p = deps.partPng(state.currentProjectPath(), name, view);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p);
      },
      async rebuildPartSync(name) {
        if (!state.currentProjectPath()) return { ok: false, error: 'No project is open in the preview app.' };
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return { ok: false, error: `Model does not exist: ${name}` };
        const result = await new Promise((resolve) => {
          if (!state.buildWaiters().has(name)) state.buildWaiters().set(name, []);
          state.buildWaiters().get(name).push(resolve);
          scheduleBuild(name);
        });
        if (!result?.ok) return result;
        const refreshed = await refreshViewerCachesAfterBuild(name);
        return { ...result, ...refreshed };
      },
      async buildStl(name, output = null) {
        try {
          const result = await deps.buildStlForModel(name, output);
          deps.sendLog(`[${result.model}] MCP build_stl exported: ${result.relativePath}`);
          return result;
        } catch (error) {
          return { ok: false, model: name, error: error?.message || String(error) };
        }
      }
    };
  }

  return {
    writeIfChanged,
    writeIfMissing,
    bootstrapAgentWorkspace,
    initProjectLayout,
    ensureRuntimeDirs,
    listPartsRaw,
    readPartDescription,
    listParts,
    openProject,
    stopWatcher,
    selectPart,
    scheduleBuild,
    runBuild,
    runBuildPython,
    validateUrdfAssemblyReferences,
    runBuildUrdf,
    resolveBuildWaiters,
    resolvePartLoadedWaiters,
    refreshViewerCachesAfterBuild,
    sendModelUpdated,
    broadcastPartsList,
    buildMcpContext
  };
}

function initMainLogicTools(mainContext) {
  const {
    constants,
    templates,
    model,
    project,
    runtime,
    build,
    ui,
    exportApi,
    state
  } = mainContext;
  return createMainLogicTools({
    state: {
      watcher: state.watcher,
      setWatcher: state.setWatcher,
      currentProjectPath: state.currentProjectPath,
      setCurrentProjectPath: state.setCurrentProjectPath,
      currentKernel: state.currentKernel,
      setCurrentKernel: state.setCurrentKernel,
      activePart: state.activePart,
      setActivePart: state.setActivePart,
      partInfoCache: state.partInfoCache,
      buildingParts: state.buildingParts,
      pendingParts: state.pendingParts,
      buildWaiters: state.buildWaiters,
      partLoadedWaiters: state.partLoadedWaiters
    },
    deps: {
      MCP_PORT: constants.MCP_PORT,
      MODELS_DIR: constants.MODELS_DIR,
      MODEL_KINDS: constants.MODEL_KINDS,
      CACHE_DIR: constants.CACHE_DIR,
      assertKernel: templates.assertKernel,
      kernelMeta: templates.kernelMeta,
      sourceFileOptions: templates.sourceFileOptions,
      cursorMcpJson: templates.cursorMcpJson,
      claudeMcpJson: templates.claudeMcpJson,
      codexConfigToml: templates.codexConfigToml,
      getAgentSkills: templates.getAgentSkills,
      agentsMdTemplate: templates.agentsMdTemplate,
      claudeMdTemplate: templates.claudeMdTemplate,
      aicadProjectJson: templates.aicadProjectJson,
      modelSourceTemplate: templates.modelSourceTemplate,
      modelParamsTemplate: templates.modelParamsTemplate,
      modelReadmeTemplate: templates.modelReadmeTemplate,
      projectMetaPath: model.projectMetaPath,
      modelDir: model.modelDir,
      modelParamsPath: model.modelParamsPath,
      sourceExt: model.sourceExt,
      modelSourceFilename: model.modelSourceFilename,
      resolveModelSource: model.resolveModelSource,
      partSource: model.partSource,
      partReadme: model.partReadme,
      partCache: model.partCache,
      modelCacheFile: model.modelCacheFile,
      modelPreviewFormat: model.modelPreviewFormat,
      partPng: model.partPng,
      readProjectKernel: project.readProjectKernel,
      saveLastProjectPath: project.saveLastProjectPath,
      detectBuildRuntime: runtime.detectBuildRuntime,
      missingRuntimeMessage: runtime.missingRuntimeMessage,
      buildRuntimeSpawn: runtime.buildRuntimeSpawn,
      getBuildRuntimeStatus: runtime.getBuildRuntimeStatus,
      ensurePartStlArtifact: build.ensurePartStlArtifact,
      buildStlForModel: exportApi.buildStlForModel,
      rebuildAppMenu: ui.rebuildAppMenu,
      sendToRenderer: ui.sendToRenderer,
      sendLog: ui.sendLog,
      sendModelUpdated: (partName) => build.sendModelUpdated(partName)
    }
  });
}

module.exports = {
  createMainLogicTools,
  initMainLogicTools
};
