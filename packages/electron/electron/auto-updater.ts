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

async function showUpdateReadyDialog(info) {
  const m = messages();
  const version = info?.version || '';
  const { response } = await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    buttons: [m.updateRestartNow, m.updateLater],
    defaultId: 0,
    cancelId: 1,
    title: m.updateReadyTitle,
    message: formatMessage(m.updateReadyMessage, { version }),
    detail: m.updateReadyDetail,
  });
  if (response === 0) autoUpdaterInstance?.quitAndInstall();
}

function wireAutoUpdaterEvents(autoUpdater) {
  autoUpdater.on('checking-for-update', () => log('checking for updates'));
  autoUpdater.on('update-available', (info) => log(`update available: ${info?.version}`));
  autoUpdater.on('update-not-available', () => log('no update available'));
  autoUpdater.on('download-progress', (p) => log(`downloading ${Math.round(p.percent)}%`));
  autoUpdater.on('error', (err) => log(`error: ${err?.message || err}`, 'error'));

  autoUpdater.on('update-downloaded', async (info) => {
    log(`update downloaded: ${info?.version}`);
    await showUpdateReadyDialog(info);
  });
}

/**
 * Wire electron-updater. Safe to call once after app.whenReady().
 *  - In dev (not packaged) the updater is a no-op.
 *  - On unsupported macOS builds (ad-hoc signed / missing Developer ID) Squirrel.Mac
 *    will reject updates; we swallow that error and log instead of crashing.
 */
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

  // Re-check every 6h while the app is open.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();
}

async function checkForUpdatesFromMenu() {
  const m = messages();

  if (!app.isPackaged) {
    await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      title: m.updateDevUnavailableTitle,
      message: m.updateDevUnavailableMessage,
    });
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

  try {
    const result = await autoUpdaterInstance.checkForUpdates();
    if (!result?.updateInfo) {
      await dialog.showMessageBox(parentWindow(), {
        type: 'info',
        title: m.updateNotAvailableTitle,
        message: formatMessage(m.updateNotAvailableMessage, { version: app.getVersion() }),
      });
      return;
    }

    await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      title: m.updateAvailableTitle,
      message: formatMessage(m.updateAvailableMessage, { version: result.updateInfo.version }),
    });

    if (result.downloadPromise) {
      await result.downloadPromise;
    }
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
