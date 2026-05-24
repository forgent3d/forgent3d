// @ts-nocheck
export {};
'use strict';

const { createMainRebuildTools } = require('./main.rebuild');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { ensureProjectDirectoryAccess } = require('./project-access');


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

  function writeAgentTextFile(filePath, content, force = false) {
    return force ? writeIfChanged(filePath, content) : writeIfMissing(filePath, content);
  }

  function bootstrapAgentWorkspace(projectPath, agent, opts = {}) {
    const force = !!opts.force;
    switch (agent) {
      case 'cli':
        const cursorSkills = deps.getAgentSkills('Cursor');
        for (const rule of cursorSkills) {
          writeAgentTextFile(path.join(projectPath, rule.relativePath), rule.content, force);
        }
        writeIfChanged(path.join(projectPath, '.cursor', 'mcp.json'), deps.cursorMcpJson(deps.MCP_PORT));
        break;
      case 'codex':
        writeIfChanged(path.join(projectPath, '.codex', 'config.toml'), deps.codexConfigToml(deps.MCP_PORT));
        writeAgentTextFile(path.join(projectPath, 'AGENTS.md'), deps.agentsMdTemplate(), force);
        const codexSkills = deps.getAgentSkills('OpenAI Codex');
        for (const rule of codexSkills) {
          writeAgentTextFile(path.join(projectPath, rule.relativePath), rule.content, force);
        }
        break;
      case 'claude':
        writeIfChanged(path.join(projectPath, '.mcp.json'), deps.claudeMcpJson(deps.MCP_PORT));
        writeAgentTextFile(path.join(projectPath, 'CLAUDE.md'), deps.claudeMdTemplate(), force);
        const claudeSkills = deps.getAgentSkills('Claude Code');
        for (const rule of claudeSkills) {
          writeAgentTextFile(path.join(projectPath, rule.relativePath), rule.content, force);
        }
        break;
      default:
        throw new Error(`Unknown agent: ${agent}`);
    }
  }

  function refreshAgentWorkspace(projectPath) {
    if (!projectPath) throw new Error('Open a project first.');
    for (const agent of ['codex', 'claude', 'cli']) {
      bootstrapAgentWorkspace(projectPath, agent, { force: true });
    }
    deps.sendLog('Updated local agent prompts and skills.');
    return { ok: true, agents: ['codex', 'claude', 'cli'] };
  }

  function normalizeModelName(name) {
    const value = String(name || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      throw new Error('Model name can only contain letters, numbers, underscores, and hyphens.');
    }
    return value;
  }

  function mergePlainObject(base, override) {
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    if (!override || typeof override !== 'object' || Array.isArray(override)) return out;
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        out[key] &&
        typeof out[key] === 'object' &&
        !Array.isArray(out[key])
      ) {
        out[key] = mergePlainObject(out[key], value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  function modelParamsWithOverrides(kind, name, description, opts = {}) {
    const raw = deps.modelParamsTemplate(kind, name, description, opts);
    let parsed = {};
    try { parsed = JSON.parse(raw || '{}'); } catch {}
    const merged = mergePlainObject(parsed, opts.params);
    return JSON.stringify(merged, null, 2) + '\n';
  }

  function createModelPackage(projectPath, kernel, name, description = '', opts = {}) {
    const k = deps.assertKernel(kernel);
    const modelName = normalizeModelName(name);
    const desc = String(description || '').trim() || `${modelName} model`;
    const modelPath = deps.modelDir(projectPath, modelName);
    if (fs.existsSync(modelPath) && opts.overwrite !== true) {
      throw new Error(`Model already exists: ${modelName}`);
    }

    const partNames = Array.isArray(opts.partNames) && opts.partNames.length
      ? opts.partNames.map((partName) => normalizeModelName(partName))
      : [modelName];
    const partDescriptions = opts.partDescriptions || {};
    const partTemplates = opts.partTemplates || {};
    const partParams = opts.partParams || {};

    writeIfChanged(
      deps.partSource(projectPath, modelName, k, 'asm'),
      deps.modelSourceTemplate(k, 'asm', modelName, desc, { partNames })
    );
    writeIfChanged(
      deps.modelParamsPath(projectPath, modelName),
      modelParamsWithOverrides('asm', modelName, desc, { partNames, params: opts.rootParams })
    );
    writeIfChanged(
      deps.partReadme(projectPath, modelName),
      deps.modelReadmeTemplate(k, 'asm', modelName, desc)
    );

    for (const partName of partNames) {
      const partDesc = String(partDescriptions[partName] || '').trim() || `${partName} part`;
      const partOpts = {
        ...(partTemplates[partName] ? { template: partTemplates[partName] } : {}),
        params: partParams[partName]
      };
      writeIfChanged(
        deps.modelPartSource(projectPath, modelName, partName, k),
        deps.modelSourceTemplate(k, 'part', partName, partDesc, partOpts)
      );
      writeIfChanged(
        deps.modelPartParamsPath(projectPath, modelName, partName),
        modelParamsWithOverrides('part', partName, partDesc, partOpts)
      );
    }

    deps.sendLog(`Model package created: models/${modelName}/`);
    return { name: modelName, path: modelPath, parts: partNames };
  }

  function createStarterModel(projectPath, kernel) {
    return createModelPackage(
      projectPath,
      kernel,
      'starter_mount',
      'Starter mounting plate assembly with editable hardware spacing.',
      {
        partNames: ['mounting_plate', 'fastener_stack'],
        partDescriptions: {
          mounting_plate: 'Rounded mounting plate with four standard clearance holes.',
          fastener_stack: 'Standard visible screw and washer stack.'
        },
        partTemplates: {
          fastener_stack: 'fastener_stack'
        }
      }
    );
  }

  function initProjectLayout(projectPath, kernel, opts = {}) {
    const k = deps.assertKernel(kernel);

    writeIfChanged(deps.projectMetaPath(projectPath), deps.aicadProjectJson(k));
    writeIfChanged(path.join(projectPath, '.gitignore'), '# Forgent3D\n.cache/\n__pycache__/\n*.pyc\n');
    fs.mkdirSync(path.join(projectPath, deps.MODELS_DIR), { recursive: true });
    fs.mkdirSync(path.join(projectPath, deps.CACHE_DIR), { recursive: true });
    void ensureProjectDirectoryAccess(projectPath, { sendLog: deps.sendLog });
    const shouldCreateSample = opts.createSample === true;
    if (shouldCreateSample) {
      createStarterModel(projectPath, k);
      deps.sendLog(`Project initialized with ${deps.kernelMeta(k).label}; starter_mount sample model was created.`);
    } else {
      deps.sendLog(`Project initialized with ${deps.kernelMeta(k).label}.`);
    }
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
    const assemblyRe = new RegExp(`^models/([^/]+)/assembly\\.${ext}$`, 'i');
    const assemblyMatch = assemblyRe.exec(rel);
    if (assemblyMatch) return { name: assemblyMatch[1], kind: 'model', fileName: `assembly${deps.sourceExt(state.currentKernel())}` };
    const flatPartRe = new RegExp(`^models/([^/]+)/part\\.${ext}$`, 'i');
    const flatPartMatch = flatPartRe.exec(rel);
    if (flatPartMatch) return { name: flatPartMatch[1], kind: 'model', fileName: `part${deps.sourceExt(state.currentKernel())}` };
    const modelParamsMatch = /^models\/([^/]+)\/params\.json$/i.exec(rel);
    if (modelParamsMatch) return { name: modelParamsMatch[1], kind: 'model', fileName: 'params.json' };
    const partRe = new RegExp(`^models/([^/]+)/parts/([^/]+)/part\\.${ext}$`, 'i');
    const partMatch = partRe.exec(rel);
    if (partMatch) return { name: partMatch[1], kind: 'model-part', partName: partMatch[2], fileName: `parts/${partMatch[2]}/part${deps.sourceExt(state.currentKernel())}` };
    const partParamsMatch = /^models\/([^/]+)\/parts\/([^/]+)\/params\.json$/i.exec(rel);
    if (partParamsMatch) return { name: partParamsMatch[1], kind: 'model-part', partName: partParamsMatch[2], fileName: `parts/${partParamsMatch[2]}/params.json` };
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
    await ensureProjectDirectoryAccess(resolvedProjectPath, { sendLog: deps.sendLog });

    stopWatcher();
    state.setCurrentProjectPath(resolvedProjectPath);
    state.setCurrentKernel(nextKernel);
    state.partInfoCache().clear();
    state.buildWaiters().clear();
    state.partLoadedWaiters().clear();
    deps.resetBuildTracking();

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
      deps.markModelDirty(entry.name);
      deps.scheduleBuild(entry.name);
    });
    watcher.on('add', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        deps.markModelDirty(entry.name);
        broadcastPartsList();
        deps.scheduleBuild(entry.name);
      }
    });
    watcher.on('unlink', (filePath) => {
      const entry = partNameFromPath(filePath);
      if (entry) {
        deps.markModelDirty(entry.name);
        deps.scheduleBuild(entry.name);
      }
      broadcastPartsList();
    });
    watcher.on('error', (err) => deps.sendLog(`watcher error: ${err.message}`, 'error'));

    if (runImmediately && state.activePart()) {
      deps.scheduleBuild(state.activePart(), { force: true });
      deps.maybeSendModelUpdated(state.activePart());
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

    deps.scheduleBuild(name, { force: true });
    deps.maybeSendModelUpdated(name);
  }

  function buildMcpContext() {
    return {
      listParts() {
        if (!state.currentProjectPath()) return { error: 'No project is open in Forgent3D.', models: [], active: null };
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
        if (!state.currentProjectPath()) return { error: 'No project is open in Forgent3D.' };
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return { error: `Model does not exist: ${name}` };
        const info = state.partInfoCache().get(name);
        const source = deps.resolveModelSource(state.currentProjectPath(), name);
        const cache = deps.modelCacheFile(state.currentProjectPath(), name, source, state.currentKernel());
        const src = source?.sourcePath || deps.partSource(state.currentProjectPath(), name);
        const cacheStale = deps.isModelBuildDirty(name);
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
      handleDesktopAuthCallback(payload) {
        return deps.handleDesktopAuthCallback?.(payload) === true;
      },
      async getPartScreenshot(name, view = 'iso', mode = 'solid') {
        if (!state.currentProjectPath()) return null;
        if (!deps.resolveModelSource(state.currentProjectPath(), name)) return null;
        try { await selectPart(name); } catch { return null; }
        const p = deps.partPng(state.currentProjectPath(), name, view, mode);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p);
      },
      rebuildPartSync: deps.rebuildPartSync,
    };
  }

  return {
    writeIfChanged,
    writeIfMissing,
    bootstrapAgentWorkspace,
    refreshAgentWorkspace,
    initProjectLayout,
    createModelPackage,
    ensureRuntimeDirs,
    listPartsRaw,
    readPartDescription,
    listParts,
    openProject,
    stopWatcher,
    selectPart,
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

  const sharedState = {
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
  };

  const sharedDeps = {
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
    handleDesktopAuthCallback: ui.handleDesktopAuthCallback
  };

  let logicApi;
  const rebuildApi = createMainRebuildTools({
    state: {
      ...sharedState,
      watcher: state.watcher,
      setWatcher: state.setWatcher
    },
    deps: {
      MODELS_DIR: sharedDeps.MODELS_DIR,
      assertKernel: sharedDeps.assertKernel,
      kernelMeta: sharedDeps.kernelMeta,
      sourceExt: sharedDeps.sourceExt,
      modelSourceFilename: sharedDeps.modelSourceFilename,
      resolveModelSource: sharedDeps.resolveModelSource,
      partSource: sharedDeps.partSource,
      modelDir: sharedDeps.modelDir,
      modelParamsPath: sharedDeps.modelParamsPath,
      modelPartSource: sharedDeps.modelPartSource,
      modelPartParamsPath: sharedDeps.modelPartParamsPath,
      modelPartStlPath: sharedDeps.modelPartStlPath,
      partCache: sharedDeps.partCache,
      modelCacheFile: sharedDeps.modelCacheFile,
      modelPreviewFormat: sharedDeps.modelPreviewFormat,
      detectBuildRuntime: sharedDeps.detectBuildRuntime,
      missingRuntimeMessage: sharedDeps.missingRuntimeMessage,
      buildRuntimeSpawn: sharedDeps.buildRuntimeSpawn,
      getBuildRuntimeStatus: sharedDeps.getBuildRuntimeStatus,
      ensurePartStlArtifact: sharedDeps.ensurePartStlArtifact,
      sendToRenderer: sharedDeps.sendToRenderer,
      sendLog: sharedDeps.sendLog,
      broadcastPartsList: () => logicApi.broadcastPartsList()
    }
  });

  logicApi = createMainLogicTools({
    state: sharedState,
    deps: {
      ...sharedDeps,
      resetBuildTracking: rebuildApi.resetBuildTracking,
      isModelBuildDirty: rebuildApi.isModelBuildDirty,
      markModelDirty: rebuildApi.markModelDirty,
      scheduleBuild: rebuildApi.scheduleBuild,
      maybeSendModelUpdated: rebuildApi.maybeSendModelUpdated,
      prepareModelDeletion: rebuildApi.prepareModelDeletion,
      rebuildPartSync: rebuildApi.rebuildPartSync,
      resolvePartLoadedWaiters: rebuildApi.resolvePartLoadedWaiters
    }
  });

  return {
    ...logicApi,
    scheduleBuild: rebuildApi.scheduleBuild,
    runBuild: rebuildApi.runBuild,
    runBuildPython: rebuildApi.runBuildPython,
    validateMjcfAssemblyReferences: rebuildApi.validateMjcfAssemblyReferences,
    runBuildMjcf: rebuildApi.runBuildMjcf,
    resolveBuildWaiters: rebuildApi.resolveBuildWaiters,
    prepareModelDeletion: rebuildApi.prepareModelDeletion,
    resolvePartLoadedWaiters: rebuildApi.resolvePartLoadedWaiters,
    refreshViewerCachesAfterBuild: rebuildApi.refreshViewerCachesAfterBuild,
    sendModelUpdated: rebuildApi.sendModelUpdated
  };
}

module.exports = {
  createMainLogicTools,
  initMainLogicTools
};
