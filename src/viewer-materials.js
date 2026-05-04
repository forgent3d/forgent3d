import * as THREE from 'three';

export const VIEWER_BACKGROUND_COLOR = 0x0b0d12;
export const CAD_CLAY_COLOR = 0xc8d0dc;
export const CAD_EDGE_COLOR = 0x26324a;

export const MATERIAL_PRESETS = {
  cad_clay: {
    color: CAD_CLAY_COLOR,
    metalness: 0.04,
    roughness: 0.72
  },
  matte_plastic: {
    color: 0xb9c2d0,
    metalness: 0.02,
    roughness: 0.62
  },
  gloss_plastic: {
    color: 0xb9c2d0,
    metalness: 0.03,
    roughness: 0.32,
    envMapIntensity: 0.72
  },
  painted_metal: {
    color: 0x8fa3b8,
    metalness: 0.22,
    roughness: 0.5,
    envMapIntensity: 0.78
  },
  anodized_aluminum: {
    color: 0x4f8fd8,
    metalness: 0.38,
    roughness: 0.4,
    envMapIntensity: 0.9
  },
  brushed_steel: {
    color: 0xa7b0ba,
    metalness: 0.78,
    roughness: 0.34
  },
  dark_steel: {
    color: 0x4b5563,
    metalness: 0.7,
    roughness: 0.42
  },
  polished_metal: {
    color: 0xd0d6dc,
    metalness: 0.9,
    roughness: 0.18,
    envMapIntensity: 1.05
  },
  rubber: {
    color: 0x242832,
    metalness: 0,
    roughness: 0.86
  },
  glass_clear: {
    color: 0xd8ecff,
    metalness: 0,
    roughness: 0.04,
    envMapIntensity: 1,
    transparent: true,
    opacity: 0.34
  }
};

export function normalizeMaterialSpec(spec = {}) {
  const presetName = String(spec.preset || spec.material || 'cad_clay').trim() || 'cad_clay';
  const preset = MATERIAL_PRESETS[presetName] || MATERIAL_PRESETS.cad_clay;
  return {
    ...preset,
    ...spec,
    preset: MATERIAL_PRESETS[presetName] ? presetName : 'cad_clay',
    color: spec.color ?? preset.color
  };
}

export function createCadMaterial(spec = {}) {
  const normalized = normalizeMaterialSpec(spec);
  const material = new THREE.MeshStandardMaterial({
    color: normalized.color,
    metalness: normalized.metalness,
    roughness: normalized.roughness,
    side: THREE.DoubleSide,
    envMapIntensity: normalized.envMapIntensity ?? 0.82,
    transparent: normalized.transparent,
    opacity: normalized.opacity ?? 1
  });
  material.userData.baseColor = material.color.getHex();
  material.userData.materialPreset = normalized.preset;
  return material;
}

export function createCadClayMaterial(overrides = {}) {
  return createCadMaterial({ preset: 'cad_clay', ...overrides });
}

export function applyMaterialSpec(material, spec = {}) {
  if (!material) return;
  const normalized = normalizeMaterialSpec(spec);
  if (material.color) material.color.set(normalized.color);
  if ('metalness' in material) material.metalness = normalized.metalness;
  if ('roughness' in material) material.roughness = normalized.roughness;
  if ('envMapIntensity' in material) material.envMapIntensity = normalized.envMapIntensity ?? 0.82;
  if (normalized.transparent != null) material.transparent = !!normalized.transparent;
  if (normalized.opacity != null) material.opacity = normalized.opacity;
  material.userData.baseColor = material.color?.getHex?.() ?? material.userData.baseColor;
  material.userData.materialPreset = normalized.preset;
  material.needsUpdate = true;
}

export function createCadEdgeMaterial(overrides = {}) {
  return new THREE.LineBasicMaterial({
    color: CAD_EDGE_COLOR,
    transparent: true,
    opacity: 0.46,
    ...overrides
  });
}
