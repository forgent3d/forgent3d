import { createHash } from 'crypto';

/** Normalize a host project path into a stable R2 namespace key. */
export function normalizeProjectPath(projectPath: string): string {
  return String(projectPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function projectKeyFromPath(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) throw new Error('projectPath is required.');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function r2ProjectPrefix(userId: string, projectPath: string): string {
  const key = projectKeyFromPath(projectPath);
  const safeUser = String(userId || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'user';
  return `projects/${safeUser}/${key}/`;
}

export function r2ProjectFileKey(userId: string, projectPath: string, relPath: string): string {
  const prefix = r2ProjectPrefix(userId, projectPath);
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) throw new Error(`Invalid project-relative path: ${relPath}`);
  return `${prefix}files/${rel}`;
}
