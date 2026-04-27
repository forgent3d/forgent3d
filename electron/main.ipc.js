'use strict';

const fs = require('fs');
const path = require('path');

function registerIpcHandlers({
  ipcMain,
  clipboard,
  dialog,
  shell,
  state,
  deps
}) {
  const {
    SCREENSHOT_VIEWS,
    CACHE_DIR
  } = deps.constants;

  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeText', (_evt, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('mcp:status', () => deps.getMcpStatusPayload());

  /** Same data source as the MCP list_models tool, useful for UI validation. */
  ipcMain.handle('mcp:testListParts', () => deps.buildMcpContext().listParts());

  ipcMain.handle('dialog:chooseDirectory', async () => {
    const res = await dialog.showOpenDialog(state.mainWindow(), {
      title: 'Choose a parent directory for the new project',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('project:create', async (_evt, { parentDir, projectName, kernel }) => {
    if (!parentDir || !projectName) throw new Error('parentDir and projectName are required.');
    const k = deps.assertKernel(kernel);
    const projectPath = path.join(parentDir, projectName);
    if (fs.existsSync(projectPath)) throw new Error(`Project path already exists: ${projectPath}`);
    fs.mkdirSync(projectPath, { recursive: true });
    deps.initProjectLayout(projectPath, k);
    await deps.openProject(projectPath, { runImmediately: true });
    return projectPath;
  });

  ipcMain.handle('project:open', async (_evt, projectPath) => {
    if (!projectPath) {
      return deps.openProjectByDialog();
    }
    if (!fs.existsSync(projectPath)) throw new Error(`Path does not exist: ${projectPath}`);
    await deps.openProject(projectPath, { runImmediately: true });
    return projectPath;
  });

  ipcMain.handle('project:meta', () => {
    if (!state.currentProjectPath()) return null;
    const meta = deps.kernelMeta(state.currentKernel());
    return {
      path: state.currentProjectPath(),
      kernel: state.currentKernel(),
      kernelLabel: meta.label,
      sourceFile: meta.sourceFile,
      sourceFiles: Object.values(deps.sourceFileOptions(state.currentKernel())),
      previewFormat: meta.previewFormat,
      runner: meta.runner,
      kernels: deps.KERNELS.map((k) => ({ id: k, ...deps.kernelMeta(k) }))
    };
  });

  ipcMain.handle('project:rebuild', async () => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    if (state.activePart()) deps.scheduleBuild(state.activePart());
    return true;
  });

  ipcMain.handle('project:revealInFolder', async () => {
    if (!state.currentProjectPath()) return;
    shell.openPath(state.currentProjectPath());
  });

  ipcMain.handle('parts:list', async () => {
    if (!state.currentProjectPath()) return { parts: [], active: null };
    return { parts: deps.listParts(state.currentProjectPath()), active: state.activePart() };
  });

  ipcMain.handle('parts:select', async (_evt, name) => {
    if (!state.currentProjectPath()) return;
    await deps.selectPart(name);
    return state.activePart();
  });

  ipcMain.handle('parts:rebuild', async (_evt, name) => {
    const target = name || state.activePart();
    if (target) deps.scheduleBuild(target);
    return true;
  });

  ipcMain.handle('parts:reveal', async (_evt, name) => {
    if (!state.currentProjectPath() || !name) return;
    shell.openPath(deps.modelDir(state.currentProjectPath(), name));
  });

  ipcMain.handle('parts:export', async (_evt, { name, format }) => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const partName = String(name || state.activePart() || '').trim();
    if (!partName) throw new Error('Select a model first.');
    return deps.exportPartByRequest(partName, format);
  });

  ipcMain.handle('viewer:partLoaded', async (_evt, payload) => {
    if (!state.currentProjectPath() || !payload?.part) return;
    const { part, faceCount, bbox, faces, snapshotDataURL, snapshotDataURLs } = payload;
    state.partInfoCache().set(part, {
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
        fs.mkdirSync(path.join(state.currentProjectPath(), CACHE_DIR), { recursive: true });
        fs.writeFileSync(deps.partPng(state.currentProjectPath(), part, view), Buffer.from(m[1], 'base64'));
      } catch (e) {
        deps.sendLog(`Failed to write screenshot cache (${view}): ${e.message}`, 'warn');
      }
      if (view === 'iso') {
        try {
          fs.writeFileSync(deps.partPng(state.currentProjectPath(), part), Buffer.from(m[1], 'base64'));
        } catch (e) {
          deps.sendLog(`Failed to write screenshot cache (legacy iso): ${e.message}`, 'warn');
        }
      }
    }
    deps.resolvePartLoadedWaiters(part, {
      part,
      faceCount,
      capturedAt: Date.now()
    });
  });

  ipcMain.handle('python:status', async () => deps.getBuildRuntimeStatus());
}

module.exports = {
  registerIpcHandlers
};
