import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';

const WHEEL_GESTURE_IDLE_MS = 180;
const WHEEL_GESTURE_POINTER_TOLERANCE_PX = 1;
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
  let lastPointerClient: { x: number; y: number } | null = null;
  let wheelPointerClient: { x: number; y: number } | null = null;

  function pointInsideRect(x: number, y: number, rect: DOMRect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function trackPointer(event: PointerEvent) {
    const rect = domElement.getBoundingClientRect();
    if (!rect.width || !rect.height || !pointInsideRect(event.clientX, event.clientY, rect)) return;
    lastPointerClient = { x: event.clientX, y: event.clientY };
  }

  function clearTrackedPointer() {
    lastPointerClient = null;
    gesture = null;
  }

  function readPointer(event: WheelEvent) {
    const rect = domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const client = lastPointerClient && pointInsideRect(lastPointerClient.x, lastPointerClient.y, rect)
      ? lastPointerClient
      : { x: event.clientX, y: event.clientY };

    wheelPointerClient = client;
    pointer.x = ((client.x - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((client.y - rect.top) / rect.height) * 2 + 1;
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
    const client = wheelPointerClient || { x: event.clientX, y: event.clientY };
    return Math.hypot(client.x - gesture.clientX, client.y - gesture.clientY) > WHEEL_GESTURE_POINTER_TOLERANCE_PX;
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

  function isSolidModelHit(hit: THREE.Intersection) {
    const object = hit.object;
    if (!object.visible || object.userData?.isWireframe) return false;
    if (!(object instanceof THREE.Mesh)) return false;
    return !!object.geometry?.isBufferGeometry;
  }

  function pickGestureAnchor(_event: WheelEvent): THREE.Vector3 {
    // Snap the camera to look at the orbit target BEFORE raycasting so the
    // anchor is picked using the same orientation that keepAnchorUnderPointer
    // will apply later in the same wheel handler. Without this, TrackballControls
    // can leave the camera slightly off-axis after an orbit, and the first-wheel
    // correction = (anchor under old ray) − (anchor under post-lookAt ray) shows
    // up as a one-time sideways lurch.
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);

    const currentRoot = getCurrentRoot();
    if (currentRoot) {
      currentRoot.updateMatrixWorld(true);
      const hit = raycaster
        .intersectObject(currentRoot, true)
        .find(isSolidModelHit);
      if (hit) return hit.point.clone();
    }

    const targetPlaneAnchor = projectPointerToPlane(controls.target, new THREE.Vector3());
    return targetPlaneAnchor || controls.target.clone();
  }

  function getGestureAnchor(event: WheelEvent) {
    const now = performance.now();
    if (gestureExpired(now) || pointerMovedOutsideGesture(event)) {
      const client = wheelPointerClient || { x: event.clientX, y: event.clientY };
      const nextGesture = {
        anchor: pickGestureAnchor(event),
        clientX: client.x,
        clientY: client.y,
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
    if (!projected) return null;

    correction.copy(anchor).sub(projected);
    if (!Number.isFinite(correction.x) || !Number.isFinite(correction.y) || !Number.isFinite(correction.z)) return null;

    camera.position.add(correction);
    controls.target.add(correction);
    return correction;
  }

  function onWheel(event: WheelEvent) {
    if (!controls.enabled || controls.noZoom || !readPointer(event)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const factor = wheelZoomFactor(event);
    const anchor = getGestureAnchor(event);

    if (!zoomCameraDistance(factor)) return;

    keepAnchorUnderPointer(anchor);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
  }

  domElement.addEventListener('wheel', onWheel, { passive: false, capture: true });
  domElement.addEventListener('pointermove', trackPointer, { passive: true, capture: true });
  domElement.addEventListener('pointerleave', clearTrackedPointer, { passive: true, capture: true });

  return {
    cancelGesture() {
      gesture = null;
    },
    dispose() {
      domElement.removeEventListener('wheel', onWheel, { capture: true });
      domElement.removeEventListener('pointermove', trackPointer, { capture: true });
      domElement.removeEventListener('pointerleave', clearTrackedPointer, { capture: true });
    }
  };
}
