// @ts-nocheck
import { createTerminalPanel } from './terminal-panel.js';
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
    previewModeBtns: document.querySelectorAll('[data-preview-mode]'),
    viewCubeHost: document.getElementById('viewcube-host'),
    viewControlPanel: document.getElementById('view-control-panel'),
    viewShowcaseBtn: document.getElementById('view-showcase'),
    viewExplodeBtn: document.getElementById('view-explode'),
    viewExplodeDistance: document.getElementById('view-explode-distance'),
    btnToggleLeft: document.getElementById('btn-toggle-left'),
    btnToggleRight: document.getElementById('btn-toggle-right'),
    btnToggleLeftHandle: document.getElementById('btn-toggle-left-handle'),
    btnToggleRightHandle: document.getElementById('btn-toggle-right-handle'),
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
    btnTermKill:     document.getElementById('btn-term-kill'),
    btnTermClose:    document.getElementById('btn-term-close')
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
  const LEFT_SIDEBAR_PREF_KEY = 'forgent3d.leftSidebarVisible';
  let leftSidebarVisible = false;
  let rightRailVisible = true;

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
    el.app.classList.toggle('right-collapsed', !rightRailVisible);
    if (el.btnToggleLeft) {
      el.btnToggleLeft.title = leftSidebarVisible ? 'Collapse left panel' : 'Expand left panel';
      el.btnToggleLeft.setAttribute('aria-label', leftSidebarVisible ? 'Collapse left panel' : 'Expand left panel');
      const icon = el.btnToggleLeft.querySelector('.collapse-icon');
      if (icon) icon.textContent = leftSidebarVisible ? '◀' : '▶';
    }
    if (el.btnToggleRight) {
      el.btnToggleRight.classList.toggle('active', rightRailVisible);
      el.btnToggleRight.title = rightRailVisible ? 'Collapse right panel' : 'Expand right panel';
      el.btnToggleRight.setAttribute('aria-label', rightRailVisible ? 'Collapse right panel' : 'Expand right panel');
      el.btnToggleRight.textContent = rightRailVisible ? '▶' : '◀';
    }
    if (el.btnToggleLeftHandle) el.btnToggleLeftHandle.classList.toggle('hidden', leftSidebarVisible || !hasProject);
    if (el.btnToggleRightHandle) el.btnToggleRightHandle.classList.toggle('hidden', rightRailVisible);
  }

  function syncExportControls() {
    const hasProject = !!currentProject;
    const hasActivePart = !!activePart;
    if (!el.selectExportFormat || !el.btnExportActive) return;

    const activeInfo = partsCache.find((part) => part.name === activePart);
    const isAssembly = activeInfo?.kind === 'asm';
    for (const option of Array.from(el.selectExportFormat.options || [])) {
      option.disabled = isAssembly && option.value === 'step';
    }
    if (isAssembly && el.selectExportFormat.value === 'step') {
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
  });

  const paramsEditor = createParamsEditorController({
    api,
    elements: el,
    getCurrentProject: () => currentProject,
    getActivePart: () => activePart
  });

  function renderModelNameBadge() {
    if (!el.modelNameBadge) return;
    if (!currentProject || !activePart) {
      el.modelNameBadge.textContent = '';
      el.modelNameBadge.classList.add('hidden');
      return;
    }
    el.modelNameBadge.textContent = `Current model: ${activePart}`;
    el.modelNameBadge.classList.remove('hidden');
  }

  function setProject(p, meta = null) {
    currentProject = p;
    currentKernel = meta?.kernel || null;
    leftSidebarVisible = p ? readLeftSidebarPreference() : false;
    if (!p) {
      activePart = null;
      loadedPart = null;
      viewerUi.stopAutoShow();
      viewerUi.stopExplodedView();
    }
    el.emptyHint.classList.toggle('hidden', !!p);
    el.partsPanel.style.display = p ? '' : 'none';
    if (el.paramsPanel) el.paramsPanel.style.display = p ? '' : 'none';
    el.agentBtns.forEach((btn) => { btn.disabled = !p; });
    applyLayoutVisibility();
    renderModelNameBadge();
    syncExportControls();
    viewerUi.renderAll();
    if (!p) paramsEditor.setIdle('Select a model to edit params.json');
  }

  /* ---------------- Models List ---------------- */
  function renderPartsList() {
    el.partsList.innerHTML = '';
    if (!partsCache.length) {
      const empty = document.createElement('li');
      empty.className = 'part-empty muted';
      empty.textContent = 'No models yet. Click + in the top-right to create one';
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
      title.textContent = p.kind === 'asm' ? `${p.name} (assembly)` : p.name;
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
      bReveal.title = 'Open in file explorer';
      bReveal.textContent = '📁';
      bReveal.addEventListener('click', (e) => {
        e.stopPropagation();
        api.revealPart(p.name);
      });
      const bBuild = document.createElement('button');
      bBuild.className = 'icon-btn';
      bBuild.title = 'Rebuild this model (part models also refresh models/<name>/<name>.stl)';
      bBuild.textContent = '↻';
      bBuild.addEventListener('click', (e) => {
        e.stopPropagation();
        api.rebuildPart(p.name);
      });
      actions.appendChild(bReveal);
      actions.appendChild(bBuild);

      li.appendChild(main);
      li.appendChild(actions);
      li.addEventListener('click', () => {
        if (p.name === activePart) return;
        if (paramsEditor.isDirty()) paramsEditor.flushPendingSave();
        api.selectPart(p.name);
      });
      el.partsList.appendChild(li);
    }
  }

  async function refreshParts() {
    if (!currentProject) return;
    try {
      const { parts, active } = await api.listParts();
      partsCache = parts || [];
      activePart = active;
      renderPartsList();
      renderModelNameBadge();
      syncExportControls();
      paramsEditor.refresh();
    } catch (e) {
      appendLog(`Failed to read models list: ${e.message}`, 'error');
    }
  }

  if (el.btnExportActive) {
    el.btnExportActive.addEventListener('click', async () => {
      if (!activePart) {
        showToast('Please select a model on the left first');
        return;
      }
      const fmt = (el.selectExportFormat?.value || 'stl').toLowerCase();
      try {
        const res = await api.exportPart(activePart, fmt);
        if (!res?.canceled) {
          const label = String(fmt).toUpperCase();
          showToast(`Exported <code>${escapeHtml(activePart)}</code> · <code>${label}</code>`);
        }
      } catch (e) {
        appendLog(`Export failed: ${e.message}`, 'error');
        showToast(`Export failed: ${escapeHtml(e.message || String(e))}`, 3800);
      }
    });
  }

  el.btnPartCancel.addEventListener('click', () => el.modalPart.classList.add('hidden'));
  el.btnPartConfirm.addEventListener('click', () => {
    el.modalPart.classList.add('hidden');
    showToast('Model creation from UI is disabled');
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
      setStatus('Creating project...', true);
      const p = await api.createProject(parent, name, DEFAULT_PROJECT_KERNEL);
      el.modal.classList.add('hidden');
      appendLog(`Project created (kernel: ${DEFAULT_PROJECT_KERNEL}): ${p}`);
    } catch (e) {
      appendLog(`Creation failed: ${e.message}`, 'error');
      alert(e.message);
      setStatus('Creation failed');
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
        appendLog(`Open project failed: ${e.message}`, 'error');
        showToast(`Open project failed: ${escapeHtml(e.message || String(e))}`, 3500);
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
  if (el.btnToggleRight) {
    el.btnToggleRight.addEventListener('click', () => {
      rightRailVisible = !rightRailVisible;
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
  if (el.btnToggleRightHandle) {
    el.btnToggleRightHandle.addEventListener('click', () => {
      rightRailVisible = true;
      applyLayoutVisibility();
    });
  }
  /* ============================================================
     Embedded terminal panel
     ============================================================ */

  const AGENT_LABELS = {
    codex:    '⚡ Codex',
    claude:   '◆ Claude Code',
    cli:      '▷ Cursor CLI'
  };

  let termPanel = null;      // instance returned by createTerminalPanel
  let termPanelOpen = false;
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

  function openTermPanel() {
    if (termPanelOpen) return;
    termPanelOpen = true;
    el.app.classList.add('term-open');
    el.termPanel.classList.add('open');
    termDebug('openTermPanel');
    // Initialize if xterm has not been mounted yet
    if (!termPanel) {
      termPanel = createTerminalPanel(el.termContainer, api);
      termDebug('createTerminalPanel done', {
        containerW: el.termContainer?.offsetWidth || 0,
        containerH: el.termContainer?.offsetHeight || 0
      });
    }
    // Retry fit/focus a few times after open to stabilize cursor/cell metrics.
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
      // Retry focus after panel open; xterm hidden textarea can lose focus on repeated open/close.
      termPanel?.focus();
      const tid = termPanel?.getTermId();
      if (tid) syncTermResize(tid, 'openPanel:stabilize');
      termDebug('fit#3(timeout)', {
        panelH: el.termPanel?.offsetHeight || 0,
        containerW: el.termContainer?.offsetWidth || 0,
        containerH: el.termContainer?.offsetHeight || 0
      });
    }, 220);
  }

  function closeTermPanel() {
    if (!termPanelOpen) return;
    termPanelOpen = false;
    el.app.classList.remove('term-open');
    el.termPanel.classList.remove('open');
    termDebug('closeTermPanel');
    if (termOpenFitTimer) {
      clearTimeout(termOpenFitTimer);
      termOpenFitTimer = null;
    }
    // Kill current PTY
    const tid = termPanel?.getTermId();
    if (tid) api.terminalKill(tid).catch(() => {});
    termPanel?.dispose();
    termPanel = null;
  }

  /* Initial width */
  setPanelWidth(TERM_DEFAULT_W);

  /* Close button */
  el.btnTermClose.addEventListener('click', closeTermPanel);

  /* Kill process button */
  el.btnTermKill.addEventListener('click', () => {
    const tid = termPanel?.getTermId();
    if (tid) {
      api.terminalKill(tid).catch(() => {});
      termPanel?.printInfo('Process terminated');
    }
  });

  /* Drag handle to resize width */
  el.termResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.termPanel.offsetWidth;
    const onMove = (mv) => {
      const delta = startX - mv.clientX;
      const w = Math.min(TERM_MAX_W, Math.max(TERM_MIN_W, startW + delta));
      setPanelWidth(w);
      termPanel?.fit();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      termPanel?.fit();
      const tid = termPanel?.getTermId();
      if (tid) syncTermResize(tid, 'dragEnd');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  /* Agent button click */
  el.agentBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const agent = btn.dataset.agent;
      if (!agent || !currentProject) return;

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
          `Previous terminal replaced with <code>${escapeHtml(AGENT_LABELS[agent] || agent)}</code>`,
          2200
        );
      }

      openTermPanel();
      if (!rightRailVisible) {
        rightRailVisible = true;
        applyLayoutVisibility();
      }
      el.termTitle.textContent = `Terminal — ${AGENT_LABELS[agent] || agent}`;
      termPanel?.printInfo(`Launching ${agent} · ${currentProject}`);

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
        appendLog(`Failed to launch ${agent}: ${e.message}`, 'error');
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
        setStatus(`Project opened (${payload.kernelLabel || payload.kernel || ''}), waiting for first build...`);
        appendLog(`Project opened: ${payload.path}`);
        if (payload.kernel) {
          appendLog(`Kernel: ${payload.kernelLabel || payload.kernel} · Source file: ${payload.sourceFile} · Preview format: ${payload.previewFormat}`);
        }
        refreshParts();
        break;
      case 'PARTS_LIST':
        partsCache = payload.parts || [];
        activePart = payload.active;
        renderPartsList();
        renderModelNameBadge();
        syncExportControls();
        viewerUi.renderAll();
        paramsEditor.refresh();
        break;
      case 'ACTIVE_PART_CHANGED':
        activePart = payload?.name || null;
        renderPartsList();
        renderModelNameBadge();
        syncExportControls();
        viewerUi.renderAll();
        paramsEditor.refresh({ force: true });
        break;
      case 'BUILD_STARTED':
        setStatus(payload?.part ? `Building ${payload.part} ...` : 'Building...', true);
        break;
      case 'BUILD_FAILED':
        setStatus('Build failed (see logs)');
        appendLog(
          (payload?.part ? `[${payload.part}] ` : '') +
          (payload?.message || payload?.stderr || 'Build failed'),
          'error'
        );
        if (payload?.reason === 'NO_PYTHON' || payload?.reason === 'NO_RUNTIME') {
          showToast(payload?.message || 'No usable build runtime detected.', 4500);
        }
        break;
      case 'PART_BUILT':
        // Refresh cache size/time in models list only
        refreshParts();
        break;
      case 'MODEL_UPDATED': {
        if (payload?.part) {
          if (payload.part !== loadedPart) viewerUi.stopAutoShow();
          activePart = payload.part;
          renderModelNameBadge();
        }
        const partLabel = payload.part ? `[${payload.part}] ` : '';
        const fmt = (payload.format || 'BREP').toUpperCase();
        setStatus(
          `${partLabel}${fmt === 'MJCF' ? 'Loading MJCF' : (fmt === 'STL' ? 'Parsing STL' : 'OCCT parsing BREP')} ...`,
          true
        );
        const sizeKB = payload.size ? (payload.size / 1024).toFixed(1) + ' KB' : '';
        const url = payload.url;
        if (!url) {
          appendLog('Main process did not return a URL, skipping load', 'warn');
          break;
        }
        const preserveView = !!payload.part && payload.part === loadedPart && typeof viewer.hasModel === 'function' && viewer.hasModel();
        viewer.loadModel(url, (msg) => appendLog(msg), { format: fmt, paramsUrl: payload.paramsUrl, preserveView })
          .then(async (partInfo) => {
            if (payload?.part) loadedPart = payload.part;
            const explodeState = typeof viewer.getExplodeState === 'function' ? viewer.getExplodeState() : { enabled: false, available: false };
            if (explodeState.enabled && !explodeState.available) viewerUi.stopExplodedView();
            const { faceCount } = partInfo;
            const tail = fmt === 'MJCF'
              ? 'MJCF assembly'
              : (fmt === 'STL' ? 'STL mesh' : `${faceCount} BREP faces`);
            setStatus(
              `${partLabel}Model ready${sizeKB ? ' · ' + sizeKB : ''} · ${tail}`
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
              appendLog(`Failed to report part info: ${e.message || e}`, 'warn');
            }
          })
          .catch((e) => {
            viewerUi.stopAutoShow();
            viewerUi.stopExplodedView();
            setStatus('Model load failed');
            appendLog(`${partLabel}Failed to load ${fmt}: ${e.message || e}`, 'error');
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

  setStatus('Waiting for project...');
}
