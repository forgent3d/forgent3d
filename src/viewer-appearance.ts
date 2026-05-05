import * as THREE from 'three';
import { applyMaterialSpec } from './viewer-materials.js';
import type { MaterialParams, MaterialPart, MaterialSpec } from './types.js';

function materialList(material: THREE.Material | THREE.Material[] | null | undefined): THREE.Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function getMeshMaterialParts(mesh: THREE.Mesh): MaterialPart[] {
  if (mesh.userData?.materialPart) {
    return [mesh.userData.materialPart];
  }
  return [];
}

function getPartMaterial(mesh: THREE.Mesh, part: MaterialPart): THREE.Material | null {
  const materials = materialList(mesh.material);
  const index = Number.isInteger(part.materialIndex) ? part.materialIndex : 0;
  return materials[index ?? 0] || null;
}

function matchesPart(part: MaterialPart, key: string | number) {
  const id = String(key);
  return String(part.id) === id
    || String(part.name) === id
    || String(part.index) === id
    || String(part.materialIndex) === id
    || (Array.isArray(part.aliases) && part.aliases.some((alias) => String(alias) === id));
}

function normalizeMaterialConfig(config: MaterialSpec | THREE.ColorRepresentation): MaterialSpec {
  if (typeof config === 'string' || typeof config === 'number' || config instanceof THREE.Color) {
    return { color: config };
  }
  return { ...(config || {}) };
}

export function createAppearanceController({ getCurrentRoot }: { getCurrentRoot: () => THREE.Object3D | null }) {
  let defaultMaterial: MaterialSpec = {};
  const partMaterials = new Map<string, MaterialSpec>();

  function apply() {
    const root = getCurrentRoot?.();
    if (!root) return;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const parts = getMeshMaterialParts(child);
      if (!parts.length) {
        for (const material of materialList(child.material)) {
          applyMaterialSpec(material, defaultMaterial);
        }
        return;
      }
      for (const part of parts) {
        const material = getPartMaterial(child, part);
        const partMaterial = partMaterials.get(String(part.id));
        applyMaterialSpec(material, { ...defaultMaterial, ...(partMaterial || {}) });
      }
    });
  }

  function setPartMaterial(partKey: string | number, config: MaterialSpec | THREE.ColorRepresentation): boolean {
    const root = getCurrentRoot?.();
    const normalized = normalizeMaterialConfig(config);
    let matched = false;
    if (root) {
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        for (const part of getMeshMaterialParts(child)) {
          if (!matchesPart(part, partKey)) continue;
          matched = true;
          partMaterials.set(String(part.id), normalized);
          applyMaterialSpec(getPartMaterial(child, part), { ...defaultMaterial, ...normalized });
        }
      });
    }
    if (!matched) {
      partMaterials.set(String(partKey), normalized);
    }
    return matched;
  }

  function setPartMaterialColor(partKey: string | number, color: THREE.ColorRepresentation): boolean {
    return setPartMaterial(partKey, { color });
  }

  function setPartMaterialColors(colorsByPart: Record<string, THREE.ColorRepresentation>) {
    for (const [partKey, color] of Object.entries(colorsByPart || {})) {
      setPartMaterialColor(partKey, color);
    }
  }

  function setMaterialParams(params: MaterialParams = {}) {
    defaultMaterial = {};
    partMaterials.clear();
    const materials = params?.__viewer?.materials || params?.viewer?.materials;
    if (!materials || typeof materials !== 'object') {
      apply();
      return;
    }
    defaultMaterial = normalizeMaterialConfig(materials.default || {});
    for (const [partKey, config] of Object.entries(materials.parts || {})) {
      setPartMaterial(partKey, config);
    }
    apply();
  }

  function clearPartMaterialColor(partKey: string | number) {
    const key = String(partKey);
    for (const existing of Array.from(partMaterials.keys())) {
      if (existing === key) partMaterials.delete(existing);
    }
    apply();
  }

  function getMaterialParts() {
    const root = getCurrentRoot?.();
    const parts: Array<MaterialPart & { color: string | null }> = [];
    if (!root) return parts;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const part of getMeshMaterialParts(child)) {
        const material = getPartMaterial(child, part);
        const materialWithColor = material as (THREE.Material & { color?: THREE.Color }) | null;
        parts.push({
          id: part.id,
          name: part.name,
          aliases: part.aliases || [],
          index: part.index,
          materialIndex: part.materialIndex,
          color: materialWithColor?.color ? `#${materialWithColor.color.getHexString()}` : null
        });
      }
    });
    return parts;
  }

  return {
    apply,
    reset: () => setMaterialParams({}),
    setMaterialParams,
    setPartMaterial,
    setPartMaterialColor,
    setPartMaterialColors,
    clearPartMaterialColor,
    getMaterialParts,
    getPartMaterialState: () => Object.fromEntries(
      Array.from(partMaterials.entries()).map(([key, spec]) => [key, { ...spec }])
    )
  };
}
