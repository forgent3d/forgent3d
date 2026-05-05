// @ts-nocheck

export function createViewerUiController({
  viewer,
  elements,
  getHasProject,
  getHasModel,
  appendLog
}) {
  let autoShowFrame = null;
  let autoShowModeLastTs = 0;
  let autoShowModeIndex = 0;
  let autoShowRunning = false;
  let autoShowStartTs = 0;
  const AUTO_SHOW_MODES = ['solid', 'xray'];
  const AUTO_SHOW_MODE_INTERVAL_MS = 4200;
  const AUTO_SHOW_ORBIT_SPEED = 0.32;
  const AUTO_SHOW_EXPLODE_TARGET = 0.5;
  const AUTO_SHOW_EXPLODE_IN_START_MS = 6200;
  const AUTO_SHOW_EXPLODE_IN_DURATION_MS = 2200;
  const AUTO_SHOW_EXPLODE_HOLD_MS = 2600;
  const AUTO_SHOW_EXPLODE_OUT_DURATION_MS = 2200;
  const AUTO_SHOW_CYCLE_MS = 22000;

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
    if (elements.viewExplodeBtn) {
      const canExplode = hasModel && !!explode.available;
      elements.viewExplodeBtn.classList.toggle('active', !!explode.enabled);
      elements.viewExplodeBtn.disabled = !canExplode;
      elements.viewExplodeBtn.setAttribute('aria-pressed', explode.enabled ? 'true' : 'false');
      elements.viewExplodeBtn.title = canExplode ? 'Toggle exploded view' : 'Explode needs multiple visible parts';
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
    elements.previewModeBtns.forEach((btn) => {
      const active = btn.dataset.previewMode === mode;
      btn.classList.toggle('active', active);
      btn.disabled = !hasModel;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function smoothStep(progress) {
    const t = Math.max(0, Math.min(1, Number(progress) || 0));
    return t * t * (3 - 2 * t);
  }

  function getAutoShowExplodeFactor(elapsedMs) {
    const cycleTs = elapsedMs % AUTO_SHOW_CYCLE_MS;
    const inStart = AUTO_SHOW_EXPLODE_IN_START_MS;
    const inEnd = inStart + AUTO_SHOW_EXPLODE_IN_DURATION_MS;
    const holdEnd = inEnd + AUTO_SHOW_EXPLODE_HOLD_MS;
    const outEnd = holdEnd + AUTO_SHOW_EXPLODE_OUT_DURATION_MS;

    if (cycleTs < inStart) return 0;
    if (cycleTs < inEnd) {
      return AUTO_SHOW_EXPLODE_TARGET * smoothStep((cycleTs - inStart) / AUTO_SHOW_EXPLODE_IN_DURATION_MS);
    }
    if (cycleTs < holdEnd) return AUTO_SHOW_EXPLODE_TARGET;
    if (cycleTs < outEnd) {
      return AUTO_SHOW_EXPLODE_TARGET * (1 - smoothStep((cycleTs - holdEnd) / AUTO_SHOW_EXPLODE_OUT_DURATION_MS));
    }
    return 0;
  }

  function runAutoShowFrame(ts) {
    if (!autoShowRunning) return;
    if (!getHasModel()) {
      stopAutoShow();
      return;
    }
    if (!autoShowStartTs) autoShowStartTs = ts;
    if (!autoShowModeLastTs) autoShowModeLastTs = ts;
    if (ts - autoShowModeLastTs >= AUTO_SHOW_MODE_INTERVAL_MS) {
      autoShowModeLastTs = ts;
      autoShowModeIndex = (autoShowModeIndex + 1) % AUTO_SHOW_MODES.length;
      if (typeof viewer.setPreviewMode === 'function') viewer.setPreviewMode(AUTO_SHOW_MODES[autoShowModeIndex]);
      renderPreviewToolbar();
    }
    const explode = typeof viewer.getExplodeState === 'function'
      ? viewer.getExplodeState()
      : { available: false };
    if (explode.available && typeof viewer.setExplodeFactor === 'function') {
      viewer.setExplodeFactor(getAutoShowExplodeFactor(ts - autoShowStartTs));
      renderViewControls();
    }
    autoShowFrame = requestAnimationFrame(runAutoShowFrame);
  }

  function startAutoShow() {
    if (autoShowRunning) return;
    if (!getHasModel()) {
      appendLog('Auto Showcase needs a loaded model.', 'warn');
      return;
    }
    autoShowRunning = true;
    autoShowModeLastTs = 0;
    autoShowModeIndex = 0;
    autoShowStartTs = 0;
    if (typeof viewer.setPreviewMode === 'function') viewer.setPreviewMode(AUTO_SHOW_MODES[autoShowModeIndex]);
    const explode = typeof viewer.getExplodeState === 'function'
      ? viewer.getExplodeState()
      : { available: false };
    if (explode.available && typeof viewer.setExplodeFactor === 'function') viewer.setExplodeFactor(0);
    if (typeof viewer.setAutoOrbitSpeed === 'function') viewer.setAutoOrbitSpeed(AUTO_SHOW_ORBIT_SPEED);
    autoShowFrame = requestAnimationFrame(runAutoShowFrame);
    renderPreviewToolbar();
    renderViewControls();
  }

  function stopAutoShow() {
    if (!autoShowRunning && !autoShowFrame) return;
    autoShowRunning = false;
    if (autoShowFrame) cancelAnimationFrame(autoShowFrame);
    autoShowFrame = null;
    autoShowModeLastTs = 0;
    autoShowStartTs = 0;
    if (typeof viewer.setAutoOrbitSpeed === 'function') viewer.setAutoOrbitSpeed(0);
    renderPreviewToolbar();
    renderViewControls();
  }

  function startExplodedView() {
    const state = typeof viewer.getExplodeState === 'function'
      ? viewer.getExplodeState()
      : { available: false };
    if (!getHasModel() || !state.available) {
      appendLog('Exploded View needs a loaded model with multiple visible parts.', 'warn');
      return;
    }
    if (typeof viewer.setExplodeEnabled === 'function') viewer.setExplodeEnabled(true);
    renderViewControls();
  }

  function stopExplodedView() {
    if (typeof viewer.setExplodeEnabled === 'function') viewer.setExplodeEnabled(false);
    renderViewControls();
  }

  elements.previewModeBtns.forEach((btn) => {
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
