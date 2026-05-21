import type { CadKernel } from './kernel.js';

export type BuildJob = {
  projectRoot: string;
  kernel: CadKernel;
  model: string;
  partName: string;
  /** Absolute path inside the sandbox or local filesystem */
  outputPath: string;
  /** Project-relative source override (export_runner --source) */
  sourceRelpath?: string;
};

export type BuildResult = {
  ok: boolean;
  model: string;
  partName: string;
  kernel?: CadKernel;
  cacheFile?: string | null;
  cacheSize?: number;
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
};

export type SyncFileEntry = {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
};

export type ProjectSyncPushRequest = {
  projectPath: string;
  files: SyncFileEntry[];
};

export type ProjectSyncPullRequest = {
  projectPath: string;
  /** Optional path prefix filter (e.g. ".cache/") */
  prefix?: string;
};
