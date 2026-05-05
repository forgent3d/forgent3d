// @ts-nocheck
export {};
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

  const menuMessages = {
    en: {
      file: 'File',
      newProject: 'New Project...',
      openProject: 'Open Project...',
      rebuild: 'Rebuild',
      revealInFolder: 'Reveal in Folder',
      exportCurrentModel: 'Export Current Model',
      exportStep: 'Export STEP...',
      exportStl: 'Export STL...',
      exportObj: 'Export OBJ...',
      quit: 'Quit',
      edit: 'Edit',
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
      view: 'View',
      reload: 'Reload',
      developerTools: 'Developer Tools',
      debugTools: 'Debug Tools',
      actualSize: 'Actual Size',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
      toggleFullScreen: 'Toggle Full Screen',
      language: 'Language',
      english: 'English',
      chinese: '中文'
    },
    'zh-CN': {
      file: '文件',
      newProject: '新建项目...',
      openProject: '打开项目...',
      rebuild: '重新构建',
      revealInFolder: '在文件夹中显示',
      exportCurrentModel: '导出当前模型',
      exportStep: '导出 STEP...',
      exportStl: '导出 STL...',
      exportObj: '导出 OBJ...',
      quit: '退出',
      edit: '编辑',
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
      selectAll: '全选',
      view: '视图',
      reload: '重新加载',
      developerTools: '开发者工具',
      debugTools: '调试工具',
      actualSize: '实际大小',
      zoomIn: '放大',
      zoomOut: '缩小',
      toggleFullScreen: '切换全屏',
      language: '语言',
      english: 'English',
      chinese: '中文'
    }
  };

  function t(key) {
    const language = state.appLanguage?.() || 'en';
    return menuMessages[language]?.[key] || menuMessages.en[key] || key;
  }

  function setLanguage(language) {
    if (typeof deps.setLanguage === 'function') deps.setLanguage(language);
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
          const name = file.replace(/\.(brep|stl|xml)$/i, '');
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
      win.loadURL('http://localhost:7788');
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
    }

    win.webContents.once('did-finish-load', async () => {
      try {
        sendToRenderer('PYTHON_STATUS', await deps.getBuildRuntimeStatus());
      } catch (e) {
        sendLog(`Python status check failed: ${e.message}`, 'error');
      }
      broadcastMcpStatus();
      sendToRenderer('LANGUAGE_CHANGED', { language: state.appLanguage?.() || 'en' });
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
        label: t('file'),
        submenu: [
          {
            label: t('newProject'),
            accelerator: 'CmdOrCtrl+N',
            click: () => sendToRenderer('MENU_NEW_PROJECT', {})
          },
          {
            label: t('openProject'),
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
            label: t('rebuild'),
            accelerator: 'F5',
            enabled: hasProject,
            click: () => {
              if (state.activePart()) deps.scheduleBuild(state.activePart());
            }
          },
          {
            label: t('revealInFolder'),
            enabled: hasProject,
            click: () => {
              if (state.currentProjectPath()) shell.openPath(state.currentProjectPath());
            }
          },
          {
            label: t('exportCurrentModel'),
            enabled: hasProject && !!state.activePart(),
            submenu: [
              { label: t('exportStep'), enabled: hasProject && !!state.activePart(), click: () => deps.handleExportFromMenu('step') },
              { label: t('exportStl'), enabled: hasProject && !!state.activePart(), click: () => deps.handleExportFromMenu('stl') },
              { label: t('exportObj'), enabled: hasProject && !!state.activePart(), click: () => deps.handleExportFromMenu('obj') }
            ]
          },
          { type: 'separator' },
          { role: 'quit', label: t('quit') }
        ]
      },
      {
        label: t('edit'),
        submenu: [
          { role: 'undo', label: t('undo') },
          { role: 'redo', label: t('redo') },
          { type: 'separator' },
          { role: 'cut', label: t('cut') },
          { role: 'copy', label: t('copy') },
          { role: 'paste', label: t('paste') },
          { role: 'selectAll', label: t('selectAll') }
        ]
      },
      {
        label: t('view'),
        submenu: [
          { role: 'reload', label: t('reload') },
          { role: 'toggleDevTools', label: t('developerTools') },
          {
            type: 'checkbox',
            label: t('debugTools'),
            checked: state.debugToolsVisible(),
            click: (menuItem) => {
              state.setDebugToolsVisible(!!menuItem.checked);
              sendToRenderer('MENU_TOGGLE_DEBUG_TOOLS', { visible: state.debugToolsVisible() });
            }
          },
          { type: 'separator' },
          {
            label: t('language'),
            submenu: [
              { type: 'radio', label: t('english'), checked: (state.appLanguage?.() || 'en') === 'en', click: () => setLanguage('en') },
              { type: 'radio', label: t('chinese'), checked: state.appLanguage?.() === 'zh-CN', click: () => setLanguage('zh-CN') }
            ]
          },
          { type: 'separator' },
          { role: 'resetZoom', label: t('actualSize') },
          { role: 'zoomIn', label: t('zoomIn') },
          { role: 'zoomOut', label: t('zoomOut') },
          { type: 'separator' },
          { role: 'togglefullscreen', label: t('toggleFullScreen') }
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
      appLanguage: state.appLanguage,
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
      setLanguage: project.setLanguage,
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
