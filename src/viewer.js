import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import occtImportJs from 'occt-import-js';
import loadMujoco from '@mujoco/mujoco';
import { createViewCubeOverlay } from './viewer-viewcube.js';
import { buildSceneFromOcctResult, buildSceneFromStlBuffer } from './viewer-loaders.js';
import { disposeMjcfSimulation, loadMjcfScene, stepMjcfSimulation } from './viewer-mjcf.js';
import { createContactShadow, createViewerLighting, decorateModelForCadDisplay } from './viewer-scene.js';
import { createSectionController } from './viewer-section.js';
import { createSnapshotRenderer } from './viewer-snapshot.js';
import { createViewController } from './viewer-navigation.js';
import { createAppearanceController } from './viewer-appearance.js';
import { createPreviewModeController } from './viewer-preview-mode.js';
import { createReferenceAxesController } from './viewer-reference-axes.js';
import { createSectionFillController } from './viewer-section-fill.js';
import { disposeThreeObject } from './viewer-utils.js';
// Vite treats wasm as an asset and returns the final bundled URL
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

/**
 * A viewer object wrapping a Three.js scene:
 *  - Uses occt-import-js (WASM version of OCCT) to parse BREP binary streams
 *  - Keeps all BREP faces merged into a single mesh for efficient rendering
 *  - Keep feature-specific display logic in focused viewer-* modules; this file wires controllers together
 */
export function createViewer(host) {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    45, host.clientWidth / host.clientHeight, 0.1, 5000
  );
  camera.position.set(80, 60, 100);

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
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.12;
  controls.target.set(0, 0, 0);
  controls.handleResize();

  const lighting = createViewerLighting(scene, renderer, () => currentRoot);
  const contactShadow = createContactShadow(scene);

  function prepareModelForCadDisplay(root) {
    const box = new THREE.Box3().setFromObject(root);
    decorateModelForCadDisplay(root);
    contactShadow.updateForBox(box);
    lighting.updateShadowCameraForBox(box);
    return box;
  }

  const referenceAxes = createReferenceAxesController(scene);
  const axes = referenceAxes.object;
  renderer.localClippingEnabled = true;

  /* ---- State ---- */
  let currentRoot = null;         // three.Group for current BREP model
  let currentMjcfRoot = null;
  let mjcfSimulation = null;
  let viewCube = null;
  const sectionController = createSectionController(renderer, () => currentRoot);
  const sectionFill = createSectionFillController(scene, sectionController, () => currentRoot);
  const previewController = createPreviewModeController({
    getCurrentRoot: () => currentRoot,
    contactShadow,
    updateSectionFill: sectionFill.update,
    afterApply: () => sectionController.apply()
  });
  const appearanceController = createAppearanceController({ getCurrentRoot: () => currentRoot });
  const viewController = createViewController({
    camera,
    controls,
    getCurrentRoot: () => currentRoot,
    updateDirectionalLights: lighting.updateDirectionalLights
  });

  /* ---- Animation ---- */
  let running = true;
  let lastFrameTs = performance.now();
  function animateMjcfSimulation(dt) {
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
    animateMjcfSimulation(dt);
    controls.update();
    lighting.updateDirectionalLights(camera, controls.target);
    renderer.render(scene, camera);
    if (viewCube) viewCube.render(camera.quaternion);
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
  let occtPromise = null;
  function getOcct() {
    if (!occtPromise) {
      occtPromise = occtImportJs({
        // Let emscripten resolve our hosted wasm file
        locateFile: (f) => (f.endsWith('.wasm') ? occtWasmUrl : f)
      });
    }
    return occtPromise;
  }

  let mujocoPromise = null;
  function getMujoco() {
    if (!mujocoPromise) {
      mujocoPromise = loadMujoco({
        locateFile: (file) => file.endsWith('.wasm') ? mujocoWasmUrl : file
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
    currentMjcfRoot = null;
    disposeMjcfSimulation(mjcfSimulation);
    mjcfSimulation = null;
    sectionController.reset();
    appearanceController.reset();
    contactShadow.hide();
    referenceAxes.hide();
    sectionFill.hide();
    controls.target.set(0, 0, 0);
    controls.update();
    viewController.reset();
    if (viewCube) viewCube.setEnabled(false);
  }

  function replaceCurrentModel(nextRoot, { preserveView = false, isMjcf = false } = {}) {
    const previousRoot = currentRoot;
    const previousSimulation = mjcfSimulation;
    const viewState = preserveView && previousRoot ? viewController.captureState() : null;

    scene.add(nextRoot);
    currentRoot = nextRoot;
    currentMjcfRoot = isMjcf ? nextRoot : null;
    mjcfSimulation = isMjcf ? (nextRoot.userData.mjcfSimulation || null) : null;
    const modelBox = prepareModelForCadDisplay(nextRoot);
    referenceAxes.updateForBox(modelBox);
    sectionController.setRangesFromBox(modelBox);
    sectionController.apply();
    appearanceController.apply();
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

  async function loadViewerParams(paramsUrl, onLog = () => {}) {
    if (!paramsUrl) return {};
    try {
      const response = await fetch(paramsUrl);
      if (!response.ok) throw new Error(`fetch ${paramsUrl} failed: ${response.status}`);
      return await response.json();
    } catch (err) {
      onLog(`params.json appearance config unavailable: ${err?.message || err}`);
      return {};
    }
  }

  /* ---- Load BREP ---- */

  async function loadBrep(url, onLog = () => {}, opts = {}) {
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
    const group = buildSceneFromOcctResult(res);

    // Center model + adapt camera
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    group.position.sub(center);

    replaceCurrentModel(group, { preserveView: !!opts.preserveView, isMjcf: false });

    const pickable = group.children.find((c) => c.isMesh && c.userData.faceRanges);
    const faceRanges = pickable?.userData.faceRanges || [];
    const totalFaces = faceRanges.length;
    onLog(`OCCT parse complete: ${totalFaces} BREP faces`);

    // Original-coordinate bbox and per-face data for MCP.
    // Do not transform with group.matrixWorld; group translation is only for display.
    const partInfo = {
      faceCount: totalFaces,
      bbox: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        size: [size.x, size.y, size.z],
        center: [center.x, center.y, center.z]
      },
      faces: faceRanges.map((r) => ({
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

  async function loadStl(url, onLog = () => {}, opts = {}) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    onLog(`STL parsing (${(buf.byteLength / 1024).toFixed(1)} KB)...`);

    const { group, geometry } = buildSceneFromStlBuffer(buf);

    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    group.position.sub(center);

    replaceCurrentModel(group, { preserveView: !!opts.preserveView, isMjcf: false });

    const triCount = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
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

  async function loadMjcf(url, paramsUrl, onLog = () => {}, opts = {}) {
    onLog('MJCF loading ...');
    const { root, simulation, partInfo } = await loadMjcfScene({
      url,
      paramsUrl,
      baseUrl: url,
      getMujoco
    }, onLog);
    root.userData.mjcfSimulation = simulation;
    replaceCurrentModel(root, { preserveView: !!opts.preserveView, isMjcf: true });
    return partInfo;
  }

  /**
   * Unified entry: choose BREP/STL/MJCF loader by URL suffix or explicit format.
   * @param {string} url
   * @param {(msg:string)=>void} [onLog]
   * @param {{ format?: 'BREP'|'STL'|'MJCF', paramsUrl?: string, preserveView?: boolean }} [opts]
   */
  async function loadModel(url, onLog = () => {}, opts = {}) {
    const fmt = (opts.format || '').toUpperCase();
    appearanceController.reset();
    let partInfo;
    if (fmt === 'MJCF' || /\/asm\.xml(\?|$)/i.test(url)) {
      partInfo = await loadMjcf(url, opts.paramsUrl, onLog, opts);
    } else {
      const isStl = fmt === 'STL' || /\.stl(\?|$)/i.test(url);
      partInfo = await (isStl ? loadStl(url, onLog, opts) : loadBrep(url, onLog, opts));
    }
    const params = await loadViewerParams(opts.paramsUrl, onLog);
    appearanceController.setMaterialParams(params);
    previewController.refresh();
    return partInfo;
  }

  function mountViewCube(hostEl) {
    if (viewCube) {
      viewCube.dispose();
      viewCube = null;
    }
    if (!hostEl) return;
    viewCube = createViewCubeOverlay(hostEl, {
      onNavigate: (viewSpec) => {
        if (!currentRoot) return;
        viewController.setView(viewSpec);
      }
    });
    viewCube.setEnabled(!!currentRoot);
  }

  function setViewCubeEnabled(enabled) {
    if (viewCube) viewCube.setEnabled(!!enabled);
  }

  function setPreviewMode(mode) {
    return previewController.setMode(mode);
  }

  function refreshPreview() {
    previewController.refresh();
  }

  function setSectionEnabled(enabled) {
    sectionController.setSectionEnabled(enabled);
    sectionFill.update();
  }

  function setSectionNormalized(normalized) {
    sectionController.setSectionNormalized(normalized);
    sectionFill.update();
  }

  function setSectionAxis(axis) {
    sectionController.setSectionAxis(axis);
    sectionFill.update();
  }

  function resetSection() {
    sectionController.resetSection();
    sectionFill.update();
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
    loadModel,
    snapshot,
    setView: viewController.setView,
    fitView: viewController.fitView,
    cycleView: viewController.cycleView,
    setSectionEnabled,
    setSectionNormalized,
    setSectionAxis,
    resetSection,
    getSectionState: sectionController.getSectionState,
    refreshPreview,
    setMaterialParams: appearanceController.setMaterialParams,
    setPartMaterial: appearanceController.setPartMaterial,
    setPartMaterialColor: appearanceController.setPartMaterialColor,
    setPartMaterialColors: appearanceController.setPartMaterialColors,
    getMaterialParts: appearanceController.getMaterialParts,
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
      contactShadow.dispose();
      lighting.dispose();
      sectionFill.dispose();
      referenceAxes.dispose();
      renderer.dispose();
    }
  };
}
