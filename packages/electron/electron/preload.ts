// @ts-nocheck
export {};
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aicad', {
  dialogConfirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
  createProject: (parentDir, projectName, kernel) =>
    ipcRenderer.invoke('project:create', { parentDir, projectName, kernel }),
  openProject: (projectPath) => ipcRenderer.invoke('project:open', projectPath),
  projectMeta: () => ipcRenderer.invoke('project:meta'),
  rebuild: () => ipcRenderer.invoke('project:rebuild'),
  revealInFolder: () => ipcRenderer.invoke('project:revealInFolder'),

  listModels: () => ipcRenderer.invoke('models:list'),
  selectModel: (name) => ipcRenderer.invoke('models:select', name),
  createModel: (payloadOrName, description) => ipcRenderer.invoke(
    'models:create',
    typeof payloadOrName === 'object' && payloadOrName !== null
      ? payloadOrName
      : { name: payloadOrName, description }
  ),
  rebuildModel: (name) => ipcRenderer.invoke('models:rebuild', name),
  rebuildAllModels: () => ipcRenderer.invoke('models:rebuildAll'),
  revealModel: (name) => ipcRenderer.invoke('models:reveal', name),
  deleteModel: (name) => ipcRenderer.invoke('models:delete', name),
  exportModel: (name, format, opts = {}) => ipcRenderer.invoke('models:export', { name, format, ...opts }),
  ensureModelPartStl: (model, part) => ipcRenderer.invoke('models:partStl', { model, part }),
  getParams: (target) => ipcRenderer.invoke('params:get', target),
  saveParams: (target, text) => ipcRenderer.invoke('params:save', { target, text }),

  shareModel: (name, options) => ipcRenderer.invoke('models:share', { name, ...options }),
  getShareStatus: (name) => ipcRenderer.invoke('models:shareStatus', name),
  updateSharePublic: (name, isPublic) => ipcRenderer.invoke('models:sharePublic', { name, isPublic }),
  unshareModel: (name) => ipcRenderer.invoke('models:unshare', name),

  notifyPartLoaded: (payload) => ipcRenderer.invoke('viewer:partLoaded', payload),

  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpTestListParts: () => ipcRenderer.invoke('mcp:testListParts'),

  pythonStatus: () => ipcRenderer.invoke('python:status'),
  getLanguage: () => ipcRenderer.invoke('language:get'),
  setLanguage: (language) => ipcRenderer.invoke('language:set', language),

  terminalCreate: (agent, projectPath, cols, rows) =>
    ipcRenderer.invoke('terminal:create', { agent, projectPath, cols, rows }),
  terminalWrite: (termId, data) =>
    ipcRenderer.invoke('terminal:write', { termId, data }),
  terminalResize: (termId, cols, rows) =>
    ipcRenderer.invoke('terminal:resize', { termId, cols, rows }),
  terminalKill: (termId) =>
    ipcRenderer.invoke('terminal:kill', { termId }),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:hasImage'),

  agentOpenNext: (projectPath, baseUrl, openExternal = true) =>
    ipcRenderer.invoke('agent:openNext', { projectPath, baseUrl, openExternal }),
  agentBridgeInfo: () => ipcRenderer.invoke('agent:bridgeInfo'),

  onEvent: (handler) => {
    const listener = (_evt, msg) => handler(msg);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  }
});
