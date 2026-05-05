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

  function getSectionWorldCoord() {
    const t = (THREE.MathUtils.clamp(state.normalized, -1, 1) + 1) * 0.5;
    const { min, max } = state.ranges[state.axis] || { min: -1, max: 1 };
    return THREE.MathUtils.lerp(min, max, t);
  }

  function getSectionPlaneInfo() {
    const axis = state.axis;
    return {
      enabled: state.enabled,
      axis,
      coord: getSectionWorldCoord(),
      ranges: {
        x: { ...state.ranges.x },
        y: { ...state.ranges.y },
        z: { ...state.ranges.z }
      }
    };
  }

  function applySectionPlane() {
    const coord = getSectionWorldCoord();
    const normal = SECTION_AXIS_NORMALS[state.axis] || SECTION_AXIS_NORMALS.y;
    sectionPlane.set(normal, -coord);
    renderer.clippingPlanes = state.enabled ? [sectionPlane] : [];
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
      renderer.clippingPlanes = [];
    },
    apply() {
      applySectionPlane();
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
    getSectionState() {
      return {
        enabled: state.enabled,
        axis: state.axis,
        normalized: state.normalized
      };
    },
    getSectionPlaneInfo
  };
}
