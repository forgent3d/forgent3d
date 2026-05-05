import * as THREE from 'three';
import type { MaterialSpec } from './types.js';

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
} satisfies Record<string, MaterialSpec>;

type MaterialPresetName = keyof typeof MATERIAL_PRESETS;

function isPresetName(value: string): value is MaterialPresetName {
  return value in MATERIAL_PRESETS;
}

export function normalizeMaterialSpec(spec: MaterialSpec = {}): MaterialSpec & { preset: MaterialPresetName } {
  const presetName = String(spec.preset || spec.material || 'cad_clay').trim() || 'cad_clay';
  const resolvedPresetName = isPresetName(presetName) ? presetName : 'cad_clay';
  const preset = MATERIAL_PRESETS[resolvedPresetName];
  return {
    ...preset,
    ...spec,
    preset: resolvedPresetName,
    color: spec.color ?? preset.color
  };
}

export function createCadMaterial(spec: MaterialSpec = {}): THREE.MeshStandardMaterial {
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

export function createCadClayMaterial(overrides: MaterialSpec = {}): THREE.MeshStandardMaterial {
  return createCadMaterial({ preset: 'cad_clay', ...overrides });
}

export function applyMaterialSpec(
  material: THREE.Material | THREE.Material[] | null | undefined,
  spec: MaterialSpec = {}
): void {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const item of material) applyMaterialSpec(item, spec);
    return;
  }
  const normalized = normalizeMaterialSpec(spec);
  const materialWithColor = material as THREE.Material & { color?: THREE.Color };
  if (materialWithColor.color && normalized.color != null) materialWithColor.color.set(normalized.color);
  if ('metalness' in material && typeof normalized.metalness === 'number') material.metalness = normalized.metalness;
  if ('roughness' in material && typeof normalized.roughness === 'number') material.roughness = normalized.roughness;
  if ('envMapIntensity' in material) material.envMapIntensity = normalized.envMapIntensity ?? 0.82;
  if (normalized.transparent != null) material.transparent = !!normalized.transparent;
  if (normalized.opacity != null) material.opacity = normalized.opacity;
  material.userData.baseColor = materialWithColor.color?.getHex?.() ?? material.userData.baseColor;
  material.userData.materialPreset = normalized.preset;
  material.needsUpdate = true;
}

export function createCadEdgeMaterial(overrides: THREE.LineBasicMaterialParameters = {}): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: CAD_EDGE_COLOR,
    transparent: true,
    opacity: 0.46,
    ...overrides
  });
}
