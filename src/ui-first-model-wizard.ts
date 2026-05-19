// @ts-nocheck
import { t } from './i18n.js';
import { MODEL_EXAMPLES } from '../electron/model-examples.ts';

const TEMPLATE_CONFIGS = Object.fromEntries(MODEL_EXAMPLES.examples.map((example) => [example.id, example]));
const DEFAULT_TEMPLATE_ID = MODEL_EXAMPLES.defaultExampleId || 'mounting_plate';

export function createFirstModelWizardController({
  api,
  getCurrentProject,
  getModels,
  openNewProjectModal,
  setStatus,
  appendLog,
  showToast,
  refreshModels,
  escapeHtml
}) {
  const el = {
    modal: document.getElementById('modal-part'),
    inputName: document.getElementById('input-part-name'),
    inputDesc: document.getElementById('input-part-desc'),
    length: document.getElementById('wizard-length'),
    width: document.getElementById('wizard-width'),
    thickness: document.getElementById('wizard-thickness'),
    holeSpacingX: document.getElementById('wizard-hole-spacing-x'),
    holeSpacingY: document.getElementById('wizard-hole-spacing-y'),
    cornerRadius: document.getElementById('wizard-corner-radius'),
    fieldLabels: [
      document.getElementById('wizard-field-label-1'),
      document.getElementById('wizard-field-label-2'),
      document.getElementById('wizard-field-label-3'),
      document.getElementById('wizard-field-label-4'),
      document.getElementById('wizard-field-label-5'),
      document.getElementById('wizard-field-label-6')
    ],
    templateCards: document.querySelectorAll('[data-wizard-template]'),
    cancel: document.getElementById('btn-part-cancel'),
    confirm: document.getElementById('btn-part-confirm')
  };
  const fieldInputs = [el.length, el.width, el.thickness, el.holeSpacingX, el.holeSpacingY, el.cornerRadius];
  let selectedTemplate = DEFAULT_TEMPLATE_ID;

  function slugifyModelName(value, fallback = 'mounting_plate') {
    const slug = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
    return slug || fallback;
  }

  function numberInputValue(input, fallback) {
    const value = Number(input?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function suggestedModelName() {
    const models = getModels();
    const base = TEMPLATE_CONFIGS[selectedTemplate]?.defaultName || DEFAULT_TEMPLATE_ID;
    if (!models.some((model) => model.name === base)) return base;
    let index = models.length + 1;
    while (models.some((model) => model.name === `${base}_${index}`)) index++;
    return `${base}_${index}`;
  }

  function setTemplate(template) {
    selectedTemplate = TEMPLATE_CONFIGS[template] ? template : DEFAULT_TEMPLATE_ID;
    const config = TEMPLATE_CONFIGS[selectedTemplate];
    el.templateCards?.forEach((card) => {
      const active = card.dataset.wizardTemplate === selectedTemplate;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    config.fields.forEach((field, index) => {
      const input = fieldInputs[index];
      const label = el.fieldLabels[index];
      if (label) {
        label.textContent = t(field.labelKey);
        label.removeAttribute('data-i18n');
      }
      if (input) {
        input.dataset.paramKey = field.key;
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step);
        input.value = String(field.defaultValue);
      }
    });
    if (el.inputName) el.inputName.value = suggestedModelName();
    if (el.inputDesc) el.inputDesc.value = t(config.defaultDescriptionKey);
  }

  function setDefaults() {
    setTemplate(DEFAULT_TEMPLATE_ID);
  }

  function readParams() {
    const params = {};
    for (const input of fieldInputs) {
      if (!input?.dataset.paramKey) continue;
      params[input.dataset.paramKey] = numberInputValue(input, 0);
    }
    return params;
  }

  function close() {
    el.modal?.classList.add('hidden');
  }

  function open() {
    if (!getCurrentProject()) {
      openNewProjectModal();
      return;
    }
    setDefaults();
    el.modal?.classList.remove('hidden');
    el.inputName?.focus();
    el.inputName?.select();
  }

  async function confirm() {
    const config = TEMPLATE_CONFIGS[selectedTemplate] || TEMPLATE_CONFIGS[DEFAULT_TEMPLATE_ID];
    const name = slugifyModelName(el.inputName?.value, config.defaultName);
    const description = el.inputDesc?.value.trim() || t(config.defaultDescriptionKey);
    const params = readParams();
    if (!getCurrentProject()) {
      openNewProjectModal();
      return;
    }
    try {
      if (el.confirm) el.confirm.disabled = true;
      setStatus(t('creatingModel'), true);
      const result = await api.createModel({
        name,
        description,
        template: selectedTemplate,
        params
      });
      close();
      appendLog(t('modelCreatedLog', { name: result.name }));
      showToast(t('modelCreatedToast', { name: escapeHtml(result.name) }));
      await refreshModels();
    } catch (e) {
      appendLog(t('modelCreateFailed', { message: e.message || e }), 'error');
      showToast(t('modelCreateFailed', { message: escapeHtml(e.message || String(e)) }), 3800);
      setStatus(t('modelCreateFailedShort'));
    } finally {
      if (el.confirm) el.confirm.disabled = false;
    }
  }

  function bind() {
    el.cancel?.addEventListener('click', close);
    el.confirm?.addEventListener('click', confirm);
    el.templateCards?.forEach((card) => {
      card.addEventListener('click', () => setTemplate(card.dataset.wizardTemplate || 'mounting_plate'));
    });
  }

  bind();
  return { open, close };
}
