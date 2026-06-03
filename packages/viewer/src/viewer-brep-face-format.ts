import type { BrepFaceSelection } from './types.js';

export type BrepFaceSelectionTranslate = (key: string, vars?: Record<string, unknown>) => string;

export type FormatBrepFaceSelectionOptions = {
  t?: BrepFaceSelectionTranslate;
  /** Model/part label supplied by the host app; the viewer selection only knows the picked mesh. */
  component?: string | null;
  separator?: string;
};

export type FormattedBrepFaceSelection = {
  label: string;
  selector: string;
  meta: string;
  metaSegments: string[];
  component: string;
};

const DEFAULT_MESSAGES: Record<string, string> = {
  selectedBrepFace: 'Selected face #{index}',
  surfaceType: '{type}',
  selectorMatches: '{count} matches',
  faceDirection: '{dir} face',
  faceComponent: 'on {name}',
  dir_top: 'top',
  dir_bottom: 'bottom',
  dir_front: 'front',
  dir_back: 'back',
  dir_left: 'left',
  dir_right: 'right'
};

function defaultTranslate(key: string, vars: Record<string, unknown> = {}): string {
  const template = DEFAULT_MESSAGES[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export function formatBrepFaceSelection(
  selection: BrepFaceSelection,
  opts: FormatBrepFaceSelectionOptions = {}
): FormattedBrepFaceSelection {
  const t = opts.t || defaultTranslate;
  const separator = opts.separator ?? ' · ';
  const selector = String(selection.selector || '');
  const component = String(opts.component ?? '').trim();
  const featureTag = String(selection.featureTag || '').trim();
  const directionLabel = String(selection.directionLabel || '').trim();
  const disambiguation = String(selection.disambiguation || '').trim();
  const metaSegments = [
    selection.surfaceType ? t('surfaceType', { type: selection.surfaceType }) : '',
    featureTag ? `tag=${featureTag}` : '',
    directionLabel ? t('faceDirection', { dir: t(`dir_${directionLabel}`) }) : '',
    component ? t('faceComponent', { name: component }) : '',
    selection.matchCount > 1 ? t('selectorMatches', { count: selection.matchCount }) : '',
    disambiguation
  ].filter((segment): segment is string => !!segment);

  return {
    label: t('selectedBrepFace', { index: selection.index }),
    selector,
    meta: metaSegments.join(separator),
    metaSegments,
    component
  };
}
