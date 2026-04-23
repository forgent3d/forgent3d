'use strict';

const build123d = require('./main.templates.prompts.build123d');
const cadquery = require('./main.templates.prompts.cadquery');

const PROMPT_BUNDLES = {
  build123d,
  cadquery
};

function kernelPromptBundle(kernel) {
  const bundle = PROMPT_BUNDLES[kernel];
  if (!bundle) {
    throw new Error(`Missing prompt bundle for kernel: ${JSON.stringify(kernel)}`);
  }
  return bundle;
}

module.exports = {
  kernelPromptBundle,
  kernelProjectPromptBundle: kernelPromptBundle
};
