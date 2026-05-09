// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { DOMParser } = require('@xmldom/xmldom');
const { spawn } = require('child_process');

global.DOMParser = DOMParser;

function createMainLogicTools({ state, deps }) {
  /** Part names whose next completed Python build should write the default project STL. */
  const pendingStlAfterBuild = new Set();
  const dirtyBuildInputs = new Map();
  const runningBuildInputs = new Map();

  function elapsedMs(startMs) {
    return Math.max(0, Date.now() - startMs);
  }

  function formatDuration(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    if (safe < 1000) return `${safe} ms`;
    return `${(safe / 1000).toFixed(safe < 10000 ? 2 : 1)} s`;
  }

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
    fs.mkdirSync(path.join(projectPath, deps.PARTS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.ASSEMBLIES_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });

    const samplePartName = 'cuboid';
    const sampleAsmName = 'assembly_demo';
    const cuboidSrcPath = deps.partSource(projectPath, samplePartName, k, 'part');
    const asmSrcPath = deps.partSource(projectPath, sampleAsmName, k, 'asm');
    fs.mkdirSync(path.dirname(cuboidSrcPath), { recursive: true });
    fs.mkdirSync(path.dirname(asmSrcPath), { recursive: true });
    writeIfMissing(
      deps.modelParamsPath(projectPath, samplePartName, 'part'),
      deps.modelParamsTemplate('part', samplePartName, 'Default cuboid model parameters.')
    );
    writeIfMissing(
      cuboidSrcPath,
      deps.modelSourceTemplate(k, 'part', samplePartName, `Default cuboid model. Edit ${meta.sourceFile} to preview changes.`)
    );
    writeIfMissing(
      deps.modelParamsPath(projectPath, sampleAsmName, 'asm'),
      deps.modelParamsTemplate('asm', sampleAsmName, 'Sample assembly parameters.')
    );
    const asmTemplate = deps.modelSourceTemplate(k, 'asm', sampleAsmName, 'Sample assembly that references the cuboid part mesh.');
    writeIfMissing(asmSrcPath, asmTemplate.replace(/cuboid/g, samplePartName));
    deps.sendLog(`Sample models created: parts/${samplePartName}/${deps.modelSourceFilename(k, 'part')} + parts/${samplePartName}/params.json + assemblies/${sampleAsmName}/asm.xml + assemblies/${sampleAsmName}/params.json`);
  }

  function ensureRuntimeDirs(projectPath) {
    fs.mkdirSync(path.join(projectPath, deps.PARTS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.ASSEMBLIES_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });
  }

  function listPartsRaw(projectPath, kernel = state.currentKernel()) {
    const k = deps.assertKernel(kernel);
    const roots = [
      { kind: 'part', dir: path.join(projectPath, deps.PARTS_DIR) },
      { kind: 'asm', dir: path.join(projectPath, deps.ASSEMBLIES_DIR) }
    ];
    const entries = [];
    for (const root of roots) {
      if (!fs.existsSync(root.dir)) continue;
      for (const d of fs.readdirSync(root.dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const source = deps.resolveModelSource(projectPath, d.name, k);
        if (source?.kind === root.kind) entries.push({ name: d.name, source });
      }
    }
    return entries
      .sort((a, b) => a.source.kind.localeCompare(b.source.kind) || a.name.localeCompare(b.name))
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
    const partRe = new RegExp(`^parts/([^/]+)/part\\.${ext}$`, 'i');
    const partMatch = partRe.exec(rel);
    if (partMatch) return { name: partMatch[1], kind: 'part', fileName: `part${deps.sourceExt(state.currentKernel())}` };
    const asmMatch = /^assemblies\/([^/]+)\/asm\.xml$/i.exec(rel);
    if (asmMatch) return { name: asmMatch[1], kind: 'asm', fileName: 'asm.xml' };
    const paramsMatch = /^(parts|assemblies)\/([^/]+)\/params\.json$/i.exec(rel);
    if (paramsMatch) {
      const name = paramsMatch[2];
      const pathKind = paramsMatch[1].toLowerCase() === 'assemblies' ? 'asm' : 'part';
      const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
      return { name, kind: source?.kind || pathKind, fileName: 'params.json' };
    }
    return null;
  }

  function statMtimeMs(filePath) {
    try {
      return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  function modelInputMtime(name, source = null) {
    if (!state.currentProjectPath() || !name) return 0;
    const resolved = source || deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    if (!resolved) return 0;
    const paramsPath = deps.modelParamsPath(state.currentProjectPath(), name);
    return Math.max(statMtimeMs(resolved.sourcePath), statMtimeMs(paramsPath));
  }

  function defaultStlPath(name) {
    return path.join(deps.modelDir(state.currentProjectPath(), name, 'part'), `${name}.stl`);
  }

  function isFileFreshForInput(filePath, inputMtime) {
    const fileMtime = statMtimeMs(filePath);
    return fileMtime > 0 && fileMtime >= inputMtime;
  }

  function refreshModelDirtyState(name, source = null) {
    if (!state.currentProjectPath() || !name) return { inputMtime: 0, buildDirty: false };
    const resolved = source || deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    if (!resolved) return { inputMtime: 0, buildDirty: false };
    const inputMtime = modelInputMtime(name, resolved);
    const cacheFile = deps.modelCacheFile(state.currentProjectPath(), name, resolved, state.currentKernel());
    const cacheFresh = !!cacheFile && isFileFreshForInput(cacheFile, inputMtime);
    const markedDirtyAt = dirtyBuildInputs.get(name) || 0;
    if (!cacheFresh || markedDirtyAt > inputMtime) {
      dirtyBuildInputs.set(name, Math.max(inputMtime, markedDirtyAt));
    } else {
      dirtyBuildInputs.delete(name);
    }
    return { inputMtime, buildDirty: dirtyBuildInputs.has(name), cacheFresh, cacheFile };
  }

  function markModelDirty(name) {
    if (!state.currentProjectPath() || !name) return;
    const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    if (!source) return;
    dirtyBuildInputs.set(name, modelInputMtime(name, source));
  }

  function isDefaultStlFresh(name, source = null) {
    if (!state.currentProjectPath() || !name) return false;
    const resolved = source || deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    if (!resolved || resolved.kind !== 'part') return true;
    const cacheFile = deps.modelCacheFile(state.currentProjectPath(), name, resolved, state.currentKernel());
    const dependencyMtime = Math.max(modelInputMtime(name, resolved), statMtimeMs(cacheFile));
    return isFileFreshForInput(defaultStlPath(name), dependencyMtime);
  }

  function cachedBuildResult(name, source = null, extra = {}) {
    const resolved = source || deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    const cacheFile = deps.modelCacheFile(state.currentProjectPath(), name, resolved, state.currentKernel());
    const size = cacheFile && fs.existsSync(cacheFile) ? fs.statSync(cacheFile).size : 0;
    return {
      ok: true,
      part: name,
      kernel: state.currentKernel(),
      cacheFile: cacheFile ? path.basename(cacheFile) : null,
      cacheSize: size,
      faceCount: resolved?.kind === 'asm' ? null : (state.partInfoCache().get(name)?.faceCount ?? null),
      skipped: true,
      reason: 'fresh',
      ...extra
    };
  }

  function finishBuildPass(partName, builtInputMtime) {
    runningBuildInputs.delete(partName);
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    const freshness = refreshModelDirtyState(partName, source);
    if (freshness.buildDirty && freshness.inputMtime > builtInputMtime) {
      state.pendingParts().add(partName);
    }
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
    const migration = deps.migrateLegacyModelsLayout?.(resolvedProjectPath, { sendLog: deps.sendLog }) || null;
    if (migration?.migrated) {
      deps.sendLog(`Legacy models/ layout migrated (${migration.moved} models, ${migration.rewritten} reference files updated).`);
    }
    ensureRuntimeDirs(resolvedProjectPath);

    stopWatcher();
    state.setCurrentProjectPath(resolvedProjectPath);
    state.setCurrentKernel(nextKernel);
    state.partInfoCache().clear();
    state.buildWaiters().clear();
    state.partLoadedWaiters().clear();
    dirtyBuildInputs.clear();
    runningBuildInputs.clear();
    pendingStlAfterBuild.clear();

    deps.saveLastProjectPath(resolvedProjectPath);
    deps.sendLog(`Project kernel: ${deps.kernelMeta(state.currentKernel()).label} (${state.currentKernel()})`);

    const parts = listPartsRaw(resolvedProjectPath, state.currentKernel());
    const preferred = parts.find((p) => p.kind === 'asm') || parts[0];
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

    const globs = [
      path.join(resolvedProjectPath, deps.PARTS_DIR, '*', deps.modelSourceFilename(state.currentKernel(), 'part')).replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.ASSEMBLIES_DIR, '*', deps.modelSourceFilename(state.currentKernel(), 'asm')).replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.PARTS_DIR, '*', 'params.json').replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.ASSEMBLIES_DIR, '*', 'params.json').replace(/\\/g, '/')
    ];
    const watcher = chokidar.watch(globs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    state.setWatcher(watcher);

    watcher.on('change', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (!entry) return;
      const group = entry.kind === 'asm' ? 'assemblies' : 'parts';
      deps.sendLog(`Model changed: ${group}/${entry.name}/${entry.fileName}`);
      markModelDirty(entry.name);
      scheduleBuild(entry.name);
    });
    watcher.on('add', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        markModelDirty(entry.name);
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
      const freshness = refreshModelDirtyState(state.activePart(), source);
      if (cache && fs.existsSync(cache) && !freshness.buildDirty && source?.kind !== 'asm') deps.sendModelUpdated(state.activePart());
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
    const freshness = refreshModelDirtyState(name, source);
    if (cache && fs.existsSync(cache) && !freshness.buildDirty && source?.kind !== 'asm') deps.sendModelUpdated(name);
    else scheduleBuild(name);
  }

  function scheduleBuild(partName, { exportProjectStl = false } = {}) {
    if (!state.currentProjectPath() || !partName) return;
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    if (!source) return;
    const freshness = refreshModelDirtyState(partName, source);
    const needsStl = exportProjectStl && source.kind === 'part' && !isDefaultStlFresh(partName, source);
    if (needsStl) pendingStlAfterBuild.add(partName);
    if (state.buildingParts().has(partName)) {
      const runningInputMtime = runningBuildInputs.get(partName) || 0;
      if (freshness.buildDirty && freshness.inputMtime > runningInputMtime) {
        state.pendingParts().add(partName);
      }
      return;
    }
    if (!freshness.buildDirty && !needsStl && source.kind !== 'asm') {
      if (freshness.cacheFile && fs.existsSync(freshness.cacheFile) && partName === state.activePart()) {
        deps.sendModelUpdated(partName);
      }
      resolveBuildWaiters(partName, cachedBuildResult(partName, source));
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
    const freshness = refreshModelDirtyState(partName, source);
    const exportProjectStl = pendingStlAfterBuild.has(partName);
    const needsStl = exportProjectStl && source.kind === 'part' && !isDefaultStlFresh(partName, source);
    if (!freshness.buildDirty && !needsStl && source.kind !== 'asm') {
      if (exportProjectStl) pendingStlAfterBuild.delete(partName);
      resolveBuildWaiters(partName, cachedBuildResult(partName, source));
      if (state.pendingParts().has(partName)) state.pendingParts().delete(partName);
      broadcastPartsList();
      return;
    }
    if (exportProjectStl && !needsStl) pendingStlAfterBuild.delete(partName);
    state.buildingParts().add(partName);
    state.pendingParts().delete(partName);
    deps.sendToRenderer('BUILD_STARTED', { part: partName });
    broadcastPartsList();
    runningBuildInputs.set(partName, freshness.inputMtime);
    if (!freshness.buildDirty && needsStl) {
      try {
        const stlStartedAt = Date.now();
        const stlPath = await deps.ensurePartStlArtifact(partName);
        const stlMs = elapsedMs(stlStartedAt);
        pendingStlAfterBuild.delete(partName);
        deps.sendLog(`[${partName}] Project STL ready (${path.relative(state.currentProjectPath(), stlPath).replace(/\\/g, '/')}, STL ${formatDuration(stlMs)})`);
        resolveBuildWaiters(partName, cachedBuildResult(partName, source, { stlPath }));
      } catch (err) {
        const msg = `Failed to generate STL artifact for "${partName}": ${err.message || err}`;
        deps.sendLog(msg, 'error');
        deps.sendToRenderer('BUILD_FAILED', { part: partName, message: msg });
        resolveBuildWaiters(partName, { ok: false, part: partName, error: msg });
      } finally {
        state.buildingParts().delete(partName);
        finishBuildPass(partName, freshness.inputMtime);
        broadcastPartsList();
        if (state.pendingParts().has(partName)) runBuild(partName);
      }
      return;
    }
    return source.kind === 'asm' ? runBuildMjcf(partName, source) : runBuildPython(partName, exportProjectStl);
  }

  async function runBuildPython(partName, exportProjectStl) {
    const runtime = await deps.detectBuildRuntime(state.currentKernel());
    if (!runtime) {
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
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
    const buildStartedAt = Date.now();
    const child = spawn(cmd.cmd, cmd.args, { cwd: state.currentProjectPath(), shell: false, windowsHide: true });
    finalizeBuildChild(
      child,
      partName,
      runtime.kind === 'bundled-runner' ? 'bundled build123d runtime' : 'electron/export_runner.py',
      exportProjectStl,
      buildStartedAt
    );
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

  const MJCF_PARAM_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

  function formatMjcfParamValue(value) {
    if (Array.isArray(value)) return value.map((item) => formatMjcfParamValue(item)).join(' ');
    return String(value ?? '');
  }

  function escapeXmlAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getParamPath(params, key, sourceLabel) {
    if (!MJCF_PARAM_PATH_RE.test(key)) {
      throw new Error(`${sourceLabel} has unsupported parameter expression: \${${key}}`);
    }
    let current = params;
    for (const segment of key.split('.')) {
      if (!current || typeof current !== 'object' || !(segment in current)) {
        throw new Error(`${sourceLabel} references missing params.json value: \${${key}}`);
      }
      current = current[segment];
    }
    return current;
  }

  function interpolateMjcfParams(text, params = {}, sourceLabel = 'asm.xml') {
    return String(text || '').replace(/<!--[\s\S]*?-->|(\$\{([^}]+)\})/g, (match, expr, rawKey) => {
      if (!expr) return match;
      const key = String(rawKey || '').trim();
      return escapeXmlAttr(formatMjcfParamValue(getParamPath(params, key, sourceLabel)));
    });
  }

  function readAssemblyMjcfText(sourcePath) {
    const sourceLabel = path.basename(sourcePath);
    const text = fs.readFileSync(sourcePath, 'utf-8');
    return interpolateMjcfParams(text, readParamsForSource(sourcePath), sourceLabel);
  }

  function parseMjcfDocument(text, sourceLabel) {
    const errors = [];
    const parser = new DOMParser({
      onError: (level, message) => {
        if (level === 'error' || level === 'fatalError') errors.push(message);
      }
    });
    const document = parser.parseFromString(text, 'application/xml');
    const root = document?.documentElement;
    if (errors.length || !root) {
      throw new Error(`${sourceLabel} MJCF XML parse failed: ${errors[0] || 'empty document'}`);
    }
    if (root.nodeName !== 'mujoco') {
      throw new Error(`${sourceLabel} must contain a <mujoco> root element`);
    }
    return document;
  }

  function elementChildren(node, tagName = null) {
    return Array.from(node?.childNodes || [])
      .filter((child) => child.nodeType === 1 && (!tagName || child.nodeName === tagName));
  }

  async function ensurePartBrepArtifact(partName) {
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    if (!source || source.kind !== 'part') {
      return { ok: false, error: `Model "${partName}" is not a part model.` };
    }
    const freshness = refreshModelDirtyState(partName, source);
    if (!freshness.buildDirty && freshness.cacheFile && fs.existsSync(freshness.cacheFile)) {
      return { ok: true, skipped: true, cacheFile: freshness.cacheFile };
    }
    return await new Promise((resolve) => {
      if (!state.buildWaiters().has(partName)) state.buildWaiters().set(partName, []);
      state.buildWaiters().get(partName).push(resolve);
      scheduleBuild(partName);
    });
  }

  async function validateMjcfAssemblyReferences(sourcePath, asmName) {
    let text;
    try {
      text = readAssemblyMjcfText(sourcePath);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
    const sourceLabel = 'asm.xml';
    let document;
    try {
      document = parseMjcfDocument(text, sourceLabel);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
    const meshes = new Map();
    for (const meshEl of Array.from(document.getElementsByTagName('mesh'))) {
      const name = String(meshEl.getAttribute('name') || '').trim();
      const file = String(meshEl.getAttribute('file') || '').trim();
      if (name && file) meshes.set(name, file);
    }
    const meshRefs = [];
    for (const geomEl of Array.from(document.getElementsByTagName('geom'))) {
      if (String(geomEl.getAttribute('type') || '').trim() === 'mesh' || geomEl.hasAttribute('mesh')) {
        const meshName = String(geomEl.getAttribute('mesh') || '').trim();
        if (!meshName) return { ok: false, error: `${sourceLabel} for "${asmName}" has a mesh geom without a mesh attribute.` };
        const meshRef = meshes.get(meshName);
        if (!meshRef) return { ok: false, error: `${sourceLabel} for "${asmName}" references unknown mesh asset "${meshName}".` };
        meshRefs.push(meshRef);
      }
    }
    if (meshRefs.length === 0) return { ok: false, error: `${sourceLabel} for "${asmName}" must include at least one mesh geom that references a part export.` };
    const worldbody = elementChildren(document.documentElement, 'worldbody')[0];
    if (!worldbody) return { ok: false, error: `${sourceLabel} for "${asmName}" must include a <worldbody> element.` };
    const asmDir = path.dirname(sourcePath);
    const projectRoot = path.resolve(state.currentProjectPath());
    const referencedParts = new Set();
    const partTimings = [];
    for (const meshRef of meshRefs) {
      if (!meshRef) return { ok: false, error: `${sourceLabel} for "${asmName}" has an empty mesh file.` };
      const normalized = meshRef.replace(/^package:\/\//i, '').replace(/\\/g, '/');
      const abs = path.resolve(asmDir, normalized);
      if (abs !== projectRoot && !abs.startsWith(`${projectRoot}${path.sep}`)) return { ok: false, error: `${sourceLabel} mesh path escapes project root: ${meshRef}` };
      if (path.extname(abs).toLowerCase() !== '.stl') return { ok: false, error: `${sourceLabel} currently supports STL meshes only: ${meshRef}` };
      const base = path.basename(abs, path.extname(abs));
      const partSourcePath = path.join(deps.modelDir(state.currentProjectPath(), base, 'part'), deps.modelSourceFilename(state.currentKernel(), 'part'));
      if (!fs.existsSync(partSourcePath)) {
        return { ok: false, error: `${sourceLabel} mesh "${meshRef}" is not linked to an existing part model "${base}" (expected parts/${base}/part${deps.sourceExt(state.currentKernel())}).` };
      }
      if (!referencedParts.has(base)) {
        const brepStartedAt = Date.now();
        const brepResult = await ensurePartBrepArtifact(base);
        const brepMs = elapsedMs(brepStartedAt);
        if (!brepResult?.ok) {
          return { ok: false, error: `${sourceLabel} mesh "${meshRef}" BREP build failed for part "${base}": ${brepResult?.error || brepResult?.stderr || 'unknown error'}` };
        }

        const partSource = deps.resolveModelSource(state.currentProjectPath(), base, state.currentKernel());
        const stlWasFresh = isDefaultStlFresh(base, partSource);
        const stlStartedAt = Date.now();
        try {
          await deps.ensurePartStlArtifact(base);
        } catch (e) {
          return { ok: false, error: `${sourceLabel} mesh file not found and could not be built: ${meshRef} (${e.message || String(e)})` };
        }
        const stlMs = elapsedMs(stlStartedAt);
        partTimings.push({ name: base, brepMs, stlMs });
        deps.sendLog(`[${asmName}] Part "${base}" ready: BREP ${formatDuration(brepMs)}${brepResult.skipped ? ' (fresh)' : ''}, STL ${formatDuration(stlMs)}${stlWasFresh ? ' (fresh)' : ''}.`);
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: `${sourceLabel} mesh file not found: ${meshRef}` };
      referencedParts.add(base);
    }
    return { ok: true, meshCount: meshRefs.length, referencedParts: Array.from(referencedParts), partTimings };
  }

  async function runBuildMjcf(partName, source) {
    const sourcePath = source?.sourcePath || deps.partSource(state.currentProjectPath(), partName, state.currentKernel(), 'asm');
    if (!fs.existsSync(sourcePath)) {
      const message = `asm.xml was not generated for model "${partName}"`;
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: message });
      broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const mjcfValidation = await validateMjcfAssemblyReferences(sourcePath, partName);
    if (!mjcfValidation.ok) {
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: mjcfValidation.error });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: mjcfValidation.error });
      broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const size = fs.statSync(sourcePath).size;
    const sourceLabel = path.basename(sourcePath);
    deps.sendLog(`[${partName}] ${sourceLabel} assembly updated (${(size / 1024).toFixed(1)} KB, ${mjcfValidation.meshCount} meshes from parts: ${mjcfValidation.referencedParts.join(', ')})`);
    deps.sendToRenderer('PART_BUILT', { part: partName, size });
    if (partName === state.activePart()) deps.sendModelUpdated(partName);
    resolveBuildWaiters(partName, {
      ok: true, part: partName, kernel: state.currentKernel(), cacheFile: path.basename(sourcePath), cacheSize: size, faceCount: null
    });
    state.buildingParts().delete(partName);
    finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
    broadcastPartsList();
    if (state.pendingParts().has(partName)) runBuild(partName);
  }

  function finalizeBuildChild(child, partName, label, exportProjectStl = false, buildStartedAt = Date.now()) {
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d) => { const s = d.toString(); stdout += s; deps.sendLog(s.trimEnd()); });
    child.stderr?.on('data', (d) => { const s = d.toString(); stderr += s; deps.sendLog(s.trimEnd(), 'warn'); });
    child.on('error', (err) => {
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      const friendlyMsg = err.message;
      deps.sendLog(`[${partName}] ${label} failed: ${friendlyMsg}`, 'error');
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: friendlyMsg });
      broadcastPartsList();
      resolveBuildWaiters(partName, { ok: false, part: partName, error: friendlyMsg });
    });
    child.on('close', async (code) => {
      const builtInputMtime = runningBuildInputs.get(partName) || 0;
      state.buildingParts().delete(partName);
      const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
      const cacheFile = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
      const cacheBase = cacheFile ? path.basename(cacheFile) : `${partName}.cache`;
      try {
        if (code !== 0) {
          deps.sendLog(`[${partName}] ${label} exited with code ${code}`, 'error');
          deps.sendToRenderer('BUILD_FAILED', { part: partName, code, stderr });
          resolveBuildWaiters(partName, { ok: false, part: partName, exitCode: code, stderr: stderr.trim(), stdout: stdout.trim() });
          finishBuildPass(partName, builtInputMtime);
        } else if (cacheFile && fs.existsSync(cacheFile)) {
          const size = fs.statSync(cacheFile).size;
          const brepMs = elapsedMs(buildStartedAt);
          if (exportProjectStl && source?.kind === 'part') {
            const stlStartedAt = Date.now();
            await deps.ensurePartStlArtifact(partName);
            const stlMs = elapsedMs(stlStartedAt);
            pendingStlAfterBuild.delete(partName);
            deps.sendLog(`[${partName}] Project STL updated (parts/${partName}/${partName}.stl, STL ${formatDuration(stlMs)})`);
          }
          deps.sendLog(`[${partName}] BREP time: ${formatDuration(brepMs)}`);
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
          finishBuildPass(partName, builtInputMtime);
        } else {
          deps.sendToRenderer('BUILD_FAILED', { part: partName, message: `${cacheBase} was not generated` });
          resolveBuildWaiters(partName, { ok: false, part: partName, error: `${cacheBase} was not generated`, stderr: stderr.trim() });
          finishBuildPass(partName, builtInputMtime);
        }
      } catch (err) {
          const msg = `Failed to generate STL artifact for "${partName}": ${err.message || err}`;
          deps.sendLog(msg, 'error');
          deps.sendToRenderer('BUILD_FAILED', { part: partName, message: msg });
          resolveBuildWaiters(partName, { ok: false, part: partName, error: msg });
          finishBuildPass(partName, builtInputMtime);
      } finally {
        broadcastPartsList();
        if (state.pendingParts().has(partName)) runBuild(partName);
      }
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
    const assetUrl = (filePath) => {
      const rel = path.relative(state.currentProjectPath(), filePath).replace(/\\/g, '/');
      return `aicad://asset/${rel.split('/').map((segment) => encodeURIComponent(segment)).join('/')}?t=${ts}`;
    };
    const url = source?.kind === 'asm'
      ? assetUrl(source.sourcePath)
      : `aicad://model/${encodeURIComponent(partName)}${suffix}?t=${ts}`;
    const paramsPath = deps.modelParamsPath(state.currentProjectPath(), partName);
    const paramsUrl = fs.existsSync(paramsPath)
      ? assetUrl(paramsPath)
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
      async getPartScreenshot(name, view = 'iso', mode = 'solid') {
        if (!state.currentProjectPath()) return null;
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return null;
        try { await selectPart(name); } catch { return null; }
        const p = deps.partPng(state.currentProjectPath(), name, view, mode);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p);
      },
      async rebuildPartSync(name) {
        if (!state.currentProjectPath()) return { ok: false, error: 'No project is open in the preview app.' };
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return { ok: false, error: `Model does not exist: ${name}` };
        let result = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
          const freshness = refreshModelDirtyState(name, source);
          if (!state.buildingParts().has(name) && !freshness.buildDirty && source?.kind !== 'asm') {
            result = cachedBuildResult(name, source);
            break;
          }
          result = await new Promise((resolve) => {
            if (!state.buildWaiters().has(name)) state.buildWaiters().set(name, []);
            state.buildWaiters().get(name).push(resolve);
            scheduleBuild(name);
          });
          if (!result?.ok) return result;
          const after = refreshModelDirtyState(name, source);
          if (!state.buildingParts().has(name) && !after.buildDirty) break;
        }
        if (!result?.ok) return result;
        const refreshed = await refreshViewerCachesAfterBuild(name);
        return { ...result, ...refreshed };
      },
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
    validateMjcfAssemblyReferences,
    runBuildMjcf,
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
      PARTS_DIR: constants.PARTS_DIR,
      ASSEMBLIES_DIR: constants.ASSEMBLIES_DIR,
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
      migrateLegacyModelsLayout: project.migrateLegacyModelsLayout,
      detectBuildRuntime: runtime.detectBuildRuntime,
      missingRuntimeMessage: runtime.missingRuntimeMessage,
      buildRuntimeSpawn: runtime.buildRuntimeSpawn,
      getBuildRuntimeStatus: runtime.getBuildRuntimeStatus,
      ensurePartStlArtifact: build.ensurePartStlArtifact,
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
