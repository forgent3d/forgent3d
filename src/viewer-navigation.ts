import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { vec3From } from './viewer-utils.js';
import type { ViewKey, ViewSpec } from './types.js';

const VIEW_CYCLE: ViewKey[] = ['iso', 'front', 'side', 'top'];

type ResolvedViewSpec = {
  key: ViewKey | string;
  dir: THREE.Vector3;
  up: THREE.Vector3;
};

const VIEW_PRESETS: Record<string, ResolvedViewSpec> = {
  iso: {
    key: 'iso',
    dir: new THREE.Vector3(1, 0.85, 1).normalize(),
    up: new THREE.Vector3(0, 1, 0)
  },
  front: {
    key: 'front',
    dir: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0)
  },
  back: {
    key: 'back',
    dir: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0)
  },
  side: {
    key: 'side',
    dir: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0)
  },
  right: {
    key: 'right',
    dir: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0)
  },
  left: {
    key: 'left',
    dir: new THREE.Vector3(-1, 0, 0),
    up: new THREE.Vector3(0, 1, 0)
  },
  top: {
    key: 'top',
    dir: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, -1)
  },
  bottom: {
    key: 'bottom',
    dir: new THREE.Vector3(0, -1, 0),
    up: new THREE.Vector3(0, 0, 1)
  }
};

function resolveViewUp(dir: THREE.Vector3): THREE.Vector3 {
  const unitDir = dir.clone().normalize();
  if (Math.abs(unitDir.y) > 0.95) {
    return new THREE.Vector3(0, 0, unitDir.y > 0 ? -1 : 1);
  }
  return new THREE.Vector3(0, 1, 0);
}

function inferViewKeyFromDirection(dir: THREE.Vector3): ViewKey {
  const unitDir = dir.clone().normalize();
  const keys: ViewKey[] = ['iso', 'front', 'back', 'right', 'left', 'top', 'bottom'];
  let bestKey: ViewKey = 'custom';
  let bestDot = -Infinity;
  for (const key of keys) {
    const dot = unitDir.dot(VIEW_PRESETS[key]!.dir);
    if (dot > bestDot) {
      bestDot = dot;
      bestKey = key;
    }
  }
  return bestDot > 0.999 ? bestKey : 'custom';
}

function normalizeViewSpec(viewInput?: ViewSpec | string | null): ResolvedViewSpec {
  if (typeof viewInput === 'string' || viewInput == null) {
    const key = String(viewInput || 'iso').trim().toLowerCase();
    const preset = VIEW_PRESETS[key] || VIEW_PRESETS.iso!;
    return {
      key: preset.key,
      dir: preset.dir.clone(),
      up: preset.up.clone()
    };
  }

  if (viewInput?.dir) {
    const dir = vec3From(viewInput.dir).normalize();
    let up = viewInput.up ? vec3From(viewInput.up).normalize() : resolveViewUp(dir);
    if (Math.abs(dir.dot(up)) > 0.999) up = resolveViewUp(dir);
    return {
      ...viewInput,
      key: viewInput.key || inferViewKeyFromDirection(dir),
      dir,
      up
    };
  }

  return normalizeViewSpec('iso');
}

export function createViewController({
  camera,
  controls,
  getCurrentRoot,
  updateDirectionalLights
}: {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  getCurrentRoot: () => THREE.Object3D | null;
  updateDirectionalLights: (camera: THREE.Camera, target: THREE.Vector3) => void;
}) {
  const viewBox = new THREE.Box3();
  const viewSphere = new THREE.Sphere();
  let currentViewKey: ViewKey | string = 'iso';

  function getViewDistance(target = controls.target) {
    const distance = camera.position.distanceTo(target);
    return Number.isFinite(distance) && distance > 1e-3 ? distance : 120;
  }

  function getCurrentModelSphere() {
    const currentRoot = getCurrentRoot?.();
    if (!currentRoot) return null;
    viewBox.setFromObject(currentRoot).getBoundingSphere(viewSphere);
    return viewSphere.clone();
  }

  function getFittedViewDistance(target = controls.target) {
    const sphere = getCurrentModelSphere();
    if (!sphere) return getViewDistance(target);
    const targetOffset = sphere.center.distanceTo(target);
    const radius = Math.max(sphere.radius + targetOffset, 1);
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(camera.aspect, 1e-3));
    const fitHeight = radius / Math.sin(Math.max(verticalHalfFov, 1e-3));
    const fitWidth = radius / Math.sin(Math.max(horizontalHalfFov, 1e-3));
    return Math.max(fitHeight, fitWidth, 1) * 1.18;
  }

  function setView(viewInput: ViewSpec | string = 'iso', opts: { distance?: number } = {}) {
    const view = normalizeViewSpec(viewInput);
    const target = controls.target.clone();
    const distance = opts.distance || getViewDistance(target);
    camera.position.copy(target).addScaledVector(view.dir, distance);
    camera.up.copy(view.up);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    controls.target.copy(target);
    controls.update();
    updateDirectionalLights(camera, controls.target);
    currentViewKey = view.key || inferViewKeyFromDirection(view.dir);
    return currentViewKey;
  }

  function fitView(viewInput: ViewSpec | string = 'iso') {
    const sphere = getCurrentModelSphere();
    if (sphere) {
      controls.target.copy(sphere.center);
    }
    const distance = getFittedViewDistance(controls.target);
    return setView(viewInput, { distance });
  }

  function cycleView() {
    const currentIndex = VIEW_CYCLE.indexOf(currentViewKey as ViewKey);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % VIEW_CYCLE.length : 0;
    return setView(VIEW_CYCLE[nextIndex] ?? 'iso');
  }

  function orbit(deltaAzimuth: number, deltaElevation = 0) {
    const target = controls.target;
    const offset = camera.position.clone().sub(target);
    const orbitAxis = camera.up.clone().normalize();
    if (orbitAxis.lengthSq() < 1e-8) orbitAxis.set(0, 1, 0);
    offset.applyAxisAngle(orbitAxis, deltaAzimuth);
    if (deltaElevation) {
      const right = new THREE.Vector3().crossVectors(orbitAxis, offset).normalize();
      if (right.lengthSq() > 1e-8) offset.applyAxisAngle(right, deltaElevation);
    }
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    controls.update();
    updateDirectionalLights(camera, controls.target);
    currentViewKey = 'custom';
    return currentViewKey;
  }

  function captureState() {
    return {
      cameraPosition: camera.position.clone(),
      cameraQuaternion: camera.quaternion.clone(),
      cameraUp: camera.up.clone(),
      target: controls.target.clone(),
      viewKey: currentViewKey
    };
  }

  function restoreState(state: ReturnType<typeof captureState> | null) {
    if (!state) return;
    camera.position.copy(state.cameraPosition);
    camera.quaternion.copy(state.cameraQuaternion);
    camera.up.copy(state.cameraUp);
    controls.target.copy(state.target);
    camera.updateMatrixWorld();
    controls.update();
    currentViewKey = state.viewKey || currentViewKey;
    updateDirectionalLights(camera, controls.target);
  }

  function reset() {
    currentViewKey = 'iso';
  }

  return {
    setView,
    fitView,
    cycleView,
    orbit,
    captureState,
    restoreState,
    reset,
    getCurrentView: () => currentViewKey
  };
}
