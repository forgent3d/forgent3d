// @ts-nocheck

export function createParamsEditorController({
  api,
  elements,
  getCurrentProject,
  getParamsTarget,
  t = (key) => key
}) {
  let paramsModel = null;
  let paramsTarget = null;
  let paramsLabel = null;
  let paramsOriginal = null;
  let paramsSaved = null;
  let paramsWorking = null;
  let paramsDirty = false;
  let paramsLoadSeq = 0;
  let paramsSaveTimer = null;
  let paramsSaving = false;

  function setStatus(text, state = '') {
    if (!elements.paramsStatus) return;
    elements.paramsStatus.textContent = text || '';
    elements.paramsStatus.classList.toggle('error', state === 'error');
    elements.paramsStatus.classList.toggle('ok', state === 'ok');
  }

  function setDirty(next) {
    paramsDirty = !!next;
    if (elements.btnParamsRevert) {
      elements.btnParamsRevert.disabled = !getCurrentProject() || !getParamsTarget() || !paramsDirty;
    }
  }

  function clearPendingSave() {
    if (!paramsSaveTimer) return;
    clearTimeout(paramsSaveTimer);
    paramsSaveTimer = null;
  }

  function cloneParams(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
  }

  function paramsEqual(left, right) {
    return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
  }

  function hasRevertableChanges() {
    return !paramsEqual(paramsWorking, paramsOriginal) || !paramsEqual(paramsSaved, paramsOriginal);
  }

  function hasUnsavedChanges() {
    return !paramsEqual(paramsWorking, paramsSaved);
  }

  function collectNumericParams(value, prefix = []) {
    if (!value || typeof value !== 'object') return [];
    const rows = [];
    for (const [key, child] of Object.entries(value)) {
      const path = [...prefix, key];
      if (typeof child === 'number' && Number.isFinite(child)) {
        rows.push({ path, value: child });
      } else if (child && typeof child === 'object' && !Array.isArray(child)) {
        rows.push(...collectNumericParams(child, path));
      }
    }
    return rows;
  }

  function setParamValue(root, path, value) {
    let current = root;
    for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
    current[path[path.length - 1]] = value;
  }

  function targetKey(target) {
    if (!target) return '';
    if (typeof target === 'string') return target;
    return `${target.model || target.name || ''}::${target.part || ''}`;
  }

  function targetLabel(target, fallback = '') {
    if (!target) return fallback;
    if (typeof target === 'string') return target;
    if (target.label) return target.label;
    if (target.part) return `${target.model}/parts/${target.part}`;
    return target.model || target.name || fallback;
  }

  function sliderSpec(baseValue, currentValue = baseValue) {
    const base = Number(baseValue) || 0;
    const current = Number(currentValue) || 0;
    const abs = Math.abs(base);
    const span = abs > 0 ? abs : 100;
    const min = Math.min(base < 0 ? base - span : 0, current);
    const max = Math.max(base > 0 ? base + span : span, current);
    const step = span >= 100 ? 1 : span >= 10 ? 0.1 : span >= 1 ? 0.01 : 0.001;
    return { min, max, step };
  }

  function render() {
    if (!elements.paramsEditor) return;
    elements.paramsEditor.replaceChildren();
    elements.paramsEditor.classList.toggle('disabled', !paramsWorking);
    if (!paramsWorking) return;

    const rows = collectNumericParams(paramsWorking);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'param-empty';
      empty.textContent = t('noNumericParams');
      elements.paramsEditor.appendChild(empty);
      return;
    }

    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const head = document.createElement('div');
      head.className = 'param-head';

      const label = document.createElement('div');
      label.className = 'param-name';
      label.title = item.path.join('.');
      label.textContent = item.path.join('.');

      const input = document.createElement('input');
      input.className = 'param-value';
      input.type = 'number';
      input.value = String(item.value);

      const range = document.createElement('input');
      range.className = 'param-range';
      range.type = 'range';
      const baseValue = paramsOriginal ? item.path.reduce((current, key) => current?.[key], paramsOriginal) : item.value;
      const spec = sliderSpec(baseValue, item.value);
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.value = String(item.value);

      const applyValue = (raw, source) => {
        const next = Number(raw);
        if (!Number.isFinite(next)) return;
        setParamValue(paramsWorking, item.path, next);
        if (source !== input) input.value = String(next);
        if (source !== range) {
          const currentMin = Number(range.min);
          const currentMax = Number(range.max);
          if (next < currentMin || next > currentMax) {
            const nextSpec = sliderSpec(baseValue, next);
            range.min = String(nextSpec.min);
            range.max = String(nextSpec.max);
            range.step = String(nextSpec.step);
          }
          range.value = String(next);
        }
        const needsSave = hasUnsavedChanges();
        setDirty(hasRevertableChanges() || needsSave);
        if (needsSave) {
          setStatus(t('updatingParams', { model: paramsLabel || paramsModel }));
          scheduleAutoSave();
        } else {
          clearPendingSave();
          setStatus(t('editingParams', { model: paramsLabel || paramsModel }));
        }
      };

      range.addEventListener('input', () => applyValue(range.value, range));
      input.addEventListener('input', () => applyValue(input.value, input));

      head.appendChild(label);
      head.appendChild(input);
      row.appendChild(head);
      row.appendChild(range);
      elements.paramsEditor.appendChild(row);
    }
  }

  function scheduleAutoSave() {
    clearPendingSave();
    if (!getCurrentProject() || !getParamsTarget() || !paramsWorking) return;
    paramsSaveTimer = setTimeout(() => {
      paramsSaveTimer = null;
      save();
    }, 350);
  }

  function setIdle(message) {
    clearPendingSave();
    paramsModel = null;
    paramsTarget = null;
    paramsLabel = null;
    paramsOriginal = null;
    paramsSaved = null;
    paramsWorking = null;
    setDirty(false);
    render();
    setStatus(message || t('selectModelParams'));
  }

  async function refresh({ force = false } = {}) {
    const currentTarget = getParamsTarget();
    if (!getCurrentProject() || !currentTarget || !elements.paramsEditor) {
      setIdle(t('selectModelParams'));
      return;
    }
    const currentKey = targetKey(currentTarget);
    if (targetKey(paramsTarget) === currentKey) return;
    const seq = ++paramsLoadSeq;
    const target = currentTarget;
    const label = targetLabel(target);
    paramsWorking = null;
    render();
    setDirty(false);
    setStatus(t('loadingParams', { model: label }));
    try {
      const res = await api.getParams(target);
      if (seq !== paramsLoadSeq || currentKey !== targetKey(getParamsTarget())) return;
      paramsModel = res?.model || (typeof target === 'string' ? target : target.model);
      paramsTarget = target;
      paramsLabel = res?.label || label;
      paramsOriginal = JSON.parse(res?.text || '{}');
      paramsSaved = cloneParams(paramsOriginal);
      paramsWorking = cloneParams(paramsOriginal);
      render();
      setDirty(false);
      setStatus(res?.exists ? t('editingParams', { model: paramsLabel }) : t('paramsWillBeCreated', { model: paramsLabel }));
    } catch (e) {
      if (seq !== paramsLoadSeq) return;
      paramsModel = target;
      paramsTarget = target;
      paramsLabel = label;
      paramsOriginal = null;
      paramsSaved = null;
      paramsWorking = null;
      render();
      setDirty(false);
      setStatus(e.message || String(e), 'error');
    }
  }

  function revert() {
    if (!paramsModel || !paramsOriginal) return;
    clearPendingSave();
    paramsWorking = cloneParams(paramsOriginal);
    render();
    setDirty(hasRevertableChanges() || hasUnsavedChanges());
    setStatus(t('revertingParams', { model: paramsLabel || paramsModel }));
    save({ keepOriginal: true });
  }

  async function save({ keepOriginal = false } = {}) {
    const currentTarget = getParamsTarget();
    if (!getCurrentProject() || !currentTarget || !paramsWorking) return;
    if (paramsSaving) return;
    const target = currentTarget;
    const key = targetKey(target);
    const label = targetLabel(target, paramsLabel || paramsModel);
    paramsSaving = true;
    setStatus(t('savingParams', { model: label }));
    try {
      const snapshot = cloneParams(paramsWorking);
      const text = JSON.stringify(snapshot, null, 2) + '\n';
      const res = await api.saveParams(target, text);
      if (key !== targetKey(getParamsTarget())) {
        paramsSaving = false;
        return;
      }
      paramsModel = res?.model || (typeof target === 'string' ? target : target.model);
      paramsTarget = target;
      paramsLabel = res?.label || label;
      paramsSaved = JSON.parse(res?.text || text);
      if (!paramsOriginal) paramsOriginal = cloneParams(paramsSaved);
      if (!paramsEqual(paramsWorking, snapshot)) {
        paramsSaving = false;
        setDirty(hasRevertableChanges() || hasUnsavedChanges());
        setStatus(t('updatingParams', { model: paramsLabel }));
        scheduleAutoSave();
        return;
      }
      paramsWorking = cloneParams(paramsSaved);
      setDirty(hasRevertableChanges() || hasUnsavedChanges());
      paramsSaving = false;
      setStatus(t('savedParamsRebuilding', { model: paramsLabel }), 'ok');
    } catch (e) {
      paramsSaving = false;
      render();
      setDirty(true);
      setStatus(e.message || String(e), 'error');
    }
  }

  function flushPendingSave() {
    clearPendingSave();
    return save();
  }

  if (elements.paramsEditor) {
    elements.paramsEditor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flushPendingSave();
      }
    });
  }
  if (elements.btnParamsRevert) {
    elements.btnParamsRevert.addEventListener('click', revert);
  }

  return {
    isDirty: () => paramsDirty,
    flushPendingSave,
    refresh,
    setIdle
  };
}
