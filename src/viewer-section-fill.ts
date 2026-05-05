import * as THREE from 'three';
import type { SectionController } from './viewer-section.js';

export function createSectionFillController(
  scene: THREE.Scene,
  sectionController: SectionController,
  getCurrentRoot: () => THREE.Object3D | null
) {
  const object = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x6ee7ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    })
  );
  object.visible = false;
  object.renderOrder = 80;
  scene.add(object);

  function update() {
    const info = sectionController.getSectionPlaneInfo?.();
    if (!info?.enabled || !getCurrentRoot?.()) {
      object.visible = false;
      return;
    }

    const ranges = info.ranges || {};
    const spanX = Math.max(1e-3, (ranges.x?.max ?? 1) - (ranges.x?.min ?? -1));
    const spanY = Math.max(1e-3, (ranges.y?.max ?? 1) - (ranges.y?.min ?? -1));
    const spanZ = Math.max(1e-3, (ranges.z?.max ?? 1) - (ranges.z?.min ?? -1));
    const centerX = ((ranges.x?.min ?? -1) + (ranges.x?.max ?? 1)) * 0.5;
    const centerY = ((ranges.y?.min ?? -1) + (ranges.y?.max ?? 1)) * 0.5;
    const centerZ = ((ranges.z?.min ?? -1) + (ranges.z?.max ?? 1)) * 0.5;
    const pad = 1.08;
    const offset = Math.max(spanX, spanY, spanZ) * 0.0008;

    object.rotation.set(0, 0, 0);
    object.position.set(centerX, centerY, centerZ);
    if (info.axis === 'x') {
      object.position.x = info.coord + offset;
      object.rotation.y = Math.PI / 2;
      object.scale.set(spanZ * pad, spanY * pad, 1);
    } else if (info.axis === 'z') {
      object.position.z = info.coord + offset;
      object.scale.set(spanX * pad, spanY * pad, 1);
    } else {
      object.position.y = info.coord + offset;
      object.rotation.x = Math.PI / 2;
      object.scale.set(spanX * pad, spanZ * pad, 1);
    }
    object.visible = true;
  }

  function hide() {
    object.visible = false;
  }

  function dispose() {
    scene.remove(object);
    object.geometry.dispose();
    object.material.dispose();
  }

  return {
    object,
    update,
    hide,
    dispose
  };
}
