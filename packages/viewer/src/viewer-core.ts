import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { VIEWER_BACKGROUND_COLOR } from './viewer-materials.js';
import { createContactShadow, createViewerLighting, decorateModelForCadDisplay } from './viewer-scene.js';
import { createReferenceAxesController } from './viewer-reference-axes.js';
import { createExplodeController } from './viewer-explode.js';
import { createPreviewModeController } from './viewer-preview-mode.js';
import { disposeThreeObject } from './viewer-utils.js';
import type { PreviewMode } from './types.js';

export type ViewerCoreOptions = {
  fov?: number;
  cameraPosition?: [number, number, number];
  preserveDrawingBuffer?: boolean;
  rotateSpeed?: number;
  zoomSpeed?: number;
  panSpeed?: number;
  /** Show an X/Y/Z reference axes gizmo at the model origin (Z-up). */
  referenceAxes?: boolean;
};

export function createViewerCore(host: HTMLElement, opts: ViewerCoreOptions = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: !!opts.preserveDrawingBuffer
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(VIEWER_BACKGROUND_COLOR, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(VIEWER_BACKGROUND_COLOR);

  const camera = new THREE.PerspectiveCamera(opts.fov ?? 45, 1, 0.1, 10000);
  // CAD Z-up: loaded BREP/GLB content is Z-up, so the camera's up axis (and the
  // contact-shadow ground below) must be Z-up to match — same convention as the full viewer.
  camera.up.set(0, 0, 1);
  camera.position.set(...(opts.cameraPosition ?? [160, -160, 120]));

  let currentRoot: THREE.Object3D | null = null;
  const lighting = createViewerLighting(scene, renderer, () => currentRoot);
  const contactShadow = createContactShadow(scene, 'z');
  const referenceAxes = opts.referenceAxes ? createReferenceAxesController(scene) : null;
  const explodeController = createExplodeController({ getCurrentRoot: () => currentRoot });
  const previewController = createPreviewModeController({
    getCurrentRoot: () => currentRoot,
    contactShadow
  });

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = opts.rotateSpeed ?? 2.4;
  controls.zoomSpeed = opts.zoomSpeed ?? 1.4;
  controls.panSpeed = opts.panSpeed ?? 0.9;
  controls.staticMoving = true;

  function resize() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    controls.handleResize();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  let raf = 0;
  let lastFrameTs = performance.now();
  function tick() {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameTs) / 1000));
    lastFrameTs = now;
    explodeController.update(dt);
    controls.update();
    lighting.updateDirectionalLights(camera, controls.target);
    renderer.render(scene, camera);
  }
  tick();

  function fitView() {
    if (!currentRoot) return;
    const box = new THREE.Box3().setFromObject(currentRoot);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const distance = sphere.radius / Math.sin(fovRad / 2);
    const dir = new THREE.Vector3(1, -1, 0.85).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, distance);
    camera.near = Math.max(distance / 200, 0.1);
    camera.far = Math.max(distance * 100, 1000);
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    contactShadow.updateForBox(box);
    referenceAxes?.updateForBox(box);
    lighting.updateShadowCameraForBox(box);
  }

  function clear() {
    explodeController.reset();
    if (currentRoot) {
      scene.remove(currentRoot);
      disposeThreeObject(currentRoot);
      currentRoot = null;
    }
    contactShadow.hide();
    referenceAxes?.hide();
  }

  function replaceRoot(root: THREE.Object3D, opts: { refreshPreview?: boolean } = {}) {
    clear();
    scene.add(root);
    currentRoot = root;
    decorateModelForCadDisplay(root);
    explodeController.rebuildTargets();
    fitView();
    if (opts.refreshPreview !== false) previewController.refresh();
  }

  function dispose() {
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    controls.dispose();
    clear();
    contactShadow.dispose();
    referenceAxes?.dispose();
    lighting.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    getCurrentRoot: () => currentRoot,
    replaceRoot,
    clear,
    fitView,
    setExplodeEnabled: explodeController.setEnabled,
    setExplodeFactor: explodeController.setFactor,
    getExplodeState: explodeController.getState,
    setPreviewMode: (mode: PreviewMode | string) => previewController.setMode(mode),
    getPreviewMode: previewController.getMode,
    refreshPreview: previewController.refresh,
    dispose
  };
}
