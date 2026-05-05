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
// Vite treats wasm as an asset and returns the final bundled URL
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

/**
 * A viewer object wrapping a Three.js scene:
 *  - Uses occt-import-js (WASM version of OCCT) to parse BREP binary streams
 *  - Keeps all BREP faces merged into a single mesh for efficient rendering
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

  function createAxisLabel(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 72;
    canvas.height = 72;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '700 34px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(6, 16, 24, 0.9)';
    ctx.fillStyle = color;
    ctx.strokeText(text, 36, 38);
    ctx.fillText(text, 36, 38);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(3.6, 3.6, 1);
    sprite.userData.isAxisLabel = true;
    sprite.userData.axisTexture = texture;
    return sprite;
  }

  function createReferenceAxes() {
    const group = new THREE.Group();
    group.visible = false;
    const helper = new THREE.AxesHelper(30);
    for (const material of Array.isArray(helper.material) ? helper.material : [helper.material]) {
      material.depthTest = false;
    }
    helper.renderOrder = 999;
    group.add(helper);

    const xLabel = createAxisLabel('X', '#ff6e6e');
    const yLabel = createAxisLabel('Y', '#4ade80');
    const zLabel = createAxisLabel('Z', '#6ee7ff');
    xLabel.position.set(33, 0, 0);
    yLabel.position.set(0, 33, 0);
    zLabel.position.set(0, 0, 33);
    group.add(xLabel, yLabel, zLabel);
    return group;
  }

  const axes = createReferenceAxes();
  axes.renderOrder = 999;
  scene.add(axes);
  const sectionFill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x6ee7ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    })
  );
  sectionFill.visible = false;
  sectionFill.renderOrder = 80;
  scene.add(sectionFill);
  renderer.localClippingEnabled = true;

  /* ---- State ---- */
  let currentRoot = null;         // three.Group for current BREP model
  let currentMjcfRoot = null;
  let mjcfSimulation = null;
  let viewCube = null;
  let previewMode = 'solid';
  const sectionController = createSectionController(renderer, () => currentRoot);
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

  /* ---- Cleanup ---- */
  function disposeObject(obj) {
    obj.traverse((child) => {
      if (child.isMesh || child.isLineSegments) {
        child.geometry?.dispose();
        const m = child.material;
        if (Array.isArray(m)) {
          m.forEach((mm) => {
            mm?.map?.dispose?.();
            mm?.dispose?.();
          });
        } else {
          m?.map?.dispose?.();
          m?.dispose?.();
        }
      } else if (child.isSprite) {
        child.material?.map?.dispose?.();
        child.material?.dispose?.();
      }
    });
  }

  function materialList(material) {
    return Array.isArray(material) ? material : [material];
  }

  function setReferenceAxesForBox(box) {
    if (!box || box.isEmpty()) {
      axes.visible = false;
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const length = THREE.MathUtils.clamp(Math.max(size.x, size.y, size.z) * 0.42, 12, 220);
    axes.position.copy(center);
    axes.scale.setScalar(length / 33);
    axes.visible = true;
  }

  function updateSectionFill() {
    const info = sectionController.getSectionPlaneInfo?.();
    if (!info?.enabled || !currentRoot) {
      sectionFill.visible = false;
      return;
    }
    const ranges = info.ranges || {};
    const spanX = Math.max(1e-3, (ranges.x?.max ?? 1) - (ranges.x?.min ?? -1));
    const spanY = Math.max(1e-3, (ranges.y?.max ?? 1) - (ranges.y?.min ?? -1));
    const spanZ = Math.max(1e-3, (ranges.z?.max ?? 1) - (ranges.z?.min ?? -1));
    const centerX = ((ranges.x?.min ?? -1) + (ranges.x?.max ?? 1)) * 0.5;
    const centerY = ((ranges.y?.min ?? -1) + (ranges.y?.max ?? 1)) * 0.5;
    const centerZ = ((ranges.z?.min ?? -1) + (ranges.z?.max ?? 1)) * 0.5;
    const pad = 1.08;
    const offset = Math.max(spanX, spanY, spanZ) * 0.0008;

    sectionFill.rotation.set(0, 0, 0);
    sectionFill.position.set(centerX, centerY, centerZ);
    if (info.axis === 'x') {
      sectionFill.position.x = info.coord + offset;
      sectionFill.rotation.y = Math.PI / 2;
      sectionFill.scale.set(spanZ * pad, spanY * pad, 1);
    } else if (info.axis === 'z') {
      sectionFill.position.z = info.coord + offset;
      sectionFill.scale.set(spanX * pad, spanY * pad, 1);
    } else {
      sectionFill.position.y = info.coord + offset;
      sectionFill.rotation.x = Math.PI / 2;
      sectionFill.scale.set(spanX * pad, spanZ * pad, 1);
    }
    sectionFill.visible = true;
  }

  function applyPreviewMode() {
    if (!currentRoot) return;
    const isWireframe = previewMode === 'wireframe';
    const isXray = previewMode === 'xray';
    currentRoot.traverse((child) => {
      if (child?.isMesh) {
        for (const material of materialList(child.material)) {
          if (!material || !('wireframe' in material)) continue;
          if (!material.userData.__previewBackup) {
            material.userData.__previewBackup = {
              transparent: !!material.transparent,
              opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
              depthWrite: !!material.depthWrite,
              color: material.color?.getHex?.()
            };
          }
          const backup = material.userData.__previewBackup;
          material.wireframe = isWireframe;
          if (isXray) {
            material.transparent = true;
            material.opacity = 0.26;
            material.depthWrite = false;
          } else {
            material.transparent = backup.transparent;
            material.opacity = backup.opacity;
            material.depthWrite = backup.depthWrite;
          }
          material.needsUpdate = true;
        }
        child.castShadow = !isWireframe && !isXray;
        return;
      }
      if (child?.isLineSegments) {
        child.visible = !isWireframe;
        const lineMaterials = materialList(child.material);
        for (const material of lineMaterials) {
          if (!material) continue;
          if (!material.userData.__previewBackup) {
            material.userData.__previewBackup = {
              color: material.color?.getHex?.(),
              opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
              transparent: !!material.transparent,
              depthTest: !!material.depthTest
            };
          }
          const backup = material.userData.__previewBackup;
          if (isXray) {
            if (material.color) material.color.setHex(0x061018);
            material.transparent = true;
            material.opacity = 0.86;
            material.depthTest = false;
          } else {
            if (material.color && Number.isFinite(backup.color)) material.color.setHex(backup.color);
            material.transparent = backup.transparent;
            material.opacity = backup.opacity;
            material.depthTest = backup.depthTest;
          }
          material.needsUpdate = true;
        }
      }
    });
    if (contactShadow?.object) {
      contactShadow.object.visible = !isWireframe && !isXray && !!currentRoot;
    }
    updateSectionFill();
  }

  function clearModel() {
    if (currentRoot) {
      scene.remove(currentRoot);
      disposeObject(currentRoot);
      currentRoot = null;
    }
    currentMjcfRoot = null;
    disposeMjcfSimulation(mjcfSimulation);
    mjcfSimulation = null;
    sectionController.reset();
    appearanceController.reset();
    contactShadow.hide();
    axes.visible = false;
    sectionFill.visible = false;
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
    setReferenceAxesForBox(modelBox);
    sectionController.setRangesFromBox(modelBox);
    sectionController.apply();
    appearanceController.apply();
    applyPreviewMode();
    sectionController.apply();

    if (previousRoot) {
      scene.remove(previousRoot);
      disposeObject(previousRoot);
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
    getPreviewMode: () => previewMode,
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
    applyPreviewMode();
    sectionController.apply();
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
    previewMode = ['solid', 'xray', 'wireframe'].includes(mode) ? mode : 'solid';
    applyPreviewMode();
    sectionController.apply();
    return previewMode;
  }

  function refreshPreview() {
    applyPreviewMode();
    sectionController.apply();
  }

  function setSectionEnabled(enabled) {
    sectionController.setSectionEnabled(enabled);
    updateSectionFill();
  }

  function setSectionNormalized(normalized) {
    sectionController.setSectionNormalized(normalized);
    updateSectionFill();
  }

  function setSectionAxis(axis) {
    sectionController.setSectionAxis(axis);
    updateSectionFill();
  }

  function resetSection() {
    sectionController.resetSection();
    updateSectionFill();
  }

  /* ---- Public API ---- */
  return {
    scene,
    camera,
    renderer,
    mountViewCube,
    setViewCubeEnabled,
    setPreviewMode,
    getPreviewMode: () => previewMode,
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
      scene.remove(sectionFill);
      sectionFill.geometry.dispose();
      sectionFill.material.dispose();
      renderer.dispose();
    }
  };
}
