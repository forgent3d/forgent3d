'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function createMainUiTools({
  BrowserWindow,
  Menu,
  dialog,
  shell,
  protocol,
  net,
  app,
  state,
  deps
}) {
  function sendToRenderer(type, payload) {
    const win = state.mainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:event', { type, payload });
    }
  }

  function sendLog(message, level = 'info') {
    sendToRenderer('LOG', { message, level, ts: Date.now() });
  }

  function getMcpStatusPayload() {
    const li = deps.mcp.getListenInfo?.() ?? null;
    const fallbackUrl = `http://127.0.0.1:${deps.MCP_PORT}/mcp`;
    return {
      running: deps.mcp.isRunning(),
      port: li?.port ?? deps.MCP_PORT,
      url: li?.url ?? fallbackUrl,
      error: state.mcpStartError()
    };
  }

  function broadcastMcpStatus() {
    sendToRenderer('MCP_STATUS', getMcpStatusPayload());
  }

  function registerProtocol() {
    protocol.handle('aicad', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname === 'model' && state.currentProjectPath()) {
          const file = path.basename(url.pathname);
          const name = file.replace(/\.(brep|stl|urdf)$/i, '');
          if (name) {
            const source = deps.resolveModelSource(state.currentProjectPath(), name, state.currentKernel());
            const p = deps.modelCacheFile(state.currentProjectPath(), name, source, state.currentKernel());
            if (p && fs.existsSync(p)) {
              return net.fetch(pathToFileURL(p).toString());
            }
          }
        }
        if (url.hostname === 'asset' && state.currentProjectPath()) {
          const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
          const asset = deps.toProjectRelativeAsset(rel);
          if (asset && fs.existsSync(asset) && fs.statSync(asset).isFile()) {
            return net.fetch(pathToFileURL(asset).toString());
          }
        }
        return new Response('Not Found', { status: 404 });
      } catch (e) {
        return new Response(`protocol error: ${e.message}`, { status: 500 });
      }
    });
  }

  function createWindow() {
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1040,
      minHeight: 640,
      title: 'AI CAD Companion Preview',
      icon: deps.appIconPath(),
      backgroundColor: '#0b0d12',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    state.setMainWindow(win);

    if (deps.isDev) {
      win.loadURL('http://localhost:5173');
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }

    win.webContents.once('did-finish-load', async () => {
      try {
        sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus());
      } catch (e) {
        sendLog(`Python status check failed: ${e.message}`, 'error');
      }
      broadcastMcpStatus();
      sendToRenderer('MENU_TOGGLE_DEBUG_TOOLS', { visible: state.debugToolsVisible() });
      try {
        await deps.restoreLastProjectIfAvailable();
      } catch (e) {
        sendLog(`Last project restore failed: ${e.message}`, 'warn');
      }
    });

    win.on('closed', () => {
      state.setMainWindow(null);
      deps.stopWatcher();
    });
  }

  function rebuildAppMenu() {
    const hasProject = !!state.currentProjectPath();
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
                await deps.openProjectByDialog();
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
              if (state.activePart()) deps.scheduleBuild(state.activePart());
            }
          },
          {
            label: 'Reveal in Folder',
            enabled: hasProject,
            click: () => {
              if (state.currentProjectPath()) shell.openPath(state.currentProjectPath());
            }
          },
          {
            label: 'Export Current Model',
            enabled: hasProject && !!state.activePart(),
            submenu: [
              { label: 'Export STEP...', enabled: hasProject && !!state.activePart(), click: () => deps.handleExportFromMenu('step') },
              { label: 'Export STL...', enabled: hasProject && !!state.activePart(), click: () => deps.handleExportFromMenu('stl') },
              { label: 'Export OBJ...', enabled: hasProject && !!state.activePart(), click: () => deps.handleExportFromMenu('obj') }
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
            checked: state.debugToolsVisible(),
            click: (menuItem) => {
              state.setDebugToolsVisible(!!menuItem.checked);
              sendToRenderer('MENU_TOGGLE_DEBUG_TOOLS', { visible: state.debugToolsVisible() });
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
    const res = await dialog.showOpenDialog(state.mainWindow(), {
      title: 'Open an Existing AI CAD Project',
      properties: ['openDirectory']
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const projectPath = res.filePaths[0];
    if (!fs.existsSync(projectPath)) throw new Error(`Path does not exist: ${projectPath}`);
    await deps.openProject(projectPath, { runImmediately: true });
    return projectPath;
  }

  async function restoreLastProjectIfAvailable() {
    const lastProjectPath = String(deps.loadAppConfig().lastProjectPath || '').trim();
    if (!lastProjectPath) return false;
    if (!fs.existsSync(lastProjectPath)) {
      deps.clearLastProjectPath();
      sendLog(`Last project no longer exists, cleared saved path: ${lastProjectPath}`, 'warn');
      return false;
    }
    try {
      await deps.openProject(lastProjectPath, { runImmediately: true });
      sendLog(`Restored last project: ${lastProjectPath}`);
      return true;
    } catch (e) {
      deps.clearLastProjectPath();
      sendLog(`Failed to restore last project (${lastProjectPath}): ${e.message}`, 'warn');
      return false;
    }
  }

  async function handleExportFromMenu(format) {
    try {
      if (!state.activePart()) throw new Error('No active model is available for export.');
      const res = await deps.exportPartByRequest(state.activePart(), format);
      if (!res?.canceled && res?.path) {
        sendLog(`[${state.activePart()}] Exported ${String(format).toUpperCase()}: ${res.path}`);
      }
    } catch (e) {
      sendLog(`Export failed: ${e.message || e}`, 'error');
      dialog.showErrorBox('Export Failed', e.message || String(e));
    }
  }

  return {
    sendToRenderer,
    sendLog,
    getMcpStatusPayload,
    broadcastMcpStatus,
    registerProtocol,
    createWindow,
    rebuildAppMenu,
    openProjectByDialog,
    restoreLastProjectIfAvailable,
    handleExportFromMenu
  };
}

function initMainUiTools(mainContext) {
  const {
    electron,
    app,
    state,
    mcp,
    constants,
    env,
    model,
    project,
    runtime,
    build,
    exportApi
  } = mainContext;
  return createMainUiTools({
    BrowserWindow: electron.BrowserWindow,
    Menu: electron.Menu,
    dialog: electron.dialog,
    shell: electron.shell,
    protocol: electron.protocol,
    net: electron.net,
    app,
    state: {
      mainWindow: state.mainWindow,
      setMainWindow: state.setMainWindow,
      currentProjectPath: state.currentProjectPath,
      currentKernel: state.currentKernel,
      activePart: state.activePart,
      debugToolsVisible: state.debugToolsVisible,
      setDebugToolsVisible: state.setDebugToolsVisible,
      mcpStartError: state.mcpStartError
    },
    deps: {
      MCP_PORT: constants.MCP_PORT,
      mcp,
      isDev: env.isDev,
      appIconPath: app.appIconPath,
      resolveModelSource: model.resolveModelSource,
      modelCacheFile: model.modelCacheFile,
      toProjectRelativeAsset: model.toProjectRelativeAsset,
      getBuildRuntimeStatus: runtime.getBuildRuntimeStatus,
      stopWatcher: project.stopWatcher,
      openProject: project.openProject,
      loadAppConfig: project.loadAppConfig,
      clearLastProjectPath: project.clearLastProjectPath,
      exportPartByRequest: exportApi.exportPartByRequest,
      scheduleBuild: build.scheduleBuild,
      restoreLastProjectIfAvailable: () => project.restoreLastProjectIfAvailable(),
      openProjectByDialog: () => project.openProjectByDialog(),
      handleExportFromMenu: (format) => exportApi.handleExportFromMenu(format)
    }
  });
}

module.exports = {
  createMainUiTools,
  initMainUiTools
};
