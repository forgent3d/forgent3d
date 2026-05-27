/// <reference path="./declarations.d.ts" />

import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import occtImportJs from 'occt-import-js';
import loadMujoco from '@mujoco/mujoco';
import { createViewCubeOverlay } from './viewer-viewcube.js';
import {
  buildSceneFromOcctResult,
  buildSceneFromStlBuffer,
  inferMaterialPartNameFromUrl,
  tagSceneAsMaterialPart
} from './viewer-loaders.js';
import { disposeMjcfSimulation, loadMjcfScene, stepMjcfSimulation } from './viewer-mjcf.js';
import { createContactShadow, createViewerLighting, decorateModelForCadDisplay } from './viewer-scene.js';
import { createSnapshotRenderer } from './viewer-snapshot.js';
import { createViewController } from './viewer-navigation.js';
import { createAppearanceController } from './viewer-appearance.js';
import { createPreviewModeController } from './viewer-preview-mode.js';
import { createReferenceAxesController } from './viewer-reference-axes.js';
import { createExplodeController } from './viewer-explode.js';
import { createAdaptiveBackgroundController } from './viewer-background.js';
import { createCursorWheelZoomController } from './viewer-cursor-zoom.js';
import { disposeThreeObject } from './viewer-utils.js';
import type { LoadModelOptions, LogHandler, MaterialParams, MaterialSpec, PartInfo, PreviewMode, Viewer, ViewSpec } from './types.js';
// Vite treats wasm as an asset and returns the final bundled URL
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import type occtImportJsType from 'occt-import-js';

type OcctModule = Awaited<ReturnType<typeof occtImportJsType>>;
type MujocoModule = Awaited<ReturnType<typeof loadMujoco>>;
type MjcfSimulation = Record<string, any> | null;
type ViewCubeOverlay = {
  render(mainCameraQuaternion: THREE.Quaternion): void;
  setEnabled(value: boolean): void;
  dispose(): void;
};

/**
 * A viewer object wrapping a Three.js scene:
 *  - Uses occt-import-js (WASM version of OCCT) to parse BREP binary streams
 *  - Keeps all BREP faces merged into a single mesh for efficient rendering
 *  - Keep feature-specific display logic in focused viewer-* modules; this file wires controllers together
 */
export function createViewer(host: HTMLElement): Viewer {
  let onSelectedPartChange: ((partKey: string | number | null) => void) | null = null;
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    45, host.clientWidth / host.clientHeight, 0.1, 5000
  );
  camera.position.set(80, 60, 100);

  // Cached bounding sphere of the active model, used to keep camera near/far
  // wide enough that parts never clip when the user zooms in/out.
  const modelClipSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  const modelClipBox = new THREE.Box3();
  let modelClipDirty = true;
  function markModelClipDirty() { modelClipDirty = true; }
  function refreshModelClipSphere() {
    if (!currentRoot) {
      modelClipSphere.center.set(0, 0, 0);
      modelClipSphere.radius = 0;
      return;
    }
    modelClipBox.setFromObject(currentRoot);
    if (modelClipBox.isEmpty()) {
      modelClipSphere.center.set(0, 0, 0);
      modelClipSphere.radius = 0;
      return;
    }
    modelClipBox.getBoundingSphere(modelClipSphere);
  }
  function updateCameraClipping() {
    if (modelClipDirty) {
      refreshModelClipSphere();
      modelClipDirty = false;
    }
    const radius = modelClipSphere.radius;
    if (!Number.isFinite(radius) || radius <= 0) return;
    // 4x radius headroom comfortably covers exploded layouts (max factor ~3).
    const dist = camera.position.distanceTo(modelClipSphere.center);
    const farNeeded = Math.max(dist + radius * 4, radius * 8, 1000);
    const nearNeeded = Math.max(0.01, farNeeded * 1e-5);
    if (camera.far !== farNeeded || camera.near !== nearNeeded) {
      camera.far = farNeeded;
      camera.near = nearNeeded;
      camera.updateProjectionMatrix();
    }
  }

  // preserveDrawingBuffer is required for stable canvas.toDataURL snapshots,
  // used by MCP screenshot_model tool
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  // TrackballControls allows continuous orbiting past the top/bottom poles.
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 6;
  controls.zoomSpeed = 2.8;
  controls.staticMoving = true;
  controls.dynamicDampingFactor = 0;
  controls.target.set(0, 0, 0);
  controls.handleResize();

  const cursorWheelZoom = createCursorWheelZoomController({
    camera,
    controls,
    domElement: renderer.domElement,
    getCurrentRoot: () => currentRoot
  });

  const lighting = createViewerLighting(scene, renderer, () => currentRoot);
  const contactShadow = createContactShadow(scene);
  const backgroundController = createAdaptiveBackgroundController(host);

  function prepareModelForCadDisplay(root: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3().setFromObject(root);
    decorateModelForCadDisplay(root);
    contactShadow.updateForBox(box);
    lighting.updateShadowCameraForBox(box);
    return box;
  }

  const referenceAxes = createReferenceAxesController(scene);
  const axes = referenceAxes.object;

  /* ---- State ---- */
  let currentRoot: THREE.Object3D | null = null;         // three.Group for current BREP model
  let currentMjcfRoot: THREE.Object3D | null = null;
  let mjcfSimulation: MjcfSimulation = null;
  const partPickRaycaster = new THREE.Raycaster();
  const partPickPointer = new THREE.Vector2();
  let partPickDown: { x: number; y: number } | null = null;
  let viewCube: ViewCubeOverlay | null = null;
  const previewController = createPreviewModeController({
    getCurrentRoot: () => currentRoot,
    contactShadow
  });
  const appearanceController = createAppearanceController({ getCurrentRoot: () => currentRoot });
  const explodeController = createExplodeController({ getCurrentRoot: () => currentRoot });
  const viewController = createViewController({
    camera,
    controls,
    getCurrentRoot: () => currentRoot,
    updateDirectionalLights: lighting.updateDirectionalLights
  });

  /* ---- Animation ---- */
  let running = true;
  let lastFrameTs = performance.now();
  let autoOrbitSpeed = 0;
  function animateMjcfSimulation(dt: number) {
    if (!currentMjcfRoot) return;
    const sim = currentMjcfRoot.userData?.mjcfSimulation;
    if (!sim) return;
    try {
      stepMjcfSimulation(currentMjcfRoot, dt);
    } catch {
      // Ignore one-off simulation update failures to keep viewer responsive.
    }
  }
  (function loop() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameTs) / 1000));
    lastFrameTs = now;
    explodeController.removeOffsets();
    animateMjcfSimulation(dt);
    explodeController.update(dt);
    controls.update();
    if (autoOrbitSpeed && currentRoot) viewController.orbit(autoOrbitSpeed * dt);
    lighting.updateDirectionalLights(camera, controls.target);
    updateCameraClipping();
    renderer.render(scene, camera);
    const activeViewCube = viewCube as ViewCubeOverlay | null;
    if (activeViewCube) activeViewCube.render(camera.quaternion);
    requestAnimationFrame(loop);
  })();

  /* ---- Resize ---- */
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    controls.handleResize();
  });
  ro.observe(host);

  /* ---- Lazy-load OCCT WASM ---- */
  let occtPromise: Promise<OcctModule> | null = null;
  function getOcct(): Promise<OcctModule> {
    if (!occtPromise) {
      occtPromise = occtImportJs({
        // Let emscripten resolve our hosted wasm file
        locateFile: (f) => (f.endsWith('.wasm') ? occtWasmUrl : f)
      });
    }
    return occtPromise;
  }

  let mujocoPromise: Promise<MujocoModule> | null = null;
  function getMujoco(): Promise<MujocoModule> {
    if (!mujocoPromise) {
      mujocoPromise = loadMujoco({
        locateFile: (file: string) => file.endsWith('.wasm') ? mujocoWasmUrl : file
      });
    }
    return mujocoPromise;
  }

  function clearModel() {
    if (currentRoot) {
      scene.remove(currentRoot);
      disposeThreeObject(currentRoot);
      currentRoot = null;
    }
    markModelClipDirty();
    currentMjcfRoot = null;
    disposeMjcfSimulation(mjcfSimulation);
    mjcfSimulation = null;
    appearanceController.reset();
    explodeController.reset();
    backgroundController.reset();
    contactShadow.hide();
    referenceAxes.hide();
    cursorWheelZoom.cancelGesture();
    controls.target.set(0, 0, 0);
    controls.update();
    viewController.reset();
    if (viewCube) viewCube.setEnabled(false);
  }

  function materialPartFromObject(object: THREE.Object3D | null): string | number | null {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      const part = cursor.userData?.materialPart;
      if (part?.id != null) return part.id;
      cursor = cursor.parent;
    }
    return null;
  }

  function pickMaterialPart(event: PointerEvent): string | number | null {
    if (!currentRoot) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    partPickPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    partPickPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    partPickRaycaster.setFromCamera(partPickPointer, camera);
    const hits = partPickRaycaster
      .intersectObject(currentRoot, true)
      .filter((hit) => !hit.object.userData?.isWireframe);
    for (const hit of hits) {
      const partId = materialPartFromObject(hit.object);
      if (partId != null) return partId;
    }
    return null;
  }

  function handlePartPickPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    partPickDown = { x: event.clientX, y: event.clientY };
  }

  function handlePartPickClick(event: MouseEvent) {
    if (event.button !== 0) return;
    if (partPickDown) {
      const dx = event.clientX - partPickDown.x;
      const dy = event.clientY - partPickDown.y;
      partPickDown = null;
      if ((dx * dx + dy * dy) > 16) return;
    }
    const pickedPart = pickMaterialPart(event as PointerEvent);
    setSelectedPart(pickedPart);
  }

  renderer.domElement.addEventListener('pointerdown', handlePartPickPointerDown);
  renderer.domElement.addEventListener('click', handlePartPickClick);

  function replaceCurrentModel(
    nextRoot: THREE.Object3D,
    { preserveView = false, isMjcf = false }: { preserveView?: boolean; isMjcf?: boolean } = {}
  ) {
    const previousRoot = currentRoot;
    const previousSimulation = mjcfSimulation;
    const viewState = preserveView && previousRoot ? viewController.captureState() : null;

    scene.add(nextRoot);
    currentRoot = nextRoot;
    currentMjcfRoot = isMjcf ? nextRoot : null;
    mjcfSimulation = isMjcf ? (nextRoot.userData.mjcfSimulation || null) : null;
    const modelBox = prepareModelForCadDisplay(nextRoot);
    referenceAxes.updateForBox(modelBox);
    markModelClipDirty();
    appearanceController.apply();
    backgroundController.update(nextRoot);
    explodeController.rebuildTargets();
    previewController.refresh();

    if (previousRoot) {
      scene.remove(previousRoot);
      disposeThreeObject(previousRoot);
    }
    if (previousSimulation && previousSimulation !== mjcfSimulation) {
      disposeMjcfSimulation(previousSimulation);
    }

    if (viewState) {
      viewController.restoreState(viewState);
    } else {
      controls.target.set(0, 0, 0);
      controls.update();
      viewController.fitView('iso');
    }
    if (viewCube) viewCube.setEnabled(true);
  }

  function metadataUrlFromParamsUrl(paramsUrl: string | undefined): string | null {
    if (!paramsUrl) return null;
    return paramsUrl.replace(/params\.json(?:\?.*)?$/i, 'metadata.json');
  }

  async function loadViewerParams(paramsUrl: string | undefined, onLog: LogHandler = () => {}): Promise<Record<string, unknown>> {
    if (!paramsUrl) return {};
    try {
      const response = await fetch(paramsUrl);
      if (!response.ok) throw new Error(`fetch ${paramsUrl} failed: ${response.status}`);
      return await response.json();
    } catch (err: any) {
      onLog(`params.json appearance config unavailable: ${err?.message || err}`);
      return {};
    }
  }

  async function loadAssemblyPartLabels(paramsUrl: string | undefined, onLog: LogHandler = () => {}): Promise<string[]> {
    const metadataUrl = metadataUrlFromParamsUrl(paramsUrl);
    if (!metadataUrl) return [];
    try {
      const response = await fetch(metadataUrl);
      if (!response.ok) return [];
      const payload = await response.json();
      const labels = payload?.assembly_parts;
      if (!Array.isArray(labels)) return [];
      return labels.map((label) => String(label || '').trim()).filter(Boolean);
    } catch (err: any) {
      onLog(`metadata.json assembly labels unavailable: ${err?.message || err}`);
      return [];
    }
  }

  /* ---- Load BREP ---- */

  async function loadBrep(url: string, onLog: LogHandler = () => {}, opts: LoadModelOptions = {}): Promise<PartInfo> {
    // 1) Fetch BREP bytes
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();

    // 2) Parse with WASM
    onLog(`OCCT parsing BREP (${(buf.byteLength / 1024).toFixed(1)} KB)...`);
    const occt = await getOcct();
    const res = occt.ReadBrepFile(new Uint8Array(buf), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5
    });

    if (!res.success) throw new Error('OCCT failed to parse BREP');

    // 3) Build Three.js scene
    const group = buildSceneFromOcctResult(res, {
      assemblyPartLabels: opts.assemblyPartLabels || []
    });

    // Center model + adapt camera
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    group.position.sub(center);

    replaceCurrentModel(group, { preserveView: !!opts.preserveView, isMjcf: false });

    const pickable = group.children.find((c) => c instanceof THREE.Mesh && c.userData.faceRanges);
    const faceRanges: Array<{ faceIndex: number; centroid: THREE.Vector3; normal: THREE.Vector3 }> = pickable?.userData.faceRanges || [];
    const totalFaces = faceRanges.length;
    onLog(`OCCT parse complete: ${totalFaces} BREP faces`);

    // Original-coordinate bbox and per-face data for MCP.
    // Do not transform with group.matrixWorld; group translation is only for display.
    const partInfo: PartInfo = {
      faceCount: totalFaces,
      bbox: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        size: [size.x, size.y, size.z],
        center: [center.x, center.y, center.z]
      },
      faces: faceRanges.map((r: { faceIndex: number; centroid: THREE.Vector3; normal: THREE.Vector3 }) => ({
        index: r.faceIndex,
        centroid: [r.centroid.x, r.centroid.y, r.centroid.z],
        normal: [r.normal.x, r.normal.y, r.normal.z]
      }))
    };
    return partInfo;
  }

  const snapshot = createSnapshotRenderer({
    renderer,
    scene,
    camera,
    axes,
    getCurrentRoot: () => currentRoot,
    getPreviewMode: previewController.getMode,
    setPreviewMode,
    updateDirectionalLights: lighting.updateDirectionalLights
  });

  /* ---- Load STL mesh preview ---- */

  async function loadStl(url: string, onLog: LogHandler = () => {}, opts: LoadModelOptions = {}): Promise<PartInfo> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    onLog(`STL parsing (${(buf.byteLength / 1024).toFixed(1)} KB)...`);

    const { group, geometry } = buildSceneFromStlBuffer(buf);
    const partName = String(opts.materialPart || '').trim() || inferMaterialPartNameFromUrl(url);
    if (partName) tagSceneAsMaterialPart(group, partName);

    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    group.position.sub(center);

    replaceCurrentModel(group, { preserveView: !!opts.preserveView, isMjcf: false });

    const position = geometry.getAttribute('position');
    const triCount = (geometry.index ? geometry.index.count : position.count) / 3;
    onLog(`STL parse complete: ${Math.floor(triCount)} triangles`);

    return {
      faceCount: 0,
      bbox: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        size: [size.x, size.y, size.z],
        center: [center.x, center.y, center.z]
      },
      faces: []
    };
  }

  async function loadGlb(url: string, onLog: LogHandler = () => {}, opts: LoadModelOptions = {}): Promise<PartInfo> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    onLog(`GLB parsing (${(buf.byteLength / 1024).toFixed(1)} KB)...`);

    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const contentRoot = gltf.scene || new THREE.Group();
    const root = new THREE.Group();
    root.name = contentRoot.name || 'glb-model';
    root.add(contentRoot);
    const unitScale = typeof opts.unitScale === 'number' && Number.isFinite(opts.unitScale) && opts.unitScale > 0
      ? opts.unitScale
      : 1;
    const coordinateSystem = String(opts.coordinateSystem || '').toLowerCase();
    if (coordinateSystem === 'gltf-y-up') {
      root.rotation.x = Math.PI / 2;
      onLog('GLB display axes: glTF Y-up -> CAD Z-up');
    }
    if (unitScale !== 1) {
      root.scale.setScalar(unitScale);
      onLog(`GLB display unit scale: ${unitScale}x`);
    }
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    root.position.sub(center);
    root.updateMatrixWorld(true);

    replaceCurrentModel(root, { preserveView: !!opts.preserveView, isMjcf: false });

    let triangles = 0;
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry?.isBufferGeometry) return;
      const position = geometry.getAttribute('position');
      if (!position) return;
      triangles += (geometry.index ? geometry.index.count : position.count) / 3;
    });
    onLog(`GLB parse complete: ${Math.floor(triangles)} triangles`);

    return {
      faceCount: 0,
      bbox: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        size: [size.x, size.y, size.z],
        center: [center.x, center.y, center.z]
      },
      faces: []
    };
  }

  async function loadMjcf(
    url: string,
    paramsUrl?: string,
    onLog: LogHandler = () => {},
    opts: LoadModelOptions = {}
  ): Promise<PartInfo> {
    onLog('MJCF loading ...');
    const { root, simulation, partInfo } = await loadMjcfScene({
      url,
      paramsUrl,
      baseUrl: url,
      getMujoco
    }, onLog as any);
    root.userData.mjcfSimulation = simulation;
    replaceCurrentModel(root, { preserveView: !!opts.preserveView, isMjcf: true });
    return partInfo as unknown as PartInfo;
  }

  /**
   * Unified entry: choose BREP/STL/MJCF loader by URL suffix or explicit format.
   * @param {string} url
   * @param {(msg:string)=>void} [onLog]
   * @param {{ format?: 'BREP'|'STL'|'MJCF'|'GLB', paramsUrl?: string, preserveView?: boolean, unitScale?: number, coordinateSystem?: string }} [opts]
   */
  async function loadModel(url: string, onLog: LogHandler = () => {}, opts: LoadModelOptions = {}): Promise<PartInfo> {
    const fmt = (opts.format || '').toUpperCase();
    appearanceController.reset();
    const [params, assemblyPartLabels] = await Promise.all([
      loadViewerParams(opts.paramsUrl, onLog),
      loadAssemblyPartLabels(opts.paramsUrl, onLog)
    ]);
    const loadOpts = {
      ...opts,
      assemblyPartLabels: opts.assemblyPartLabels?.length ? opts.assemblyPartLabels : assemblyPartLabels
    };
    let partInfo;
    if (fmt === 'MJCF' || /\/asm\.xml(\?|$)/i.test(url)) {
      partInfo = await loadMjcf(url, opts.paramsUrl, onLog, loadOpts);
    } else if (fmt === 'GLB' || /\.glb(\?|$)/i.test(url)) {
      partInfo = await loadGlb(url, onLog, loadOpts);
    } else {
      const isStl = fmt === 'STL' || /\.stl(\?|$)/i.test(url);
      partInfo = await (isStl ? loadStl(url, onLog, loadOpts) : loadBrep(url, onLog, loadOpts));
    }
    appearanceController.setMaterialParams(params);
    backgroundController.update(currentRoot);
    previewController.refresh();
    return partInfo;
  }

  function mountViewCube(hostEl: HTMLElement | null) {
    if (viewCube) {
      viewCube.dispose();
      viewCube = null;
    }
    if (!hostEl) return;
    viewCube = createViewCubeOverlay(hostEl, {
      onNavigate: (viewSpec: ViewSpec) => {
        if (!currentRoot) return;
        viewController.setView(viewSpec);
      }
    });
    viewCube.setEnabled(!!currentRoot);
  }

  function setViewCubeEnabled(enabled: boolean) {
    if (viewCube) viewCube.setEnabled(!!enabled);
  }

  function setPreviewMode(mode: PreviewMode | string): PreviewMode {
    return previewController.setMode(mode);
  }

  function setAutoOrbitSpeed(radiansPerSecond: number) {
    autoOrbitSpeed = Number.isFinite(radiansPerSecond) ? radiansPerSecond : 0;
  }

  function refreshPreview() {
    previewController.refresh();
  }

  function setMaterialParams(params: MaterialParams = {}) {
    appearanceController.setMaterialParams(params);
    backgroundController.update(currentRoot);
  }

  function setPartMaterial(partKey: string | number, config: MaterialSpec | THREE.ColorRepresentation): boolean {
    const matched = appearanceController.setPartMaterial(partKey, config);
    backgroundController.update(currentRoot);
    return matched;
  }

  function setPartMaterialColor(partKey: string | number, color: THREE.ColorRepresentation): boolean {
    const matched = appearanceController.setPartMaterialColor(partKey, color);
    backgroundController.update(currentRoot);
    return matched;
  }

  function setPartMaterialColors(colorsByPart: Record<string, THREE.ColorRepresentation>) {
    appearanceController.setPartMaterialColors(colorsByPart);
    backgroundController.update(currentRoot);
  }

  function setSelectedPart(partKey: string | number | null) {
    const selected = appearanceController.setSelectedPart(partKey);
    previewController.refresh();
    backgroundController.update(currentRoot);
    onSelectedPartChange?.(selected);
    return selected;
  }

  function setOnSelectedPartChange(
    handler: ((partKey: string | number | null) => void) | null
  ) {
    onSelectedPartChange = handler;
  }

  function setExplodeEnabled(enabled: boolean) {
    return explodeController.setEnabled(enabled);
  }

  function setExplodeFactor(factor: number) {
    return explodeController.setFactor(factor);
  }

  function getExplodeState() {
    return explodeController.getState();
  }

  /* ---- Public API ---- */
  return {
    scene,
    camera,
    renderer,
    mountViewCube,
    setViewCubeEnabled,
    setPreviewMode,
    getPreviewMode: previewController.getMode,
    loadBrep,
    loadStl,
    loadMjcf,
    loadGlb,
    loadModel,
    snapshot,
    setView: viewController.setView,
    fitView: viewController.fitView,
    cycleView: viewController.cycleView,
    orbit: viewController.orbit,
    setAutoOrbitSpeed,
    setExplodeEnabled,
    setExplodeFactor,
    getExplodeState,
    refreshPreview,
    setMaterialParams,
    setPartMaterial,
    setPartMaterialColor,
    setPartMaterialColors,
    setSelectedPart,
    setOnSelectedPartChange,
    getMaterialParts: appearanceController.getMaterialParts,
    getSelectedPart: appearanceController.getSelectedPart,
    getPartMaterialState: appearanceController.getPartMaterialState,
    getCurrentView: viewController.getCurrentView,
    hasModel: () => !!currentRoot,
    clearModel,
    dispose() {
      running = false;
      ro.disconnect();
      if (viewCube) {
        viewCube.dispose();
        viewCube = null;
      }
      clearModel();
      renderer.domElement.removeEventListener('pointerdown', handlePartPickPointerDown);
      renderer.domElement.removeEventListener('click', handlePartPickClick);
      cursorWheelZoom.dispose();
      contactShadow.dispose();
      lighting.dispose();
      referenceAxes.dispose();
      renderer.dispose();
    }
  };
}
