'use strict';

const KERNELS = ['build123d'];

const KERNEL_META = {
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

function isValidKernel(kernel) {
  return KERNELS.includes(kernel);
}

function assertKernel(kernel) {
  if (!isValidKernel(kernel)) {
    throw new Error(`Invalid CAD kernel: ${JSON.stringify(kernel)} (expected one of: ${KERNELS.join(' / ')})`);
  }
  return kernel;
}

function kernelMeta(kernel) {
  return KERNEL_META[assertKernel(kernel)];
}

function languageBundle(meta) {
  return meta.language === meta.label ? meta.label : `${meta.language} + ${meta.label}`;
}

module.exports = {
  KERNELS,
  isValidKernel,
  assertKernel,
  kernelMeta,
  languageBundle
};
