import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyCadStyleToGlbScene, tagGlbSceneMaterialParts } from './viewer-loaders.js';
import { VIEWER_BACKGROUND_COLOR } from './viewer-materials.js';
import { createContactShadow, createViewerLighting, decorateModelForCadDisplay } from './viewer-scene.js';
import { disposeThreeObject } from './viewer-utils.js';

export type GlbViewer = {
  load(url: string, opts?: GlbLoadOptions): Promise<void>;
  clear(): void;
  refresh(): void;
  dispose(): void;
};

export type GlbLoadOptions = {
  unitScale?: number;
  coordinateSystem?: 'cad-z-up' | 'gltf-y-up' | string;
};

export function createGlbViewer(host: HTMLElement): GlbViewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(VIEWER_BACKGROUND_COLOR, 1);
  // setSize(..., false) below skips CSS sizing; pin the canvas to its container
  // here so the pixel-ratio-scaled drawing buffer doesn't overflow the host.
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(VIEWER_BACKGROUND_COLOR);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
  camera.position.set(140, 100, 140);

  let currentRoot: THREE.Object3D | null = null;
  const lighting = createViewerLighting(scene, renderer, () => currentRoot);
  const contactShadow = createContactShadow(scene);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 2.4;
  controls.zoomSpeed = 1.4;
  controls.panSpeed = 0.9;
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
  function tick() {
    raf = requestAnimationFrame(tick);
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
    const dir = new THREE.Vector3(0.85, 0.65, 0.85).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, distance);
    camera.near = Math.max(distance / 200, 0.1);
    camera.far = Math.max(distance * 100, 1000);
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    contactShadow.updateForBox(box);
    lighting.updateShadowCameraForBox(box);
  }

  function clear() {
    if (!currentRoot) return;
    scene.remove(currentRoot);
    disposeThreeObject(currentRoot);
    currentRoot = null;
    contactShadow.hide();
  }

  async function load(url: string, opts: GlbLoadOptions = {}) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const contentRoot = gltf.scene || new THREE.Group();
    const root = new THREE.Group();
    root.name = contentRoot.name || 'glb-model';
    root.add(contentRoot);

    tagGlbSceneMaterialParts(root, []);
    applyCadStyleToGlbScene(root);

    const coord = String(opts.coordinateSystem || '').toLowerCase();
    if (coord === 'gltf-y-up') root.rotation.x = Math.PI / 2;
    const unitScale = typeof opts.unitScale === 'number' && Number.isFinite(opts.unitScale) && opts.unitScale > 0
      ? opts.unitScale
      : 1;
    if (unitScale !== 1) root.scale.setScalar(unitScale);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.position.sub(center);
    root.updateMatrixWorld(true);

    clear();
    scene.add(root);
    currentRoot = root;
    decorateModelForCadDisplay(root);
    fitView();
  }

  function dispose() {
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    controls.dispose();
    clear();
    contactShadow.dispose();
    lighting.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  }

  return { load, clear, refresh: fitView, dispose };
}
