function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function normalizePreviewMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return ['solid', 'xray', 'wireframe'].includes(value) ? value : 'solid';
}

export function createPreviewModeController({
  getCurrentRoot,
  contactShadow,
  updateSectionFill = () => {},
  afterApply = () => {}
}) {
  let mode = 'solid';

  function apply() {
    const currentRoot = getCurrentRoot?.();
    if (!currentRoot) return;

    const isWireframe = mode === 'wireframe';
    const isXray = mode === 'xray';
    currentRoot.traverse((child) => {
      if (child?.isMesh) {
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

      if (child?.isLineSegments) {
        child.visible = !isWireframe;
        for (const material of materialList(child.material)) {
          if (!material) continue;
          if (!material.userData.__previewBackup) {
            material.userData.__previewBackup = {
              color: material.color?.getHex?.(),
              opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
              transparent: !!material.transparent,
              depthTest: !!material.depthTest
            };
          }
          const backup = material.userData.__previewBackup;
          if (isXray) {
            if (material.color) material.color.setHex(0x061018);
            material.transparent = true;
            material.opacity = 0.86;
            material.depthTest = false;
          } else {
            if (material.color && Number.isFinite(backup.color)) material.color.setHex(backup.color);
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
    updateSectionFill();
  }

  function setMode(nextMode) {
    mode = normalizePreviewMode(nextMode);
    apply();
    afterApply();
    return mode;
  }

  function refresh() {
    apply();
    afterApply();
  }

  return {
    apply,
    refresh,
    setMode,
    getMode: () => mode
  };
}
