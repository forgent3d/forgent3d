// @ts-nocheck
export {};
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_ORIGINS = new Set([
  'https://agent.forgent3d.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);

function isAllowedOrigin() {
  try {
    return ALLOWED_ORIGINS.has(window.location.origin);
  } catch {
    return false;
  }
}

function bridgeDebug(message, detail) {
  const prefix = '[agent-bridge:preload]';
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

if (isAllowedOrigin()) {
  bridgeDebug('exposing bridge', { origin: window.location.origin });
  contextBridge.exposeInMainWorld('forgent3dBridge', {
    platform: 'forgent3d-desktop',
    capabilities: {
      desktop: true,
      tools: true,
      desktopPython: true
    },
    getEnvironment: async () => {
      const startedAt = Date.now();
      bridgeDebug('getEnvironment -> ipc invoke');
      const info = await ipcRenderer.invoke('agent:bridgeInfo');
      bridgeDebug('getEnvironment <- ipc result', {
        elapsedMs: Date.now() - startedAt,
        projectPath: info?.projectPath || '',
        language: info?.language || 'en',
        hasTools: !!info?.capabilities?.tools
      });
      return {
        version: info?.version || '0.0.0',
        platform: 'forgent3d-desktop',
        projectPath: info?.projectPath || '',
        language: info?.language || 'en',
        capabilities: {
          desktop: true,
          tools: true,
          desktopPython: true,
          ...(info?.capabilities || {})
        }
      };
    },
    callTool: async (name, args) => {
      const callId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      bridgeDebug('callTool -> ipc invoke', {
        callId,
        name,
        argKeys: args && typeof args === 'object' ? Object.keys(args || {}) : [],
        argType: typeof args
      });
      try {
        const result = await ipcRenderer.invoke('agent:callTool', { name, args: args || {}, callId });
        bridgeDebug('callTool <- ipc result', {
          callId,
          name,
          elapsedMs: Date.now() - startedAt,
          isError: !!result?.isError,
          contentTypes: Array.isArray(result?.content) ? result.content.map((item) => item?.type) : []
        });
        return result;
      } catch (e) {
        bridgeDebug('callTool <- ipc error', {
          callId,
          name,
          elapsedMs: Date.now() - startedAt,
          error: e?.message || String(e)
        });
        throw e;
      }
    }
  });
} else {
  bridgeDebug('origin not allowed; bridge not exposed', {
    origin: (() => {
      try { return window.location.origin; } catch { return ''; }
    })()
  });
}
