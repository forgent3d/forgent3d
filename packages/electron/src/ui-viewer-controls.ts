// @ts-nocheck

export function createViewerUiController({
  viewer,
  elements,
  getHasProject,
  getHasModel,
  appendLog,
  t = (key) => key
}) {
  let autoShowRunning = false;
  const AUTO_SHOW_ORBIT_SPEED = 0.32;

  if (elements.viewCubeHost && typeof viewer.mountViewCube === 'function') {
    viewer.mountViewCube(elements.viewCubeHost);
  }

  function renderViewCube() {
    if (!elements.viewCubeHost) return;
    const hasProject = getHasProject();
    const hasModel = getHasModel();
    elements.viewCubeHost.classList.toggle('hidden', !hasProject);
    elements.viewCubeHost.classList.toggle('disabled', !hasModel);
    if (typeof viewer.setViewCubeEnabled === 'function') {
      viewer.setViewCubeEnabled(hasModel);
    }
  }

  function renderViewControls() {
    if (!elements.viewControlPanel) return;
    const hasProject = getHasProject();
    const hasModel = getHasModel();
    const explode = typeof viewer.getExplodeState === 'function'
      ? viewer.getExplodeState()
      : { enabled: false, factor: 0, available: false };
    elements.viewControlPanel.classList.toggle('hidden', !hasProject || !hasModel);
    if (elements.viewShowcaseBtn) {
      elements.viewShowcaseBtn.classList.toggle('active', autoShowRunning);
      elements.viewShowcaseBtn.disabled = !hasModel;
      elements.viewShowcaseBtn.setAttribute('aria-pressed', autoShowRunning ? 'true' : 'false');
    }
    elements.viewModeBtns?.forEach((btn) => {
      const mode = typeof viewer.getPreviewMode === 'function' ? viewer.getPreviewMode() : 'solid';
      const active = btn.dataset.previewMode === mode;
      btn.classList.toggle('active', active);
      btn.disabled = !hasModel;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (elements.viewExplodeBtn) {
      const canExplode = hasModel && !!explode.available;
      elements.viewExplodeBtn.classList.toggle('active', !!explode.enabled);
      elements.viewExplodeBtn.disabled = !canExplode;
      elements.viewExplodeBtn.setAttribute('aria-pressed', explode.enabled ? 'true' : 'false');
      elements.viewExplodeBtn.title = canExplode ? t('toggleExplodedView') : t('explodeNeedsParts');
    }
    if (elements.viewExplodeDistance) {
      elements.viewExplodeDistance.disabled = !hasModel || !explode.available;
      elements.viewExplodeDistance.value = String(Math.round((Number(explode.factor) || 0) * 100));
    }
  }

  function renderPreviewToolbar() {
    if (!elements.previewToolbar) return;
    const hasProject = getHasProject();
    const hasModel = getHasModel();
    const mode = typeof viewer.getPreviewMode === 'function' ? viewer.getPreviewMode() : 'solid';
    elements.previewToolbar.classList.toggle('hidden', !hasProject || !hasModel);
    elements.viewModeBtns?.forEach((btn) => {
      const active = btn.dataset.previewMode === mode;
      btn.classList.toggle('active', active);
      btn.disabled = !hasModel;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function startAutoShow() {
    if (autoShowRunning) return;
    if (!getHasModel()) {
      appendLog(t('autoShowNeedsModel'), 'warn');
      return;
    }
    autoShowRunning = true;
    if (typeof viewer.setAutoOrbitSpeed === 'function') viewer.setAutoOrbitSpeed(AUTO_SHOW_ORBIT_SPEED);
    renderViewControls();
  }

  function stopAutoShow() {
    if (!autoShowRunning) return;
    autoShowRunning = false;
    if (typeof viewer.setAutoOrbitSpeed === 'function') viewer.setAutoOrbitSpeed(0);
    renderViewControls();
  }

  function startExplodedView() {
    const state = typeof viewer.getExplodeState === 'function'
      ? viewer.getExplodeState()
      : { available: false };
    if (!getHasModel() || !state.available) {
      appendLog(t('explodeNeedsLoadedParts'), 'warn');
      return;
    }
    if (typeof viewer.setExplodeEnabled === 'function') viewer.setExplodeEnabled(true);
    renderViewControls();
  }

  function stopExplodedView() {
    if (typeof viewer.setExplodeEnabled === 'function') viewer.setExplodeEnabled(false);
    renderViewControls();
  }

  elements.viewModeBtns?.forEach((btn) => {
    btn.addEventListener('click', () => {
      stopAutoShow();
      const mode = btn.dataset.previewMode || 'solid';
      if (typeof viewer.setPreviewMode === 'function') viewer.setPreviewMode(mode);
      renderPreviewToolbar();
      renderViewControls();
    });
  });
  if (elements.viewShowcaseBtn) {
    elements.viewShowcaseBtn.addEventListener('click', () => {
      if (autoShowRunning) stopAutoShow();
      else startAutoShow();
    });
  }
  if (elements.viewExplodeBtn) {
    elements.viewExplodeBtn.addEventListener('click', () => {
      const state = typeof viewer.getExplodeState === 'function'
        ? viewer.getExplodeState()
        : { enabled: false, available: false };
      if (!state.available) return;
      if (state.enabled) stopExplodedView();
      else startExplodedView();
    });
  }
  if (elements.viewExplodeDistance) {
    elements.viewExplodeDistance.addEventListener('input', () => {
      const factor = Number(elements.viewExplodeDistance.value) / 100;
      if (typeof viewer.setExplodeFactor === 'function') viewer.setExplodeFactor(factor);
      renderViewControls();
    });
  }

  function renderAll() {
    renderPreviewToolbar();
    renderViewCube();
    renderViewControls();
  }

  return {
    renderAll,
    renderViewCube,
    renderViewControls,
    renderPreviewToolbar,
    stopAutoShow,
    stopExplodedView
  };
}
