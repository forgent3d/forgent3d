// @ts-nocheck
export {};
'use strict';

const { dialog, app } = require('electron');

const defaultMessages = {
  updateReadyTitle: 'Update ready',
  updateReadyMessage: 'Forgent3D {version} is ready to install.',
  updateReadyDetail: 'Restart the app to apply the update. Otherwise it will install on next quit.',
  updateRestartNow: 'Restart now',
  updateLater: 'Later',
  updateNotAvailableTitle: 'No Updates',
  updateNotAvailableMessage: 'You are running the latest version ({version}).',
  updateAvailableTitle: 'Update Available',
  updateAvailableMessage: 'Forgent3D {version} is available. Downloading in the background…',
  updateDownloadingTitle: 'Downloading Update',
  updateDownloadingMessage: 'Forgent3D {version} is downloading ({percent}%).',
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
  status: 'idle', // 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  latestVersion: null,
  downloadPercent: 0,
  inFlightCheck: null,
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
    state.status = 'downloading';
    state.latestVersion = info?.version || state.latestVersion;
    state.downloadPercent = 0;
    log(`update available: ${info?.version}`);
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
  });
  autoUpdater.on('error', (err) => {
    state.status = 'error';
    log(`error: ${err?.message || err}`, 'error');
  });
  autoUpdater.on('update-downloaded', async (info) => {
    state.status = 'downloaded';
    state.latestVersion = info?.version || state.latestVersion;
    log(`update downloaded: ${info?.version}`);
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
  autoUpdater.autoDownload = true;
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

  // Mid-download — show progress instead of starting another check.
  if (state.status === 'downloading' && isNewer(state.latestVersion)) {
    await showInfo(
      m.updateDownloadingTitle,
      formatMessage(m.updateDownloadingMessage, {
        version: state.latestVersion,
        percent: state.downloadPercent,
      }),
    );
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

    state.latestVersion = remoteVersion;
    await showInfo(
      m.updateAvailableTitle,
      formatMessage(m.updateAvailableMessage, { version: remoteVersion }),
    );
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
