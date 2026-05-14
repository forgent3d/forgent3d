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
    nextAgentOpenedExternal: 'Opened Forgent3D desktop login in external browser: {url}',
    nextAgentOpenedExternalToast: 'Opened external browser for Forgent3D login',
    nextAgentDesktopAuthReceived: 'Received Forgent3D login callback; opening embedded agent',
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
    noNumericParams: 'No numeric params',
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
    appTitle: 'Forgent3D 伴侣预览器',
    collapseLeftPanel: '折叠左侧面板',
    expandLeftPanel: '展开左侧面板',
    models: '模型',
    params: '参数',
    export: '导出',
    revert: '还原',
    selectExportFormat: '选择导出格式',
    expandModelParts: '展开模型部件',
    collapseModelParts: '折叠模型部件',
    numericParamsEditor: '数值参数编辑器',
    selectModelParams: '选择一个模型来编辑 params.json',
    solid: '实体',
    xray: '透视',
    wire: '线框',
    viewControls: '视图控制',
    showcase: '展示',
    explode: '爆炸图',
    explodeDistance: '爆炸距离',
    waitingForProject: '等待项目...',
    createProject: '创建项目',
    openProject: '打开项目',
    buildLogs: '构建日志',
    clear: '清空',
    pythonExportOutput: 'Python / 导出输出',
    terminal: '终端',
    closePanel: '关闭面板',
    codeAgent: '代码 Agent',
    nextAgent: 'Forgent3D',
    newModel: '新建模型',
    newModelHelp: '这会创建 models/&lt;name&gt;/asm.xml、params.json，以及本地 parts/&lt;name&gt;/part.py。名称只能包含字母、数字、下划线和连字符。',
    modelType: '模型类型',
    modelName: '模型名称',
    modelNamePlaceholder: 'bracket',
    modelDescription: '一句话描述（可选，会写入 README.md）',
    modelDescriptionPlaceholder: '用于 XX 的安装支架',
    partKind: '零件（part.py）',
    assemblyKind: '装配体（asm.xml）',
    cancel: '取消',
    create: '创建',
    newProject: '新建项目',
    projectName: '项目名称',
    parentDirectory: '父目录',
    pickParentPlaceholder: '点击右侧按钮选择...',
    browse: '浏览...',
    currentModel: '当前模型：{name}',
    noModels: '还没有模型。点击右上角 + 创建一个',
    assemblySuffix: '{name}（装配体）',
    openInFileExplorer: '在文件资源管理器中打开',
    rebuildModelTitle: '重新构建此模型包并刷新本地部件网格',
    rebuildAllTitle: '强制重建所有模型（不使用缓存）',
    rebuildAllStarted: '正在重建所有模型...',
    rebuildAllDone: '重建完成',
    rebuildAllFailed: '重建失败：{message}',
    partBuilt: '{part} 已构建',
    selectModelFirst: '请先在左侧选择一个模型',
    exported: '已导出 <code>{name}</code> · <code>{format}</code>',
    exportFailed: '导出失败：{message}',
    modelCreationDisabled: '已禁用从界面创建模型',
    creatingProject: '正在创建项目...',
    projectCreated: '项目已创建（内核：{kernel}）：{path}',
    creationFailed: '创建失败',
    creationFailedDetail: '创建失败：{message}',
    openProjectFailed: '打开项目失败：{message}',
    terminalLaunchingNotice: '如果终端一直为空，请在 shell 中安装/启用 <code>{agent}</code> 后重试。',
    terminalTitle: '终端 - {agent}',
    launchingTerminal: '正在启动 {agent} · {project}',
    launchFailed: '启动 {agent} 失败：{message}',
    previousTerminalReplaced: '已替换之前的终端为 <code>{agent}</code>',
    nextAgentOpened: '已打开 Forgent3D：{url}',
    nextAgentOpenedToast: '已用当前项目打开 Forgent3D',
    nextAgentOpenedExternal: '已在外部浏览器打开 Forgent3D 桌面登录：{url}',
    nextAgentOpenedExternalToast: '已打开外部浏览器登录 Forgent3D',
    nextAgentDesktopAuthReceived: '已收到 Forgent3D 登录回调，正在打开内嵌 Agent',
    nextAgentOpenFailed: '打开 Forgent3D 失败：{message}',
    projectOpenedStatus: '项目已打开（{kernel}），等待首次构建...',
    projectOpenedLog: '项目已打开：{path}',
    kernelInfo: '内核：{kernel} · 源文件：{sourceFile} · 预览格式：{previewFormat}',
    failedReadModels: '读取模型列表失败：{message}',
    buildingPart: '正在构建 {part} ...',
    building: '正在构建...',
    buildFailedSeeLogs: '构建失败（查看日志）',
    buildFailed: '构建失败',
    noRuntime: '未检测到可用的构建运行时。',
    loadingMjcf: '正在加载 MJCF',
    parsingStl: '正在解析 STL',
    parsingBrep: 'OCCT 正在解析 BREP',
    missingModelUrl: '主进程未返回 URL，跳过加载',
    modelReady: '{partLabel}模型就绪{sizeLabel} · {tail}',
    mjcfAssembly: 'MJCF 装配体',
    stlMesh: 'STL 网格',
    brepFaces: '{count} 个 BREP 面',
    failedReportPartInfo: '上报部件信息失败：{message}',
    modelLoadFailed: '模型加载失败',
    failedLoadModel: '{partLabel}加载 {format} 失败：{message}',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '切换全屏',
    debugTools: '调试工具',
    developerTools: '开发者工具',
    reload: '重新加载',
    toggleExplodedView: '切换爆炸图',
    explodeNeedsParts: '爆炸图需要多个可见部件',
    autoShowNeedsModel: '自动展示需要先加载模型。',
    explodeNeedsLoadedParts: '爆炸图需要已加载且包含多个可见部件的模型。',
    noNumericParams: '没有数值型参数',
    updatingParams: '正在更新 {model}/params.json ...',
    editingParams: '正在编辑 {model}/params.json',
    loadingParams: '正在加载 {model}/params.json ...',
    paramsWillBeCreated: '将为 {model} 创建 params.json',
    revertingParams: '正在还原 {model}/params.json ...',
    savingParams: '正在保存 {model}/params.json ...',
    savedParamsRebuilding: '已保存 {model}/params.json；正在重建模型',
    nextAgentPanelTitle: 'Forgent3D',
    nextAgentLoading: '正在加载 Forgent3D…',
  }
};

export function normalizeLanguage(language) {
  const value = String(language || '').trim().replace('_', '-');
  if (SUPPORTED_LANGUAGES.includes(value)) return value;
  return value.toLowerCase() === 'zh' || value.toLowerCase().startsWith('zh-') ? 'zh-CN' : DEFAULT_LANGUAGE;
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
