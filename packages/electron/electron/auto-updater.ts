// @ts-nocheck
export {};
'use strict';

const { dialog, app, BrowserWindow } = require('electron');

const defaultMessages = {
  updateReadyTitle: 'Update ready',
  updateReadyMessage: 'Forgent3D {version} is ready to install.',
  updateReadyDetail: 'Restart the app to apply the update. Otherwise it will install on next quit.',
  updateRestartNow: 'Restart now',
  updateLater: 'Later',
  updateNotAvailableTitle: 'No Updates',
  updateNotAvailableMessage: 'You are running the latest version ({version}).',
  updateAvailableTitle: 'Update Available',
  updateAvailablePromptMessage: 'Forgent3D {version} is available. Download now?',
  updateAvailablePromptDetail: 'The update installs on next quit, or you can restart immediately when the download finishes.',
  updateDownloadNow: 'Download',
  updateDownloadingTitle: 'Downloading Update',
  updateDownloadingLabel: 'Downloading Forgent3D {version}…',
  updateCheckFailedTitle: 'Update Check Failed',
  updateDevUnavailableTitle: 'Updates Unavailable',
  updateDevUnavailableMessage: 'Automatic updates are only available in the installed app.',
  updateUnavailableTitle: 'Updates Unavailable',
  updateUnavailableMessage: 'The update service is not available in this build.',
};

let autoUpdaterInstance = null;
let sendLogFn = null;
let getMessagesFn = () => defaultMessages;
let getParentWindowFn = () => null;

const state = {
  status: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  latestVersion: null,
  downloadPercent: 0,
  inFlightCheck: null,
  progressWindow: null,
  promptInFlight: false,
};

function semverGt(a, b) {
  try {
    return require('semver').gt(a, b);
  } catch {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] || 0;
      const db = pb[i] || 0;
      if (da !== db) return da > db;
    }
    return false;
  }
}

function isNewer(remoteVersion) {
  if (!remoteVersion) return false;
  return semverGt(remoteVersion, app.getVersion());
}

function formatMessage(template, replacements = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_match, name) => replacements[name] ?? '');
}

function messages() {
  return { ...defaultMessages, ...(getMessagesFn?.() || {}) };
}

function parentWindow() {
  const win = getParentWindowFn?.();
  return win && !win.isDestroyed?.() ? win : null;
}

function log(msg, level = 'info') {
  sendLogFn?.(`[updater] ${msg}`, level);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function progressHtml(labelText) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 18px 20px; color: #1f1f1f; background: #f6f6f7; -webkit-user-select: none; user-select: none; }
    .label { font-size: 13px; margin-bottom: 12px; line-height: 1.3; }
    .bar { width: 100%; height: 8px; background: #dcdcdc; border-radius: 4px; overflow: hidden; }
    .fill { height: 100%; background: #2e7df5; width: 0%; transition: width .15s linear; }
    .pct { font-size: 12px; color: #555; margin-top: 8px; text-align: right; font-variant-numeric: tabular-nums; }
    @media (prefers-color-scheme: dark) {
      body { background: #1f1f22; color: #ececec; }
      .bar { background: #3a3a3d; }
      .pct { color: #b0b0b3; }
    }
  </style></head><body>
    <div class="label">${escapeHtml(labelText)}</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="pct" id="pct">0%</div>
  </body></html>`;
}

function openProgressWindow(version) {
  if (state.progressWindow && !state.progressWindow.isDestroyed()) {
    state.progressWindow.show();
    state.progressWindow.focus();
    return;
  }
  const m = messages();
  const parent = parentWindow();
  const win = new BrowserWindow({
    width: 360,
    height: 130,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent: parent || undefined,
    modal: false,
    alwaysOnTop: false,
    show: false,
    title: m.updateDownloadingTitle,
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  const labelText = formatMessage(m.updateDownloadingLabel, { version: version || state.latestVersion || '' });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(progressHtml(labelText)));
  win.once('ready-to-show', () => {
    win.show();
    updateProgressWindow(state.downloadPercent);
  });
  win.on('closed', () => {
    if (state.progressWindow === win) state.progressWindow = null;
  });
  state.progressWindow = win;
}

function updateProgressWindow(percent) {
  const win = state.progressWindow;
  if (!win || win.isDestroyed()) return;
  const safePct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  win.webContents
    .executeJavaScript(
      `(function(){var f=document.getElementById('fill');var p=document.getElementById('pct');` +
      `if(f)f.style.width='${safePct}%';if(p)p.textContent='${safePct}%';})();`,
      true,
    )
    .catch(() => {});
}

function closeProgressWindow() {
  const win = state.progressWindow;
  state.progressWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

async function promptDownload(version) {
  if (state.promptInFlight) return;
  if (state.status === 'downloading' || state.status === 'downloaded') return;
  if (!autoUpdaterInstance) return;
  state.promptInFlight = true;
  try {
    const m = messages();
    const { response } = await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      buttons: [m.updateDownloadNow, m.updateLater],
      defaultId: 0,
      cancelId: 1,
      title: m.updateAvailableTitle,
      message: formatMessage(m.updateAvailablePromptMessage, { version: version || state.latestVersion || '' }),
      detail: m.updateAvailablePromptDetail,
    });
    if (response !== 0) return;
    state.status = 'downloading';
    state.downloadPercent = 0;
    openProgressWindow(version);
    try {
      await autoUpdaterInstance.downloadUpdate();
    } catch (err) {
      log(`download failed: ${err?.message || err}`, 'error');
      closeProgressWindow();
      state.status = 'error';
    }
  } finally {
    state.promptInFlight = false;
  }
}

async function promptRestart(version) {
  const m = messages();
  const { response } = await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    buttons: [m.updateRestartNow, m.updateLater],
    defaultId: 0,
    cancelId: 1,
    title: m.updateReadyTitle,
    message: formatMessage(m.updateReadyMessage, { version: version || state.latestVersion || '' }),
    detail: m.updateReadyDetail,
  });
  if (response === 0) autoUpdaterInstance?.quitAndInstall();
}

function wireAutoUpdaterEvents(autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    state.status = 'checking';
    log('checking for updates');
  });
  autoUpdater.on('update-available', (info) => {
    state.status = 'available';
    state.latestVersion = info?.version || state.latestVersion;
    state.downloadPercent = 0;
    log(`update available: ${info?.version}`);
    void promptDownload(state.latestVersion);
  });
  autoUpdater.on('update-not-available', (info) => {
    state.status = 'not-available';
    state.latestVersion = info?.version || state.latestVersion;
    log('no update available');
  });
  autoUpdater.on('download-progress', (p) => {
    state.status = 'downloading';
    state.downloadPercent = Math.round(p?.percent || 0);
    log(`downloading ${state.downloadPercent}%`);
    updateProgressWindow(state.downloadPercent);
  });
  autoUpdater.on('error', (err) => {
    state.status = 'error';
    log(`error: ${err?.message || err}`, 'error');
    closeProgressWindow();
  });
  autoUpdater.on('update-downloaded', async (info) => {
    state.status = 'downloaded';
    state.latestVersion = info?.version || state.latestVersion;
    state.downloadPercent = 100;
    log(`update downloaded: ${info?.version}`);
    updateProgressWindow(100);
    closeProgressWindow();
    await promptRestart(info?.version);
  });
}

function initAutoUpdater({ sendLog, getMessages, getParentWindow } = {}) {
  sendLogFn = sendLog;
  if (typeof getMessages === 'function') getMessagesFn = getMessages;
  if (typeof getParentWindow === 'function') getParentWindowFn = getParentWindow;

  if (!app.isPackaged) {
    sendLog?.('[updater] skipped: app is not packaged');
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    sendLog?.(`[updater] electron-updater not installed: ${err.message}`, 'error');
    return;
  }

  autoUpdaterInstance = autoUpdater;
  // Require explicit user agreement before pulling the installer.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.logger = {
    info: (m) => log(String(m)),
    warn: (m) => log(String(m), 'warn'),
    error: (m) => log(String(m), 'error'),
    debug: (m) => log(String(m)),
  };

  wireAutoUpdaterEvents(autoUpdater);

  autoUpdater.checkForUpdates().catch((err) => log(`initial check failed: ${err?.message || err}`, 'warn'));

  setInterval(() => {
    if (state.status === 'downloading' || state.status === 'downloaded') return;
    autoUpdater.checkForUpdates().catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();
}

async function showInfo(title, message) {
  await dialog.showMessageBox(parentWindow(), { type: 'info', title, message });
}

async function checkForUpdatesFromMenu() {
  const m = messages();

  if (!app.isPackaged) {
    await showInfo(m.updateDevUnavailableTitle, m.updateDevUnavailableMessage);
    return;
  }

  if (!autoUpdaterInstance) {
    await dialog.showMessageBox(parentWindow(), {
      type: 'warning',
      title: m.updateUnavailableTitle,
      message: m.updateUnavailableMessage,
    });
    return;
  }

  // Already downloaded — go straight to the restart prompt.
  if (state.status === 'downloaded' && isNewer(state.latestVersion)) {
    await promptRestart(state.latestVersion);
    return;
  }

  // Mid-download — reopen the progress window if it was closed.
  if (state.status === 'downloading' && isNewer(state.latestVersion)) {
    openProgressWindow(state.latestVersion);
    updateProgressWindow(state.downloadPercent);
    return;
  }

  // User previously declined — re-prompt without re-fetching the manifest.
  if (state.status === 'available' && isNewer(state.latestVersion)) {
    await promptDownload(state.latestVersion);
    return;
  }

  try {
    const checkPromise = state.inFlightCheck || autoUpdaterInstance.checkForUpdates();
    state.inFlightCheck = checkPromise;
    let result;
    try {
      result = await checkPromise;
    } finally {
      state.inFlightCheck = null;
    }

    const remoteVersion = result?.updateInfo?.version;

    if (!isNewer(remoteVersion)) {
      await showInfo(
        m.updateNotAvailableTitle,
        formatMessage(m.updateNotAvailableMessage, { version: app.getVersion() }),
      );
      return;
    }

    // update-available event handler already showed the download prompt.
    state.latestVersion = remoteVersion;
  } catch (err) {
    log(`manual check failed: ${err?.message || err}`, 'warn');
    await dialog.showMessageBox(parentWindow(), {
      type: 'error',
      title: m.updateCheckFailedTitle,
      message: err?.message || String(err),
    });
  }
}

module.exports = { initAutoUpdater, checkForUpdatesFromMenu };
