import * as THREE from 'three';
import type { AxisRanges, SectionAxis, SectionPlaneInfo, SectionState } from './types.js';

const SECTION_AXIS_NORMALS: Record<SectionAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

function normalizeAxis(axis: unknown): SectionAxis {
  const nextAxis = String(axis || '').toLowerCase();
  return nextAxis === 'x' || nextAxis === 'y' || nextAxis === 'z' ? nextAxis : 'y';
}

export type SectionController = ReturnType<typeof createSectionController>;

export function createSectionController(
  renderer: THREE.WebGLRenderer,
  getCurrentRoot: () => THREE.Object3D | null
) {
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const state: SectionState & { ranges: AxisRanges } = {
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

  function getSectionPlaneInfo(): SectionPlaneInfo {
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
    setRangesFromBox(box: THREE.Box3) {
      for (const axis of ['x', 'y', 'z'] as const) {
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
    setSectionEnabled(enabled: boolean) {
      state.enabled = !!enabled;
      applySectionPlane();
    },
    setSectionNormalized(normalized: number) {
      state.normalized = THREE.MathUtils.clamp(Number(normalized) || 0, -1, 1);
      applySectionPlane();
    },
    setSectionAxis(axis: SectionAxis | string) {
      state.axis = normalizeAxis(axis);
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
