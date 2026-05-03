import * as THREE from 'three';
import { vec3From } from './viewer-utils.js';

const VIEW_CYCLE = ['iso', 'front', 'side', 'top'];

const VIEW_PRESETS = {
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

function resolveViewUp(dir) {
  const unitDir = dir.clone().normalize();
  if (Math.abs(unitDir.y) > 0.95) {
    return new THREE.Vector3(0, 0, unitDir.y > 0 ? -1 : 1);
  }
  return new THREE.Vector3(0, 1, 0);
}

function inferViewKeyFromDirection(dir) {
  const unitDir = dir.clone().normalize();
  const keys = ['iso', 'front', 'back', 'right', 'left', 'top', 'bottom'];
  let bestKey = 'custom';
  let bestDot = -Infinity;
  for (const key of keys) {
    const dot = unitDir.dot(VIEW_PRESETS[key].dir);
    if (dot > bestDot) {
      bestDot = dot;
      bestKey = key;
    }
  }
  return bestDot > 0.999 ? bestKey : 'custom';
}

function normalizeViewSpec(viewInput) {
  if (typeof viewInput === 'string' || viewInput == null) {
    const key = String(viewInput || 'iso').trim().toLowerCase();
    const preset = VIEW_PRESETS[key] || VIEW_PRESETS.iso;
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
}) {
  const viewBox = new THREE.Box3();
  const viewSphere = new THREE.Sphere();
  let currentViewKey = 'iso';

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

  function setView(viewInput = 'iso', opts = {}) {
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

  function fitView(viewInput = 'iso') {
    const sphere = getCurrentModelSphere();
    if (sphere) {
      controls.target.copy(sphere.center);
    }
    const distance = getFittedViewDistance(controls.target);
    return setView(viewInput, { distance });
  }

  function cycleView() {
    const currentIndex = VIEW_CYCLE.indexOf(currentViewKey);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % VIEW_CYCLE.length : 0;
    return setView(VIEW_CYCLE[nextIndex]);
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

  function restoreState(state) {
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
    captureState,
    restoreState,
    reset,
    getCurrentView: () => currentViewKey
  };
}
