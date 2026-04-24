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
const {
  KERNELS,
  assertKernel,
  kernelMeta,
  cursorMcpJson,
  claudeMcpJson,
  codexConfigToml,
  aicadProjectJson,
  modelSourceTemplate,
  modelReadmeTemplate,
  sourceFileOptions,
  CURSOR_PROJECT_RULE_FILE,
  cursorRulesTemplate,
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
const CACHE_DIR = '.cache';
const PROJECT_META_DIR = '.aicad';
const PROJECT_META_FILE = 'project.json';
let cachedElectronExportRunnerPath = null;
const EXPORT_FORMATS = ['step', 'stl', 'obj', 'glb'];
const SCREENSHOT_VIEWS = ['iso', 'front', 'side', 'top'];
const PLATFORM_TAG = `${process.platform}-${process.arch}`;
const BUNDLED_RUNNER_NAME = process.platform === 'win32'
  ? 'aicad-export-runner.exe'
  : 'aicad-export-runner';

function modelDir(projectPath, name) { return path.join(projectPath, MODELS_DIR, name); }
function sourceExt(kernel = currentKernel) { return path.extname(kernelMeta(kernel).sourceFile); }
function modelSourceFilename(kernel = currentKernel, kind = 'part') {
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
  return path.join(projectPath, CACHE_DIR, `${name}${kernelMeta(kernel).cacheExt}`);
}
function normalizeScreenshotView(view) {
  const v = String(view || 'iso').trim().toLowerCase();
  return SCREENSHOT_VIEWS.includes(v) ? v : 'iso';
}
function partPng(projectPath, name, view = 'iso') {
  const v = normalizeScreenshotView(view);
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
    path.join(__dirname, '..', 'vendor', 'export-runner', PLATFORM_TAG, 'aicad-export-runner', BUNDLED_RUNNER_NAME),
    path.join(process.resourcesPath, relOnefile),
    path.join(__dirname, '..', 'vendor', 'export-runner', PLATFORM_TAG, BUNDLED_RUNNER_NAME)
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

  const status = await pyenv.getPythonStatus();
  if (!status.ok && prefersBundledBuildRuntime(targetKernel)) {
    return {
      ...status,
      message: app.isPackaged
        ? 'Bundled build123d runtime is missing from the app package, and no fallback Python was detected.'
        : 'No bundled build123d runtime found. Run `npm run build:runner`, or configure a system Python with build123d.'
    };
  }
  return status;
}

async function detectBuildRuntime(kernel = currentKernel) {
  const targetKernel = runtimeKernel(kernel);
  const bundled = getBundledRunnerPath(targetKernel);
  if (bundled) {
    return { kind: 'bundled-runner', source: 'bundled', cmd: bundled, args: [], version: 'internal' };
  }
  const py = await pyenv.detectPython({
    requireBuild123d: prefersBundledBuildRuntime(targetKernel)
  });
  return py ? { kind: 'python', ...py } : null;
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
      : 'No bundled build123d runtime found, and no system Python with build123d is configured.';
  }
  return 'No usable Python interpreter was detected. Configure one in the Python Environment panel.';
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
  switch (String(format || '').toLowerCase()) {
    case 'step': return '.step';
    case 'stl': return '.stl';
    case 'obj': return '.obj';
    case 'glb': return '.glb';
    default: return null;
  }
}

function ensureExportFormat(format) {
  const f = String(format || '').toLowerCase();
  if (!EXPORT_FORMATS.includes(f)) {
    throw new Error(`Unsupported export format: ${format}`);
  }
  return f;
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
  return assertKernel(meta?.kernel);
}

/* Per-model runtime info reported by the renderer and exposed to MCP. */
const partInfoCache = new Map();   // name -> { faceCount, bbox, faces:[{index, centroid, normal}], capturedAt }
/* Synchronous waiters for rebuild_part: name -> Array<resolve> */
const buildWaiters = new Map();
/* Synchronous waiters for viewer cache refresh: name -> Array<resolve> */
const partLoadedWaiters = new Map();

/* ---------------- Window ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    title: 'AI CAD Companion Preview',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      sendToRenderer('PYTHON_STATUS', await getBuildRuntimeStatus());
    } catch (e) {
      sendLog(`Python status check failed: ${e.message}`, 'error');
    }
    broadcastMcpStatus();
    sendToRenderer('MENU_TOGGLE_DEBUG_TOOLS', { visible: debugToolsVisible });
    try {
      await restoreLastProjectIfAvailable();
    } catch (e) {
      sendLog(`Last project restore failed: ${e.message}`, 'warn');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopWatcher();
  });
}

function rebuildAppMenu() {
  const hasProject = !!currentProjectPath;
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project...',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('MENU_NEW_PROJECT', {})
        },
        {
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            try {
              await openProjectByDialog();
            } catch (e) {
              sendLog(`Open failed: ${e.message}`, 'error');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Rebuild',
          accelerator: 'F5',
          enabled: hasProject,
          click: () => {
            if (activePart) scheduleBuild(activePart);
          }
        },
        {
          label: 'Reveal in Folder',
          enabled: hasProject,
          click: () => {
            if (currentProjectPath) shell.openPath(currentProjectPath);
          }
        },
        {
          label: 'Export Current Model',
          enabled: hasProject && !!activePart,
          submenu: [
            {
              label: 'Export STEP...',
              enabled: hasProject && !!activePart,
              click: () => handleExportFromMenu('step')
            },
            {
              label: 'Export STL...',
              enabled: hasProject && !!activePart,
              click: () => handleExportFromMenu('stl')
            },
            {
              label: 'Export OBJ...',
              enabled: hasProject && !!activePart,
              click: () => handleExportFromMenu('obj')
            },
            {
              label: 'Export GLB...',
              enabled: hasProject && !!activePart,
              click: () => handleExportFromMenu('glb')
            }
          ]
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        {
          type: 'checkbox',
          label: 'Debug Tools',
          checked: debugToolsVisible,
          click: (menuItem) => {
            debugToolsVisible = !!menuItem.checked;
            sendToRenderer('MENU_TOGGLE_DEBUG_TOOLS', { visible: debugToolsVisible });
          }
        },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openProjectByDialog() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open an Existing AI CAD Project',
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const projectPath = res.filePaths[0];
  if (!fs.existsSync(projectPath)) throw new Error(`Path does not exist: ${projectPath}`);
  await openProject(projectPath, { runImmediately: true });
  return projectPath;
}

async function restoreLastProjectIfAvailable() {
  const lastProjectPath = String(loadAppConfig().lastProjectPath || '').trim();
  if (!lastProjectPath) return false;
  if (!fs.existsSync(lastProjectPath)) {
    clearLastProjectPath();
    sendLog(`Last project no longer exists, cleared saved path: ${lastProjectPath}`, 'warn');
    return false;
  }
  try {
    await openProject(lastProjectPath, { runImmediately: true });
    sendLog(`Restored last project: ${lastProjectPath}`);
    return true;
  } catch (e) {
    clearLastProjectPath();
    sendLog(`Failed to restore last project (${lastProjectPath}): ${e.message}`, 'warn');
    return false;
  }
}

async function handleExportFromMenu(format) {
  try {
    if (!activePart) throw new Error('No active model is available for export.');
    const res = await exportPartByRequest(activePart, format);
    if (!res?.canceled && res?.path) {
      sendLog(`[${activePart}] Exported ${String(format).toUpperCase()}: ${res.path}`);
    }
  } catch (e) {
    sendLog(`Export failed: ${e.message || e}`, 'error');
    dialog.showErrorBox('Export Failed', e.message || String(e));
  }
}

app.whenReady().then(async () => {
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
// aicad://model/<partName>.brep -> .cache/<partName>.brep

function registerProtocol() {
  protocol.handle('aicad', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'model' && currentProjectPath) {
        const file = path.basename(url.pathname);           // <name>.brep / <name>.stl
        const name = file.replace(/\.(brep|stl)$/i, '');
        if (name) {
          const p = partCache(currentProjectPath, name);
          if (fs.existsSync(p)) {
            return net.fetch(pathToFileURL(p).toString());
          }
        }
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response(`protocol error: ${e.message}`, { status: 500 });
    }
  });
}

/* ---------------- File Templates ---------------- */

/* ---------------- Project Setup ---------------- */

function writeIfChanged(filePath, content) {
  try {
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (prev === content) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    if (prev !== null) sendLog(`Updated: ${path.relative(currentProjectPath || '', filePath)}`);
    return true;
  } catch (e) {
    sendLog(`Failed to write ${filePath}: ${e.message}`, 'error');
    return false;
  }
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

/**
 * Write CLI Cursor / Codex / Claude workspace files when the user launches that agent from the UI.
 * Machine-oriented configs use writeIfChanged; markdown / .mdc rules use writeIfMissing so user edits persist.
 */
function bootstrapAgentWorkspace(projectPath, agent) {
  const k = readProjectKernel(projectPath);
  switch (agent) {
    case 'cli':
      writeIfMissing(
        path.join(projectPath, '.cursor', 'rules', CURSOR_PROJECT_RULE_FILE),
        cursorRulesTemplate(k)
      );
      writeIfChanged(path.join(projectPath, '.cursor', 'mcp.json'), cursorMcpJson(MCP_PORT));
      break;
    case 'codex':
      writeIfChanged(path.join(projectPath, '.codex', 'config.toml'), codexConfigToml(MCP_PORT));
      writeIfMissing(path.join(projectPath, 'AGENTS.md'), agentsMdTemplate(k));
      break;
    case 'claude':
      writeIfChanged(path.join(projectPath, '.mcp.json'), claudeMcpJson(MCP_PORT));
      writeIfMissing(path.join(projectPath, 'CLAUDE.md'), claudeMdTemplate(k));
      break;
    default:
      throw new Error(`Unknown agent: ${agent}`);
  }
}

/**
 * Initialize a new project layout:
 *   - .aicad/project.json
 *   - models/cuboid/<src> as a sample model
 *   - .cache/ for preview artifacts
 *   - .gitignore
 * Agent-specific rules and MCP configs are written on demand (see bootstrapAgentWorkspace).
 */
function initProjectLayout(projectPath, kernel) {
  const k = assertKernel(kernel);
  const meta = kernelMeta(k);

  writeIfChanged(projectMetaPath(projectPath), aicadProjectJson(k));

  writeIfChanged(path.join(projectPath, '.gitignore'),
    '# AI CAD Companion Preview\n.cache/\n__pycache__/\n*.pyc\n');
  fs.mkdirSync(path.join(projectPath, MODELS_DIR), { recursive: true });
  fs.mkdirSync(path.join(projectPath, CACHE_DIR), { recursive: true });

  createPartFiles(projectPath, 'cuboid', `Default cuboid model. Edit ${meta.sourceFile} to preview changes.`, k);
  sendLog(`Sample model created: models/cuboid/${modelSourceFilename(k, 'part')}`);
}

/**
 * When opening an existing project, only ensure the required runtime folders exist.
 * Do not rewrite user-managed rule files here.
 */
function ensureRuntimeDirs(projectPath) {
  fs.mkdirSync(path.join(projectPath, MODELS_DIR), { recursive: true });
  fs.mkdirSync(path.join(projectPath, CACHE_DIR), { recursive: true });
}

function createPartFiles(projectPath, name, kindOrDescription, descriptionOrKernel, kernel = currentKernel) {
  let kind = 'part';
  let description = kindOrDescription;
  let actualKernel = descriptionOrKernel ?? kernel;
  if (MODEL_KINDS.includes(kindOrDescription)) {
    kind = kindOrDescription;
    description = descriptionOrKernel;
    actualKernel = kernel;
  }
  const k = assertKernel(actualKernel);
  const srcPath = partSource(projectPath, name, k, kind);
  const mdPath = partReadme(projectPath, name);
  fs.mkdirSync(path.dirname(srcPath), { recursive: true });
  writeIfMissing(srcPath, modelSourceTemplate(k, kind, name, description));
  writeIfMissing(mdPath, modelReadmeTemplate(k, kind, name, description));
}

/* ---------------- Model Listing ---------------- */

function listPartsRaw(projectPath, kernel = currentKernel) {
  const k = assertKernel(kernel);
  const dir = path.join(projectPath, MODELS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .map((name) => ({ name, source: resolveModelSource(projectPath, name, k) }))
    .filter(({ source }) => !!source)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, source }) => ({
      name,
      kind: source.kind,
      sourceFile: source.fileName,
      description: readPartDescription(projectPath, name, k)
    }));
}

function readPartDescription(projectPath, name, kernel = currentKernel) {
  const k = assertKernel(kernel);
  // Prefer the first non-empty, non-heading, non-quote paragraph from README.md.
  try {
    const md = fs.readFileSync(partReadme(projectPath, name), 'utf-8');
    const lines = md.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (l.startsWith('#')) continue;
      if (l.startsWith('>')) continue;
      return l.replace(/^[*-]\s*/, '').slice(0, 120);
    }
  } catch {}
  // Fallback to a top-level source comment.
  try {
    const source = resolveModelSource(projectPath, name, k);
    if (!source) return '';
    const src = fs.readFileSync(source.sourcePath, 'utf-8');
    const m = /^\s*"""([\s\S]*?)"""/.exec(src);
    if (m) return m[1].trim().split(/\r?\n/)[0].slice(0, 120);
  } catch {}
  return '';
}

function listParts(projectPath, kernel = currentKernel) {
  const k = assertKernel(kernel);
  return listPartsRaw(projectPath, k).map((p) => {
    const cache = partCache(projectPath, p.name, k);
    let size = 0, mtime = 0;
    if (fs.existsSync(cache)) {
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
      building: buildingParts.has(p.name) || pendingParts.has(p.name)
    };
  });
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeText', (_evt, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('mcp:status', () => getMcpStatusPayload());

  /** Same data source as the MCP list_parts tool, useful for UI validation. */
  ipcMain.handle('mcp:testListParts', () => buildMcpContext().listParts());

  ipcMain.handle('dialog:chooseDirectory', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a parent directory for the new project',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('project:create', async (_evt, { parentDir, projectName, kernel }) => {
    if (!parentDir || !projectName) throw new Error('parentDir and projectName are required.');
    const k = assertKernel(kernel);
    const projectPath = path.join(parentDir, projectName);
    if (fs.existsSync(projectPath)) throw new Error(`Project path already exists: ${projectPath}`);
    fs.mkdirSync(projectPath, { recursive: true });
    initProjectLayout(projectPath, k);
    await openProject(projectPath, { runImmediately: true });
    return projectPath;
  });

  ipcMain.handle('project:open', async (_evt, projectPath) => {
    if (!projectPath) {
      return openProjectByDialog();
    }
    if (!fs.existsSync(projectPath)) throw new Error(`Path does not exist: ${projectPath}`);
    await openProject(projectPath, { runImmediately: true });
    return projectPath;
  });

  ipcMain.handle('project:meta', () => {
    if (!currentProjectPath) return null;
    const meta = kernelMeta(currentKernel);
    return {
      path: currentProjectPath,
      kernel: currentKernel,
      kernelLabel: meta.label,
      sourceFile: meta.sourceFile,
      sourceFiles: Object.values(sourceFileOptions(currentKernel)),
      previewFormat: meta.previewFormat,
      runner: meta.runner,
      kernels: KERNELS.map((k) => ({ id: k, ...kernelMeta(k) }))
    };
  });

  ipcMain.handle('project:rebuild', async () => {
    if (!currentProjectPath) throw new Error('Open a project first.');
    if (activePart) scheduleBuild(activePart);
    return true;
  });

  ipcMain.handle('project:revealInFolder', async () => {
    if (!currentProjectPath) return;
    shell.openPath(currentProjectPath);
  });

  /* ---- Model actions ---- */

  ipcMain.handle('parts:list', async () => {
    if (!currentProjectPath) return { parts: [], active: null };
    return { parts: listParts(currentProjectPath), active: activePart };
  });

  ipcMain.handle('parts:create', async (_evt, { name, kind = 'part', description }) => {
    if (!currentProjectPath) throw new Error('Open a project first.');
    const cleanName = sanitizePartName(name);
    if (!cleanName) throw new Error('Model names may only contain letters, numbers, underscores, and hyphens.');
    if (!MODEL_KINDS.includes(kind)) throw new Error(`Unsupported model kind: ${kind}`);
    if (fs.existsSync(modelDir(currentProjectPath, cleanName))) {
      throw new Error(`Model "${cleanName}" already exists.`);
    }
    createPartFiles(currentProjectPath, cleanName, kind, description, currentKernel);
    broadcastPartsList();
    sendLog(`Model created: models/${cleanName}/${modelSourceFilename(currentKernel, kind)}`);
    // Make the new model active and build it immediately.
    await selectPart(cleanName);
    scheduleBuild(cleanName);
    return cleanName;
  });

  ipcMain.handle('parts:select', async (_evt, name) => {
    if (!currentProjectPath) return;
    await selectPart(name);
    return activePart;
  });

  ipcMain.handle('parts:rebuild', async (_evt, name) => {
    const target = name || activePart;
    if (target) scheduleBuild(target);
    return true;
  });

  ipcMain.handle('parts:reveal', async (_evt, name) => {
    if (!currentProjectPath || !name) return;
    shell.openPath(modelDir(currentProjectPath, name));
  });

  ipcMain.handle('parts:export', async (_evt, { name, format }) => {
    if (!currentProjectPath) throw new Error('Open a project first.');
    const partName = String(name || activePart || '').trim();
    if (!partName) throw new Error('Select a model first.');
    return exportPartByRequest(partName, format);
  });

  ipcMain.handle('viewer:partLoaded', async (_evt, payload) => {
    if (!currentProjectPath || !payload?.part) return;
    const { part, faceCount, bbox, faces, snapshotDataURL, snapshotDataURLs } = payload;
    partInfoCache.set(part, {
      faceCount, bbox, faces,
      capturedAt: Date.now()
    });
    const snapshots = snapshotDataURLs && typeof snapshotDataURLs === 'object'
      ? snapshotDataURLs
      : { iso: snapshotDataURL };
    for (const view of SCREENSHOT_VIEWS) {
      const dataUrl = snapshots?.[view];
      if (typeof dataUrl !== 'string') continue;
      const m = /^data:image\/[a-zA-Z]+;base64,(.*)$/.exec(dataUrl);
      if (!m) continue;
      try {
        fs.mkdirSync(path.join(currentProjectPath, CACHE_DIR), { recursive: true });
        fs.writeFileSync(partPng(currentProjectPath, part, view), Buffer.from(m[1], 'base64'));
      } catch (e) {
        sendLog(`Failed to write screenshot cache (${view}): ${e.message}`, 'warn');
      }
      if (view === 'iso') {
        try {
          fs.writeFileSync(partPng(currentProjectPath, part), Buffer.from(m[1], 'base64'));
        } catch (e) {
          sendLog(`Failed to write screenshot cache (legacy iso): ${e.message}`, 'warn');
        }
      }
    }
    resolvePartLoadedWaiters(part, {
      part,
      faceCount,
      capturedAt: Date.now()
    });
  });

  /* ---- Python / Conda environment ---- */

  ipcMain.handle('python:status', async () => getBuildRuntimeStatus());

  ipcMain.handle('python:pick', async () => {
    const filters = process.platform === 'win32'
      ? [{ name: 'Python', extensions: ['exe'] }]
      : [{ name: 'All Files', extensions: ['*'] }];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Python interpreter',
      properties: ['openFile'],
      filters
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const result = await pyenv.setPythonPath(res.filePaths[0]);
    sendLog(`Python interpreter set: ${res.filePaths[0]} (v${result.version})`);
    return await getBuildRuntimeStatus();
  });

  ipcMain.handle('python:clearPath', async () => {
    await pyenv.setPythonPath(null);
    sendLog('Cleared custom Python path. Falling back to system PATH.');
    return await getBuildRuntimeStatus();
  });

  ipcMain.handle('python:condaAvailable', async () => pyenv.detectConda());

  ipcMain.handle('python:createCondaEnv', async (_evt, opts) => {
    try {
      const pyPath = await pyenv.createCondaEnv({
        envName: opts?.envName,
        pythonVersion: opts?.pythonVersion,
        installBuild123d: opts?.installBuild123d !== false,
        onLog: (msg, level = 'info') => sendLog(msg, level)
      });
      const status = await getBuildRuntimeStatus();
      return { ok: true, pythonPath: pyPath, status };
    } catch (e) {
      sendLog(`Conda environment creation failed: ${e.message}`, 'error');
      throw e;
    }
  });

}

function sanitizePartName(name) {
  const s = String(name || '').trim();
  if (!/^[a-zA-Z0-9_\-]+$/.test(s)) return null;
  return s;
}


/* ---------------- Project and Watchers ---------------- */

async function openProject(projectPath, { runImmediately = false } = {}) {
  const resolvedProjectPath = path.resolve(projectPath);
  const nextKernel = readProjectKernel(resolvedProjectPath);
  ensureRuntimeDirs(resolvedProjectPath);

  stopWatcher();
  currentProjectPath = resolvedProjectPath;
  currentKernel = nextKernel;
  partInfoCache.clear();
  buildWaiters.clear();
  partLoadedWaiters.clear();

  saveLastProjectPath(resolvedProjectPath);
  sendLog(`Project kernel: ${kernelMeta(currentKernel).label} (${currentKernel})`);

  // Select the first model as the active model.
  const parts = listPartsRaw(resolvedProjectPath, currentKernel);
  activePart = parts.length ? parts[0].name : null;

  sendToRenderer('PROJECT_OPENED', {
    path: resolvedProjectPath,
    kernel: currentKernel,
    kernelLabel: kernelMeta(currentKernel).label,
    sourceFile: kernelMeta(currentKernel).sourceFile,
    sourceFiles: Object.values(sourceFileOptions(currentKernel)),
    previewFormat: kernelMeta(currentKernel).previewFormat
  });
  sendToRenderer('PYTHON_STATUS', await getBuildRuntimeStatus(currentKernel));
  broadcastPartsList();
  rebuildAppMenu();

  // Watch both part.* and asm.* source files for the current kernel.
  const globs = MODEL_KINDS.map((kind) =>
    path.join(resolvedProjectPath, MODELS_DIR, '*', modelSourceFilename(currentKernel, kind)).replace(/\\/g, '/')
  );
  watcher = chokidar.watch(globs, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });

  watcher.on('change', (filePath) => {
    const entry = partNameFromPath(filePath);
    if (!entry) return;
    sendLog(`Model changed: models/${entry.name}/${entry.fileName}`);
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
  watcher.on('error', (err) => sendLog(`watcher error: ${err.message}`, 'error'));

  if (runImmediately && activePart) {
    const cache = partCache(currentProjectPath, activePart);
    if (fs.existsSync(cache)) {
      // On project open, prefer existing cache for instant preview.
      sendModelUpdated(activePart);
    } else {
      scheduleBuild(activePart);
    }
  }
}

function partNameFromPath(filePath) {
  const rel = path.relative(currentProjectPath || '', filePath).replace(/\\/g, '/');
  const ext = sourceExt(currentKernel).replace(/^\./, '');
  const re = new RegExp(`^models/([^/]+)/(part|asm)\\.${ext}$`, 'i');
  const m = re.exec(rel);
  return m ? { name: m[1], kind: m[2], fileName: `${m[2]}${sourceExt(currentKernel)}` } : null;
}

function stopWatcher() {
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
  }
}

async function selectPart(name) {
  if (!currentProjectPath) return;
  if (!resolveModelSource(currentProjectPath, name)) {
    throw new Error(`Model does not exist: ${name}`);
  }
  activePart = name;
  sendToRenderer('ACTIVE_PART_CHANGED', { name });
  broadcastPartsList();

  const cache = partCache(currentProjectPath, name);
  if (fs.existsSync(cache)) {
    sendModelUpdated(name);
  } else {
    scheduleBuild(name);
  }
}

/* ---------------- Build ---------------- */

function scheduleBuild(partName) {
  if (!currentProjectPath || !partName) return;
  if (buildingParts.has(partName)) {
    pendingParts.add(partName);
    return;
  }
  runBuild(partName);
}

async function runBuild(partName) {
  if (!currentProjectPath || !partName) return;
  buildingParts.add(partName);
  pendingParts.delete(partName);
  sendToRenderer('BUILD_STARTED', { part: partName });
  broadcastPartsList();
  return runBuildPython(partName);
}

async function runBuildPython(partName) {
  const runtime = await detectBuildRuntime(currentKernel);
  if (!runtime) {
    buildingParts.delete(partName);
    const msg = missingRuntimeMessage(currentKernel);
    sendLog(msg, 'error');
    sendToRenderer('BUILD_FAILED', { part: partName, message: msg, reason: 'NO_RUNTIME' });
    sendToRenderer('PYTHON_STATUS', await getBuildRuntimeStatus(currentKernel));
    broadcastPartsList();
    resolveBuildWaiters(partName, { ok: false, part: partName, error: msg, reason: 'NO_RUNTIME' });
    if (pendingParts.has(partName)) runBuild(partName);
    return;
  }

  const cmd = buildRuntimeSpawn(runtime, ['--project', currentProjectPath, '--model', partName]);
  sendLog(
    runtime.kind === 'bundled-runner'
      ? `[${partName}] Build using bundled build123d runtime`
      : `[${partName}] Build using Python ${runtime.cmd} (v${runtime.version}) with ${kernelMeta(currentKernel).label}`
  );

  const child = spawn(cmd.cmd, cmd.args, {
    cwd: currentProjectPath,
    shell: false,
    windowsHide: true
  });

  finalizeBuildChild(
    child,
    partName,
    runtime.kind === 'bundled-runner' ? 'bundled build123d runtime' : 'electron/export_runner.py'
  );
}

/**
 * Shared process cleanup:
 * stream stdout/stderr into logs, then resolve success or failure from cache output.
 */
function finalizeBuildChild(child, partName, label) {
  let stderr = '';
  let stdout = '';
  child.stdout?.on('data', (d) => {
    const s = d.toString();
    stdout += s;
    sendLog(s.trimEnd());
  });
  child.stderr?.on('data', (d) => {
    const s = d.toString();
    stderr += s;
    sendLog(s.trimEnd(), 'warn');
  });

  child.on('error', (err) => {
    buildingParts.delete(partName);
    const friendlyMsg = err.message;
    sendLog(`[${partName}] ${label} failed: ${friendlyMsg}`, 'error');
    sendToRenderer('BUILD_FAILED', { part: partName, message: friendlyMsg });
    broadcastPartsList();
    resolveBuildWaiters(partName, { ok: false, part: partName, error: friendlyMsg });
  });

  child.on('close', (code) => {
    buildingParts.delete(partName);
    const cacheFile = partCache(currentProjectPath, partName);
    const cacheBase = path.basename(cacheFile);

    if (code !== 0) {
      sendLog(`[${partName}] ${label} exited with code ${code}`, 'error');
      sendToRenderer('BUILD_FAILED', { part: partName, code, stderr });
      resolveBuildWaiters(partName, {
        ok: false, part: partName, exitCode: code, stderr: stderr.trim(), stdout: stdout.trim()
      });
    } else if (fs.existsSync(cacheFile)) {
      const size = fs.statSync(cacheFile).size;
      sendLog(`[${partName}] Model cache updated (${(size / 1024).toFixed(1)} KB)`);
      sendToRenderer('PART_BUILT', { part: partName, size });
      if (partName === activePart) sendModelUpdated(partName);
      resolveBuildWaiters(partName, {
        ok: true,
        part: partName,
        kernel: currentKernel,
        cacheFile: cacheBase,
        cacheSize: size,
        faceCount: partInfoCache.get(partName)?.faceCount ?? null,
        stdout: stdout.trim()
      });
    } else {
      sendToRenderer('BUILD_FAILED', { part: partName, message: `${cacheBase} was not generated` });
      resolveBuildWaiters(partName, {
        ok: false, part: partName, error: `${cacheBase} was not generated`, stderr: stderr.trim()
      });
    }
    broadcastPartsList();
    if (pendingParts.has(partName)) runBuild(partName);
  });
}

function resolveBuildWaiters(name, payload) {
  const arr = buildWaiters.get(name);
  if (!arr || arr.length === 0) return;
  buildWaiters.delete(name);
  for (const resolve of arr) {
    try { resolve(payload); } catch {}
  }
}

function resolvePartLoadedWaiters(name, payload) {
  const arr = partLoadedWaiters.get(name);
  if (!arr || arr.length === 0) return;
  partLoadedWaiters.delete(name);
  for (const resolve of arr) {
    try { resolve(payload); } catch {}
  }
}

function waitForPartLoaded(name, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!partLoadedWaiters.has(name)) partLoadedWaiters.set(name, []);
    const arr = partLoadedWaiters.get(name);
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
      if (arr.length === 0) partLoadedWaiters.delete(name);
      resolve(null);
    }, timeoutMs);
    arr.push(onLoaded);
  });
}

async function refreshViewerCachesAfterBuild(partName) {
  if (!currentProjectPath || !partName) return { cacheRefresh: 'skipped' };
  if (!fs.existsSync(partCache(currentProjectPath, partName))) {
    return { cacheRefresh: 'skipped', cacheRefreshReason: 'cache-missing' };
  }
  sendModelUpdated(partName);
  const loaded = await waitForPartLoaded(partName, 5000);
  if (!loaded) {
    return { cacheRefresh: 'timeout' };
  }
  return {
    cacheRefresh: 'ok',
    faceCount: partInfoCache.get(partName)?.faceCount ?? null
  };
}

function sendModelUpdated(partName) {
  const cache = partCache(currentProjectPath, partName);
  if (!fs.existsSync(cache)) return;
  const ts = Date.now();
  const size = fs.statSync(cache).size;
  const meta = kernelMeta(currentKernel);
  const ext = meta.cacheExt.replace(/^\./, '');
  sendToRenderer('MODEL_UPDATED', {
    part: partName,
    url: `aicad://model/${encodeURIComponent(partName)}${meta.cacheExt}?t=${ts}`,
    format: meta.previewFormat,
    extension: ext,
    kernel: currentKernel,
    size,
    ts
  });
}

async function runCommandCollect(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runPythonExport(partName, format, outFile) {
  const runtime = await detectBuildRuntime(currentKernel);
  if (!runtime) throw new Error(missingRuntimeMessage(currentKernel));
  const cmd = buildRuntimeSpawn(runtime, [
    '--project',
    currentProjectPath,
    '--model',
    partName,
    '--export-format',
    format,
    '--output',
    outFile
  ]);
  const ret = await runCommandCollect(cmd.cmd, cmd.args, {
    cwd: currentProjectPath,
    shell: false,
    windowsHide: true
  });
  if (ret.code !== 0) {
    throw new Error((ret.stderr || ret.stdout || `Python export failed with exit code ${ret.code}`).trim());
  }
}

async function convertStlToObjOrGlb(stlPath, outPath, format) {
  const THREE = require('three');
  const [{ STLLoader }, { OBJExporter }, { GLTFExporter }] = await Promise.all([
    import('three/examples/jsm/loaders/STLLoader.js'),
    import('three/examples/jsm/exporters/OBJExporter.js'),
    import('three/examples/jsm/exporters/GLTFExporter.js')
  ]);

  const data = fs.readFileSync(stlPath);
  const loader = new STLLoader();
  const geometry = loader.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb0b0b0 }));
  const scene = new THREE.Scene();
  scene.add(mesh);

  if (format === 'obj') {
    const objText = new OBJExporter().parse(scene);
    fs.writeFileSync(outPath, objText, 'utf-8');
    return;
  }
  if (format === 'glb') {
    const exporter = new GLTFExporter();
    const glbBuffer = await new Promise((resolve, reject) => {
      exporter.parse(
        scene,
        (result) => resolve(Buffer.from(result)),
        (err) => reject(err),
        { binary: true }
      );
    });
    fs.writeFileSync(outPath, glbBuffer);
    return;
  }
  throw new Error(`Unsupported conversion format: ${format}`);
}

async function generateExportFile(partName, format, outFile) {
  if (format === 'step') {
    await runPythonExport(partName, 'step', outFile);
    return;
  }
  if (format === 'stl') {
    await runPythonExport(partName, 'stl', outFile);
    return;
  }

  const tmpStl = path.join(os.tmpdir(), `aicad-export-${partName}-${Date.now()}.stl`);
  try {
    await runPythonExport(partName, 'stl', tmpStl);
    await convertStlToObjOrGlb(tmpStl, outFile, format);
  } finally {
    try { fs.unlinkSync(tmpStl); } catch {}
  }
}

async function exportPartByRequest(partName, format) {
  if (!currentProjectPath) throw new Error('Open a project first.');
  const cleanPart = String(partName || '').trim();
  if (!cleanPart) throw new Error('Model name is required.');
  if (!resolveModelSource(currentProjectPath, cleanPart, currentKernel)) {
    throw new Error(`Model does not exist: ${cleanPart}`);
  }

  const fmt = ensureExportFormat(format);
  const ext = exportExt(fmt);
  const saveRes = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${cleanPart} as ${fmt.toUpperCase()}`,
    defaultPath: path.join(currentProjectPath, `${cleanPart}${ext}`),
    filters: [{ name: `${fmt.toUpperCase()} File`, extensions: [ext.replace(/^\./, '')] }]
  });
  if (saveRes.canceled || !saveRes.filePath) return { canceled: true };

  sendLog(`[${cleanPart}] Exporting ${fmt.toUpperCase()}...`);
  await generateExportFile(cleanPart, fmt, saveRes.filePath);
  return { canceled: false, path: saveRes.filePath, format: fmt, part: cleanPart };
}

/* ---------------- Broadcast ---------------- */

function broadcastPartsList() {
  if (!currentProjectPath) return;
  sendToRenderer('PARTS_LIST', {
    active: activePart,
    kernel: currentKernel,
    parts: listParts(currentProjectPath, currentKernel)
  });
}

function sendToRenderer(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:event', { type, payload });
  }
}

function sendLog(message, level = 'info') {
  sendToRenderer('LOG', { message, level, ts: Date.now() });
}

function getMcpStatusPayload() {
  const li = mcp.getListenInfo?.() ?? null;
  const fallbackUrl = `http://127.0.0.1:${MCP_PORT}/mcp`;
  return {
    running: mcp.isRunning(),
    port: li?.port ?? MCP_PORT,
    url: li?.url ?? fallbackUrl,
    error: mcpStartError
  };
}

function broadcastMcpStatus() {
  sendToRenderer('MCP_STATUS', getMcpStatusPayload());
}

/* ---------------- MCP context ---------------- */
/**
 * Build the MCP server context object.
 * mcp-server.js reads runtime state through this interface instead of touching main.js globals.
 */
function buildMcpContext() {
  return {
    listParts() {
      if (!currentProjectPath) return { error: 'No project is open in the preview app.', parts: [], active: null };
      const meta = kernelMeta(currentKernel);
      const list = listParts(currentProjectPath, currentKernel).map((p) => {
        const info = partInfoCache.get(p.name);
        return {
          ...p,
          hasScreenshot: fs.existsSync(partPng(currentProjectPath, p.name)),
          hasInfo: !!info,
          faceCount: info?.faceCount ?? null
        };
      });
      return {
        projectPath: currentProjectPath,
        kernel: currentKernel,
        kernelLabel: meta.label,
        sourceFile: meta.sourceFile,
        sourceFiles: Object.values(sourceFileOptions(currentKernel)),
        previewFormat: meta.previewFormat,
        supportsFaceIndex: meta.previewFormat === 'BREP',
        active: activePart,
        parts: list
      };
    },

    async getPartInfo(name) {
      if (!currentProjectPath) return { error: 'No project is open in the preview app.' };
      if (!resolveModelSource(currentProjectPath, name)) {
        return { error: `Model does not exist: ${name}` };
      }
      const info = partInfoCache.get(name);
      const cache = partCache(currentProjectPath, name);
      const src = partSource(currentProjectPath, name);
      const source = resolveModelSource(currentProjectPath, name);
      const cacheStale = fs.existsSync(cache) && fs.existsSync(src)
        && fs.statSync(src).mtimeMs > fs.statSync(cache).mtimeMs;
      if (!info) {
        return {
          name,
          kernel: currentKernel,
          error:
            `Geometry info for "${name}" is not cached yet. ` +
            `Run rebuild_part({"part":"${name}"}) first, then verify status with list_parts and try again.`,
          cacheStale
        };
      }
      return {
        name,
        kernel: currentKernel,
        kind: source?.kind || null,
        sourceFile: source?.fileName || null,
        description: readPartDescription(currentProjectPath, name, currentKernel),
        faceCount: info.faceCount,
        bbox: info.bbox,
        cacheStale,
        capturedAt: new Date(info.capturedAt).toISOString()
      };
    },

    async getPartScreenshot(name, view = 'iso') {
      if (!currentProjectPath) return null;
      if (!resolveModelSource(currentProjectPath, name)) return null;
      try {
        await selectPart(name);
      } catch {
        return null;
      }
      const p = partPng(currentProjectPath, name, view);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p);
    },

    async rebuildPartSync(name) {
      if (!currentProjectPath) return { ok: false, error: 'No project is open in the preview app.' };
      if (!resolveModelSource(currentProjectPath, name)) {
        return { ok: false, error: `Model does not exist: ${name}` };
      }
      const result = await new Promise((resolve) => {
        if (!buildWaiters.has(name)) buildWaiters.set(name, []);
        buildWaiters.get(name).push(resolve);
        scheduleBuild(name);
      });
      if (!result?.ok) return result;
      const refreshed = await refreshViewerCachesAfterBuild(name);
      return { ...result, ...refreshed };
    }
  };
}
