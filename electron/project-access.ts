// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function probeWritable(dir) {
  const probe = path.join(dir, `.forgent3d-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch {}
    return false;
  }
}

function grantWindowsFolderAccess(folderPath) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: true, mode: 'skipped' });
  }
  const user = String(process.env.USERNAME || '').trim();
  if (!user) return Promise.resolve({ ok: false, mode: 'no-user' });
  const domain = String(process.env.USERDOMAIN || '').trim();
  const principal = domain ? `${domain}\\${user}` : user;
  const grant = `${principal}:(OI)(CI)M`;
  return new Promise((resolve) => {
    execFile(
      'icacls',
      [folderPath, '/grant', grant, '/T', '/C'],
      { windowsHide: true },
      (error) => {
        if (error) resolve({ ok: false, mode: 'icacls-failed', error: error.message || String(error) });
        else resolve({ ok: true, mode: 'icacls-granted' });
      }
    );
  });
}

/**
 * Ensure the current Windows user can create/update/delete files under the project
 * without repeated elevation prompts. No-op when already writable.
 */
async function ensureProjectDirectoryAccess(projectPath, { sendLog } = {}) {
  const resolved = path.resolve(String(projectPath || ''));
  if (!resolved) return { ok: false, mode: 'empty-path' };
  if (probeWritable(resolved)) return { ok: true, mode: 'already-writable' };

  if (process.platform !== 'win32') {
    sendLog?.(`Project folder is not writable: ${resolved}`, 'warn');
    return { ok: false, mode: 'not-writable' };
  }

  const grant = await grantWindowsFolderAccess(resolved);
  if (grant.ok && probeWritable(resolved)) {
    sendLog?.(`Granted write access to project folder for ${process.env.USERNAME || 'current user'}.`, 'info');
    return { ok: true, mode: 'granted' };
  }

  sendLog?.(
    'Cannot write to the project folder. Move the project to a user folder (e.g. Documents) or run Forgent3D once as administrator to fix permissions.',
  'warn'
  );
  return { ok: false, mode: 'denied', grant };
}

module.exports = {
  probeWritable,
  ensureProjectDirectoryAccess
};
