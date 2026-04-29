'use strict';

const {
  KERNELS,
  isValidKernel,
  assertKernel,
  kernelMeta
} = require('./main.templates.kernel');

const {
  cursorMcpJson,
  claudeMcpJson,
  codexConfigToml,
  aicadProjectJson,
  modelSourceTemplate,
  modelParamsTemplate,
  modelReadmeTemplate,
  exportRunnerTemplate,
  exportRunnerFilename,
  sourceFileOptions
} = require('./main.templates.project');

const {
  getAgentSkills,
  agentsMdTemplate,
  claudeMdTemplate,
  copilotInstructionsTemplate
} = require('./main.templates.agents');

module.exports = {
  KERNELS,
  isValidKernel,
  assertKernel,
  kernelMeta,

  cursorMcpJson,
  claudeMcpJson,
  codexConfigToml,
  aicadProjectJson,

  modelSourceTemplate,
  modelParamsTemplate,
  modelReadmeTemplate,
  sourceFileOptions,
  getAgentSkills,
  agentsMdTemplate,
  claudeMdTemplate,
  copilotInstructionsTemplate,
  exportRunnerTemplate,
  exportRunnerFilename
};
