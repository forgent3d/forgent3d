// @ts-nocheck
export {};
'use strict';

const { dialog, app } = require('electron');

/**
 * Wire electron-updater. Safe to call once after app.whenReady().
 *  - In dev (not packaged) the updater is a no-op.
 *  - On unsupported macOS builds (ad-hoc signed / missing Developer ID) Squirrel.Mac
 *    will reject updates; we swallow that error and log instead of crashing.
 */
function initAutoUpdater({ sendLog } = {}) {
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

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const log = (msg, level = 'info') => sendLog?.(`[updater] ${msg}`, level);

  autoUpdater.logger = {
    info: (m) => log(String(m)),
    warn: (m) => log(String(m), 'warn'),
    error: (m) => log(String(m), 'error'),
    debug: (m) => log(String(m)),
  };

  autoUpdater.on('checking-for-update', () => log('checking for updates'));
  autoUpdater.on('update-available', (info) => log(`update available: ${info?.version}`));
  autoUpdater.on('update-not-available', () => log('no update available'));
  autoUpdater.on('download-progress', (p) => log(`downloading ${Math.round(p.percent)}%`));
  autoUpdater.on('error', (err) => log(`error: ${err?.message || err}`, 'error'));

  autoUpdater.on('update-downloaded', async (info) => {
    log(`update downloaded: ${info?.version}`);
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Forgent3D ${info?.version} is ready to install.`,
      detail: 'Restart the app to apply the update. Otherwise it will install on next quit.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch((err) => log(`initial check failed: ${err?.message || err}`, 'warn'));

  // Re-check every 6h while the app is open.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();
}

module.exports = { initAutoUpdater };
