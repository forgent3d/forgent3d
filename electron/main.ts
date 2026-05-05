// @ts-nocheck
export {};
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const pyenv = require('./python-env');
const mcp = require('./mcp-server');
const terminalManager = require('./terminal-manager');
const { registerIpcHandlers } = require('./main.ipc');
const { initMainExportTools } = require('./main.export');
const { initMainUiTools } = require('./main.ui');
const { initMainLogicTools } = require('./main.logic');
const {
  KERNELS,
  assertKernel,
  kernelMeta,
  cursorMcpJson,
  claudeMcpJson,
  codexConfigToml,
  aicadProjectJson,
  modelSourceTemplate,
  modelParamsTemplate,
  modelReadmeTemplate,
  sourceFileOptions,
  getAgentSkills,
  agentsMdTemplate,
  claudeMdTemplate
} = require('./main.templates.index');
const { EXPORT_RUNNER_PYTHON } = require('./main.templates.export-runner');

const MCP_PORT = 41234;
/** MCP startup error details, usually a port conflict. Null when running. */
let mcpStartError = null;

// Must be registered before app ready so aicad:// supports fetch and CORS.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aicad',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

/* ---------------- State ---------------- */
let mainWindow = null;
let watcher = null;
let currentProjectPath = null;
let currentKernel = null;     // CAD kernel used by the open project, or null when no project is open.
let activePart = null;        // Model currently shown in the viewport.
let debugToolsVisible = false;
const buildingParts = new Set();   // Models currently being built.
const pendingParts = new Set();    // Models queued for another build pass.

const MODELS_DIR = 'models';
const MODEL_KINDS = ['part', 'asm'];
const MODEL_PARAMS_FILE = 'params.json';
const CACHE_DIR = '.cache';
const PROJECT_META_DIR = '.aicad';
const PROJECT_META_FILE = 'project.json';
let cachedElectronExportRunnerPath = null;
const EXPORT_FORMATS = ['step', 'stl', 'obj'];
const SCREENSHOT_VIEWS = ['iso', 'front', 'side', 'top'];
const PLATFORM_TAG = `${process.platform}-${process.arch}`;
const BUNDLED_RUNNER_NAME = process.platform === 'win32'
  ? 'aicad-export-runner.exe'
  : 'aicad-export-runner';
let exportTools = null;
let uiTools = null;
let logicTools = null;

function appIconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'images', 'logo.png');
}

function modelDir(projectPath, name) { return path.join(projectPath, MODELS_DIR, name); }
function modelParamsPath(projectPath, name) { return path.join(modelDir(projectPath, name), MODEL_PARAMS_FILE); }
function sourceExt(kernel = currentKernel) { return path.extname(kernelMeta(kernel).sourceFile); }
function modelSourceFilename(kernel = currentKernel, kind = 'part') {
  if (kind === 'asm') return 'asm.xml';
  return `${kind}${sourceExt(kernel)}`;
}
function resolveModelSource(projectPath, name, kernel = currentKernel) {
  const k = assertKernel(kernel);
  for (const kind of MODEL_KINDS) {
    const fileName = modelSourceFilename(k, kind);
    const sourcePath = path.join(modelDir(projectPath, name), fileName);
    if (fs.existsSync(sourcePath)) return { kind, fileName, sourcePath };
  }
  return null;
}
function partSource(projectPath, name, kernel = currentKernel, kind = null) {
  if (kind) return path.join(modelDir(projectPath, name), modelSourceFilename(kernel, kind));
  return resolveModelSource(projectPath, name, kernel)?.sourcePath
    || path.join(modelDir(projectPath, name), modelSourceFilename(kernel, 'part'));
}
function partReadme(projectPath, name) { return path.join(modelDir(projectPath, name), 'README.md'); }
function partCache(projectPath, name, kernel = currentKernel) {
  return path.join(modelDir(projectPath, name), `${name}${kernelMeta(kernel).cacheExt}`);
}
function modelCacheFile(projectPath, name, source = null, kernel = currentKernel) {
  const s = source || resolveModelSource(projectPath, name, kernel);
  if (!s) return null;
  return s.kind === 'asm' ? s.sourcePath : partCache(projectPath, name, kernel);
}
function modelPreviewFormat(source = null, kernel = currentKernel) {
  if (source?.kind === 'asm') return 'MJCF';
  return kernelMeta(kernel).previewFormat;
}
function toProjectRelativeAsset(relPath) {
  if (!currentProjectPath) return null;
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(currentProjectPath, normalized);
  const root = path.resolve(currentProjectPath);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  return abs;
}
function normalizeScreenshotView(view) {
  const v = String(view || 'iso').trim().toLowerCase();
  return SCREENSHOT_VIEWS.includes(v) ? v : 'iso';
}
function partPng(projectPath, name, view = 'iso', mode = 'solid') {
  const v = normalizeScreenshotView(view);
  const m = String(mode || 'solid').trim().toLowerCase() === 'xray' ? 'xray' : 'solid';
  if (m === 'xray') {
    return path.join(projectPath, CACHE_DIR, v === 'iso' ? `${name}.xray.png` : `${name}.${v}.xray.png`);
  }
  return path.join(projectPath, CACHE_DIR, v === 'iso' ? `${name}.png` : `${name}.${v}.png`);
}
function projectMetaPath(projectPath) {
  return path.join(projectPath, PROJECT_META_DIR, PROJECT_META_FILE);
}

function loadAppConfig() {
  return pyenv.loadConfig?.() || {};
}

function saveAppConfig(cfg) {
  pyenv.saveConfig?.(cfg || {});
}

function saveLastProjectPath(projectPath) {
  const cfg = loadAppConfig();
  const normalized = typeof projectPath === 'string' && projectPath.trim()
    ? path.resolve(projectPath)
    : null;
  if (normalized) cfg.lastProjectPath = normalized;
  else delete cfg.lastProjectPath;
  saveAppConfig(cfg);
}

function clearLastProjectPath() {
  const cfg = loadAppConfig();
  if (!cfg.lastProjectPath) return;
  delete cfg.lastProjectPath;
  saveAppConfig(cfg);
}

function runtimeKernel(kernel = currentKernel) {
  return kernel || 'build123d';
}

function prefersBundledBuildRuntime(kernel = currentKernel) {
  return runtimeKernel(kernel) === 'build123d';
}

function bundledRunnerCandidates() {
  const relOnedir = path.join('export-runner', PLATFORM_TAG, 'aicad-export-runner', BUNDLED_RUNNER_NAME);
  const relOnefile = path.join('export-runner', PLATFORM_TAG, BUNDLED_RUNNER_NAME);
  return Array.from(new Set([
    path.join(process.resourcesPath, relOnedir),
    path.join(__dirname, '..', '..', 'vendor', 'export-runner', PLATFORM_TAG, 'aicad-export-runner', BUNDLED_RUNNER_NAME),
    path.join(process.resourcesPath, relOnefile),
    path.join(__dirname, '..', '..', 'vendor', 'export-runner', PLATFORM_TAG, BUNDLED_RUNNER_NAME)
  ]));
}

function getBundledRunnerPath(kernel = currentKernel) {
  if (!prefersBundledBuildRuntime(kernel)) return null;
  return bundledRunnerCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

async function getBuildRuntimeStatus(kernel = currentKernel) {
  const targetKernel = runtimeKernel(kernel);
  const bundled = getBundledRunnerPath(targetKernel);
  if (bundled) {
    return {
      ok: true,
      kind: 'bundled-runner',
      source: 'bundled',
      runtimeName: 'Bundled build123d runtime',
      version: 'internal',
      versionText: 'Bundled build123d runtime',
      cmd: bundled,
      args: [],
      hasBuild123d: true
    };
  }

  return {
    ok: false,
    kind: 'bundled-runner',
    source: 'bundled',
    message: app.isPackaged
      ? 'Bundled build123d runtime is missing from the app package.'
      : 'No bundled build123d runtime found. Run `npm run build:runner` to generate it.'
  };
}

async function detectBuildRuntime(kernel = currentKernel) {
  const targetKernel = runtimeKernel(kernel);
  const bundled = getBundledRunnerPath(targetKernel);
  if (bundled) {
    return { kind: 'bundled-runner', source: 'bundled', cmd: bundled, args: [], version: 'internal' };
  }
  return null;
}

function buildRuntimeSpawn(runtime, runnerArgs) {
  if (runtime.kind === 'bundled-runner') {
    return { cmd: runtime.cmd, args: runnerArgs };
  }
  const runnerScript = ensureElectronExportRunner();
  return { cmd: runtime.cmd, args: [...runtime.args, runnerScript, ...runnerArgs] };
}

function missingRuntimeMessage(kernel = currentKernel) {
  if (prefersBundledBuildRuntime(kernel)) {
    return app.isPackaged
      ? 'Bundled build123d runtime is missing from the app package.'
      : 'No bundled build123d runtime found. Run `npm run build:runner` to generate it.';
  }
  return 'No usable build runtime was detected.';
}

function ensureElectronExportRunner() {
  if (cachedElectronExportRunnerPath && fs.existsSync(cachedElectronExportRunnerPath)) {
    return cachedElectronExportRunnerPath;
  }
  const dir = path.join(app.getPath('userData'), 'runners');
  const runnerPath = path.join(dir, 'export_runner.py');
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(runnerPath, EXPORT_RUNNER_PYTHON);
  cachedElectronExportRunnerPath = runnerPath;
  return runnerPath;
}

function exportExt(format) {
  return exportTools.exportExt(format);
}

function ensureExportFormat(format) {
  return exportTools.ensureExportFormat(format);
}

/**
 * Read the kernel from .aicad/project.json and fail fast when invalid.
 */
function readProjectKernel(projectPath) {
  const p = projectMetaPath(projectPath);
  if (!fs.existsSync(p)) {
    throw new Error(`Not a valid AI CAD project. Missing ${path.relative(projectPath, p)}.`);
  }
  const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (meta?.kernel === 'openscad') {
    throw new Error('OpenSCAD projects are no longer supported by this app.');
  }
  if (meta?.kernel === 'cadquery') {
    throw new Error('CadQuery projects are no longer supported by this app.');
  }
  return assertKernel(meta?.kernel);
}

/* Per-model runtime info reported by the renderer and exposed to MCP. */
const partInfoCache = new Map();   // name -> { faceCount, bbox, faces:[{index, centroid, normal}], capturedAt }
/* Synchronous waiters for rebuild_model: name -> Array<resolve> */
const buildWaiters = new Map();
/* Synchronous waiters for viewer cache refresh: name -> Array<resolve> */
const partLoadedWaiters = new Map();

/* ---------------- Window ---------------- */
function createWindow() {
  return uiTools.createWindow();
}

function registerIpc() {
  registerIpcHandlers({
    ipcMain,
    clipboard,
    dialog,
    shell,
    state: {
      mainWindow: () => mainWindow,
      currentProjectPath: () => currentProjectPath,
      currentKernel: () => currentKernel,
      activePart: () => activePart,
      partInfoCache: () => partInfoCache
    },
    deps: {
      constants: {
        SCREENSHOT_VIEWS,
        CACHE_DIR
      },
      KERNELS,
      assertKernel,
      kernelMeta,
      sourceFileOptions,
      getMcpStatusPayload,
      buildMcpContext,
      initProjectLayout,
      openProject,
      openProjectByDialog,
      scheduleBuild,
      listParts,
      selectPart,
      modelDir,
      modelParamsPath,
      resolveModelSource,
      exportPartByRequest,
      partPng,
      resolvePartLoadedWaiters,
      getBuildRuntimeStatus,
      sendLog
    }
  });
}

function rebuildAppMenu() {
  return uiTools.rebuildAppMenu();
}

async function openProjectByDialog() {
  return uiTools.openProjectByDialog();
}

async function restoreLastProjectIfAvailable() {
  return uiTools.restoreLastProjectIfAvailable();
}

async function handleExportFromMenu(format) {
  return uiTools.handleExportFromMenu(format);
}

function initModuleTools() {
  const mainContext = {
    electron: { BrowserWindow, Menu, dialog, shell, protocol, net },
    app: {
      app,
      appIconPath
    },
    mcp,
    env: { isDev },
    constants: {
      MCP_PORT,
      MODELS_DIR,
      MODEL_KINDS,
      MODEL_PARAMS_FILE,
      CACHE_DIR,
      EXPORT_FORMATS
    },
    templates: {
      getAgentSkills,
      assertKernel,
      kernelMeta,
      sourceFileOptions,
      cursorMcpJson,
      claudeMcpJson,
      codexConfigToml,
      agentsMdTemplate,
      claudeMdTemplate,
      aicadProjectJson,
      modelSourceTemplate,
      modelParamsTemplate,
      modelReadmeTemplate
    },
    state: {
      mainWindow: () => mainWindow,
      setMainWindow: (v) => { mainWindow = v; },
      watcher: () => watcher,
      setWatcher: (v) => { watcher = v; },
      currentProjectPath: () => currentProjectPath,
      setCurrentProjectPath: (v) => { currentProjectPath = v; },
      currentKernel: () => currentKernel,
      setCurrentKernel: (v) => { currentKernel = v; },
      activePart: () => activePart,
      setActivePart: (v) => { activePart = v; },
      debugToolsVisible: () => debugToolsVisible,
      setDebugToolsVisible: (v) => { debugToolsVisible = !!v; },
      mcpStartError: () => mcpStartError,
      partInfoCache: () => partInfoCache,
      buildingParts: () => buildingParts,
      pendingParts: () => pendingParts,
      buildWaiters: () => buildWaiters,
      partLoadedWaiters: () => partLoadedWaiters
    },
    model: {
      projectMetaPath,
      modelDir,
      modelParamsPath,
      sourceExt,
      modelSourceFilename,
      resolveModelSource,
      partSource,
      partReadme,
      partCache,
      modelCacheFile,
      modelPreviewFormat,
      toProjectRelativeAsset,
      partPng
    },
    project: {
      readProjectKernel,
      loadAppConfig,
      saveLastProjectPath,
      clearLastProjectPath,
      openProject: (...args) => openProject(...args),
      openProjectByDialog: (...args) => openProjectByDialog(...args),
      restoreLastProjectIfAvailable: (...args) => restoreLastProjectIfAvailable(...args),
      stopWatcher: (...args) => stopWatcher(...args)
    },
    runtime: {
      detectBuildRuntime,
      missingRuntimeMessage,
      buildRuntimeSpawn,
      getBuildRuntimeStatus
    },
    logging: {
      sendLog: (...args) => sendLog(...args)
    },
    build: {
      scheduleBuild: (...args) => scheduleBuild(...args),
      ensurePartStlArtifact: (...args) => ensurePartStlArtifact(...args),
      sendModelUpdated: (...args) => sendModelUpdated(...args)
    },
    exportApi: {
      buildStlForModel: (...args) => buildStlForModel(...args),
      exportPartByRequest: (...args) => exportPartByRequest(...args),
      handleExportFromMenu: (...args) => handleExportFromMenu(...args)
    },
    ui: {
      rebuildAppMenu: (...args) => rebuildAppMenu(...args),
      sendToRenderer: (...args) => sendToRenderer(...args),
      sendLog: (...args) => sendLog(...args)
    }
  };

  exportTools = initMainExportTools(mainContext);
  uiTools = initMainUiTools(mainContext);
  logicTools = initMainLogicTools(mainContext);
}

app.whenReady().then(async () => {
  initModuleTools();
  registerProtocol();
  registerIpc();
  terminalManager.init(ipcMain, (type, payload) => sendToRenderer(type, payload), {
    onBeforeTerminalCreate: async ({ agent, projectPath }) => {
      if (agent === 'codex' || agent === 'claude' || agent === 'cli') {
        bootstrapAgentWorkspace(projectPath, agent);
      }
    }
  });
  createWindow();
  rebuildAppMenu();

  try {
    const info = await mcp.start(buildMcpContext(), { port: MCP_PORT });
    mcpStartError = null;
    sendLog(`MCP server started: ${info.url}`);
  } catch (e) {
    mcpStartError = e.message || String(e);
    sendLog(`MCP server failed to start: ${e.message} (usually port ${MCP_PORT} is already in use)`, 'error');
  }
  broadcastMcpStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopWatcher();
  mcp.stop().catch(() => {});
  terminalManager.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  mcp.stop().catch(() => {});
  terminalManager.stopAll();
});

/* ---------------- Custom Protocol aicad:// ---------------- */
// aicad://model/<name>.<ext> -> cached model payload
// aicad://asset/<relative-path> -> project-scoped asset (MJCF meshes, etc.)

function registerProtocol() {
  return uiTools.registerProtocol();
}

/* ---------------- File Templates ---------------- */

/* ---------------- Project Setup ---------------- */

function writeIfChanged(filePath, content) {
  return logicTools.writeIfChanged(filePath, content);
}

/**
 * Write CLI Cursor / Codex / Claude workspace files when the user launches that agent from the UI.
 * Machine-oriented configs use writeIfChanged; markdown / .mdc rules use writeIfMissing so user edits persist.
 */
function bootstrapAgentWorkspace(projectPath, agent) {
  return logicTools.bootstrapAgentWorkspace(projectPath, agent);
}

/**
 * Initialize a new project layout:
 *   - .aicad/project.json
 *   - models/cuboid/part.py as a sample part
 *   - params.json beside each model source
 *   - models/assembly_demo/asm.xml as a sample assembly that references cuboid
 *   - .cache/ for preview artifacts
 *   - .gitignore
 *   - agent-specific rules, skills, and MCP configs
 */
function initProjectLayout(projectPath, kernel) {
  return logicTools.initProjectLayout(projectPath, kernel);
}


/* ---------------- Model Listing ---------------- */

function listParts(projectPath, kernel = currentKernel) {
  return logicTools.listParts(projectPath, kernel);
}

/* ---------------- Project and Watchers ---------------- */

async function openProject(projectPath, { runImmediately = false } = {}) {
  return logicTools.openProject(projectPath, { runImmediately });
}

function stopWatcher() {
  return logicTools.stopWatcher();
}

async function selectPart(name) {
  return logicTools.selectPart(name);
}

/* ---------------- Build ---------------- */

function scheduleBuild(partName, options) {
  return logicTools.scheduleBuild(partName, options);
}

async function ensurePartStlArtifact(partName) {
  return exportTools.ensurePartStlArtifact(partName);
}

function resolvePartLoadedWaiters(name, payload) {
  return logicTools.resolvePartLoadedWaiters(name, payload);
}

function sendModelUpdated(partName) {
  return logicTools.sendModelUpdated(partName);
}


async function buildStlForModel(modelName, outputPath = null) {
  return exportTools.buildStlForModel(modelName, outputPath);
}

async function exportPartByRequest(partName, format) {
  return exportTools.exportPartByRequest(partName, format);
}

/* ---------------- Broadcast ---------------- */

function sendToRenderer(type, payload) {
  return uiTools.sendToRenderer(type, payload);
}

function sendLog(message, level = 'info') {
  return uiTools.sendLog(message, level);
}

function getMcpStatusPayload() {
  return uiTools.getMcpStatusPayload();
}

function broadcastMcpStatus() {
  return uiTools.broadcastMcpStatus();
}

/* ---------------- MCP context ---------------- */
/**
 * Build the MCP server context object.
 * mcp-server.js reads runtime state through this interface instead of touching main.js globals.
 */
function buildMcpContext() {
  return logicTools.buildMcpContext();
}
