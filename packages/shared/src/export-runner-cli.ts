import type { BuildJob } from './build-types.js';

/** argv for export_runner / bundled aicad-export-runner (matches Electron main.rebuild). */
export function exportRunnerArgv(job: BuildJob): string[] {
  const args = [
    '--project',
    job.projectRoot,
    '--model',
    job.model,
    '--part-name',
    job.partName,
    '--output',
    job.outputPath
  ];
  if (job.sourceRelpath) args.push('--source', job.sourceRelpath);
  return args;
}
