// @ts-nocheck

export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'];
export const DEFAULT_LANGUAGE = 'en';

let currentLanguage = DEFAULT_LANGUAGE;
const listeners = new Set();

const messages = {
  en: {
    appTitle: 'Forgent3D Companion Previewer',
    collapseLeftPanel: 'Collapse left panel',
    expandLeftPanel: 'Expand left panel',
    models: 'Models',
    params: 'Params',
    export: 'Export',
    revert: 'Revert',
    selectExportFormat: 'Select export format',
    expandModelParts: 'Expand model parts',
    collapseModelParts: 'Collapse model parts',
    numericParamsEditor: 'Numeric params editor',
    selectModelParams: 'Select a model to edit params.json',
    solid: 'Solid',
    xray: 'X-Ray',
    wire: 'Wire',
    viewControls: 'View controls',
    showcase: 'Showcase',
    explode: 'Explode',
    explodeDistance: 'Explode distance',
    waitingForProject: 'Waiting for project...',
    createProject: 'Create Project',
    openProject: 'Open Project',
    buildLogs: 'Build Logs',
    clear: 'Clear',
    pythonExportOutput: 'Python / export output',
    terminal: 'Terminal',
    closePanel: 'Close panel',
    codeAgent: 'Code Agent',
    nextAgent: 'Forgent3D',
    newModel: 'New Model',
    newModelHelp: 'This creates models/&lt;name&gt;/asm.xml, params.json, and a local parts/&lt;name&gt;/part.py. Name can only contain letters, numbers, underscores, and hyphens.',
    modelType: 'Model type',
    modelName: 'Model name',
    modelNamePlaceholder: 'bracket',
    modelDescription: 'One-line description (optional, written to README.md)',
    modelDescriptionPlaceholder: 'Mounting bracket for XX',
    partKind: 'Part (part.py)',
    assemblyKind: 'Assembly (asm.xml)',
    cancel: 'Cancel',
    create: 'Create',
    newProject: 'New Project',
    projectName: 'Project name',
    parentDirectory: 'Parent directory',
    pickParentPlaceholder: 'Click button on the right to select...',
    browse: 'Browse...',
    currentModel: 'Current model: {name}',
    noModels: 'No models yet. Click + in the top-right to create one',
    assemblySuffix: '{name} (assembly)',
    openInFileExplorer: 'Open in file explorer',
    rebuildModelTitle: 'Rebuild this model package and refresh local part meshes',
    rebuildAllTitle: 'Force rebuild all models (no cache)',
    rebuildAllStarted: 'Rebuilding all models...',
    rebuildAllDone: 'Rebuild complete',
    rebuildAllFailed: 'Rebuild failed: {message}',
    partBuilt: '{part} built',
    selectModelFirst: 'Please select a model on the left first',
    exported: 'Exported <code>{name}</code> · <code>{format}</code>',
    exportFailed: 'Export failed: {message}',
    modelCreationDisabled: 'Model creation from UI is disabled',
    creatingProject: 'Creating project...',
    projectCreated: 'Project created (kernel: {kernel}): {path}',
    creationFailed: 'Creation failed',
    creationFailedDetail: 'Creation failed: {message}',
    openProjectFailed: 'Open project failed: {message}',
    terminalLaunchingNotice: 'If the terminal stays blank, install/enable <code>{agent}</code> in your shell and try again.',
    terminalTitle: 'Terminal - {agent}',
    launchingTerminal: 'Launching {agent} · {project}',
    launchFailed: 'Failed to launch {agent}: {message}',
    previousTerminalReplaced: 'Previous terminal replaced with <code>{agent}</code>',
    nextAgentOpened: 'Opened Forgent3D: {url}',
    nextAgentOpenedToast: 'Opened Forgent3D for current project',
    nextAgentOpenFailed: 'Failed to open Forgent3D: {message}',
    projectOpenedStatus: 'Project opened ({kernel}), waiting for first build...',
    projectOpenedLog: 'Project opened: {path}',
    kernelInfo: 'Kernel: {kernel} · Source file: {sourceFile} · Preview format: {previewFormat}',
    failedReadModels: 'Failed to read models list: {message}',
    buildingPart: 'Building {part} ...',
    building: 'Building...',
    buildFailedSeeLogs: 'Build failed (see logs)',
    buildFailed: 'Build failed',
    noRuntime: 'No usable build runtime detected.',
    loadingMjcf: 'Loading MJCF',
    parsingStl: 'Parsing STL',
    parsingBrep: 'OCCT parsing BREP',
    missingModelUrl: 'Main process did not return a URL, skipping load',
    modelReady: '{partLabel}Model ready{sizeLabel} · {tail}',
    mjcfAssembly: 'MJCF assembly',
    stlMesh: 'STL mesh',
    brepFaces: '{count} BREP faces',
    failedReportPartInfo: 'Failed to report part info: {message}',
    modelLoadFailed: 'Model load failed',
    failedLoadModel: '{partLabel}Failed to load {format}: {message}',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    debugTools: 'Debug Tools',
    developerTools: 'Developer Tools',
    reload: 'Reload',
    toggleExplodedView: 'Toggle exploded view',
    explodeNeedsParts: 'Explode needs multiple visible parts',
    autoShowNeedsModel: 'Auto Showcase needs a loaded model.',
    explodeNeedsLoadedParts: 'Exploded View needs a loaded model with multiple visible parts.',
    noNumericParams: 'No numeric model params',
    updatingParams: 'Updating {model}/params.json ...',
    editingParams: 'Editing {model}/params.json',
    loadingParams: 'Loading {model}/params.json ...',
    paramsWillBeCreated: 'params.json will be created for {model}',
    revertingParams: 'Reverting {model}/params.json ...',
    savingParams: 'Saving {model}/params.json ...',
    savedParamsRebuilding: 'Saved {model}/params.json; rebuilding model',
    nextAgentPanelTitle: 'Forgent3D',
    nextAgentLoading: 'Loading Forgent3D…',
  },
  'zh-CN': {
    appTitle: 'Forgent3D Companion Previewer',
    collapseLeftPanel: 'Collapse left panel',
    expandLeftPanel: 'Expand left panel',
    models: 'Models',
    params: 'Params',
    export: 'Export',
    revert: 'Revert',
    selectExportFormat: 'Select export format',
    expandModelParts: 'Expand model parts',
    collapseModelParts: 'Collapse model parts',
    numericParamsEditor: 'Numeric params editor',
    selectModelParams: 'Select a model to edit params.json',
    solid: 'Solid',
    xray: 'X-Ray',
    wire: 'Wire',
    viewControls: 'View controls',
    showcase: 'Showcase',
    explode: 'Explode',
    explodeDistance: 'Explode distance',
    waitingForProject: 'Waiting for project...',
    createProject: 'Create Project',
    openProject: 'Open Project',
    buildLogs: 'Build Logs',
    clear: 'Clear',
    pythonExportOutput: 'Python / export output',
    terminal: 'Terminal',
    closePanel: 'Close panel',
    codeAgent: 'Code Agent',
    nextAgent: 'Forgent3D',
    newModel: 'New Model',
    newModelHelp: 'This creates models/&lt;name&gt;/asm.xml, params.json, and a local parts/&lt;name&gt;/part.py. Name can only contain letters, numbers, underscores, and hyphens.',
    modelType: 'Model type',
    modelName: 'Model name',
    modelNamePlaceholder: 'bracket',
    modelDescription: 'One-line description (optional, written to README.md)',
    modelDescriptionPlaceholder: 'Mounting bracket for XX',
    partKind: 'Part (part.py)',
    assemblyKind: 'Assembly (asm.xml)',
    cancel: 'Cancel',
    create: 'Create',
    newProject: 'New Project',
    projectName: 'Project name',
    parentDirectory: 'Parent directory',
    pickParentPlaceholder: 'Click button on the right to select...',
    browse: 'Browse...',
    currentModel: 'Current model: {name}',
    noModels: 'No models yet. Click + in the top-right to create one',
    assemblySuffix: '{name} (assembly)',
    openInFileExplorer: 'Open in file explorer',
    rebuildModelTitle: 'Rebuild this model package and refresh local part meshes',
    rebuildAllTitle: '强制重建所有模型（不使用缓存）',
    rebuildAllStarted: '正在重建所有模型...',
    rebuildAllDone: '重建完成',
    rebuildAllFailed: '重建失败：{message}',
    partBuilt: '{part} 已构建',
    selectModelFirst: 'Please select a model on the left first',
    exported: 'Exported <code>{name}</code> as <code>{format}</code>',
    exportFailed: 'Export failed: {message}',
    modelCreationDisabled: 'Model creation from UI is disabled',
    creatingProject: 'Creating project...',
    projectCreated: 'Project created (kernel: {kernel}): {path}',
    creationFailed: 'Creation failed',
    creationFailedDetail: 'Creation failed: {message}',
    openProjectFailed: 'Open project failed: {message}',
    terminalLaunchingNotice: 'If the terminal stays blank, install/enable <code>{agent}</code> in your shell and try again.',
    terminalTitle: 'Terminal - {agent}',
    launchingTerminal: 'Launching {agent} at {project}',
    launchFailed: 'Failed to launch {agent}: {message}',
    previousTerminalReplaced: 'Previous terminal replaced with <code>{agent}</code>',
    nextAgentOpened: '已打开 Forgent3D：{url}',
    nextAgentOpenedToast: '已用当前项目打开 Forgent3D',
    nextAgentOpenFailed: '打开 Forgent3D 失败：{message}',
    projectOpenedStatus: 'Project opened ({kernel}), waiting for first build...',
    projectOpenedLog: 'Project opened: {path}',
    kernelInfo: 'Kernel: {kernel} | Source file: {sourceFile} | Preview format: {previewFormat}',
    failedReadModels: 'Failed to read models list: {message}',
    buildingPart: 'Building {part} ...',
    building: 'Building...',
    buildFailedSeeLogs: 'Build failed (see logs)',
    buildFailed: 'Build failed',
    noRuntime: 'No usable build runtime detected.',
    loadingMjcf: 'Loading MJCF',
    parsingStl: 'Parsing STL',
    parsingBrep: 'OCCT parsing BREP',
    missingModelUrl: 'Main process did not return a URL, skipping load',
    modelReady: '{partLabel}Model ready{sizeLabel} | {tail}',
    mjcfAssembly: 'MJCF assembly',
    stlMesh: 'STL mesh',
    brepFaces: '{count} BREP faces',
    failedReportPartInfo: 'Failed to report part info: {message}',
    modelLoadFailed: 'Model load failed',
    failedLoadModel: '{partLabel}Failed to load {format}: {message}',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    debugTools: 'Debug Tools',
    developerTools: 'Developer Tools',
    reload: 'Reload',
    toggleExplodedView: 'Toggle exploded view',
    explodeNeedsParts: 'Explode needs multiple visible parts',
    autoShowNeedsModel: 'Auto Showcase needs a loaded model.',
    explodeNeedsLoadedParts: 'Exploded View needs a loaded model with multiple visible parts.',
    noNumericParams: 'No numeric model params',
    updatingParams: 'Updating {model}/params.json ...',
    editingParams: 'Editing {model}/params.json',
    loadingParams: 'Loading {model}/params.json ...',
    paramsWillBeCreated: 'params.json will be created for {model}',
    revertingParams: 'Reverting {model}/params.json ...',
    savingParams: 'Saving {model}/params.json ...',
    savedParamsRebuilding: 'Saved {model}/params.json; rebuilding model',
    nextAgentPanelTitle: 'Forgent3D',
    nextAgentLoading: '正在加载 Forgent3D…',
  }
};

export function normalizeLanguage(language) {
  const value = String(language || '').trim();
  return SUPPORTED_LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE;
}

export function getLanguage() {
  return currentLanguage;
}

export function setLanguage(language) {
  const next = normalizeLanguage(language);
  if (next === currentLanguage) return;
  currentLanguage = next;
  document.documentElement.lang = next === 'zh-CN' ? 'zh-CN' : 'en';
  applyDocumentI18n();
  listeners.forEach((listener) => listener(next));
}

export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function t(key, vars = {}) {
  const table = messages[currentLanguage] || messages[DEFAULT_LANGUAGE];
  const fallback = messages[DEFAULT_LANGUAGE] || {};
  const template = table[key] ?? fallback[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export function applyDocumentI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((node) => {
    node.innerHTML = t(node.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  });
  document.title = t('appTitle');
}

export async function initRendererI18n(api) {
  applyDocumentI18n();
  try {
    const language = await api.getLanguage?.();
    setLanguage(language || DEFAULT_LANGUAGE);
  } catch {
    setLanguage(DEFAULT_LANGUAGE);
  }
}
