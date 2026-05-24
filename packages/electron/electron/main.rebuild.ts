// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const { spawn } = require('child_process');
const { pythonChildProcessEnv } = require('./python-env');

global.DOMParser = DOMParser;

function createMainRebuildTools({ state, deps }) {
  const dirtyBuildInputs = new Map();
  const runningBuildInputs = new Map();
  const partBrepBuildPromises = new Map();
  const modelBuildChildren = new Map();
  const partPrepareConcurrency = Math.max(1, Math.min(4, Math.max(1, (os.cpus?.().length || 2) - 1)));

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function trackBuildChild(modelName, child) {
    if (!modelName || !child) return;
    if (!modelBuildChildren.has(modelName)) modelBuildChildren.set(modelName, new Set());
    const tracked = modelBuildChildren.get(modelName);
    tracked.add(child);
    const untrack = () => tracked.delete(child);
    child.once('close', untrack);
    child.once('error', untrack);
  }

  function killBuildChild(child) {
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  function elapsedMs(startMs) {
    return Math.max(0, Date.now() - startMs);
  }

  function formatDuration(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    if (safe < 1000) return `${safe} ms`;
    return `${(safe / 1000).toFixed(safe < 10000 ? 2 : 1)} s`;
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
    const partRoot = path.join(deps.modelDir(state.currentProjectPath(), name), 'parts');
    let latest = Math.max(statMtimeMs(resolved.sourcePath), statMtimeMs(paramsPath));
    if (fs.existsSync(partRoot)) {
      for (const d of fs.readdirSync(partRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        latest = Math.max(
          latest,
          statMtimeMs(deps.modelPartSource(state.currentProjectPath(), name, d.name, state.currentKernel())),
          statMtimeMs(deps.modelPartParamsPath(state.currentProjectPath(), name, d.name))
        );
      }
    }
    return latest;
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
    const cacheFresh = true;
    const markedDirtyAt = dirtyBuildInputs.get(name) || 0;
    if (markedDirtyAt > 0) {
      dirtyBuildInputs.set(name, Math.max(inputMtime, markedDirtyAt));
    } else {
      dirtyBuildInputs.delete(name);
    }
    return { inputMtime, buildDirty: dirtyBuildInputs.has(name), cacheFresh, cacheFile };
  }

  function resetBuildTracking() {
    dirtyBuildInputs.clear();
    runningBuildInputs.clear();
    modelBuildChildren.clear();
    partBrepBuildPromises.clear();
  }

  function isModelBuildDirty(name) {
    return dirtyBuildInputs.has(name);
  }

  function markModelDirty(name) {
    if (!state.currentProjectPath() || !name) return;
    const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    if (!source) return;
    dirtyBuildInputs.set(name, modelInputMtime(name, source));
  }

  function clearModelDirtyUpTo(name, builtInputMtime) {
    const markedDirtyAt = dirtyBuildInputs.get(name) || 0;
    if (markedDirtyAt <= builtInputMtime) dirtyBuildInputs.delete(name);
  }

  function modelPartInputMtime(modelName, partName) {
    if (!state.currentProjectPath() || !modelName || !partName) return 0;
    return Math.max(
      statMtimeMs(deps.modelPartSource(state.currentProjectPath(), modelName, partName, state.currentKernel())),
      statMtimeMs(deps.modelPartParamsPath(state.currentProjectPath(), modelName, partName))
    );
  }

  function isModelPartStlFresh(modelName, partName) {
    const cacheFile = deps.partCache(state.currentProjectPath(), modelName, partName, state.currentKernel());
    const dependencyMtime = Math.max(modelPartInputMtime(modelName, partName), statMtimeMs(cacheFile));
    return isFileFreshForInput(deps.modelPartStlPath(state.currentProjectPath(), modelName, partName), dependencyMtime);
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
      faceCount: null,
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

  async function prepareModelDeletion(modelName) {
    const name = String(modelName || '').trim();
    if (!name) return;
    state.pendingParts().delete(name);
    const tracked = modelBuildChildren.get(name);
    if (tracked?.size) {
      for (const child of tracked) killBuildChild(child);
      if (process.platform === 'win32') await sleep(400);
    }
    const deadline = Date.now() + 3000;
    while (state.buildingParts().has(name) && Date.now() < deadline) {
      await sleep(100);
    }
    if (state.buildingParts().has(name)) {
      state.buildingParts().delete(name);
      runningBuildInputs.delete(name);
      dirtyBuildInputs.delete(name);
      resolveBuildWaiters(name, { ok: false, error: 'Model deleted' });
    }
    modelBuildChildren.delete(name);
    const modelKey = `${name}__`.toLowerCase();
    for (const key of Array.from(partBrepBuildPromises.keys())) {
      if (String(key).toLowerCase().includes(modelKey)) partBrepBuildPromises.delete(key);
    }
    const projectPath = state.currentProjectPath();
    if (projectPath) {
      const watcher = state.watcher();
      const modelRoot = path.join(projectPath, deps.MODELS_DIR, name);
      if (watcher) {
        const paths = [
          modelRoot,
          path.join(modelRoot, deps.modelSourceFilename(state.currentKernel(), 'asm')),
          path.join(modelRoot, 'params.json'),
          path.join(modelRoot, 'parts')
        ];
        for (const watchedPath of paths) {
          try { await watcher.unwatch(watchedPath); } catch {}
        }
      }
    }
    state.partInfoCache().delete(name);
    state.partLoadedWaiters().delete(name);
  }

  async function openProject(projectPath, { runImmediately = false } = {}) {
    const resolvedProjectPath = path.resolve(projectPath);
    const nextKernel = deps.readProjectKernel(resolvedProjectPath);
    ensureRuntimeDirs(resolvedProjectPath);
    await ensureProjectDirectoryAccess(resolvedProjectPath, { sendLog: deps.sendLog });

    stopWatcher();
    state.setCurrentProjectPath(resolvedProjectPath);
    state.setCurrentKernel(nextKernel);
    state.partInfoCache().clear();
    state.buildWaiters().clear();
    state.partLoadedWaiters().clear();
    dirtyBuildInputs.clear();
    runningBuildInputs.clear();

    deps.saveLastProjectPath(resolvedProjectPath);
    deps.sendLog(`Project kernel: ${deps.kernelMeta(state.currentKernel()).label} (${state.currentKernel()})`);

    const models = listPartsRaw(resolvedProjectPath, state.currentKernel());
    state.setActivePart(models[0]?.name || null);

    deps.sendToRenderer('PROJECT_OPENED', {
      path: resolvedProjectPath,
      kernel: state.currentKernel(),
      kernelLabel: deps.kernelMeta(state.currentKernel()).label,
      sourceFile: deps.kernelMeta(state.currentKernel()).sourceFile,
      sourceFiles: Object.values(deps.sourceFileOptions(state.currentKernel())),
      previewFormat: deps.kernelMeta(state.currentKernel()).previewFormat
    });
    deps.sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus(state.currentKernel()));
    deps.broadcastPartsList();
    deps.rebuildAppMenu();

    const globs = [
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', deps.modelSourceFilename(state.currentKernel(), 'asm')).replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', deps.modelSourceFilename(state.currentKernel(), 'assembly')).replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', deps.modelSourceFilename(state.currentKernel(), 'part')).replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', 'params.json').replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', 'parts', '*', deps.modelSourceFilename(state.currentKernel(), 'part')).replace(/\\/g, '/'),
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', 'parts', '*', 'params.json').replace(/\\/g, '/')
    ];
    const watcher = chokidar.watch(globs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    state.setWatcher(watcher);

    watcher.on('change', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (!entry) return;
      deps.sendLog(`Model changed: models/${entry.name}/${entry.fileName}`);
      markModelDirty(entry.name);
      scheduleBuild(entry.name);
    });
    watcher.on('add', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        markModelDirty(entry.name);
        deps.broadcastPartsList();
        scheduleBuild(entry.name);
      }
    });
    watcher.on('unlink', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        markModelDirty(entry.name);
        scheduleBuild(entry.name);
      }
      deps.broadcastPartsList();
    });
    watcher.on('error', (err) => deps.sendLog(`watcher error: ${err.message}`, 'error'));

    if (runImmediately && state.activePart()) {
      scheduleBuild(state.activePart(), { force: true });
      maybeSendModelUpdated(state.activePart());
    }
  }

  function maybeSendModelUpdated(partName) {
    if (!state.currentProjectPath() || !partName || partName !== state.activePart()) return;
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    const cache = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
    const freshness = refreshModelDirtyState(partName, source);
    if (cache && fs.existsSync(cache) && !freshness.buildDirty && assemblyMeshesReady(partName, source)) {
      sendModelUpdated(partName);
    }
  }

  function assemblyMeshesReady(modelName, source) {
    const sourcePath = source?.sourcePath;
    if (!sourcePath || !fs.existsSync(sourcePath)) return false;
    try {
      const sourceLabel = path.basename(sourcePath);
      const document = parseMjcfDocument(readAssemblyMjcfText(sourcePath), sourceLabel);
      const meshes = new Map();
      for (const meshEl of Array.from(document.getElementsByTagName('mesh'))) {
        const meshName = String(meshEl.getAttribute('name') || '').trim();
        const file = String(meshEl.getAttribute('file') || '').trim();
        if (meshName && file) meshes.set(meshName, file);
      }
      const meshRefs = [];
      for (const geomEl of Array.from(document.getElementsByTagName('geom'))) {
        if (String(geomEl.getAttribute('type') || '').trim() === 'mesh' || geomEl.hasAttribute('mesh')) {
          const meshName = String(geomEl.getAttribute('mesh') || '').trim();
          const meshRef = meshes.get(meshName);
          if (meshRef) meshRefs.push(meshRef);
        }
      }
      if (meshRefs.length === 0) return false;
      const asmDir = path.dirname(sourcePath);
      return meshRefs.every((meshRef) => {
        const normalized = meshRef.replace(/^package:\/\//i, '').replace(/\\/g, '/');
        const abs = path.resolve(asmDir, normalized);
        return fs.existsSync(abs) && fs.statSync(abs).isFile();
      });
    } catch {
      return false;
    }
  }

  async function selectPart(name) {
    if (!state.currentProjectPath()) return;
    if (!deps.resolveModelSource(state.currentProjectPath(), name)) {
      throw new Error(`Model does not exist: ${name}`);
    }
    state.setActivePart(name);
    deps.sendToRenderer('ACTIVE_MODEL_CHANGED', { name });
    deps.broadcastPartsList();

    scheduleBuild(name, { force: true });
    maybeSendModelUpdated(name);
  }

  function scheduleBuild(partName, { force = false } = {}) {
    if (!state.currentProjectPath() || !partName) return;
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    if (!source) return;
    if (force) markModelDirty(partName);
    const freshness = refreshModelDirtyState(partName, source);
    if (state.buildingParts().has(partName)) {
      const runningInputMtime = runningBuildInputs.get(partName) || 0;
      if (freshness.buildDirty && freshness.inputMtime > runningInputMtime) {
        state.pendingParts().add(partName);
      }
      return;
    }
    if (!freshness.buildDirty) {
      if (partName === state.activePart()) maybeSendModelUpdated(partName);
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
    if (!freshness.buildDirty) {
      resolveBuildWaiters(partName, cachedBuildResult(partName, source));
      if (state.pendingParts().has(partName)) state.pendingParts().delete(partName);
      deps.broadcastPartsList();
      return;
    }
    state.buildingParts().add(partName);
    state.pendingParts().delete(partName);
    deps.sendToRenderer('BUILD_STARTED', { part: partName });
    deps.broadcastPartsList();
    runningBuildInputs.set(partName, freshness.inputMtime);
    if (source.kind === 'assembly') return runBuildAssembly(partName, source);
    if (source.kind === 'part') return runBuildFlatPart(partName, source);
    return runBuildMjcf(partName, source);
  }

  async function runBuildAssembly(partName, source) {
    return runBuildBrep(partName, source, source.sourcePath, 'assembly.py');
  }

  async function runBuildFlatPart(partName, source) {
    return runBuildBrep(partName, source, source.sourcePath, 'part.py');
  }

  async function runBuildBrep(partName, source, sourcePath, sourceLabel) {
    if (!fs.existsSync(sourcePath)) {
      const message = `${sourceLabel} not found for model "${partName}"`;
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: message });
      deps.broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const cacheFile = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
    const buildResult = await runBuildPython(partName, partName, cacheFile, { sourceRelpath: path.relative(state.currentProjectPath(), sourcePath).replace(/\\/g, '/') });
    if (!buildResult?.ok) {
      const message = buildResult?.error || `${sourceLabel} build failed for model "${partName}"`;
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message, stderr: buildResult?.stderr });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: message, stderr: buildResult?.stderr });
      deps.broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const size = fs.existsSync(cacheFile) ? fs.statSync(cacheFile).size : 0;
    deps.sendLog(`[${partName}] ${sourceLabel} built (${(size / 1024).toFixed(1)} KB)`);
    deps.sendToRenderer('PART_BUILT', { part: partName, size });
    if (partName === state.activePart()) sendModelUpdated(partName);
    resolveBuildWaiters(partName, {
      ok: true, part: partName, kernel: state.currentKernel(), cacheFile: path.basename(cacheFile), cacheSize: size, faceCount: null
    });
    clearModelDirtyUpTo(partName, runningBuildInputs.get(partName) || 0);
    state.buildingParts().delete(partName);
    finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
    deps.broadcastPartsList();
    if (state.pendingParts().has(partName)) runBuild(partName);
  }

  async function runBuildPython(modelName, partName, outFile, opts = {}) {
    const runtime = await deps.detectBuildRuntime(state.currentKernel());
    if (!runtime) {
      const msg = deps.missingRuntimeMessage(state.currentKernel());
      deps.sendLog(msg, 'error');
      deps.sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus(state.currentKernel()));
      return { ok: false, part: modelName, model: modelName, modelPart: partName, error: msg, reason: 'NO_RUNTIME' };
    }
    const args = [
      '--project', state.currentProjectPath(),
      '--model', modelName,
      '--part-name', partName,
      '--output', outFile
    ];
    if (opts.sourceRelpath) args.push('--source', opts.sourceRelpath);
    const cmd = deps.buildRuntimeSpawn(runtime, args);
    deps.sendLog(
      runtime.kind === 'bundled-runner'
        ? `[${modelName}/${partName}] Build using bundled build123d + bd_warehouse runtime`
        : `[${modelName}/${partName}] Build using Python ${runtime.cmd} (v${runtime.version}) with ${deps.kernelMeta(state.currentKernel()).label}`
    );
    const buildStartedAt = Date.now();
    const child = spawn(cmd.cmd, cmd.args, { cwd: state.currentProjectPath(), shell: false, windowsHide: true, env: pythonChildProcessEnv() });
    trackBuildChild(modelName, child);
    return await runBuildChild(
      child,
      modelName,
      partName,
      outFile,
      runtime.kind === 'bundled-runner' ? 'bundled build123d + bd_warehouse runtime' : 'electron/export_runner.py',
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
  const MJCF_PARAM_TOKEN_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g;
  const MJCF_NUMERIC_EXPR_RE = /^[\d+\-*/().\sA-Za-z_$]+$/;

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

  function evaluateMjcfParamExpression(params, expression, sourceLabel) {
    const expr = String(expression || '').trim();
    if (MJCF_PARAM_PATH_RE.test(expr)) return getParamPath(params, expr, sourceLabel);
    if (!MJCF_NUMERIC_EXPR_RE.test(expr)) {
      throw new Error(`${sourceLabel} has unsupported parameter expression: \${${expr}}`);
    }
    const values = [];
    const jsExpr = expr.replace(MJCF_PARAM_TOKEN_RE, (key) => {
      const value = getParamPath(params, key, sourceLabel);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${sourceLabel} expression requires numeric params.json value: \${${key}}`);
      }
      values.push(value);
      return `__v[${values.length - 1}]`;
    });
    if (!/^[\d+\-*/().\s_[\]v]+$/.test(jsExpr)) {
      throw new Error(`${sourceLabel} has unsupported parameter expression: \${${expr}}`);
    }
    const result = Function('__v', `"use strict"; return (${jsExpr});`)(values);
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new Error(`${sourceLabel} parameter expression did not produce a finite number: \${${expr}}`);
    }
    return result;
  }

  function interpolateMjcfParams(text, params = {}, sourceLabel = 'asm.xml') {
    return String(text || '').replace(/<!--[\s\S]*?-->|(\$\{([^}]+)\})/g, (match, expr, rawKey) => {
      if (!expr) return match;
      const key = String(rawKey || '').trim();
      return escapeXmlAttr(formatMjcfParamValue(evaluateMjcfParamExpression(params, key, sourceLabel)));
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

  async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    }));
    return results;
  }

  function runBuildChild(child, modelName, partName, cacheFile, label, buildStartedAt = Date.now()) {
    return new Promise((resolve) => {
      let stderr = '';
      let stdout = '';
      child.stdout?.on('data', (d) => { const s = d.toString(); stdout += s; deps.sendLog(s.trimEnd()); });
      child.stderr?.on('data', (d) => { const s = d.toString(); stderr += s; deps.sendLog(s.trimEnd(), 'warn'); });
      child.on('error', (err) => {
        const friendlyMsg = err.message;
        deps.sendLog(`[${modelName}/${partName}] ${label} failed: ${friendlyMsg}`, 'error');
        resolve({ ok: false, part: modelName, model: modelName, modelPart: partName, error: friendlyMsg });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          deps.sendLog(`[${modelName}/${partName}] ${label} exited with code ${code}`, 'error');
          resolve({ ok: false, part: modelName, model: modelName, modelPart: partName, exitCode: code, stderr: stderr.trim(), stdout: stdout.trim() });
          return;
        }
        if (!cacheFile || !fs.existsSync(cacheFile)) {
          const cacheBase = cacheFile ? path.basename(cacheFile) : `${modelName}__${partName}.cache`;
          resolve({ ok: false, part: modelName, model: modelName, modelPart: partName, error: `${cacheBase} was not generated`, stderr: stderr.trim() });
          return;
        }
        const size = fs.statSync(cacheFile).size;
        deps.sendLog(`[${modelName}/${partName}] BREP time: ${formatDuration(elapsedMs(buildStartedAt))}`);
        deps.sendLog(`[${modelName}/${partName}] Part cache updated (${(size / 1024).toFixed(1)} KB)`);
        resolve({
          ok: true,
          part: modelName,
          model: modelName,
          modelPart: partName,
          kernel: state.currentKernel(),
          cacheFile: path.basename(cacheFile),
          cacheSize: size,
          stdout: stdout.trim()
        });
      });
    });
  }

  function runJsonChild(child, input, label) {
    return new Promise((resolve) => {
      let stderr = '';
      let stdout = '';
      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ ok: false, error: `${label} timed out`, stderr: stderr.trim(), stdout: stdout.trim() });
      }, 90000);
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: err.message, stderr: stderr.trim(), stdout: stdout.trim() });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch {}
          resolve({ ok: false, error: parsed?.error || `${label} exited with code ${code}`, stderr: stderr.trim(), stdout: stdout.trim() });
          return;
        }
        try {
          resolve(JSON.parse(stdout || '{}'));
        } catch (e) {
          resolve({ ok: false, error: `${label} returned invalid JSON: ${e.message}`, stderr: stderr.trim(), stdout: stdout.trim() });
        }
      });
      child.stdin?.end(JSON.stringify(input || {}));
    });
  }

  async function ensurePartBrepArtifact(modelName, partName) {
    const sourcePath = deps.modelPartSource(state.currentProjectPath(), modelName, partName, state.currentKernel());
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: `Model part "${partName}" does not exist in models/${modelName}/parts/${partName}.` };
    }
    const cacheFile = deps.partCache(state.currentProjectPath(), modelName, partName, state.currentKernel());
    if (isFileFreshForInput(cacheFile, modelPartInputMtime(modelName, partName))) {
      return { ok: true, skipped: true, cacheFile };
    }
    const sourceRelpath = path.relative(state.currentProjectPath(), sourcePath).replace(/\\/g, '/');
    const key = path.resolve(cacheFile).toLowerCase();
    if (partBrepBuildPromises.has(key)) return partBrepBuildPromises.get(key);
    const promise = runBuildPython(modelName, partName, cacheFile, { sourceRelpath }).finally(() => {
      partBrepBuildPromises.delete(key);
    });
    partBrepBuildPromises.set(key, promise);
    return await promise;
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
    const modelRoot = path.resolve(asmDir);
    const partsRoot = path.join(modelRoot, 'parts');
    const partByName = new Map();
    for (const meshRef of meshRefs) {
      if (!meshRef) return { ok: false, error: `${sourceLabel} for "${asmName}" has an empty mesh file.` };
      const normalized = meshRef.replace(/^package:\/\//i, '').replace(/\\/g, '/');
      const abs = path.resolve(asmDir, normalized);
      if (!abs.startsWith(`${partsRoot}${path.sep}`)) return { ok: false, error: `${sourceLabel} mesh path must stay inside models/${asmName}/parts/: ${meshRef}` };
      if (path.extname(abs).toLowerCase() !== '.stl') return { ok: false, error: `${sourceLabel} currently supports STL meshes only: ${meshRef}` };
      const base = path.basename(abs, path.extname(abs));
      const partSourcePath = deps.modelPartSource(state.currentProjectPath(), asmName, base, state.currentKernel());
      if (!fs.existsSync(partSourcePath)) {
        return { ok: false, error: `${sourceLabel} mesh "${meshRef}" is not linked to an existing local part "${base}" (expected models/${asmName}/parts/${base}/part${deps.sourceExt(state.currentKernel())}).` };
      }
      if (!partByName.has(base)) partByName.set(base, { name: base, abs, meshRef });
    }

    const referencedPartEntries = Array.from(partByName.values());
    const partTimings = [];
    const prepareResults = await mapWithConcurrency(referencedPartEntries, partPrepareConcurrency, async ({ name: base, meshRef }) => {
      const brepStartedAt = Date.now();
      const brepResult = await ensurePartBrepArtifact(asmName, base);
      const brepMs = elapsedMs(brepStartedAt);
      if (!brepResult?.ok) {
        return { ok: false, error: `${sourceLabel} mesh "${meshRef}" BREP build failed for part "${base}": ${brepResult?.error || brepResult?.stderr || 'unknown error'}` };
      }

      const stlWasFresh = isModelPartStlFresh(asmName, base);
      const stlStartedAt = Date.now();
      try {
        await deps.ensurePartStlArtifact(asmName, base);
      } catch (e) {
        return { ok: false, error: `${sourceLabel} mesh file not found and could not be built: ${meshRef} (${e.message || String(e)})` };
      }
      const stlMs = elapsedMs(stlStartedAt);
      deps.sendLog(`[${asmName}] Part "${base}" ready: BREP ${formatDuration(brepMs)}${brepResult.skipped ? ' (fresh)' : ''}, STL ${formatDuration(stlMs)}${stlWasFresh ? ' (fresh)' : ''}.`);
      return { ok: true, name: base, brepMs, stlMs };
    });

    for (const result of prepareResults) {
      if (!result?.ok) return result;
      partTimings.push({ name: result.name, brepMs: result.brepMs, stlMs: result.stlMs });
    }
    for (const { abs, meshRef } of referencedPartEntries) {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: `${sourceLabel} mesh file not found: ${meshRef}` };
    }
    return { ok: true, meshCount: meshRefs.length, referencedParts: referencedPartEntries.map((part) => part.name), partTimings };
  }

  async function runBuildMjcf(partName, source) {
    const sourcePath = source?.sourcePath || deps.partSource(state.currentProjectPath(), partName, state.currentKernel(), 'asm');
    if (!fs.existsSync(sourcePath)) {
      const message = `asm.xml was not generated for model "${partName}"`;
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: message });
      deps.broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const mjcfValidation = await validateMjcfAssemblyReferences(sourcePath, partName);
    if (!mjcfValidation.ok) {
      state.buildingParts().delete(partName);
      finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
      deps.sendToRenderer('BUILD_FAILED', { part: partName, message: mjcfValidation.error });
      resolveBuildWaiters(partName, { ok: false, part: partName, error: mjcfValidation.error });
      deps.broadcastPartsList();
      if (state.pendingParts().has(partName)) runBuild(partName);
      return;
    }
    const size = fs.statSync(sourcePath).size;
    const sourceLabel = path.basename(sourcePath);
    deps.sendLog(`[${partName}] ${sourceLabel} assembly updated (${(size / 1024).toFixed(1)} KB, ${mjcfValidation.meshCount} meshes from parts: ${mjcfValidation.referencedParts.join(', ')})`);
    deps.sendToRenderer('PART_BUILT', { part: partName, size });
    if (partName === state.activePart()) sendModelUpdated(partName);
    resolveBuildWaiters(partName, {
      ok: true, part: partName, kernel: state.currentKernel(), cacheFile: path.basename(sourcePath), cacheSize: size, faceCount: null
    });
    clearModelDirtyUpTo(partName, runningBuildInputs.get(partName) || 0);
    state.buildingParts().delete(partName);
    finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
    deps.broadcastPartsList();
    if (state.pendingParts().has(partName)) runBuild(partName);
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
    sendModelUpdated(partName);
    const loaded = await waitForPartLoaded(partName, 5000);
    if (!loaded) return { cacheRefresh: 'timeout' };
    return { cacheRefresh: 'ok', faceCount: state.partInfoCache().get(partName)?.faceCount ?? null };
  }

  function sendModelUpdated(partName) {
    const source = deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    const cache = deps.modelCacheFile(state.currentProjectPath(), partName, source, state.currentKernel());
    if (!cache || !fs.existsSync(cache)) return;
    if (source.kind === 'asm' && !assemblyMeshesReady(partName, source)) return;
    const ts = Date.now();
    const size = fs.statSync(cache).size;
    const ext = path.extname(cache).replace(/^\./, '');
    const format = deps.modelPreviewFormat(source, state.currentKernel());
    const assetUrl = (filePath) => {
      const rel = path.relative(state.currentProjectPath(), filePath).replace(/\\/g, '/');
      return `aicad://asset/${rel.split('/').map((segment) => encodeURIComponent(segment)).join('/')}?t=${ts}`;
    };
    const url = assetUrl(cache);
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
      kind: 'model',
      size,
      ts
    });
  }
  async function rebuildPartSync(name) {
    if (!state.currentProjectPath()) return { ok: false, error: 'No project is open in Forgent3D.' };
    if (!deps.resolveModelSource(state.currentProjectPath(), name)) return { ok: false, error: `Model does not exist: ${name}` };
    markModelDirty(name);
    let result = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
      const freshness = refreshModelDirtyState(name, source);
      if (!state.buildingParts().has(name) && !freshness.buildDirty) {
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
  }

  return {
    resetBuildTracking,
    isModelBuildDirty,
    markModelDirty,
    scheduleBuild,
    runBuild,
    runBuildPython,
    validateMjcfAssemblyReferences,
    runBuildMjcf,
    resolveBuildWaiters,
    prepareModelDeletion,
    resolvePartLoadedWaiters,
    refreshViewerCachesAfterBuild,
    sendModelUpdated,
    maybeSendModelUpdated,
    rebuildPartSync
  };
}

function initMainRebuildTools(mainContext) {
  const { constants, templates, model, runtime, build, ui, state } = mainContext;
  return createMainRebuildTools({
    state: {
      currentProjectPath: state.currentProjectPath,
      currentKernel: state.currentKernel,
      activePart: state.activePart,
      partInfoCache: state.partInfoCache,
      buildingParts: state.buildingParts,
      pendingParts: state.pendingParts,
      buildWaiters: state.buildWaiters,
      partLoadedWaiters: state.partLoadedWaiters
    },
    deps: {
      MODELS_DIR: constants.MODELS_DIR,
      assertKernel: templates.assertKernel,
      kernelMeta: templates.kernelMeta,
      sourceExt: model.sourceExt,
      modelSourceFilename: model.modelSourceFilename,
      resolveModelSource: model.resolveModelSource,
      partSource: model.partSource,
      modelDir: model.modelDir,
      modelParamsPath: model.modelParamsPath,
      modelPartSource: model.modelPartSource,
      modelPartParamsPath: model.modelPartParamsPath,
      modelPartStlPath: model.modelPartStlPath,
      partCache: model.partCache,
      modelCacheFile: model.modelCacheFile,
      modelPreviewFormat: model.modelPreviewFormat,
      detectBuildRuntime: runtime.detectBuildRuntime,
      missingRuntimeMessage: runtime.missingRuntimeMessage,
      buildRuntimeSpawn: runtime.buildRuntimeSpawn,
      getBuildRuntimeStatus: runtime.getBuildRuntimeStatus,
      ensurePartStlArtifact: build.ensurePartStlArtifact,
      sendToRenderer: ui.sendToRenderer,
      sendLog: ui.sendLog,
      broadcastPartsList: () => {}
    }
  });
}

module.exports = {
  createMainRebuildTools,
  initMainRebuildTools
};
