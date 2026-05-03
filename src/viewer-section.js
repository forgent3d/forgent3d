import * as THREE from 'three';

const SECTION_AXIS_NORMALS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

export function createSectionController(renderer, getCurrentRoot) {
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const state = {
    enabled: false,
    axis: 'y',
    normalized: 0,
    ranges: {
      x: { min: -1, max: 1 },
      y: { min: -1, max: 1 },
      z: { min: -1, max: 1 }
    }
  };
  let ghostEnabled = false;

  function getSectionWorldCoord() {
    const t = (THREE.MathUtils.clamp(state.normalized, -1, 1) + 1) * 0.5;
    const { min, max } = state.ranges[state.axis] || { min: -1, max: 1 };
    return THREE.MathUtils.lerp(min, max, t);
  }

  function applySectionPlane() {
    const coord = getSectionWorldCoord();
    const normal = SECTION_AXIS_NORMALS[state.axis] || SECTION_AXIS_NORMALS.y;
    sectionPlane.set(normal, -coord);
    renderer.clippingPlanes = state.enabled ? [sectionPlane] : [];
  }

  function applyGhostMode() {
    const currentRoot = getCurrentRoot?.();
    if (!currentRoot) return;
    currentRoot.traverse((child) => {
      if (!child?.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (!m) continue;
        if (!m.userData.__ghostBackup) {
          m.userData.__ghostBackup = {
            transparent: !!m.transparent,
            opacity: Number.isFinite(m.opacity) ? m.opacity : 1
          };
        }
        if (ghostEnabled) {
          m.transparent = true;
          m.opacity = Math.min(0.22, m.userData.__ghostBackup.opacity);
        } else {
          m.transparent = m.userData.__ghostBackup.transparent;
          m.opacity = m.userData.__ghostBackup.opacity;
        }
        m.needsUpdate = true;
      }
    });
  }

  return {
    setRangesFromBox(box) {
      for (const axis of ['x', 'y', 'z']) {
        const min = box.min[axis];
        const max = box.max[axis];
        state.ranges[axis] = Number.isFinite(min) && Number.isFinite(max) && max > min
          ? { min, max }
          : { min: -1, max: 1 };
      }
    },
    reset() {
      state.ranges = {
        x: { min: -1, max: 1 },
        y: { min: -1, max: 1 },
        z: { min: -1, max: 1 }
      };
      state.axis = 'y';
      state.normalized = 0;
      state.enabled = false;
      ghostEnabled = false;
      renderer.clippingPlanes = [];
    },
    apply() {
      applySectionPlane();
      applyGhostMode();
    },
    setSectionEnabled(enabled) {
      state.enabled = !!enabled;
      applySectionPlane();
    },
    setSectionNormalized(normalized) {
      state.normalized = THREE.MathUtils.clamp(Number(normalized) || 0, -1, 1);
      applySectionPlane();
    },
    setSectionAxis(axis) {
      const nextAxis = String(axis || '').toLowerCase();
      state.axis = ['x', 'y', 'z'].includes(nextAxis) ? nextAxis : 'y';
      applySectionPlane();
    },
    resetSection() {
      state.normalized = 0;
      applySectionPlane();
    },
    setGhostEnabled(enabled) {
      ghostEnabled = !!enabled;
      applyGhostMode();
    },
    getSectionState() {
      return {
        enabled: state.enabled,
        axis: state.axis,
        normalized: state.normalized,
        ghost: ghostEnabled
      };
    }
  };
}
