// @ts-nocheck
import { createTerminalPanel } from './terminal-panel.js';
import { applyDocumentI18n, initRendererI18n, onLanguageChange, setLanguage, t } from './i18n.js';
import { createParamsEditorController } from './ui-params-editor.js';
import { createViewerUiController } from './ui-viewer-controls.js';

const api = window.aicad;

export function initUI(viewer) {
  const el = {
    app: document.getElementById('app'),
    btnClearLog: document.getElementById('btn-clear-log'),
    log: document.getElementById('log'),
    statusText: document.getElementById('status-text'),
    spinner: document.getElementById('status-spinner'),
    modelNameBadge: document.getElementById('model-name-badge'),
    previewToolbar: document.getElementById('preview-toolbar'),
    viewCubeHost: document.getElementById('viewcube-host'),
    viewControlPanel: document.getElementById('view-control-panel'),
    viewModeBtns: document.querySelectorAll('[data-preview-mode]'),
    viewShowcaseBtn: document.getElementById('view-showcase'),
    viewExplodeBtn: document.getElementById('view-explode'),
    viewExplodeDistance: document.getElementById('view-explode-distance'),
    btnToggleLeft: document.getElementById('btn-toggle-left'),
    btnToggleLeftHandle: document.getElementById('btn-toggle-left-handle'),
    toast: document.getElementById('toast'),
    emptyHint: document.getElementById('empty-hint'),
    btnEmptyCreateProject: document.getElementById('btn-empty-create-project'),
    btnEmptyOpenProject: document.getElementById('btn-empty-open-project'),
    debugTools: document.querySelectorAll('.debug-only'),

    modal: document.getElementById('modal-new'),
    inputName: document.getElementById('input-project-name'),
    inputParent: document.getElementById('input-parent-dir'),
    btnPickParent: document.getElementById('btn-pick-parent'),
    btnModalCancel: document.getElementById('btn-modal-cancel'),
    btnModalConfirm: document.getElementById('btn-modal-confirm'),

    partsPanel: document.getElementById('parts-panel'),
    partsList: document.getElementById('parts-list'),
    btnRebuildAll: document.getElementById('btn-rebuild-all'),
    modelKindBtns: document.querySelectorAll('[data-kind-filter]'),
    selectExportFormat: document.getElementById('select-export-format'),
    btnExportActive: document.getElementById('btn-export-active'),
    paramsPanel: document.getElementById('params-panel'),
    paramsEditor: document.getElementById('params-editor'),
    paramsStatus: document.getElementById('params-status'),
    btnParamsRevert: document.getElementById('btn-params-revert'),
    modalPart: document.getElementById('modal-part'),
    inputPartName: document.getElementById('input-part-name'),
    inputPartDesc: document.getElementById('input-part-desc'),
    selectModelKind: document.getElementById('select-model-kind'),
    btnPartCancel: document.getElementById('btn-part-cancel'),
    btnPartConfirm: document.getElementById('btn-part-confirm'),

    // Agent bar
    agentBar: document.getElementById('agent-bar'),
    agentBtns: document.querySelectorAll('.agent-btn'),

    // Terminal panel
    termPanel:       document.getElementById('terminal-panel'),
    termContainer:   document.getElementById('term-container'),
    termTitle:       document.getElementById('term-title'),
    termResizeHandle:document.getElementById('term-resize-handle'),
    btnTermClose:    document.getElementById('btn-term-close'),
    agentNextRoot:    document.getElementById('agent-next-root'),
    agentNextGuide:   document.getElementById('agent-next-guide'),
    agentNextExternalLogin: document.getElementById('agent-next-external-login'),
    agentNextEmbeddedOpen:  document.getElementById('agent-next-embedded-open'),
    agentNextFrame:   document.getElementById('agent-next-frame'),
    agentNextLoading: document.getElementById('agent-next-loading')
  };

  /* ---------------- Status & Log ---------------- */
  function setStatus(text, busy = false) {
    el.statusText.textContent = text;
    el.spinner.classList.toggle('hidden', !busy);
  }
  function appendLog(message, level = 'info') {
    const line = document.createElement('div');
    line.className = `line ${level}`;
    const ts = new Date().toLocaleTimeString();
    line.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(String(message))}`;
    el.log.appendChild(line);
    el.log.scrollTop = el.log.scrollHeight;
    while (el.log.children.length > 500) el.log.removeChild(el.log.firstChild);
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  el.btnClearLog.addEventListener('click', () => (el.log.innerHTML = ''));

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function showToast(html, ms = 2600) {
    el.toast.innerHTML = html;
    el.toast.classList.remove('hidden');
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      setTimeout(() => el.toast.classList.add('hidden'), 250);
    }, ms);
  }

  /* ---------------- Project State ---------------- */
  let currentProject = null;
  let currentKernel = null;
  let activePart = null;
  let loadedPart = null;
  let partsCache = [];
  let selectedModelPart = null;
  let selectedModelPartModel = null;
  let displayedModelPart = null;
  const assemblyPayloads = new Map();
  const expandedModels = new Set();
  const LEFT_SIDEBAR_PREF_KEY = 'forgent3d.leftSidebarVisible';
  let leftSidebarVisible = false;

  function readLeftSidebarPreference() {
    try {
      const stored = window.localStorage?.getItem(LEFT_SIDEBAR_PREF_KEY);
      return stored == null ? true : stored === 'true';
    } catch {
      return true;
    }
  }

  function writeLeftSidebarPreference(visible) {
    try {
      window.localStorage?.setItem(LEFT_SIDEBAR_PREF_KEY, visible ? 'true' : 'false');
    } catch {}
  }

  function applyLayoutVisibility() {
    const hasProject = !!currentProject;
    el.app.classList.toggle('left-collapsed', !leftSidebarVisible);
    if (el.btnToggleLeft) {
      const label = leftSidebarVisible ? t('collapseLeftPanel') : t('expandLeftPanel');
      el.btnToggleLeft.title = label;
      el.btnToggleLeft.setAttribute('aria-label', label);
    }
    if (el.btnToggleLeftHandle) el.btnToggleLeftHandle.classList.toggle('hidden', leftSidebarVisible || !hasProject);
  }

  function syncExportControls() {
    const hasProject = !!currentProject;
    const hasActivePart = !!activePart;
    if (!el.selectExportFormat || !el.btnExportActive) return;

    for (const option of Array.from(el.selectExportFormat.options || [])) {
      option.disabled = option.value === 'step';
    }
    if (el.selectExportFormat.value === 'step') {
      el.selectExportFormat.value = 'stl';
    }
    el.selectExportFormat.disabled = !hasProject || !hasActivePart;
    el.btnExportActive.disabled = !hasProject || !hasActivePart;

  }

  const viewerUi = createViewerUiController({
    viewer,
    elements: el,
    getHasProject: () => !!currentProject,
    getHasModel: () => (typeof viewer.hasModel === 'function' ? viewer.hasModel() : !!activePart),
    appendLog
    ,t
  });

  const paramsEditor = createParamsEditorController({
    api,
    elements: el,
    getCurrentProject: () => currentProject,
    getParamsTarget: () => {
      if (selectedModelPartModel && selectedModelPart) {
        return {
          model: selectedModelPartModel,
          part: selectedModelPart,
          label: `${selectedModelPartModel}/parts/${selectedModelPart}`
        };
      }
      return activePart ? { model: activePart, label: activePart } : null;
    },
    t
  });

  function renderModelNameBadge() {
    if (!el.modelNameBadge) return;
    if (!currentProject || !activePart) {
      el.modelNameBadge.textContent = '';
      el.modelNameBadge.classList.add('hidden');
      return;
    }
    el.modelNameBadge.textContent = t('currentModel', { name: activePart });
    el.modelNameBadge.classList.remove('hidden');
  }

  function syncModelKindButtons() {
    el.modelKindBtns?.forEach((btn) => {
      btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', 'false');
    });
  }

  function setModelListKind(_kind, { render = true } = {}) {
    syncModelKindButtons();
    if (render) renderPartsList();
  }

  function syncModelListKindToModel(name, opts = {}) {
    setModelListKind('model', opts);
  }

  function refreshLocalizedUi() {
    applyDocumentI18n();
    applyLayoutVisibility();
    renderModelNameBadge();
    renderPartsList();
    viewerUi.renderAll();
    if (!currentProject) {
      paramsEditor.setIdle(t('selectModelParams'));
      setStatus(t('waitingForProject'));
    }
  }

  onLanguageChange(refreshLocalizedUi);

  function setProject(p, meta = null) {
    currentProject = p;
    currentKernel = meta?.kernel || null;
    leftSidebarVisible = p ? readLeftSidebarPreference() : false;
    if (!p) {
      activePart = null;
      loadedPart = null;
      selectedModelPart = null;
      selectedModelPartModel = null;
      displayedModelPart = null;
      assemblyPayloads.clear();
      expandedModels.clear();
      viewerUi.stopAutoShow();
      viewerUi.stopExplodedView();
      if (typeof viewer.setSelectedPart === 'function') viewer.setSelectedPart(null);
    }
    el.emptyHint.classList.toggle('hidden', !!p);
    el.partsPanel.style.display = p ? '' : 'none';
    if (el.paramsPanel) el.paramsPanel.style.display = p ? '' : 'none';
    el.agentBtns.forEach((btn) => { btn.disabled = !p; });
    applyLayoutVisibility();
    syncModelKindButtons();
    renderModelNameBadge();
    syncExportControls();
    viewerUi.renderAll();
    if (!p) paramsEditor.setIdle(t('selectModelParams'));
  }

  function modelPartsFor(modelName) {
    const model = partsCache.find((item) => item.name === modelName);
    return Array.isArray(model?.parts) ? model.parts : [];
  }

  async function showAssembly(modelName = activePart, { preserveView = true } = {}) {
    selectedModelPart = null;
    selectedModelPartModel = null;
    displayedModelPart = null;
    paramsEditor.refresh({ force: true });
    const payload = assemblyPayloads.get(modelName);
    if (!payload?.url) {
      if (modelName) {
        setStatus(t('buildingPart', { part: modelName }), true);
        api.rebuildModel(modelName).catch((e) => appendLog(t('buildFailed') + `: ${e.message || e}`, 'error'));
      }
      return;
    }
    if (typeof viewer.setSelectedPart === 'function') viewer.setSelectedPart(null);
    viewerUi.stopExplodedView();
    const partLabel = payload.part ? `[${payload.part}] ` : '';
    setStatus(`${partLabel}${t('loadingMjcf')} ...`, true);
    try {
      const partInfo = await viewer.loadModel(payload.url, (msg) => appendLog(msg), {
        format: 'MJCF',
        paramsUrl: payload.paramsUrl,
        preserveView
      });
      if (payload?.part) loadedPart = payload.part;
      const modelParts = modelPartsFor(payload.part);
      if (payload?.part && modelParts.length >= 2) expandedModels.add(payload.part);
      renderPartsList();
      const sizeKB = payload.size ? (payload.size / 1024).toFixed(1) + ' KB' : '';
      setStatus(t('modelReady', { partLabel, sizeLabel: sizeKB ?  sizeKB : '', tail: t('mjcfAssembly') }));
      viewerUi.renderAll();
      return partInfo;
    } catch (e) {
      setStatus(t('modelLoadFailed'));
      appendLog(t('failedLoadModel', { partLabel, format: 'MJCF', message: e.message || e }), 'error');
      showToast(t('failedLoadModel', { partLabel, format: 'MJCF', message: escapeHtml(e.message || String(e)) }), 3800);
      throw e;
    }
  }

  async function showModelPart(modelName, part) {
    const partId = String(part?.name || part?.id || '');
    if (!modelName || !partId) return;
    viewerUi.stopAutoShow();
    viewerUi.stopExplodedView();
    selectedModelPart = partId;
    selectedModelPartModel = modelName;
    displayedModelPart = partId;
    paramsEditor.refresh({ force: true });
    if (typeof viewer.setSelectedPart === 'function') viewer.setSelectedPart(null);
    renderPartsList();
    setStatus(`[${part.name || partId}] ${part.hasStl ? t('parsingStl') : t('buildingPart', { part: partId })} ...`, true);
    try {
      const stl = await api.ensureModelPartStl(modelName, partId);
      part.hasStl = true;
      part.stlUrl = stl.url;
      const partInfo = await viewer.loadModel(stl.url, (msg) => appendLog(msg), { format: 'STL', preserveView: false });
      setStatus(t('modelReady', {
        partLabel: `[${part.name || partId}] `,
        sizeLabel: '',
        tail: t('stlMesh')
      }));
      viewerUi.renderAll();
      return partInfo;
    } catch (e) {
      setStatus(t('modelLoadFailed'));
      appendLog(t('failedLoadModel', { partLabel: `[${part.name || partId}] `, format: 'STL', message: e.message || e }), 'error');
      showToast(t('failedLoadModel', { partLabel: `[${part.name || partId}] `, format: 'STL', message: escapeHtml(e.message || String(e)) }), 3800);
      throw e;
    }
  }

  function renderModelPartList(modelName, items) {
    if (items.length < 1 || !expandedModels.has(modelName)) return null;
    const ul = document.createElement('ul');
    ul.className = 'model-part-list';
    for (const part of items) {
      const li = document.createElement('li');
      const partId = String(part.name || part.id);
      li.className = 'model-part-item' + (selectedModelPartModel === modelName && String(displayedModelPart || '') === partId ? ' selected' : '');
      li.dataset.partId = partId;
      li.title = part.hasStl ? partId : `${partId} (STL not built yet)`;
      li.textContent = partId;
      li.classList.toggle('missing', !part.hasStl);
      li.addEventListener('click', async (event) => {
        event.stopPropagation();
        await showModelPart(modelName, part);
      });
      ul.appendChild(li);
    }
    return ul;
  }

  /* ---------------- Models List ---------------- */
  function renderPartsList() {
    el.partsList.innerHTML = '';
    syncModelKindButtons();
    if (!partsCache.length) {
      const empty = document.createElement('li');
      empty.className = 'part-empty muted';
      empty.textContent = t('noModels');
      el.partsList.appendChild(empty);
      return;
    }
    for (const p of partsCache) {
      const li = document.createElement('li');
      li.className = 'part-item' + (p.name === activePart ? ' active' : '');
      li.dataset.name = p.name;

      const main = document.createElement('div');
      main.className = 'part-main';
      const title = document.createElement('div');
      title.className = 'part-title';
      const modelParts = Array.isArray(p.parts) ? p.parts : [];
      if (modelParts.length >= 1) {
        const expand = document.createElement('button');
        expand.className = 'model-part-toggle';
        expand.type = 'button';
        expand.textContent = expandedModels.has(p.name) ? '-' : '+';
        expand.title = expandedModels.has(p.name) ? t('collapseModelParts') : t('expandModelParts');
        expand.addEventListener('click', (event) => {
          event.stopPropagation();
          if (expandedModels.has(p.name)) expandedModels.delete(p.name);
          else expandedModels.add(p.name);
          renderPartsList();
        });
        title.appendChild(expand);
      }
      const titleText = document.createElement('span');
      titleText.className = 'part-title-text';
      titleText.textContent = p.name;
      title.appendChild(titleText);
      if (modelParts.length >= 1) {
        const count = document.createElement('span');
        count.className = 'model-part-count';
        count.textContent = String(modelParts.length);
        title.appendChild(count);
      }
      if (p.building) {
        const dot = document.createElement('span');
        dot.className = 'part-busy';
        title.appendChild(dot);
      }
      const desc = document.createElement('div');
      desc.className = 'part-desc muted';
      desc.textContent = p.description || '—';
      main.appendChild(title);
      main.appendChild(desc);

      const actions = document.createElement('div');
      actions.className = 'part-actions';
      const bReveal = document.createElement('button');
      bReveal.className = 'icon-btn';
      bReveal.title = t('openInFileExplorer');
      bReveal.textContent = '📁';
      bReveal.addEventListener('click', (e) => {
        e.stopPropagation();
        api.revealModel(p.name);
      });
      const bBuild = document.createElement('button');
      bBuild.className = 'icon-btn';
      bBuild.title = t('rebuildModelTitle');
      bBuild.textContent = '↻';
      bBuild.addEventListener('click', (e) => {
        e.stopPropagation();
        api.rebuildModel(p.name);
      });
      actions.appendChild(bReveal);
      actions.appendChild(bBuild);

      li.appendChild(main);
      li.appendChild(actions);
      const partList = renderModelPartList(p.name, modelParts);
      if (partList) li.appendChild(partList);
      li.addEventListener('click', () => {
        if (paramsEditor.isDirty()) paramsEditor.flushPendingSave();
        selectedModelPart = null;
        selectedModelPartModel = null;
        if (p.name !== activePart) api.selectModel(p.name);
        else showAssembly(p.name);
      });
      el.partsList.appendChild(li);
    }
  }

  async function refreshParts() {
    if (!currentProject) return;
    try {
      const { models, active } = await api.listModels();
      partsCache = models || [];
      activePart = active;
      syncModelListKindToModel(activePart, { render: false });
      renderPartsList();
      renderModelNameBadge();
      syncExportControls();
      paramsEditor.refresh();
    } catch (e) {
      appendLog(t('failedReadModels', { message: e.message }), 'error');
    }
  }

  if (el.btnRebuildAll) {
    el.btnRebuildAll.addEventListener('click', async () => {
      el.btnRebuildAll.disabled = true;
      setStatus(t('rebuildAllStarted'), true);
      try {
        const res = await api.rebuildAllModels();
        if (res?.ok) {
          setStatus(t('rebuildAllDone'));
          await refreshParts();
        } else {
          const failed = (res?.results || []).filter((r) => !r.ok).map((r) => r.name).join(', ');
          const msg = failed || 'unknown error';
          setStatus(t('rebuildAllFailed', { message: msg }));
          appendLog(t('rebuildAllFailed', { message: msg }), 'error');
        }
      } catch (e) {
        const msg = e.message || String(e);
        setStatus(t('rebuildAllFailed', { message: msg }));
        appendLog(t('rebuildAllFailed', { message: msg }), 'error');
      } finally {
        el.btnRebuildAll.disabled = false;
      }
    });
  }

  if (el.btnExportActive) {
    el.btnExportActive.addEventListener('click', async () => {
      if (!activePart) {
        showToast(t('selectModelFirst'));
        return;
      }
      const fmt = (el.selectExportFormat?.value || 'stl').toLowerCase();
      try {
        const res = await api.exportModel(activePart, fmt);
        if (!res?.canceled) {
          const label = String(fmt).toUpperCase();
          showToast(t('exported', { name: escapeHtml(activePart), format: label }));
        }
      } catch (e) {
        appendLog(t('exportFailed', { message: e.message }), 'error');
        showToast(t('exportFailed', { message: escapeHtml(e.message || String(e)) }), 3800);
      }
    });
  }

  el.modelKindBtns?.forEach((btn) => {
    btn.addEventListener('click', () => {
      setModelListKind(btn.dataset.kindFilter);
    });
  });

  el.btnPartCancel.addEventListener('click', () => el.modalPart.classList.add('hidden'));
  el.btnPartConfirm.addEventListener('click', () => {
    el.modalPart.classList.add('hidden');
    showToast(t('modelCreationDisabled'));
  });

  /* ---------------- Button Events ---------------- */
  /** New projects always use build123d (no kernel picker in UI). */
  const DEFAULT_PROJECT_KERNEL = 'build123d';

  function openNewProjectModal() {
    el.inputParent.value = '';
    el.inputName.value = 'my-cad-project';
    el.modal.classList.remove('hidden');
    el.inputName.focus();
    el.inputName.select();
  }

  el.btnPickParent.addEventListener('click', async () => {
    try {
      const dir = await api.chooseDirectory();
      if (dir) el.inputParent.value = dir;
    } catch (e) { appendLog(e.message, 'error'); }
  });

  el.btnModalCancel.addEventListener('click', () => el.modal.classList.add('hidden'));

  el.btnModalConfirm.addEventListener('click', async () => {
    const parent = el.inputParent.value.trim();
    const name = el.inputName.value.trim();
    if (!parent) { alert('Please select a parent directory first'); return; }
    if (!name) { alert('Please enter a project name'); return; }
    try {
      setStatus(t('creatingProject'), true);
      const p = await api.createProject(parent, name, DEFAULT_PROJECT_KERNEL);
      el.modal.classList.add('hidden');
      appendLog(t('projectCreated', { kernel: DEFAULT_PROJECT_KERNEL, path: p }));
    } catch (e) {
      appendLog(t('creationFailedDetail', { message: e.message }), 'error');
      alert(e.message);
      setStatus(t('creationFailed'));
    }
  });

  if (el.btnEmptyCreateProject) {
    el.btnEmptyCreateProject.addEventListener('click', openNewProjectModal);
  }
  if (el.btnEmptyOpenProject) {
    el.btnEmptyOpenProject.addEventListener('click', async () => {
      try {
        await api.openProject();
      } catch (e) {
        appendLog(t('openProjectFailed', { message: e.message }), 'error');
        showToast(t('openProjectFailed', { message: escapeHtml(e.message || String(e)) }), 3500);
      }
    });
  }

  if (el.btnToggleLeft) {
    el.btnToggleLeft.addEventListener('click', () => {
      leftSidebarVisible = !leftSidebarVisible;
      writeLeftSidebarPreference(leftSidebarVisible);
      applyLayoutVisibility();
    });
  }
  if (el.btnToggleLeftHandle) {
    el.btnToggleLeftHandle.addEventListener('click', () => {
      if (!currentProject) return;
      leftSidebarVisible = true;
      writeLeftSidebarPreference(leftSidebarVisible);
      applyLayoutVisibility();
    });
  }
  window.addEventListener('resize', applyLayoutVisibility);
  /* ============================================================
     Embedded terminal panel
     ============================================================ */

  const AGENT_LABELS = {
    codex:    '⚡ Codex',
    claude:   '◆ Claude Code',
    cli:      '▷ Cursor CLI',
    next:     'Forgent3D'
  };

  let termPanel = null;      // instance returned by createTerminalPanel
  let termPanelOpen = false;
  let rightDockMode = null; // 'terminal' | 'next'
  /** When true, hide Forgent3D loading overlay on the next webview load completion or failure. */
  let pendingNextAgentWebviewLoad = false;
  let termOpenFitTimer = null;
  let termDataChunkCount = 0;
  let termDebugEnabled = false;
  const TERM_DEFAULT_W = 460;
  const TERM_MIN_W = 320;
  const TERM_MAX_W = 900;

  function termDebug(message, extra = null) {
    if (!termDebugEnabled) return;
    const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
    appendLog(`[TERM_DEBUG] ${message}${suffix}`, 'warn');
    try {
      // Also print to DevTools for full object inspection
      // console.debug('[TERM_DEBUG]', message, extra || '');
    } catch {}
  }

  function setDebugToolsVisible(visible) {
    el.debugTools.forEach((node) => node.classList.toggle('hidden', !visible));
    el.app?.classList.toggle('with-log-rail', !!visible);
  }

  function calcTermSize() {
    const w = el.termContainer?.offsetWidth || 0;
    const h = el.termContainer?.offsetHeight || 0;
    return {
      w,
      h,
      cols: w > 20 ? Math.floor((w - 20) / 8) : 120,
      rows: h > 10 ? Math.floor((h - 10) / 20) : 30
    };
  }

  function readTermSize() {
    const fallback = calcTermSize();
    const actual = termPanel?.getSize?.();
    if (!actual) return fallback;
    return {
      w: actual.width || fallback.w,
      h: actual.height || fallback.h,
      cols: actual.cols || fallback.cols,
      rows: actual.rows || fallback.rows
    };
  }

  function syncTermResize(termId, tag = 'syncTermResize') {
    if (!termId) return;
    termPanel?.fit();
    const { w, h, cols, rows } = readTermSize();
    termDebug(tag, { termId, w, h, cols, rows });
    api.terminalResize(termId, cols, rows).catch((e) => {
      termDebug(`${tag}:failed`, { termId, message: e?.message || String(e) });
    });
  }

  function setPanelWidth(w) {
    el.app.style.setProperty('--term-w', `${w}px`);
    el.termPanel.style.setProperty('--term-w', `${w}px`);
  }

  function setNextAgentLoadingVisible(visible) {
    if (!el.agentNextLoading) return;
    el.agentNextLoading.classList.toggle('hidden', !visible);
    el.agentNextLoading.setAttribute('aria-busy', visible ? 'true' : 'false');
  }

  function clearNextAgentWebviewLoadIntent() {
    pendingNextAgentWebviewLoad = false;
    setNextAgentLoadingVisible(false);
  }

  function setNextAgentGuideVisible(visible) {
    el.agentNextGuide?.classList.toggle('hidden', !visible);
  }

  async function openNextAgentExternalLogin() {
    if (!currentProject) return;
    try {
      const res = await api.agentOpenNext(currentProject, undefined, true);
      appendLog(t('nextAgentOpenedExternal', { url: res?.url || '' }));
      showToast(t('nextAgentOpenedExternalToast'), 2600);
    } catch (e) {
      appendLog(t('nextAgentOpenFailed', { message: e?.message || String(e) }), 'error');
      showToast(t('nextAgentOpenFailed', { message: escapeHtml(e?.message || String(e)) }), 4200);
    }
  }

  async function openNextAgentEmbedded() {
    if (!currentProject) return;
    try {
      pendingNextAgentWebviewLoad = true;
      setNextAgentGuideVisible(false);
      setNextAgentLoadingVisible(true);
      const res = await api.agentOpenNext(currentProject, undefined, false);
      if (el.agentNextFrame && el.agentNextFrame.src !== res?.url) {
        el.agentNextFrame.src = res?.url || 'about:blank';
      } else {
        clearNextAgentWebviewLoadIntent();
      }
      appendLog(t('nextAgentOpened', { url: res?.url || '' }));
    } catch (e) {
      clearNextAgentWebviewLoadIntent();
      setNextAgentGuideVisible(true);
      appendLog(t('nextAgentOpenFailed', { message: e?.message || String(e) }), 'error');
      showToast(t('nextAgentOpenFailed', { message: escapeHtml(e?.message || String(e)) }), 4200);
    }
  }

  function consumeNextAgentDesktopAuth(payload) {
    const token = String(payload?.token || '');
    const rawBaseUrl = String(payload?.baseUrl || '');
    if (!token || !rawBaseUrl) return;
    try {
      const url = new URL('/desktop-auth/consume', rawBaseUrl.replace(/\/+$/, '') + '/');
      url.searchParams.set('token', token);
      const projectPath = String(payload?.projectPath || currentProject || '');
      if (projectPath) url.searchParams.set('projectPath', projectPath);
      pendingNextAgentWebviewLoad = true;
      openTermPanel('next');
      setNextAgentGuideVisible(false);
      setNextAgentLoadingVisible(true);
      el.termTitle.textContent = t('nextAgentPanelTitle');
      if (el.agentNextFrame) el.agentNextFrame.src = url.toString();
      appendLog(t('nextAgentDesktopAuthReceived'));
    } catch (e) {
      appendLog(t('nextAgentOpenFailed', { message: e?.message || String(e) }), 'error');
      showToast(t('nextAgentOpenFailed', { message: escapeHtml(e?.message || String(e)) }), 4200);
    }
  }

  function openTermPanel(mode = 'terminal') {
    const dockMode = mode === 'next' ? 'next' : 'terminal';
    if (termOpenFitTimer) {
      clearTimeout(termOpenFitTimer);
      termOpenFitTimer = null;
    }
    const firstOpen = !termPanelOpen;
    if (!termPanelOpen) {
      termPanelOpen = true;
      el.app.classList.add('term-open');
      el.termPanel.classList.add('open');
      termDebug('openTermPanel', dockMode);
    }
    rightDockMode = dockMode;

    if (dockMode === 'next') {
      el.termContainer?.classList.add('hidden');
      el.agentNextRoot?.classList.remove('hidden');
      return;
    }

    el.agentNextRoot?.classList.add('hidden');
    el.termContainer?.classList.remove('hidden');
    if (!termPanel) {
      termPanel = createTerminalPanel(el.termContainer, api);
      termDebug('createTerminalPanel done', {
        containerW: el.termContainer?.offsetWidth || 0,
        containerH: el.termContainer?.offsetHeight || 0
      });
    }

    if (firstOpen) {
      requestAnimationFrame(() => {
        termPanel?.fit();
        termPanel?.focus();
        termDebug('fit#1', {
          panelH: el.termPanel?.offsetHeight || 0,
          containerW: el.termContainer?.offsetWidth || 0,
          containerH: el.termContainer?.offsetHeight || 0
        });
      });
      requestAnimationFrame(() => {
        termPanel?.fit();
        termPanel?.focus();
        termDebug('fit#2', {
          panelH: el.termPanel?.offsetHeight || 0,
          containerW: el.termContainer?.offsetWidth || 0,
          containerH: el.termContainer?.offsetHeight || 0
        });
      });
      if (termOpenFitTimer) clearTimeout(termOpenFitTimer);
      termOpenFitTimer = setTimeout(() => {
        termOpenFitTimer = null;
        termPanel?.fit();
        termPanel?.focus();
        const tid = termPanel?.getTermId();
        if (tid) syncTermResize(tid, 'openPanel:stabilize');
        termDebug('fit#3(timeout)', {
          panelH: el.termPanel?.offsetHeight || 0,
          containerW: el.termContainer?.offsetWidth || 0,
          containerH: el.termContainer?.offsetHeight || 0
        });
      }, 220);
    } else {
      requestAnimationFrame(() => {
        termPanel?.fit();
        termPanel?.focus();
      });
    }
  }

  function closeTermPanel() {
    if (!termPanelOpen) return;
    termPanelOpen = false;
    rightDockMode = null;
    el.app.classList.remove('term-open');
    el.termPanel.classList.remove('open');
    termDebug('closeTermPanel');
    clearNextAgentWebviewLoadIntent();
    el.agentNextRoot?.classList.add('hidden');
    el.termContainer?.classList.remove('hidden');
    if (termOpenFitTimer) {
      clearTimeout(termOpenFitTimer);
      termOpenFitTimer = null;
    }
    const tid = termPanel?.getTermId();
    if (tid) api.terminalKill(tid).catch(() => {});
    termPanel?.dispose();
    termPanel = null;
  }

  /* Initial width */
  setPanelWidth(TERM_DEFAULT_W);

  /* Close button */
  el.btnTermClose.addEventListener('click', closeTermPanel);
  el.agentNextExternalLogin?.addEventListener('click', openNextAgentExternalLogin);
  el.agentNextEmbeddedOpen?.addEventListener('click', openNextAgentEmbedded);

  if (el.agentNextFrame) {
    el.agentNextFrame.addEventListener('did-finish-load', () => {
      if (!pendingNextAgentWebviewLoad) return;
      pendingNextAgentWebviewLoad = false;
      setNextAgentLoadingVisible(false);
    });
    el.agentNextFrame.addEventListener('did-fail-load', () => {
      if (!pendingNextAgentWebviewLoad) return;
      clearNextAgentWebviewLoadIntent();
    });
  }

  /* Drag handle to resize width */
  el.termResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.termPanel.offsetWidth;
    const onMove = (mv) => {
      const delta = startX - mv.clientX;
      const w = Math.min(TERM_MAX_W, Math.max(TERM_MIN_W, startW + delta));
      setPanelWidth(w);
      if (rightDockMode === 'terminal') {
        termPanel?.fit();
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rightDockMode === 'terminal') {
        termPanel?.fit();
        const tid = termPanel?.getTermId();
        if (tid) syncTermResize(tid, 'dragEnd');
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  /* Agent button click */
  el.agentBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const agent = btn.dataset.agent;
      if (!agent || !currentProject) return;

      if (agent === 'next') {
        clearNextAgentWebviewLoadIntent();
        openTermPanel('next');
        setNextAgentGuideVisible(true);
        el.termTitle.textContent = t('nextAgentPanelTitle');
        return;
      }

      /* ---- CLI agents: embedded terminal panel ---- */
      // If a session already exists, terminate it and launch the new one in place.
      //
      // We intentionally do NOT pop a window.confirm() here, and we also do NOT
      // rebuild the xterm instance via termPanel.mount(). Both of those break
      // keyboard / IME focus on re-launch on Windows:
      //   * confirm() is a native MessageBox. Clicking "OK" on it does NOT
      //     restore a real "user activation" signal to the webContents. The
      //     subsequent await on terminalCreate further drops any remaining
      //     activation. After that, programmatic xterm.focus() only sets
      //     document.activeElement; Chromium won't hand true OS input focus
      //     back to the hidden <textarea>, so the cursor stops blinking and
      //     Windows IME (e.g. Microsoft Pinyin) refuses to attach until the
      //     user manually clicks outside and back into the terminal.
      //   * mount() disposes the xterm instance and recreates its hidden
      //     <textarea>. Even when that new textarea receives focus, the IME
      //     context does not reliably re-bind to a freshly-spawned element.
      //
      // Instead: silently kill the old PTY, keep the same xterm/textarea,
      // and let attachSession(newId) reset the buffer before binding the new
      // session. A toast keeps the user informed of the replacement.
      if (termPanel?.getTermId()) {
        const oldTid = termPanel.getTermId();
        termPanel.attachSession(null);
        api.terminalKill(oldTid).catch(() => {});
        showToast(
          t('previousTerminalReplaced', { agent: escapeHtml(AGENT_LABELS[agent] || agent) }),
          2200
        );
      }

      openTermPanel();
      el.termTitle.textContent = t('terminalTitle', { agent: AGENT_LABELS[agent] || agent });
      termPanel?.printInfo(t('launchingTerminal', { agent, project: currentProject }));

      try {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        termPanel?.fit();
        const { w, h, cols, rows } = readTermSize();
        termDebug('before terminalCreate', { agent, w, h, cols, rows });
        const { termId } = await api.terminalCreate(agent, currentProject, cols, rows);
        termDataChunkCount = 0;
        termDebug('terminalCreate returned', { termId });
        termPanel?.attachSession(termId, agent);
        termDebug('attachSession', { termId });
        // On first open, height animation may cause inaccurate rows; force another resize sync.
        requestAnimationFrame(() => {
          syncTermResize(termId, 'resize#1(raf)');
          termPanel?.focus();
        });
        setTimeout(() => {
          syncTermResize(termId, 'resize#2(timeout220)');
          termPanel?.focus();
        }, 220);
        setTimeout(() => {
          syncTermResize(termId, 'resize#3(timeout420)');
          termPanel?.focus();
        }, 420);
      } catch (e) {
        termDebug('terminalCreate failed', { message: e?.message || String(e) });
        appendLog(t('launchFailed', { agent, message: e.message }), 'error');
        termPanel?.printInfo(`Error: ${e.message}`);
      }
    });
  });

  /* Receive terminal data / exit events (handled in main onEvent switch) */

  /* ---------------- Main Process Events ---------------- */
  api.onEvent(({ type, payload }) => {
    switch (type) {
      case 'PROJECT_OPENED':
        setProject(payload.path, payload);
        setStatus(t('projectOpenedStatus', { kernel: payload.kernelLabel || payload.kernel || '' }));
        appendLog(t('projectOpenedLog', { path: payload.path }));
        if (payload.kernel) {
          appendLog(t('kernelInfo', {
            kernel: payload.kernelLabel || payload.kernel,
            sourceFile: payload.sourceFile,
            previewFormat: payload.previewFormat
          }));
        }
        refreshParts();
        break;
      case 'MODELS_LIST':
        partsCache = payload.models || [];
        activePart = payload.active;
        syncModelListKindToModel(activePart, { render: false });
        renderPartsList();
        renderModelNameBadge();
        syncExportControls();
        viewerUi.renderAll();
        paramsEditor.refresh();
        break;
      case 'ACTIVE_MODEL_CHANGED':
        activePart = payload?.name || null;
        displayedModelPart = null;
        selectedModelPart = null;
        selectedModelPartModel = null;
        syncModelListKindToModel(activePart, { render: false });
        renderPartsList();
        renderModelNameBadge();
        syncExportControls();
        viewerUi.renderAll();
        paramsEditor.refresh({ force: true });
        break;
      case 'BUILD_STARTED':
        if (payload?.part && payload.part === activePart) {
          syncModelListKindToModel(payload.part, { render: false });
          renderPartsList();
        }
        setStatus(payload?.part ? t('buildingPart', { part: payload.part }) : t('building'), true);
        break;
      case 'BUILD_FAILED':
        setStatus(t('buildFailedSeeLogs'));
        appendLog(
          (payload?.part ? `[${payload.part}] ` : '') +
          (payload?.message || payload?.stderr || t('buildFailed')),
          'error'
        );
        if (payload?.reason === 'NO_PYTHON' || payload?.reason === 'NO_RUNTIME') {
          showToast(payload?.message || t('noRuntime'), 4500);
        }
        break;
      case 'PART_BUILT':
        refreshParts();
        // MODEL_UPDATED (which clears the spinner) is only sent for the active part.
        // For non-active part builds, clear the busy spinner here so UI doesn't hang.
        if (!payload?.part || payload.part !== activePart) {
          setStatus(payload?.part ? t('partBuilt', { part: payload.part }) : '');
        }
        break;
      case 'MODEL_UPDATED': {
        if (payload?.part) {
          if (payload.part !== loadedPart) viewerUi.stopAutoShow();
          activePart = payload.part;
          syncModelListKindToModel(activePart, { render: false });
          renderPartsList();
          renderModelNameBadge();
        }
        const fmt = (payload.format || 'BREP').toUpperCase();
        const url = payload.url;
        if (!url) {
          appendLog(t('missingModelUrl'), 'warn');
          break;
        }
        if (fmt === 'MJCF' && payload.part) assemblyPayloads.set(payload.part, { ...payload });
        const preserveView = !!payload.part && payload.part === loadedPart && typeof viewer.hasModel === 'function' && viewer.hasModel();
        const partLabel = payload.part ? `[${payload.part}] ` : '';
        if (fmt === 'MJCF') {
          showAssembly(payload.part, { preserveView }).then(async (partInfo) => {
            const explodeState = typeof viewer.getExplodeState === 'function' ? viewer.getExplodeState() : { enabled: false, available: false };
            if (explodeState.enabled && !explodeState.available) viewerUi.stopExplodedView();
            try {
              await new Promise((r) => requestAnimationFrame(() => r()));
              const snapshotViews = ['iso', 'front', 'side', 'top'];
              const buildSnapshotSet = (mode) => Object.fromEntries(
                snapshotViews.map((view) => [
                  view,
                  viewer.snapshot('image/png', { maxEdge: 1280, view, mode })
                ])
              );
              const snapshotDataURLs = {
                solid: buildSnapshotSet('solid'),
                xray: buildSnapshotSet('xray')
              };
              await api.notifyPartLoaded({
                part: payload.part,
                faceCount: partInfo.faceCount,
                bbox: partInfo.bbox,
                faces: partInfo.faces,
                snapshotDataURLs
              });
            } catch (e) {
              appendLog(t('failedReportPartInfo', { message: e.message || e }), 'warn');
            }
          }).catch(() => {});
          break;
        }
        setStatus(`${partLabel}${fmt === 'STL' ? t('parsingStl') : t('parsingBrep')} ...`, true);
        const sizeKB = payload.size ? (payload.size / 1024).toFixed(1) + ' KB' : '';
        viewer.loadModel(url, (msg) => appendLog(msg), { format: fmt, paramsUrl: payload.paramsUrl, preserveView })
          .then(async (partInfo) => {
            if (payload?.part) loadedPart = payload.part;
            renderPartsList();
            const explodeState = typeof viewer.getExplodeState === 'function' ? viewer.getExplodeState() : { enabled: false, available: false };
            if (explodeState.enabled && !explodeState.available) viewerUi.stopExplodedView();
            const { faceCount } = partInfo;
            const tail = fmt === 'MJCF'
              ? t('mjcfAssembly')
              : (fmt === 'STL' ? t('stlMesh') : t('brepFaces', { count: faceCount }));
            setStatus(
              t('modelReady', { partLabel, sizeLabel: sizeKB ? ' · ' + sizeKB : '', tail })
            );
            viewerUi.renderAll();
            // Send part info and single-view screenshots back to main process (MCP cache)
            try {
              // Wait one frame so OrbitControls and renderer.setSize first frame is stable
              await new Promise((r) => requestAnimationFrame(() => r()));
              const snapshotViews = ['iso', 'front', 'side', 'top'];
              const buildSnapshotSet = (mode) => Object.fromEntries(
                snapshotViews.map((view) => [
                  view,
                  viewer.snapshot('image/png', { maxEdge: 1280, view, mode })
                ])
              );
              const snapshotDataURLs = {
                solid: buildSnapshotSet('solid'),
                xray: buildSnapshotSet('xray')
              };
              await api.notifyPartLoaded({
                part: payload.part,
                faceCount: partInfo.faceCount,
                bbox: partInfo.bbox,
                faces: partInfo.faces,
                snapshotDataURLs
              });
            } catch (e) {
              appendLog(t('failedReportPartInfo', { message: e.message || e }), 'warn');
            }
          })
          .catch((e) => {
            viewerUi.stopAutoShow();
            viewerUi.stopExplodedView();
            setStatus(t('modelLoadFailed'));
            appendLog(t('failedLoadModel', { partLabel, format: fmt, message: e.message || e }), 'error');
            viewerUi.renderAll();
          });
        break;
      }
      case 'LOG':
        appendLog(payload.message, payload.level || 'info');
        break;
      case 'MENU_NEW_PROJECT':
        openNewProjectModal();
        break;
      case 'MENU_TOGGLE_DEBUG_TOOLS':
        setDebugToolsVisible(!!payload?.visible);
        break;
      case 'LANGUAGE_CHANGED':
        setLanguage(payload?.language || 'en');
        break;
      case 'DESKTOP_AUTH_CALLBACK':
        consumeNextAgentDesktopAuth(payload);
        break;
      case 'TERM_DATA':
        if (termPanel && termPanel.getTermId() === payload.termId) {
          termDataChunkCount += 1;
          if (termDataChunkCount === 1 || termDataChunkCount % 100 === 0) {
            termDebug('TERM_DATA', {
              termId: payload.termId,
              chunkCount: termDataChunkCount,
              size: String(payload.data || '').length
            });
          }
          termPanel.write(payload.data);
        }
        break;

      case 'TERM_EXIT':
        if (termPanel && termPanel.getTermId() === payload.termId) {
          termDebug('TERM_EXIT', { termId: payload.termId, exitCode: payload.exitCode ?? null });
          termPanel.printInfo(`Process exited (exit code: ${payload.exitCode ?? '?'})`);
          termPanel.attachSession(null);
        }
        break;
    }
  });

  // Debug tools are hidden by default, controlled by View menu
  setDebugToolsVisible(false);
  applyLayoutVisibility();
  syncExportControls();
  viewerUi.renderAll();

  initRendererI18n(api).then(refreshLocalizedUi);
  setStatus(t('waitingForProject'));
}
