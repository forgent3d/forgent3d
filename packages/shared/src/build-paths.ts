import { assertKernel, kernelMeta, type CadKernel } from './kernel.js';

export const MODELS_DIR = 'models';
export const MODEL_PARAMS_FILE = 'params.json';
export const CACHE_DIR = '.cache';
export const PROJECT_META_DIR = '.aicad';
export const PROJECT_META_FILE = 'project.json';

export type ModelSourceKind = 'assembly' | 'part';

export type ResolvedModelSource = {
  kind: ModelSourceKind;
  fileName: string;
  /** Project-relative path with forward slashes */
  relPath: string;
};

export type ResolvedMotionSource = {
  kind: 'motion';
  fileName: string;
  /** Project-relative path with forward slashes */
  relPath: string;
};

function joinPosix(...segments: string[]): string {
  return segments.filter(Boolean).join('/').replace(/\/+/g, '/');
}

export function sourceExt(kernel: CadKernel): string {
  const ext = kernelMeta(kernel).sourceFile;
  const dot = ext.lastIndexOf('.');
  return dot >= 0 ? ext.slice(dot) : '';
}

export function modelSourceFilename(kernel: CadKernel, kind: 'part' | 'assembly' | 'asm'): string {
  if (kind === 'asm') return 'asm.xml';
  if (kind === 'assembly') return `assembly${sourceExt(kernel)}`;
  return `${kind}${sourceExt(kernel)}`;
}

export function modelDirRel(name: string): string {
  return joinPosix(MODELS_DIR, name);
}

export function modelParamsRel(name: string): string {
  return joinPosix(modelDirRel(name), MODEL_PARAMS_FILE);
}

export function modelPartDirRel(modelName: string, partName: string): string {
  return joinPosix(modelDirRel(modelName), 'parts', partName);
}

export function modelPartSourceRel(modelName: string, partName: string, kernel: CadKernel): string {
  return joinPosix(modelPartDirRel(modelName, partName), modelSourceFilename(kernel, 'part'));
}

export function partCacheRel(
  modelName: string,
  partName: string = modelName,
  kernel: CadKernel = 'build123d'
): string {
  return joinPosix(CACHE_DIR, `${modelName}__${partName}${kernelMeta(kernel).cacheExt}`);
}

export function modelCacheRel(
  name: string,
  source: ResolvedModelSource | null,
  kernel: CadKernel = 'build123d'
): string | null {
  if (!source) return null;
  return joinPosix(CACHE_DIR, `${name}${kernelMeta(kernel).cacheExt}`);
}

/** Pick the primary CAD model source file when multiple exist (assembly > flat part). */
export function resolveModelSourceRel(
  existingRelPaths: Iterable<string>,
  modelName: string,
  kernel: CadKernel
): ResolvedModelSource | null {
  const k = assertKernel(kernel);
  const dir = modelDirRel(modelName);
  const candidates: Array<{ kind: ModelSourceKind; fileName: string }> = [
    { kind: 'assembly', fileName: modelSourceFilename(k, 'assembly') },
    { kind: 'part', fileName: modelSourceFilename(k, 'part') }
  ];
  const set = new Set(existingRelPaths);
  for (const { kind, fileName } of candidates) {
    const relPath = joinPosix(dir, fileName);
    if (set.has(relPath)) return { kind, fileName, relPath };
  }
  return null;
}

/** Optional MJCF motion-preview source; never selected as the CAD export/build target. */
export function resolveMotionSourceRel(
  existingRelPaths: Iterable<string>,
  modelName: string
): ResolvedMotionSource | null {
  const relPath = joinPosix(modelDirRel(modelName), 'asm.xml');
  return new Set(existingRelPaths).has(relPath)
    ? { kind: 'motion', fileName: 'asm.xml', relPath }
    : null;
}

export function projectMetaRel(): string {
  return joinPosix(PROJECT_META_DIR, PROJECT_META_FILE);
}

/** Relative prefixes synced to R2 before a cloud rebuild. */
export const PROJECT_SYNC_PUSH_PREFIXES = [
  `${MODELS_DIR}/`,
  `${PROJECT_META_DIR}/`,
  `${CACHE_DIR}/`
] as const;

export function isProjectSyncPushPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..')) return false;
  return PROJECT_SYNC_PUSH_PREFIXES.some((prefix) => p.startsWith(prefix));
}
