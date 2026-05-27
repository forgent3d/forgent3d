// @ts-nocheck
import { createTerminalPanel } from './terminal-panel.js';
import { applyDocumentI18n, getLanguage, initRendererI18n, onLanguageChange, setLanguage, t } from './i18n.js';
import { createFirstModelWizardController } from './ui-first-model-wizard.js';
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
    sourcePreviewBtns: document.querySelectorAll('[data-source-preview]'),
    previewCadBtn: document.getElementById('preview-cad'),
    previewMotionBtn: document.getElementById('preview-motion'),
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

    viewShareBtn: document.getElementById('view-share-btn'),
    modalShare: document.getElementById('modal-share'),
    modalShareContent: document.getElementById('modal-share-content'),
    modalShareUrl: document.getElementById('modal-share-url'),
    modalSharePublic: document.getElementById('modal-share-public'),
    modalShareStatus: document.getElementById('modal-share-status'),
    modalShareLogin: document.getElementById('modal-share-login'),
    btnModalShareLogin: document.getElementById('btn-modal-share-login'),
    btnModalShareCopy: document.getElementById('btn-modal-share-copy'),
    btnModalShareClose: document.getElementById('btn-modal-share-close'),
    btnModalShareGenerate: document.getElementById('btn-modal-share-generate'),
    btnModalShareUnshare: document.getElementById('btn-modal-share-unshare'),

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
    selectModelKind: document.getElementById('select-model-kind'),

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
  const buildingModels = new Set();
  const expandedModels = new Set();
  let activeSourcePreviewMode = 'cad';
  const LEFT_SIDEBAR_PREF_KEY = 'forgent3d.leftSidebarVisible';
  let leftSidebarVisible = false;
  let openFirstModelWizardAfterProjectOpen = false;

  const firstModelWizard = createFirstModelWizardController({
    api,
    getCurrentProject: () => currentProject,
    getModels: () => partsCache,
    openNewProjectModal,
    setStatus,
    appendLog,
    showToast,
    refreshModels: refreshParts,
    escapeHtml
  });

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

  function activeExportTargetState() {
    if (!activePart) return { exportable: false };
    return { exportable: true };
  }

  function syncExportControls() {
    const hasProject = !!currentProject;
    const hasActivePart = !!activePart;
    if (!el.selectExportFormat || !el.btnExportActive) return;

    const exportState = activeExportTargetState();
    const exportEnabled = hasProject && hasActivePart && exportState.exportable;
    for (const option of Array.from(el.selectExportFormat.options || [])) {
      option.disabled = !exportEnabled;
    }
    el.selectExportFormat.disabled = !exportEnabled;
    el.btnExportActive.disabled = !exportEnabled;
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
      if (!activePart) return null;
      const parts = modelPartsFor(activePart);
      if (parts.length === 1) {
        const onlyPart = String(parts[0].name || parts[0].id || '');
        if (onlyPart) {
          return {
            model: activePart,
            part: onlyPart,
            label: `${activePart}/parts/${onlyPart}`
          };
        }
      }
      return { model: activePart, label: activePart };
    },
    t
  });

  function syncShareButton() {
    if (!el.viewShareBtn) return;
    const visible = !!currentProject && !!activePart;
    el.viewShareBtn.classList.toggle('hidden', !visible);
  }

  let shareDialogPublished = false;
  let sharePublicBusy = false;
  let shareAwaitingAuth = false;
  let shareRefreshTimer = null;
  const SHARE_AUTH_REQUIRED = 'SHARE_AUTH_REQUIRED';

  function isShareDialogOpen() {
    return !!el.modalShare && !el.modalShare.classList.contains('hidden');
  }

  function shouldRefreshShareDialog() {
    if (!isShareDialogOpen() || !activePart) return false;
    return shareAwaitingAuth || !el.modalShareLogin?.classList.contains('hidden');
  }

  function isShareAuthRequired(err) {
    const msg = String(err?.message || err || '');
    return msg.includes(SHARE_AUTH_REQUIRED)
      || /not signed in/i.test(msg)
      || /未授权/.test(msg);
  }

  /** @param {'loading' | 'login' | 'share'} mode */
  function setShareDialogMode(mode) {
    const loginOnly = mode === 'login';
    const loading = mode === 'loading';
    el.modalShareContent?.classList.toggle('hidden', loginOnly || loading);
    el.modalShareLogin?.classList.toggle('hidden', !loginOnly);
    el.btnModalShareGenerate?.classList.toggle('hidden', loginOnly || loading);
    if (loginOnly || loading) {
      el.btnModalShareUnshare?.classList.add('hidden');
    }
  }

  async function openShareExternalLogin() {
    if (!currentProject) return;
    shareAwaitingAuth = true;
    try {
      const res = await api.agentOpenNext(currentProject, undefined, true);
      el.modalShareStatus.textContent = t('shareSignInOpened');
      appendLog(t('nextAgentOpenedExternal', { url: res?.url || '' }));
      showToast(t('nextAgentOpenedExternalToast'), 2600);
    } catch (e) {
      shareAwaitingAuth = false;
      el.modalShareStatus.textContent = t('shareFailed', { message: e?.message || String(e) });
      showToast(t('shareFailed', { message: escapeHtml(e?.message || String(e)) }), 4200);
    }
  }

  function handleShareAuthRequired() {
    shareDialogPublished = false;
    shareAwaitingAuth = true;
    setShareDialogMode('login');
    el.modalShareStatus.textContent = '';
  }

  function scheduleShareDialogRefresh() {
    if (!shouldRefreshShareDialog()) return;
    if (shareRefreshTimer) clearTimeout(shareRefreshTimer);
    shareRefreshTimer = setTimeout(() => {
      shareRefreshTimer = null;
      void refreshShareDialogAfterAuth();
    }, 250);
  }

  async function refreshShareDialogAfterAuth() {
    if (!shouldRefreshShareDialog()) return;
    setShareDialogMode('loading');
    el.modalShareStatus.textContent = t('shareLoading');
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const status = await api.getShareStatus(activePart);
        shareAwaitingAuth = false;
        setShareDialogMode('share');
        applyShareDialogState(status);
        el.modalShareStatus.textContent = '';
        el.btnModalShareGenerate.disabled = false;
        if (el.modalSharePublic) el.modalSharePublic.disabled = false;
        return;
      } catch (err) {
        if (!isShareAuthRequired(err)) {
          shareAwaitingAuth = false;
          setShareDialogMode('share');
          el.modalShareStatus.textContent = t('shareFailed', { message: String(err?.message || err) });
          applyShareDialogState({ published: false });
          el.btnModalShareGenerate.disabled = false;
          if (el.modalSharePublic) el.modalSharePublic.disabled = false;
          return;
        }
        if (attempt < 7) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    }
    handleShareAuthRequired();
  }

  function applyShareDialogState(status) {
    shareDialogPublished = !!status?.published;
    if (shareDialogPublished && status?.shareUrl) {
      el.modalShareUrl.value = status.shareUrl;
      el.btnModalShareCopy.disabled = false;
      el.modalSharePublic.checked = !!status.isPublic;
      el.btnModalShareUnshare?.classList.remove('hidden');
      el.btnModalShareGenerate.textContent = t('shareUpdateSnapshot');
    } else {
      el.modalShareUrl.value = '';
      el.btnModalShareCopy.disabled = true;
      el.modalSharePublic.checked = !!status?.isPublic;
      el.btnModalShareUnshare?.classList.add('hidden');
      el.btnModalShareGenerate.textContent = t('shareCreateLink');
    }
  }

  async function openShareDialog() {
    if (!el.modalShare || !activePart) return;
    el.modalShare.classList.remove('hidden');
    setShareDialogMode('loading');
    el.modalShareStatus.textContent = t('shareLoading');
    el.btnModalShareGenerate.disabled = true;
    el.btnModalShareCopy.disabled = true;
    if (el.modalSharePublic) el.modalSharePublic.disabled = true;
    try {
      const status = await api.getShareStatus(activePart);
      shareAwaitingAuth = false;
      setShareDialogMode('share');
      applyShareDialogState(status);
      el.modalShareStatus.textContent = '';
    } catch (err) {
      if (isShareAuthRequired(err)) {
        handleShareAuthRequired();
      } else {
        shareAwaitingAuth = false;
        setShareDialogMode('share');
        el.modalShareStatus.textContent = t('shareFailed', { message: String(err?.message || err) });
        applyShareDialogState({ published: false });
      }
    } finally {
      if (el.modalShareLogin?.classList.contains('hidden')) {
        el.btnModalShareGenerate.disabled = false;
        if (el.modalSharePublic) el.modalSharePublic.disabled = false;
      }
    }
  }

  function closeShareDialog() {
    el.modalShare?.classList.add('hidden');
    shareAwaitingAuth = false;
    if (shareRefreshTimer) {
      clearTimeout(shareRefreshTimer);
      shareRefreshTimer = null;
    }
    setShareDialogMode('share');
  }

  function captureSharePreviewDataUrl() {
    if (typeof viewer.hasModel !== 'function' || !viewer.hasModel()) return null;
    return viewer.snapshot('image/png', { view: 'current', maxEdge: 1280 }) || null;
  }

  async function generateShareLink() {
    if (!activePart) return;
    const modelName = activePart;
    const isPublic = !!el.modalSharePublic?.checked;
    el.btnModalShareGenerate.disabled = true;
    el.modalShareStatus.textContent = t('sharePublishing');
    try {
      const previewDataUrl = captureSharePreviewDataUrl();
      const result = await api.shareModel(modelName, { isPublic, previewDataUrl });
      applyShareDialogState(result);
      el.modalShareStatus.textContent = t('shareLinkReady');
      el.modalShareUrl.focus();
      el.modalShareUrl.select();
    } catch (err) {
      if (isShareAuthRequired(err)) {
        handleShareAuthRequired();
        await openShareExternalLogin();
      } else {
        el.modalShareStatus.textContent = t('shareFailed', { message: String(err?.message || err) });
      }
    } finally {
      el.btnModalShareGenerate.disabled = false;
    }
  }

  async function unshareModelLink() {
    if (!activePart || !shareDialogPublished) return;
    const modelName = activePart;
    el.btnModalShareUnshare.disabled = true;
    el.modalShareStatus.textContent = t('sharePublishing');
    try {
      await api.unshareModel(modelName);
      applyShareDialogState({ published: false });
      el.modalShareStatus.textContent = t('shareRemoved');
    } catch (err) {
      if (isShareAuthRequired(err)) {
        handleShareAuthRequired();
      } else {
        el.modalShareStatus.textContent = t('shareFailed', { message: String(err?.message || err) });
      }
    } finally {
      el.btnModalShareUnshare.disabled = false;
    }
  }

  async function onSharePublicToggle() {
    if (!activePart || !shareDialogPublished || sharePublicBusy) return;
    sharePublicBusy = true;
    const isPublic = !!el.modalSharePublic?.checked;
    try {
      const result = await api.updateSharePublic(activePart, isPublic);
      applyShareDialogState(result);
    } catch (err) {
      if (el.modalSharePublic) el.modalSharePublic.checked = !isPublic;
      if (isShareAuthRequired(err)) {
        handleShareAuthRequired();
      } else {
        el.modalShareStatus.textContent = t('shareFailed', { message: String(err?.message || err) });
      }
    } finally {
      sharePublicBusy = false;
    }
  }

  if (el.viewShareBtn) {
    el.viewShareBtn.addEventListener('click', openShareDialog);
  }
  if (el.btnModalShareClose) {
    el.btnModalShareClose.addEventListener('click', closeShareDialog);
  }
  if (el.modalShare) {
    el.modalShare.addEventListener('click', (e) => {
      if (e.target === el.modalShare) closeShareDialog();
    });
  }
  if (el.btnModalShareGenerate) {
    el.btnModalShareGenerate.addEventListener('click', generateShareLink);
  }
  if (el.btnModalShareLogin) {
    el.btnModalShareLogin.addEventListener('click', openShareExternalLogin);
  }
  if (el.btnModalShareUnshare) {
    el.btnModalShareUnshare.addEventListener('click', unshareModelLink);
  }
  if (el.modalSharePublic) {
    el.modalSharePublic.addEventListener('change', onSharePublicToggle);
  }
  if (el.btnModalShareCopy) {
    el.btnModalShareCopy.addEventListener('click', async () => {
      const url = el.modalShareUrl.value;
      if (!url) return;
      try {
        await api.clipboardWriteText(url);
        el.modalShareStatus.textContent = t('shareCopied');
      } catch (err) {
        el.modalShareStatus.textContent = t('shareCopyFailed', { message: String(err?.message || err) });
      }
    });
  }

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
    syncShareButton();
    syncSourcePreviewControls();
    renderPartsList();
    viewerUi.renderAll();
    if (!currentProject) {
      paramsEditor.setIdle(t('selectModelParams'));
      setStatus(t('waitingForProject'));
    }
  }

  onLanguageChange(refreshLocalizedUi);

  function setProject(p, meta = null) {
    const projectChanged = p !== currentProject;
    currentProject = p;
    currentKernel = meta?.kernel || null;
    leftSidebarVisible = p ? readLeftSidebarPreference() : false;
    if (projectChanged) {
      partsCache = [];
      activePart = null;
      loadedPart = null;
      selectedModelPart = null;
      selectedModelPartModel = null;
      displayedModelPart = null;
      activeSourcePreviewMode = 'cad';
      assemblyPayloads.clear();
      expandedModels.clear();
      if (typeof viewer.setSelectedPart === 'function') viewer.setSelectedPart(null);
    }
    if (!p) {
      viewerUi.stopAutoShow();
      viewerUi.stopExplodedView();
    }
    el.emptyHint.classList.toggle('hidden', !!p);
    el.partsPanel.style.display = p ? '' : 'none';
    if (el.paramsPanel) el.paramsPanel.style.display = p ? '' : 'none';
    el.agentBtns.forEach((btn) => { btn.disabled = !p; });
    applyLayoutVisibility();
    syncModelKindButtons();
    renderModelNameBadge();
    syncShareButton();
    syncExportControls();
    syncSourcePreviewControls();
    viewerUi.renderAll();
    if (!p) paramsEditor.setIdle(t('selectModelParams'));
  }

  function modelPartsFor(modelName) {
    const model = partsCache.find((item) => item.name === modelName);
    return Array.isArray(model?.parts) ? model.parts : [];
  }

  function findModelPart(modelName, partName) {
    const target = String(partName || '');
    return modelPartsFor(modelName).find((part) => String(part.name || part.id || '') === target) || null;
  }

  function findModelPartByPick(modelName, pickedId) {
    const target = String(pickedId || '');
    if (!target) return null;
    const direct = findModelPart(modelName, target);
    if (direct) return direct;
    const lower = target.toLowerCase();
    return modelPartsFor(modelName).find((part) => {
      const partId = String(part.name || part.id || '');
      const idLower = partId.toLowerCase();
      return idLower === lower
        || lower.startsWith(`${idLower}/`)
        || lower.endsWith(`/${idLower}`)
        || lower.includes(idLower);
    }) || null;
  }

  function syncSelectionFromViewer(partKey) {
    if (!activePart) return;
    if (partKey == null || partKey === '') {
      if (!displayedModelPart) {
        selectedModelPart = null;
        selectedModelPartModel = null;
        renderPartsList();
        paramsEditor.refresh();
      }
      return;
    }
    const part = findModelPartByPick(activePart, partKey);
    const partId = String(part?.name || part?.id || partKey);
    const changed = selectedModelPartModel !== activePart || selectedModelPart !== partId;
    selectedModelPart = partId;
    selectedModelPartModel = activePart;
    if (modelPartsFor(activePart).length >= 2) expandedModels.add(activePart);
    if (changed) {
      renderPartsList();
      paramsEditor.refresh({ force: true });
    } else {
      syncExportControls();
    }
  }

  function syncSourcePreviewControls(payload = assemblyPayloads.get(activePart)) {
    const motionReady = !!payload?.motionReady && !!payload?.motionUrl;
    if (activeSourcePreviewMode === 'motion' && !motionReady) activeSourcePreviewMode = 'cad';
    el.sourcePreviewBtns?.forEach((btn) => {
      const mode = btn.dataset.sourcePreview || 'cad';
      const active = mode === activeSourcePreviewMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.disabled = mode === 'motion' && !motionReady;
      if (mode === 'motion') {
        btn.title = payload?.hasMotionPreview
          ? (motionReady ? t('motionPreview') : t('buildingPart', { part: activePart || '' }))
          : t('motionPreview');
      }
    });
  }

  function previewPayloadForMode(payload) {
    const motionReady = !!payload?.motionReady && !!payload?.motionUrl;
    const mode = activeSourcePreviewMode === 'motion' && motionReady ? 'motion' : 'cad';
    if (mode !== activeSourcePreviewMode) activeSourcePreviewMode = mode;
    return {
      mode,
      url: mode === 'motion' ? payload.motionUrl : payload.url,
      paramsUrl: mode === 'motion' ? (payload.motionParamsUrl || payload.paramsUrl) : payload.paramsUrl,
      format: mode === 'motion' ? (payload.motionFormat || 'MJCF') : (payload.format || 'BREP'),
      unitScale: mode === 'motion' ? payload.motionUnitScale : payload.unitScale,
      coordinateSystem: mode === 'motion' ? payload.motionCoordinateSystem : payload.coordinateSystem
    };
  }

  async function showAssembly(modelName = activePart, { preserveView = true } = {}) {
    selectedModelPart = null;
    selectedModelPartModel = null;
    displayedModelPart = null;
    syncExportControls();
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
    syncSourcePreviewControls(payload);
    const preview = previewPayloadForMode(payload);
    const fmt = String(preview.format || 'BREP').toUpperCase();
    const partLabel = payload.part ? `[${payload.part}] ` : '';
    const loadingLabel = fmt === 'MJCF'
      ? (preview.mode === 'motion' ? t('loadingMotion') : t('loadingMjcf'))
      : (fmt === 'GLB' ? t('parsingGlb') : (fmt === 'STL' ? t('parsingStl') : t('parsingBrep')));
    setStatus(`${partLabel}${loadingLabel} ...`, true);
    try {
      const partInfo = await viewer.loadModel(preview.url, (msg) => appendLog(msg), {
        format: fmt,
        paramsUrl: preview.paramsUrl,
        preserveView,
        unitScale: preview.unitScale,
        coordinateSystem: preview.coordinateSystem
      });
      if (payload?.part) loadedPart = payload.part;
      const modelParts = modelPartsFor(payload.part);
      if (payload?.part && modelParts.length >= 2) expandedModels.add(payload.part);
      renderPartsList();
      const sizeKB = payload.size ? (payload.size / 1024).toFixed(1) + ' KB' : '';
      const tail = fmt === 'MJCF'
        ? (preview.mode === 'motion' ? t('motionPreviewReady') : t('mjcfAssembly'))
        : (fmt === 'GLB' ? t('glbModel') : (fmt === 'STL' ? t('stlMesh') : t('brepFaces', { count: partInfo?.faceCount ?? 0 })));
      setStatus(t('modelReady', { partLabel, sizeLabel: sizeKB ? sizeKB : '', tail }));
      viewerUi.renderAll();
      return partInfo;
    } catch (e) {
      const message = e.message || String(e);
      const waitingForMeshes = modelName && (buildingModels.has(modelName) || /404/.test(message));
      if (waitingForMeshes) {
        setStatus(t('buildingPart', { part: modelName }), true);
        return;
      }
      setStatus(t('modelLoadFailed'));
      appendLog(t('failedLoadModel', { partLabel, format: fmt, message }), 'error');
      showToast(t('failedLoadModel', { partLabel, format: fmt, message: escapeHtml(message) }), 3800);
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
    syncExportControls();
    paramsEditor.refresh({ force: true });
    if (typeof viewer.setSelectedPart === 'function') viewer.setSelectedPart(null);
    renderPartsList();
    setStatus(`[${part.name || partId}] ${part.hasStl ? t('parsingStl') : t('buildingPart', { part: partId })} ...`, true);
    try {
      const stl = await api.ensureModelPartStl(modelName, partId);
      part.hasStl = true;
      part.stlUrl = stl.url;
      const parentPayload = assemblyPayloads.get(modelName);
      const partInfo = await viewer.loadModel(stl.url, (msg) => appendLog(msg), {
        format: 'STL',
        paramsUrl: parentPayload?.paramsUrl,
        preserveView: false,
        materialPart: partId
      });
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
      li.className = 'model-part-item' + (selectedModelPartModel === modelName && selectedModelPart === partId ? ' selected' : '');
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
      const bDelete = document.createElement('button');
      bDelete.className = 'icon-btn icon-btn--danger';
      bDelete.title = t('deleteModelTitle');
      bDelete.textContent = '🗑';
      bDelete.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await api.dialogConfirm({
          title: t('deleteModelTitle'),
          message: t('deleteModelConfirm', { name: p.name }),
          confirmLabel: t('moveToTrash'),
          cancelLabel: t('cancel'),
        });
        if (!confirmed) return;
        try {
          bDelete.disabled = true;
          await api.deleteModel(p.name);
          await refreshParts();
        } catch (err) {
          showToast(String(err?.message || err));
        } finally {
          bDelete.disabled = false;
        }
      });
      actions.appendChild(bReveal);
      actions.appendChild(bBuild);
      actions.appendChild(bDelete);

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
    syncExportControls();
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
      syncShareButton();
      syncExportControls();
      syncSourcePreviewControls();
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
        const exportPart = selectedModelPartModel === activePart ? selectedModelPart : null;
        const res = await api.exportModel(activePart, fmt, exportPart ? { part: exportPart } : {});
        if (!res?.canceled) {
          const label = String(fmt).toUpperCase();
          showToast(t('exported', { name: escapeHtml(exportPart || activePart), format: label }));
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

  el.sourcePreviewBtns?.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.sourcePreview || 'cad';
      if (mode === 'motion' && btn.disabled) return;
      activeSourcePreviewMode = mode === 'motion' ? 'motion' : 'cad';
      syncSourcePreviewControls();
      if (activePart) showAssembly(activePart, { preserveView: true }).catch(() => {});
    });
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
      openFirstModelWizardAfterProjectOpen = true;
      const p = await api.createProject(parent, name, DEFAULT_PROJECT_KERNEL);
      el.modal.classList.add('hidden');
      appendLog(t('projectCreated', { kernel: DEFAULT_PROJECT_KERNEL, path: p }));
    } catch (e) {
      openFirstModelWizardAfterProjectOpen = false;
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

  function setNextAgentBridgePreload(preloadUrl) {
    if (!el.agentNextFrame || !preloadUrl) return;
    if (el.agentNextFrame.getAttribute('preload') !== preloadUrl) {
      el.agentNextFrame.setAttribute('preload', preloadUrl);
    }
  }

  function syncNextAgentLanguage(language = getLanguage()) {
    if (!el.agentNextFrame || !language) return;
    const payload = JSON.stringify({ type: 'FORGENT3D_LANGUAGE_CHANGED', language });
    try {
      if (typeof el.agentNextFrame.executeJavaScript === 'function') {
        el.agentNextFrame.executeJavaScript(`
          window.postMessage(${payload}, '*');
          try {
            const url = new URL(window.location.href);
            url.searchParams.set('lang', ${JSON.stringify(language)});
            window.history.replaceState(window.history.state, '', url.toString());
          } catch {}
        `, false).catch(() => {});
      }
    } catch {}
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
      setNextAgentBridgePreload(res?.preloadUrl);
      if (el.agentNextFrame && el.agentNextFrame.src !== res?.url) {
        el.agentNextFrame.src = res?.url || 'about:blank';
      } else {
        clearNextAgentWebviewLoadIntent();
        syncNextAgentLanguage();
      }
      appendLog(t('nextAgentOpened', { url: res?.url || '' }));
    } catch (e) {
      clearNextAgentWebviewLoadIntent();
      setNextAgentGuideVisible(true);
      appendLog(t('nextAgentOpenFailed', { message: e?.message || String(e) }), 'error');
      showToast(t('nextAgentOpenFailed', { message: escapeHtml(e?.message || String(e)) }), 4200);
    }
  }

  async function consumeNextAgentDesktopAuth(payload) {
    const token = String(payload?.token || '');
    const rawBaseUrl = String(payload?.baseUrl || '');
    if (!token || !rawBaseUrl) return;
    try {
      const url = new URL('/desktop-auth/consume', rawBaseUrl.replace(/\/+$/, '') + '/');
      url.searchParams.set('token', token);
      const projectPath = String(payload?.projectPath || currentProject || '');
      if (projectPath) url.searchParams.set('projectPath', projectPath);
      url.searchParams.set('lang', payload?.language || getLanguage());
      const bridgeInfo = await api.agentBridgeInfo?.().catch(() => null);
      url.searchParams.set('embedded', '1');
      if (bridgeInfo?.desktopCallbackUrl) {
        url.searchParams.set('desktopCallbackUrl', bridgeInfo.desktopCallbackUrl);
      }
      setNextAgentBridgePreload(bridgeInfo?.preloadUrl);
      pendingNextAgentWebviewLoad = true;
      openTermPanel('next');
      setNextAgentGuideVisible(false);
      setNextAgentLoadingVisible(true);
      el.termTitle.textContent = t('nextAgentPanelTitle');
      if (el.agentNextFrame) el.agentNextFrame.src = url.toString();
      appendLog(t('nextAgentDesktopAuthReceived'));
      scheduleShareDialogRefresh();
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
      if (pendingNextAgentWebviewLoad) {
        pendingNextAgentWebviewLoad = false;
        setNextAgentLoadingVisible(false);
        syncNextAgentLanguage();
      }
      scheduleShareDialogRefresh();
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
        el.termTitle.textContent = t('nextAgentPanelTitle');
        await openNextAgentEmbedded();
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
        if (openFirstModelWizardAfterProjectOpen) {
          openFirstModelWizardAfterProjectOpen = false;
          requestAnimationFrame(() => firstModelWizard.open());
        }
        break;
      case 'MODELS_LIST':
        partsCache = payload.models || [];
        activePart = payload.active;
        if (!activePart || !partsCache.some((model) => model.name === activePart)) {
          activePart = null;
          loadedPart = null;
          displayedModelPart = null;
          selectedModelPart = null;
          selectedModelPartModel = null;
          assemblyPayloads.clear();
          buildingModels.clear();
          viewerUi.stopAutoShow();
          viewerUi.stopExplodedView();
          if (typeof viewer.clearModel === 'function') viewer.clearModel();
          paramsEditor.setIdle(t('selectModelParams'));
        }
        syncModelListKindToModel(activePart, { render: false });
        renderPartsList();
        renderModelNameBadge();
        syncShareButton();
        syncExportControls();
        syncSourcePreviewControls();
        viewerUi.renderAll();
        paramsEditor.refresh();
        break;
      case 'ACTIVE_MODEL_CHANGED':
        activePart = payload?.name || null;
        displayedModelPart = null;
        selectedModelPart = null;
        selectedModelPartModel = null;
        if (payload?.name) assemblyPayloads.delete(payload.name);
        syncModelListKindToModel(activePart, { render: false });
        renderPartsList();
        renderModelNameBadge();
        syncShareButton();
        syncExportControls();
        syncSourcePreviewControls();
        viewerUi.renderAll();
        paramsEditor.refresh({ force: true });
        break;
      case 'BUILD_STARTED':
        if (payload?.part) buildingModels.add(payload.part);
        if (payload?.part && payload.part === activePart) {
          syncModelListKindToModel(payload.part, { render: false });
          renderPartsList();
        }
        setStatus(payload?.part ? t('buildingPart', { part: payload.part }) : t('building'), true);
        break;
      case 'BUILD_FAILED':
        if (payload?.part) buildingModels.delete(payload.part);
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
        if (payload?.part) buildingModels.delete(payload.part);
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
          syncShareButton();
        }
        const url = payload.url;
        if (!url) {
          appendLog(t('missingModelUrl'), 'warn');
          break;
        }
        if (payload.part) {
          assemblyPayloads.set(payload.part, { ...payload });
          buildingModels.delete(payload.part);
          syncSourcePreviewControls(payload);
        }
        const preserveView = !!payload.part && payload.part === loadedPart && typeof viewer.hasModel === 'function' && viewer.hasModel();
        const partLabel = payload.part ? `[${payload.part}] ` : '';
        if (payload.part && displayedModelPart && selectedModelPartModel === payload.part) {
          const selectedPart = findModelPart(payload.part, displayedModelPart)
            || findModelPart(payload.part, selectedModelPart)
            || { name: displayedModelPart };
          showModelPart(payload.part, selectedPart).catch(() => {});
          break;
        }
        if (payload.part) {
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
        const fmt = (payload.format || 'BREP').toUpperCase();
        const loadingLabel = fmt === 'GLB'
          ? t('parsingGlb')
          : (fmt === 'STL' ? t('parsingStl') : t('parsingBrep'));
        setStatus(`${partLabel}${loadingLabel} ...`, true);
        const sizeKB = payload.size ? (payload.size / 1024).toFixed(1) + ' KB' : '';
        viewer.loadModel(url, (msg) => appendLog(msg), {
          format: fmt,
          paramsUrl: payload.paramsUrl,
          preserveView,
          unitScale: payload.unitScale,
          coordinateSystem: payload.coordinateSystem
        })
          .then(async (partInfo) => {
            if (payload?.part) loadedPart = payload.part;
            renderPartsList();
            const explodeState = typeof viewer.getExplodeState === 'function' ? viewer.getExplodeState() : { enabled: false, available: false };
            if (explodeState.enabled && !explodeState.available) viewerUi.stopExplodedView();
            const { faceCount } = partInfo;
            const tail = fmt === 'MJCF'
              ? t('mjcfAssembly')
              : (fmt === 'GLB' ? t('glbModel') : (fmt === 'STL' ? t('stlMesh') : t('brepFaces', { count: faceCount })));
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
      case 'MODEL_GLB_READY':
        if (!payload?.part || payload.part !== activePart) break;
        if (displayedModelPart || selectedModelPartModel === payload.part) break;
        assemblyPayloads.set(payload.part, {
          ...(assemblyPayloads.get(payload.part) || {}),
          ...payload,
          format: 'GLB'
        });
        showAssembly(payload.part, { preserveView: true }).catch(() => {});
        break;
      case 'LOG':
        appendLog(payload.message, payload.level || 'info');
        break;
      case 'MENU_NEW_PROJECT':
        openNewProjectModal();
        break;
      case 'MENU_OPEN_EXAMPLE_WIZARD':
        firstModelWizard.open();
        break;
      case 'MENU_TOGGLE_DEBUG_TOOLS':
        setDebugToolsVisible(!!payload?.visible);
        break;
      case 'LANGUAGE_CHANGED':
        setLanguage(payload?.language || 'en');
        syncNextAgentLanguage(payload?.language || 'en');
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

  if (typeof viewer.setOnSelectedPartChange === 'function') {
    viewer.setOnSelectedPartChange(syncSelectionFromViewer);
  }

  initRendererI18n(api).then(refreshLocalizedUi);
  setStatus(t('waitingForProject'));
}
