export const KERNELS = ['build123d'] as const;

export type CadKernel = (typeof KERNELS)[number];

export type KernelMeta = {
  label: string;
  language: string;
  sourceFile: string;
  sourceLang: string;
  previewFormat: string;
  cacheExt: string;
  runner: string;
  blurb: string;
};

const KERNEL_META: Record<CadKernel, KernelMeta> = {
  build123d: {
    label: 'build123d',
    language: 'Python',
    sourceFile: 'part.py',
    sourceLang: 'python',
    previewFormat: 'BREP',
    cacheExt: '.brep',
    runner: 'python',
    blurb: 'Modern Python CAD DSL on OCCT with precise B-Rep geometry support.'
  }
};

export function isValidKernel(kernel: string): kernel is CadKernel {
  return (KERNELS as readonly string[]).includes(kernel);
}

export function assertKernel(kernel: string): CadKernel {
  if (!isValidKernel(kernel)) {
    throw new Error(`Invalid CAD kernel: ${JSON.stringify(kernel)} (expected one of: ${KERNELS.join(' / ')})`);
  }
  return kernel;
}

export function kernelMeta(kernel: string): KernelMeta {
  return KERNEL_META[assertKernel(kernel)];
}

export function languageBundle(meta: KernelMeta): string {
  return meta.language === meta.label ? meta.label : `${meta.language} + ${meta.label}`;
}
