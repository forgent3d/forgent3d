import * as THREE from 'three';
import type { PreviewMode } from './types.js';

function materialList(material: THREE.Material | THREE.Material[] | null | undefined): THREE.Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function normalizePreviewMode(mode: unknown): PreviewMode {
  const value = String(mode || '').trim().toLowerCase();
  return value === 'solid' || value === 'xray' || value === 'wireframe' ? value : 'solid';
}

type ContactShadowController = {
  object?: THREE.Object3D;
};

export function createPreviewModeController({
  getCurrentRoot,
  contactShadow
}: {
  getCurrentRoot: () => THREE.Object3D | null;
  contactShadow?: ContactShadowController;
}) {
  let mode: PreviewMode = 'solid';

  function apply() {
    const currentRoot = getCurrentRoot?.();
    if (!currentRoot) return;

    const isWireframe = mode === 'wireframe';
    const isXray = mode === 'xray';
    currentRoot.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        for (const material of materialList(child.material)) {
          if (!material || !('wireframe' in material)) continue;
          if (!material.userData.__previewBackup) {
            material.userData.__previewBackup = {
              transparent: !!material.transparent,
              opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
              depthWrite: !!material.depthWrite
            };
          }
          const backup = material.userData.__previewBackup;
          material.wireframe = isWireframe;
          if (isXray) {
            material.transparent = true;
            material.opacity = 0.26;
            material.depthWrite = false;
          } else {
            material.transparent = backup.transparent;
            material.opacity = backup.opacity;
            material.depthWrite = backup.depthWrite;
          }
          material.needsUpdate = true;
        }
        child.castShadow = !isWireframe && !isXray;
        return;
      }

      if (child instanceof THREE.LineSegments) {
        child.visible = !isWireframe;
        for (const material of materialList(child.material)) {
          const materialWithColor = material as THREE.Material & { color?: THREE.Color };
          if (!material) continue;
          if (!material.userData.__previewBackup) {
            material.userData.__previewBackup = {
              color: materialWithColor.color?.getHex?.(),
              opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
              transparent: !!material.transparent,
              depthTest: !!material.depthTest
            };
          }
          const backup = material.userData.__previewBackup;
          if (isXray) {
            if (materialWithColor.color) materialWithColor.color.setHex(0x061018);
            material.transparent = true;
            material.opacity = 0.86;
            material.depthTest = false;
          } else {
            if (materialWithColor.color && Number.isFinite(backup.color)) materialWithColor.color.setHex(backup.color);
            material.transparent = backup.transparent;
            material.opacity = backup.opacity;
            material.depthTest = backup.depthTest;
          }
          material.needsUpdate = true;
        }
      }
    });

    if (contactShadow?.object) {
      contactShadow.object.visible = !isWireframe && !isXray && !!currentRoot;
    }
  }

  function setMode(nextMode: PreviewMode | string): PreviewMode {
    mode = normalizePreviewMode(nextMode);
    apply();
    return mode;
  }

  function refresh() {
    apply();
  }

  return {
    apply,
    refresh,
    setMode,
    getMode: () => mode
  };
}
