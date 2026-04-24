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
  modelReadmeTemplate,
  exportRunnerTemplate,
  exportRunnerFilename,
  sourceFileOptions
} = require('./main.templates.project');

const {
  CURSOR_PROJECT_RULE_FILE,
  cursorRulesTemplate,
  agentsMdTemplate,
  claudeMdTemplate,
  geminiMdTemplate,
  copilotInstructionsTemplate
} = require('./main.templates.rules');

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
  modelReadmeTemplate,
  sourceFileOptions,
  CURSOR_PROJECT_RULE_FILE,
  cursorRulesTemplate,
  agentsMdTemplate,
  claudeMdTemplate,
  geminiMdTemplate,
  copilotInstructionsTemplate,
  exportRunnerTemplate,
  exportRunnerFilename
};
