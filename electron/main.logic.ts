// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const chokidar = require('chokidar');
const { DOMParser } = require('@xmldom/xmldom');
const { spawn } = require('child_process');

global.DOMParser = DOMParser;

function createMainLogicTools({ state, deps }) {
  const dirtyBuildInputs = new Map();
  const runningBuildInputs = new Map();
  const partBrepBuildPromises = new Map();
  const partPrepareConcurrency = Math.max(1, Math.min(4, Math.max(1, (os.cpus?.().length || 2) - 1)));

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
    writeIfChanged(path.join(projectPath, '.gitignore'), '# Forgent3D\n.cache/\n__pycache__/\n*.pyc\n');
    fs.mkdirSync(path.join(projectPath, deps.MODELS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });

    const sampleModelName = 'reference_mount';
    const samplePartNames = ['mounting_plate', 'fastener_stack'];
    const modelDir = deps.modelDir(projectPath, sampleModelName);
    const asmSrcPath = deps.partSource(projectPath, sampleModelName, k, 'asm');
    fs.mkdirSync(modelDir, { recursive: true });
    writeIfMissing(
      deps.modelParamsPath(projectPath, sampleModelName),
      deps.modelParamsTemplate('asm', sampleModelName, 'Reference assembly parameters for a standard fastener mount.', { template: 'reference_mount' })
    );
    for (const partName of samplePartNames) {
      const partSrcPath = deps.modelPartSource(projectPath, sampleModelName, partName, k);
      fs.mkdirSync(path.dirname(partSrcPath), { recursive: true });
      writeIfMissing(
        deps.modelPartParamsPath(projectPath, sampleModelName, partName),
        deps.modelParamsTemplate('part', partName, `Reference ${partName} parameters.`, { template: partName })
      );
      writeIfMissing(
        partSrcPath,
        deps.modelSourceTemplate(k, 'part', partName, `Reference ${partName}. Edit ${meta.sourceFile} to preview changes.`, { template: partName })
      );
    }
    const asmTemplate = deps.modelSourceTemplate(k, 'asm', sampleModelName, 'Reference model package that composes a custom mounting plate with bd_warehouse fasteners.', { template: 'reference_mount', partNames: samplePartNames });
    writeIfMissing(asmSrcPath, asmTemplate);
    writeIfMissing(deps.partReadme(projectPath, sampleModelName), deps.modelReadmeTemplate(k, 'asm', sampleModelName, 'Reference mount model package for AI-assisted CAD generation.'));
    deps.sendLog(`Sample model created: models/${sampleModelName}/asm.xml + models/${sampleModelName}/params.json + ${samplePartNames.map((partName) => `models/${sampleModelName}/parts/${partName}/${deps.modelSourceFilename(k, 'part')} + models/${sampleModelName}/parts/${partName}/params.json`).join(' + ')}`);
  }

  function ensureRuntimeDirs(projectPath) {
    fs.mkdirSync(path.join(projectPath, deps.MODELS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });
  }

  function listPartsRaw(projectPath, kernel = state.currentKernel()) {
    const k = deps.assertKernel(kernel);
    const root = path.join(projectPath, deps.MODELS_DIR);
    const entries = [];
    if (!fs.existsSync(root)) return [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const source = deps.resolveModelSource(projectPath, d.name, k);
      if (source) entries.push({ name: d.name, source });
    }
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, source }) => ({
        name,
        kind: 'model',
        sourceFile: source.fileName,
        description: readPartDescription(projectPath, name, k)
      }));
  }

  function assetUrlForProjectPath(projectPath, filePath) {
    const rel = path.relative(projectPath, filePath).replace(/\\/g, '/');
    return `aicad://asset/${rel.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
  }

  function listModelParts(projectPath, modelName, kernel = state.currentKernel()) {
    const k = deps.assertKernel(kernel);
    const partsRoot = path.join(deps.modelDir(projectPath, modelName), 'parts');
    if (!fs.existsSync(partsRoot)) return [];
    const parts = [];
    for (const d of fs.readdirSync(partsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sourcePath = deps.modelPartSource(projectPath, modelName, d.name, k);
      if (!fs.existsSync(sourcePath)) continue;
      const stlPath = deps.modelPartStlPath(projectPath, modelName, d.name);
      parts.push({
        name: d.name,
        sourceFile: deps.modelSourceFilename(k, 'part'),
        stlFile: `${d.name}.stl`,
        hasStl: fs.existsSync(stlPath),
        stlUrl: assetUrlForProjectPath(projectPath, stlPath)
      });
    }
    return parts.sort((a, b) => a.name.localeCompare(b.name));
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
        parts: listModelParts(projectPath, p.name, k),
        building: state.buildingParts().has(p.name) || state.pendingParts().has(p.name)
      };
    });
  }

  function broadcastPartsList() {
    if (!state.currentProjectPath()) return;
    deps.sendToRenderer('MODELS_LIST', {
      active: state.activePart(),
      kernel: state.currentKernel(),
      models: listParts(state.currentProjectPath(), state.currentKernel())
    });
  }

  function partNameFromPath(filePath) {
    const rel = path.relative(state.currentProjectPath() || '', filePath).replace(/\\/g, '/');
    const ext = deps.sourceExt(state.currentKernel()).replace(/^\./, '');
    const asmMatch = /^models\/([^/]+)\/asm\.xml$/i.exec(rel);
    if (asmMatch) return { name: asmMatch[1], kind: 'model', fileName: 'asm.xml' };
    const modelParamsMatch = /^models\/([^/]+)\/params\.json$/i.exec(rel);
    if (modelParamsMatch) return { name: modelParamsMatch[1], kind: 'model', fileName: 'params.json' };
    const partRe = new RegExp(`^models/([^/]+)/parts/([^/]+)/part\\.${ext}$`, 'i');
    const partMatch = partRe.exec(rel);
    if (partMatch) return { name: partMatch[1], kind: 'model-part', partName: partMatch[2], fileName: `parts/${partMatch[2]}/part${deps.sourceExt(state.currentKernel())}` };
    const partParamsMatch = /^models\/([^/]+)\/parts\/([^/]+)\/params\.json$/i.exec(rel);
    if (partParamsMatch) return { name: partParamsMatch[1], kind: 'model-part', partName: partParamsMatch[2], fileName: `parts/${partParamsMatch[2]}/params.json` };
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
    broadcastPartsList();
    deps.rebuildAppMenu();

    const globs = [
      path.join(resolvedProjectPath, deps.MODELS_DIR, '*', deps.modelSourceFilename(state.currentKernel(), 'asm')).replace(/\\/g, '/'),
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
        broadcastPartsList();
        scheduleBuild(entry.name);
      }
    });
    watcher.on('unlink', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        markModelDirty(entry.name);
        scheduleBuild(entry.name);
      }
      broadcastPartsList();
    });
    watcher.on('error', (err) => deps.sendLog(`watcher error: ${err.message}`, 'error'));

    if (runImmediately && state.activePart()) {
      const source = deps.resolveModelSource(state.currentProjectPath(), state.activePart(), state.currentKernel());
      const cache = deps.modelCacheFile(state.currentProjectPath(), state.activePart(), source, state.currentKernel());
      const freshness = refreshModelDirtyState(state.activePart(), source);
      if (cache && fs.existsSync(cache) && !freshness.buildDirty) deps.sendModelUpdated(state.activePart());
      scheduleBuild(state.activePart(), { force: true });
    }
  }

  async function selectPart(name) {
    if (!state.currentProjectPath()) return;
    if (!deps.resolveModelSource(state.currentProjectPath(), name)) {
      throw new Error(`Model does not exist: ${name}`);
    }
    state.setActivePart(name);
    deps.sendToRenderer('ACTIVE_MODEL_CHANGED', { name });
    broadcastPartsList();

    const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
    const cache = deps.modelCacheFile(state.currentProjectPath(), name, source, state.currentKernel());
    const freshness = refreshModelDirtyState(name, source);
    if (cache && fs.existsSync(cache) && !freshness.buildDirty) deps.sendModelUpdated(name);
    scheduleBuild(name, { force: true });
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
    if (!freshness.buildDirty) {
      resolveBuildWaiters(partName, cachedBuildResult(partName, source));
      if (state.pendingParts().has(partName)) state.pendingParts().delete(partName);
      broadcastPartsList();
      return;
    }
    state.buildingParts().add(partName);
    state.pendingParts().delete(partName);
    deps.sendToRenderer('BUILD_STARTED', { part: partName });
    broadcastPartsList();
    runningBuildInputs.set(partName, freshness.inputMtime);
    return runBuildMjcf(partName, source);
  }

  async function runBuildPython(modelName, partName, outFile) {
    const runtime = await deps.detectBuildRuntime(state.currentKernel());
    if (!runtime) {
      const msg = deps.missingRuntimeMessage(state.currentKernel());
      deps.sendLog(msg, 'error');
      deps.sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus(state.currentKernel()));
      return { ok: false, part: modelName, model: modelName, modelPart: partName, error: msg, reason: 'NO_RUNTIME' };
    }
    const cmd = deps.buildRuntimeSpawn(runtime, [
      '--project', state.currentProjectPath(),
      '--model', modelName,
      '--part-name', partName,
      '--output', outFile
    ]);
    deps.sendLog(
      runtime.kind === 'bundled-runner'
        ? `[${modelName}/${partName}] Build using bundled build123d + bd_warehouse runtime`
        : `[${modelName}/${partName}] Build using Python ${runtime.cmd} (v${runtime.version}) with ${deps.kernelMeta(state.currentKernel()).label}`
    );
    const buildStartedAt = Date.now();
    return await runBuildChild(
      spawn(cmd.cmd, cmd.args, { cwd: state.currentProjectPath(), shell: false, windowsHide: true }),
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

  async function ensurePartBrepArtifact(modelName, partName) {
    const sourcePath = deps.modelPartSource(state.currentProjectPath(), modelName, partName, state.currentKernel());
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: `Model part "${partName}" does not exist in models/${modelName}/parts/${partName}.` };
    }
    const cacheFile = deps.partCache(state.currentProjectPath(), modelName, partName, state.currentKernel());
    if (isFileFreshForInput(cacheFile, modelPartInputMtime(modelName, partName))) {
      return { ok: true, skipped: true, cacheFile };
    }
    const key = path.resolve(cacheFile).toLowerCase();
    if (partBrepBuildPromises.has(key)) return partBrepBuildPromises.get(key);
    const promise = runBuildPython(modelName, partName, cacheFile).finally(() => {
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
    clearModelDirtyUpTo(partName, runningBuildInputs.get(partName) || 0);
    state.buildingParts().delete(partName);
    finishBuildPass(partName, runningBuildInputs.get(partName) || 0);
    broadcastPartsList();
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
    const assetUrl = (filePath) => {
      const rel = path.relative(state.currentProjectPath(), filePath).replace(/\\/g, '/');
      return `aicad://asset/${rel.split('/').map((segment) => encodeURIComponent(segment)).join('/')}?t=${ts}`;
    };
    const url = assetUrl(source.sourcePath);
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

  function buildMcpContext() {
    return {
      listParts() {
        if (!state.currentProjectPath()) return { error: 'No project is open in the preview app.', models: [], active: null };
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
          previewFormat: 'MJCF',
          supportsFaceIndex: false,
          active: state.activePart(),
          models: list
        };
      },
      async getPartInfo(name) {
        if (!state.currentProjectPath()) return { error: 'No project is open in the preview app.' };
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return { error: `Model does not exist: ${name}` };
        const info = state.partInfoCache().get(name);
        const source = deps.resolveModelSource(state.currentProjectPath(), name);
        const cache = deps.modelCacheFile(state.currentProjectPath(), name, source, state.currentKernel());
        const src = source?.sourcePath || deps.partSource(state.currentProjectPath(), name);
        const cacheStale = dirtyBuildInputs.has(name);
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
          kind: 'model',
          sourceFile: source?.fileName || null,
          description: readPartDescription(state.currentProjectPath(), name, state.currentKernel()),
          faceCount: null,
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
      modelPartDir: model.modelPartDir,
      modelPartSource: model.modelPartSource,
      modelPartParamsPath: model.modelPartParamsPath,
      modelPartStlPath: model.modelPartStlPath,
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
