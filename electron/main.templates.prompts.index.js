'use strict';

const { assertKernel } = require('./main.templates.kernel');
const build123d = require('./main.templates.prompts.build123d');

function kernelPromptBundle(kernel) {
  assertKernel(kernel);
  return build123d;
}

module.exports = {
  kernelPromptBundle,
  kernelProjectPromptBundle: kernelPromptBundle
};
