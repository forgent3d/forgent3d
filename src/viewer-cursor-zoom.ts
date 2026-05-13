import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';

const WHEEL_GESTURE_IDLE_MS = 180;
const WHEEL_GESTURE_POINTER_TOLERANCE_PX = 10;
const MAX_WHEEL_ZOOM_STEP = 0.34;
const MIN_CAMERA_DISTANCE = 1e-6;

type CursorWheelZoomControllerOptions = {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  domElement: HTMLElement;
  getCurrentRoot: () => THREE.Object3D | null;
};

type WheelGesture = {
  anchor: THREE.Vector3;
  clientX: number;
  clientY: number;
  lastWheelAt: number;
};

export function createCursorWheelZoomController({
  camera,
  controls,
  domElement,
  getCurrentRoot
}: CursorWheelZoomControllerOptions) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const focusPlane = new THREE.Plane();
  const cameraDirection = new THREE.Vector3();
  const projectedAnchor = new THREE.Vector3();
  const correction = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();

  let gesture: WheelGesture | null = null;

  function readPointer(event: WheelEvent) {
    const rect = domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return true;
  }

  function wheelUnit(event: WheelEvent) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return 0.055;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return 0.022;
    return 0.0007;
  }

  function wheelZoomFactor(event: WheelEvent) {
    const step = event.deltaY * wheelUnit(event) * controls.zoomSpeed;
    return Math.exp(THREE.MathUtils.clamp(step, -MAX_WHEEL_ZOOM_STEP, MAX_WHEEL_ZOOM_STEP));
  }

  function pointerMovedOutsideGesture(event: WheelEvent) {
    if (!gesture) return true;
    return Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) > WHEEL_GESTURE_POINTER_TOLERANCE_PX;
  }

  function gestureExpired(now: number) {
    return !gesture || now - gesture.lastWheelAt > WHEEL_GESTURE_IDLE_MS;
  }

  function projectPointerToPlane(pointOnPlane: THREE.Vector3, target: THREE.Vector3) {
    camera.getWorldDirection(cameraDirection).normalize();
    focusPlane.setFromNormalAndCoplanarPoint(cameraDirection, pointOnPlane);
    raycaster.setFromCamera(pointer, camera);
    const projected = raycaster.ray.intersectPlane(focusPlane, target);
    return projected ? target : null;
  }

  function pickGestureAnchor(event: WheelEvent) {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);

    const currentRoot = getCurrentRoot();
    if (currentRoot) {
      const hit = raycaster
        .intersectObject(currentRoot, true)
        .find((entry) => entry.object.visible);
      if (hit) return hit.point.clone();
    }

    const targetPlaneAnchor = projectPointerToPlane(controls.target, new THREE.Vector3());
    return targetPlaneAnchor || controls.target.clone();
  }

  function getGestureAnchor(event: WheelEvent) {
    const now = performance.now();
    if (gestureExpired(now) || pointerMovedOutsideGesture(event)) {
      const nextGesture = {
        anchor: pickGestureAnchor(event),
        clientX: event.clientX,
        clientY: event.clientY,
        lastWheelAt: now
      };
      gesture = nextGesture;
      return nextGesture.anchor;
    }

    const activeGesture = gesture;
    if (!activeGesture) return pickGestureAnchor(event);

    activeGesture.lastWheelAt = now;
    return activeGesture.anchor;
  }

  function zoomCameraDistance(factor: number) {
    const distance = camera.position.distanceTo(controls.target);
    if (!Number.isFinite(distance) || distance <= MIN_CAMERA_DISTANCE) return false;

    const nextDistance = THREE.MathUtils.clamp(
      distance * factor,
      controls.minDistance,
      controls.maxDistance
    );
    const effectiveFactor = nextDistance / distance;
    if (!Number.isFinite(effectiveFactor) || effectiveFactor <= 0 || effectiveFactor === 1) return false;

    cameraOffset.subVectors(camera.position, controls.target).multiplyScalar(effectiveFactor);
    camera.position.copy(controls.target).add(cameraOffset);
    return true;
  }

  function keepAnchorUnderPointer(anchor: THREE.Vector3) {
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();

    const projected = projectPointerToPlane(anchor, projectedAnchor);
    if (!projected) return;

    correction.copy(anchor).sub(projected);
    camera.position.add(correction);
    controls.target.add(correction);
  }

  function onWheel(event: WheelEvent) {
    if (!controls.enabled || controls.noZoom || !readPointer(event)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const anchor = getGestureAnchor(event);
    if (!zoomCameraDistance(wheelZoomFactor(event))) return;

    keepAnchorUnderPointer(anchor);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
  }

  domElement.addEventListener('wheel', onWheel, { passive: false, capture: true });

  return {
    cancelGesture() {
      gesture = null;
    },
    dispose() {
      domElement.removeEventListener('wheel', onWheel, { capture: true });
    }
  };
}
