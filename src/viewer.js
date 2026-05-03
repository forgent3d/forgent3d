import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import occtImportJs from 'occt-import-js';
import loadMujoco from '@mujoco/mujoco';
import { loadMjcfDocument } from './mjcf.js';
// Vite treats wasm as an asset and returns the final bundled URL
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

function vec3From(value) {
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
  }
  return new THREE.Vector3();
}

function composeViewCubeLabel(signs) {
  const labels = [];
  if (signs.y) labels.push(signs.y > 0 ? 'Top' : 'Bottom');
  if (signs.z) labels.push(signs.z > 0 ? 'Front' : 'Back');
  if (signs.x) labels.push(signs.x > 0 ? 'Right' : 'Left');
  return labels.join(' ');
}

function createViewCubeLabelTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${text.length > 5 ? 40 : 48}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
    ctx.fillStyle = 'rgba(241, 247, 255, 0.96)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillText(text.toUpperCase(), canvas.width / 2, canvas.height / 2 + 4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createViewCubePlane(normal, distance, size, material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  const unitNormal = normal.clone().normalize();
  mesh.position.copy(unitNormal).multiplyScalar(distance);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), unitNormal);
  return mesh;
}

function createViewCubeOverlay(host, { onNavigate }) {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'viewcube-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);

  const root = new THREE.Group();
  scene.add(root);

  const textures = [];
  const pickables = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const cubeHalf = 0.78;
  const faceSize = 1.28;
  const edgeLength = 0.54;
  const edgeThickness = 0.16;
  const cornerSize = 0.22;
  const accentColor = 0x8ee8ff;
  let enabled = false;
  let hovered = null;

  const frameBaseGeometry = new THREE.BoxGeometry(cubeHalf * 2.06, cubeHalf * 2.06, cubeHalf * 2.06);
  const frameGeometry = new THREE.EdgesGeometry(frameBaseGeometry);
  frameBaseGeometry.dispose();
  const frameMaterial = new THREE.LineBasicMaterial({
    color: 0xa8dfff,
    transparent: true,
    opacity: 0.92
  });
  root.add(new THREE.LineSegments(frameGeometry, frameMaterial));

  function addPickable(mesh, data) {
    mesh.userData = {
      ...mesh.userData,
      ...data,
      baseColor: data.baseColor ?? mesh.material.color.getHex(),
      baseOpacity: data.baseOpacity ?? mesh.material.opacity,
      activeColor: data.activeColor ?? accentColor,
      activeOpacity: data.activeOpacity ?? 0.95
    };
    pickables.push(mesh);
    return mesh;
  }

  function applyHoverState(mesh, active) {
    if (!mesh?.material?.color) return;
    mesh.material.color.setHex(active ? mesh.userData.activeColor : mesh.userData.baseColor);
    mesh.material.opacity = active ? mesh.userData.activeOpacity : mesh.userData.baseOpacity;
  }

  function setHovered(next) {
    if (hovered === next) return;
    if (hovered) applyHoverState(hovered, false);
    hovered = next || null;
    if (hovered) applyHoverState(hovered, true);
    renderer.domElement.style.cursor = hovered && enabled ? 'pointer' : 'default';
    host.title = hovered?.userData?.label ? `ViewCube: ${hovered.userData.label}` : 'ViewCube';
  }

  function offsetPosition(signs, offset) {
    return new THREE.Vector3(
      signs.x === 0 ? 0 : Math.sign(signs.x) * (cubeHalf + offset),
      signs.y === 0 ? 0 : Math.sign(signs.y) * (cubeHalf + offset),
      signs.z === 0 ? 0 : Math.sign(signs.z) * (cubeHalf + offset)
    );
  }

  const faceSpecs = [
    { key: 'top', label: 'Top', text: 'Top', normal: [0, 1, 0], color: 0x4978b6 },
    { key: 'front', label: 'Front', text: 'Front', normal: [0, 0, 1], color: 0x355d96 },
    { key: 'right', label: 'Right', text: 'Right', normal: [1, 0, 0], color: 0x2a4f80 },
    { key: 'left', label: 'Left', text: 'Left', normal: [-1, 0, 0], color: 0x213650 },
    { key: 'back', label: 'Back', text: 'Back', normal: [0, 0, -1], color: 0x1a293f },
    { key: 'bottom', label: 'Bottom', text: 'Bottom', normal: [0, -1, 0], color: 0x162033 }
  ];

  for (const spec of faceSpecs) {
    const normal = vec3From(spec.normal).normalize();
    const faceMaterial = new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: 0.96
    });
    const faceMesh = createViewCubePlane(normal, cubeHalf, faceSize, faceMaterial);
    addPickable(faceMesh, {
      kind: 'face',
      priority: 10,
      label: spec.label,
      viewSpec: {
        key: spec.key,
        label: spec.label,
        dir: normal.clone()
      },
      baseColor: spec.color,
      baseOpacity: 0.96,
      activeOpacity: 1
    });
    root.add(faceMesh);

    const labelTexture = createViewCubeLabelTexture(spec.text);
    textures.push(labelTexture);
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: labelTexture,
      transparent: true,
      depthWrite: false
    });
    const labelMesh = createViewCubePlane(normal, cubeHalf + 0.02, faceSize * 0.82, labelMaterial);
    root.add(labelMesh);
  }

  const edgeSpecs = [
    { axis: 'y', signs: { x: 1, y: 0, z: 1 } },
    { axis: 'y', signs: { x: -1, y: 0, z: 1 } },
    { axis: 'y', signs: { x: 1, y: 0, z: -1 } },
    { axis: 'y', signs: { x: -1, y: 0, z: -1 } },
    { axis: 'x', signs: { x: 0, y: 1, z: 1 } },
    { axis: 'x', signs: { x: 0, y: 1, z: -1 } },
    { axis: 'x', signs: { x: 0, y: -1, z: 1 } },
    { axis: 'x', signs: { x: 0, y: -1, z: -1 } },
    { axis: 'z', signs: { x: 1, y: 1, z: 0 } },
    { axis: 'z', signs: { x: -1, y: 1, z: 0 } },
    { axis: 'z', signs: { x: 1, y: -1, z: 0 } },
    { axis: 'z', signs: { x: -1, y: -1, z: 0 } }
  ];

  for (const spec of edgeSpecs) {
    const dims = spec.axis === 'x'
      ? [edgeLength, edgeThickness, edgeThickness]
      : spec.axis === 'y'
        ? [edgeThickness, edgeLength, edgeThickness]
        : [edgeThickness, edgeThickness, edgeLength];
    const edgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x688cb4,
      transparent: true,
      opacity: 0.26
    });
    const edgeMesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), edgeMaterial);
    edgeMesh.position.copy(offsetPosition(spec.signs, 0.04));
    addPickable(edgeMesh, {
      kind: 'edge',
      priority: 20,
      label: composeViewCubeLabel(spec.signs),
      viewSpec: {
        key: composeViewCubeLabel(spec.signs).toLowerCase().replace(/\s+/g, '-'),
        label: composeViewCubeLabel(spec.signs),
        dir: new THREE.Vector3(spec.signs.x, spec.signs.y, spec.signs.z).normalize()
      },
      baseColor: 0x688cb4,
      baseOpacity: 0.26,
      activeOpacity: 0.82
    });
    root.add(edgeMesh);
  }

  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        const signs = { x, y, z };
        const cornerMaterial = new THREE.MeshBasicMaterial({
          color: 0x56759a,
          transparent: true,
          opacity: 0.32
        });
        const cornerMesh = new THREE.Mesh(new THREE.BoxGeometry(cornerSize, cornerSize, cornerSize), cornerMaterial);
        cornerMesh.position.copy(offsetPosition(signs, 0.08));
        addPickable(cornerMesh, {
          kind: 'corner',
          priority: 30,
          label: composeViewCubeLabel(signs),
          viewSpec: {
            key: composeViewCubeLabel(signs).toLowerCase().replace(/\s+/g, '-'),
            label: composeViewCubeLabel(signs),
            dir: new THREE.Vector3(x, y, z).normalize()
          },
          baseColor: 0x56759a,
          baseOpacity: 0.32,
          activeOpacity: 0.9
        });
        root.add(cornerMesh);
      }
    }
  }

  function resizeRenderer() {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const aspect = width / height;
    const extent = 1.92;
    renderer.setSize(width, height, false);
    camera.left = -extent * aspect;
    camera.right = extent * aspect;
    camera.top = extent;
    camera.bottom = -extent;
    camera.updateProjectionMatrix();
  }

  function pickObject(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersections = raycaster.intersectObjects(pickables, false);
    intersections.sort((a, b) => {
      const prio = (b.object.userData.priority || 0) - (a.object.userData.priority || 0);
      return prio || a.distance - b.distance;
    });
    return intersections[0]?.object || null;
  }

  function stopPointer(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerMove(event) {
    if (!enabled) return;
    stopPointer(event);
    setHovered(pickObject(event));
  }

  function onPointerLeave() {
    setHovered(null);
  }

  function onPointerDown(event) {
    if (!enabled) return;
    stopPointer(event);
  }

  function onClick(event) {
    if (!enabled) return;
    stopPointer(event);
    const picked = pickObject(event);
    if (picked?.userData?.viewSpec) {
      onNavigate?.(picked.userData.viewSpec);
    }
  }

  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('click', onClick);

  const ro = new ResizeObserver(resizeRenderer);
  ro.observe(host);
  resizeRenderer();

  return {
    render(mainCameraQuaternion) {
      root.quaternion.copy(mainCameraQuaternion).invert();
      renderer.render(scene, camera);
    },
    setEnabled(value) {
      enabled = !!value;
      host.classList.toggle('disabled', !enabled);
      if (!enabled) {
        setHovered(null);
        renderer.domElement.style.cursor = 'default';
        host.title = 'ViewCube';
      }
    },
    dispose() {
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('click', onClick);
      ro.disconnect();
      setHovered(null);
      root.traverse((child) => {
        child.geometry?.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      host.replaceChildren();
    }
  };
}

/**
 * A viewer object wrapping a Three.js scene:
 *  - Uses occt-import-js (WASM version of OCCT) to parse BREP binary streams
 *  - Keeps all BREP faces merged into a single mesh for efficient rendering
 */
export function createViewer(host) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);

  const camera = new THREE.PerspectiveCamera(
    45, host.clientWidth / host.clientHeight, 0.1, 5000
  );
  camera.position.set(80, 60, 100);

  // preserveDrawingBuffer is required for stable canvas.toDataURL snapshots,
  // used by MCP screenshot_model tool
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  // TrackballControls allows continuous orbiting past the top/bottom poles.
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 6;
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.12;
  controls.target.set(0, 0, 0);
  controls.handleResize();

  // Lighting: directional lights follow the camera so the key always comes from
  // roughly the viewing hemisphere (fixed world-space lights read as "back-lit" when orbiting).
  scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x0b0d12, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0x9aa3ff, 0.35);
  scene.add(fill);
  scene.add(fill.target);

  const _lightKeyOffset = new THREE.Vector3(0.85, 0.55, 0.35).normalize();
  const _lightFillOffset = new THREE.Vector3(-0.65, 0.25, -0.55).normalize();
  const _lightSphere = new THREE.Sphere();

  function updateDirectionalLights(viewCamera, orbitTarget) {
    key.target.position.copy(orbitTarget);
    fill.target.position.copy(orbitTarget);
    let radius = 80;
    if (currentRoot) {
      new THREE.Box3().setFromObject(currentRoot).getBoundingSphere(_lightSphere);
      radius = Math.max(_lightSphere.radius, 1e-3);
    }
    const arm = Math.max(radius * 2.8, 120);
    _lightKeyOffset.set(0.85, 0.55, 0.35).normalize();
    _lightFillOffset.set(-0.65, 0.25, -0.55).normalize();
    _lightKeyOffset.applyQuaternion(viewCamera.quaternion);
    _lightFillOffset.applyQuaternion(viewCamera.quaternion);
    key.position.copy(viewCamera.position).addScaledVector(_lightKeyOffset, arm);
    fill.position.copy(viewCamera.position).addScaledVector(_lightFillOffset, arm * 0.95);
    key.target.updateMatrixWorld();
    fill.target.updateMatrixWorld();
  }

  const axes = new THREE.AxesHelper(30);
  axes.material.depthTest = false;
  axes.renderOrder = 999;
  axes.visible = false;
  scene.add(axes);
  renderer.localClippingEnabled = true;

  /* ---- State ---- */
  let currentRoot = null;         // three.Group for current BREP model
  let currentMjcfRoot = null;
  let mjcfSimulation = null;
  let currentViewKey = 'iso';
  const VIEW_CYCLE = ['iso', 'front', 'side', 'top'];
  const _viewBox = new THREE.Box3();
  const _viewSphere = new THREE.Sphere();
  let viewCube = null;
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const SECTION_AXIS_NORMALS = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1)
  };
  const sectionState = {
    enabled: false,
    axis: 'y',
    normalized: 0,
    ranges: {
      x: { min: -1, max: 1 },
      y: { min: -1, max: 1 },
      z: { min: -1, max: 1 }
    }
  };
  let ghostEnabled = false;

  /* ---- Animation ---- */
  let running = true;
  let lastFrameTs = performance.now();
  function animateMjcfSimulation(dt) {
    if (!currentMjcfRoot) return;
    const sim = currentMjcfRoot.userData?.mjcfSimulation;
    if (!sim) return;
    try {
      stepMjcfSimulation(dt);
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
    updateDirectionalLights(camera, controls.target);
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
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m?.dispose();
      }
    });
  }

  function disposeMjcfSimulation(sim) {
    if (!sim) return;
    for (const binding of sim.bodyBindings || []) binding.bodyAccessor?.delete?.();
    sim.defaultCtrlAccessor?.delete?.();
    sim.data?.delete?.();
    sim.model?.delete?.();
    sim.vfs?.delete?.();
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
    sectionState.ranges = {
      x: { min: -1, max: 1 },
      y: { min: -1, max: 1 },
      z: { min: -1, max: 1 }
    };
    sectionState.axis = 'y';
    sectionState.normalized = 0;
    sectionState.enabled = false;
    ghostEnabled = false;
    renderer.clippingPlanes = [];
    controls.target.set(0, 0, 0);
    controls.update();
    currentViewKey = 'iso';
    if (viewCube) viewCube.setEnabled(false);
  }

  function captureViewState() {
    return {
      cameraPosition: camera.position.clone(),
      cameraQuaternion: camera.quaternion.clone(),
      cameraUp: camera.up.clone(),
      target: controls.target.clone(),
      viewKey: currentViewKey
    };
  }

  function restoreViewState(state) {
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

  function replaceCurrentModel(nextRoot, { preserveView = false, isMjcf = false } = {}) {
    const previousRoot = currentRoot;
    const previousSimulation = mjcfSimulation;
    const viewState = preserveView && previousRoot ? captureViewState() : null;

    scene.add(nextRoot);
    currentRoot = nextRoot;
    currentMjcfRoot = isMjcf ? nextRoot : null;
    mjcfSimulation = isMjcf ? (nextRoot.userData.mjcfSimulation || null) : null;
    const modelBox = new THREE.Box3().setFromObject(nextRoot);
    const axes = ['x', 'y', 'z'];
    for (const axis of axes) {
      const min = modelBox.min[axis];
      const max = modelBox.max[axis];
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        sectionState.ranges[axis] = { min, max };
      } else {
        sectionState.ranges[axis] = { min: -1, max: 1 };
      }
    }
    applySectionPlane();
    applyGhostMode();

    if (previousRoot) {
      scene.remove(previousRoot);
      disposeObject(previousRoot);
    }
    if (previousSimulation && previousSimulation !== mjcfSimulation) {
      disposeMjcfSimulation(previousSimulation);
    }

    if (viewState) {
      restoreViewState(viewState);
    } else {
      controls.target.set(0, 0, 0);
      controls.update();
      fitView('iso');
    }
    if (viewCube) viewCube.setEnabled(true);
  }

  function getSectionWorldCoord() {
    const t = (THREE.MathUtils.clamp(sectionState.normalized, -1, 1) + 1) * 0.5;
    const { min, max } = sectionState.ranges[sectionState.axis] || { min: -1, max: 1 };
    return THREE.MathUtils.lerp(min, max, t);
  }

  function applySectionPlane() {
    const coord = getSectionWorldCoord();
    const normal = SECTION_AXIS_NORMALS[sectionState.axis] || SECTION_AXIS_NORMALS.y;
    sectionPlane.set(normal, -coord);
    renderer.clippingPlanes = sectionState.enabled ? [sectionPlane] : [];
  }

  function setSectionEnabled(enabled) {
    sectionState.enabled = !!enabled;
    applySectionPlane();
  }

  function setSectionNormalized(normalized) {
    sectionState.normalized = THREE.MathUtils.clamp(Number(normalized) || 0, -1, 1);
    applySectionPlane();
  }

  function setSectionAxis(axis) {
    const nextAxis = String(axis || '').toLowerCase();
    sectionState.axis = ['x', 'y', 'z'].includes(nextAxis) ? nextAxis : 'y';
    applySectionPlane();
  }

  function resetSection() {
    sectionState.normalized = 0;
    applySectionPlane();
  }

  function getSectionState() {
    return {
      enabled: sectionState.enabled,
      axis: sectionState.axis,
      normalized: sectionState.normalized,
      ghost: ghostEnabled
    };
  }

  function applyGhostMode() {
    if (!currentRoot) return;
    currentRoot.traverse((child) => {
      if (!child?.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (!m) continue;
        if (!m.userData.__ghostBackup) {
          m.userData.__ghostBackup = {
            transparent: !!m.transparent,
            opacity: Number.isFinite(m.opacity) ? m.opacity : 1
          };
        }
        if (ghostEnabled) {
          m.transparent = true;
          m.opacity = Math.min(0.22, m.userData.__ghostBackup.opacity);
        } else {
          m.transparent = m.userData.__ghostBackup.transparent;
          m.opacity = m.userData.__ghostBackup.opacity;
        }
        m.needsUpdate = true;
      }
    });
  }

  function setGhostEnabled(enabled) {
    ghostEnabled = !!enabled;
    applyGhostMode();
  }

  /* ---- Load BREP ---- */

  /**
   * Merge meshes returned by occt-import-js into one large BufferGeometry,
   * and mark each BREP face with geometry.groups + userData.faceRanges.
   * Returns a three.Group.
   */
  function buildSceneFromOcctResult(occtResult) {
    const group = new THREE.Group();

    // Merge faces from all solids into one geometry so we get one draw call,
    // and raycaster intersect.faceIndex remains a global triangle index
    const positions = [];   // number[]
    const normals = [];     // number[]
    const indices = [];     // number[]
    /** faceRanges[i] = {faceIndex, triStart, triCount, centroid, normal}
     *  triStart / triCount are global triangle index ranges in this geometry */
    const faceRanges = [];

    let vertexOffset = 0;
    let triOffset = 0;
    let globalFaceIdx = 0;

    for (const mesh of occtResult.meshes) {
      const posArr = mesh.attributes.position.array;
      const nrmArr = mesh.attributes.normal?.array;
      const idxArr = mesh.index.array;

      // Vertices
      for (let i = 0; i < posArr.length; i++) positions.push(posArr[i]);
      if (nrmArr && nrmArr.length === posArr.length) {
        for (let i = 0; i < nrmArr.length; i++) normals.push(nrmArr[i]);
      } else {
        // Placeholder; computeVertexNormals will recalculate later
        for (let i = 0; i < posArr.length; i++) normals.push(0);
      }
      // Triangle indices -> add offset
      for (let i = 0; i < idxArr.length; i++) indices.push(idxArr[i] + vertexOffset);

      // For each BREP face, first/last are triangle indices within this mesh.
      // Convert them to global triangle indices in merged geometry.
      for (const bf of mesh.brep_faces) {
        const triStart = triOffset + bf.first;
        const triCount = bf.last - bf.first + 1;

        // Estimate face centroid and normal for logs/toast/>Z compatibility
        const c = estimateFaceCentroidAndNormal(posArr, idxArr, bf.first, bf.last);

        faceRanges.push({
          faceIndex: globalFaceIdx++,
          triStart,
          triCount,
          centroid: c.centroid,
          normal: c.normal
        });
      }

      vertexOffset += posArr.length / 3;
      triOffset += idxArr.length / 3;
    }

    if (indices.length === 0) return group;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    if (normals.every((v) => v === 0)) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: 0x8fa3ff,
      metalness: 0.25,
      roughness: 0.55,
      side: THREE.DoubleSide
    });

    const threeMesh = new THREE.Mesh(geometry, material);
    threeMesh.userData.faceRanges = faceRanges;
    group.add(threeMesh);

    // Add wireframe overlay to make CAD topology edges clearer
    const edges = new THREE.EdgesGeometry(geometry, 20);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x1a2340, transparent: true, opacity: 0.35
    });
    const lines = new THREE.LineSegments(edges, lineMat);
    lines.userData.isWireframe = true;
    group.add(lines);

    return group;
  }

  function estimateFaceCentroidAndNormal(posArr, idxArr, firstTri, lastTri) {
    const centroid = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let triCount = 0;
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let t = firstTri; t <= lastTri; t++) {
      const ia = idxArr[t * 3 + 0];
      const ib = idxArr[t * 3 + 1];
      const ic = idxArr[t * 3 + 2];
      v0.set(posArr[ia * 3], posArr[ia * 3 + 1], posArr[ia * 3 + 2]);
      v1.set(posArr[ib * 3], posArr[ib * 3 + 1], posArr[ib * 3 + 2]);
      v2.set(posArr[ic * 3], posArr[ic * 3 + 1], posArr[ic * 3 + 2]);
      centroid.add(v0).add(v1).add(v2);
      e1.subVectors(v1, v0); e2.subVectors(v2, v0);
      n.crossVectors(e1, e2);
      if (n.lengthSq() > 0) { n.normalize(); normal.add(n); }
      triCount++;
    }
    if (triCount > 0) {
      centroid.multiplyScalar(1 / (triCount * 3));
      if (normal.lengthSq() > 0) normal.normalize();
      else normal.set(0, 0, 1);
    }
    return { centroid, normal };
  }

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

  const SNAPSHOT_VIEWS = {
    iso: {
      dir: new THREE.Vector3(1, 0.85, 1).normalize(),
      up: new THREE.Vector3(0, 1, 0)
    },
    front: {
      dir: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0)
    },
    side: {
      dir: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0)
    },
    top: {
      dir: new THREE.Vector3(0, 1, 0.02).normalize(),
      up: new THREE.Vector3(0, 0, -1)
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

  function getViewDistance(target = controls.target) {
    const distance = camera.position.distanceTo(target);
    return Number.isFinite(distance) && distance > 1e-3 ? distance : 120;
  }

  function getCurrentModelSphere() {
    if (!currentRoot) return null;
    _viewBox.setFromObject(currentRoot).getBoundingSphere(_viewSphere);
    return _viewSphere.clone();
  }

  function getFittedViewDistance(target = controls.target) {
    const sphere = getCurrentModelSphere();
    if (!sphere) return getViewDistance(target);
    // If target drifts away from model center (common in assembly updates),
    // include that offset in fit radius so camera framing stays stable.
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

  function buildViewBasis(dir, upHint) {
    const forward = dir.clone().normalize();
    let up = (upHint || new THREE.Vector3(0, 1, 0)).clone().normalize();
    let right = new THREE.Vector3().crossVectors(forward, up);
    if (right.lengthSq() < 1e-8) {
      up = Math.abs(forward.y) < 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
      right = new THREE.Vector3().crossVectors(forward, up);
    }
    right.normalize();
    up = new THREE.Vector3().crossVectors(right, forward).normalize();
    return { forward, right, up };
  }

  function rotateViewBasis(basis, angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(basis.forward, angle);
    return {
      forward: basis.forward.clone(),
      right: basis.right.clone().applyQuaternion(q).normalize(),
      up: basis.up.clone().applyQuaternion(q).normalize()
    };
  }

  function projectWorldPointToBasis(point, center, basis) {
    const delta = point.clone().sub(center);
    return {
      x: delta.dot(basis.right),
      y: delta.dot(basis.up),
      z: delta.dot(basis.forward)
    };
  }

  function appendBoundingBoxCorners(points, box) {
    const xs = [box.min.x, box.max.x];
    const ys = [box.min.y, box.max.y];
    const zs = [box.min.z, box.max.z];
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          points.push(new THREE.Vector3(x, y, z));
        }
      }
    }
  }

  function collectModelSamplePoints(root, box, maxPoints = 4096) {
    const meshes = [];
    let totalVertices = 0;
    root.updateWorldMatrix(true, true);
    root.traverse((child) => {
      const pos = child?.geometry?.attributes?.position;
      if (!child?.isMesh || !pos) return;
      meshes.push({ child, pos });
      totalVertices += pos.count;
    });

    const step = Math.max(1, Math.ceil(totalVertices / Math.max(1, maxPoints)));
    const world = new THREE.Vector3();
    const sampled = [];
    for (const { child, pos } of meshes) {
      for (let i = 0; i < pos.count; i += step) {
        world.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
        sampled.push(world.clone());
      }
    }
    appendBoundingBoxCorners(sampled, box);
    return sampled;
  }

  function projectWorldPointsToBasis(points, center, basis) {
    return points.map((point) => projectWorldPointToBasis(point, center, basis));
  }

  function computePrincipalAngle2D(points) {
    if (!points.length) return 0;
    let meanX = 0;
    let meanY = 0;
    for (const p of points) {
      meanX += p.x;
      meanY += p.y;
    }
    meanX /= points.length;
    meanY /= points.length;

    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (const p of points) {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      xx += dx * dx;
      xy += dx * dy;
      yy += dy * dy;
    }
    return 0.5 * Math.atan2(2 * xy, xx - yy);
  }

  function computeAxisAlignedExtents2D(points) {
    if (!points.length) return { width: 1, height: 1 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    return {
      width: Math.max(1e-3, maxX - minX),
      height: Math.max(1e-3, maxY - minY)
    };
  }

  function computeAxisAlignedDepthRange(points) {
    if (!points.length) return { min: -1, max: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      min = Math.min(min, p.z);
      max = Math.max(max, p.z);
    }
    return { min, max };
  }

  function getSnapshotTargetSize(aspect, maxEdge = 1280) {
    const safeAspect = THREE.MathUtils.clamp(aspect || 1, 0.25, 4);
    const capped = Math.max(256, Math.round(maxEdge || 1280));
    if (safeAspect >= 1) {
      return {
        width: capped,
        height: Math.max(256, Math.round(capped / safeAspect))
      };
    }
    return {
      width: Math.max(256, Math.round(capped * safeAspect)),
      height: capped
    };
  }

  function computeSnapshotFrame(root, box, center, view, maxEdge) {
    const sampledPoints = collectModelSamplePoints(root, box);
    const initialBasis = buildViewBasis(view.dir, view.up);
    const initialPoints = projectWorldPointsToBasis(sampledPoints, center, initialBasis);
    const principalAngle = computePrincipalAngle2D(initialPoints);
    const rolledBasis = rotateViewBasis(initialBasis, principalAngle);
    const rolledPoints = projectWorldPointsToBasis(sampledPoints, center, rolledBasis);
    const extents = computeAxisAlignedExtents2D(rolledPoints);
    const actualAspect = extents.width / Math.max(extents.height, 1e-3);
    const outputAspect = THREE.MathUtils.clamp(actualAspect, 0.25, 4);
    const targetSize = getSnapshotTargetSize(outputAspect, maxEdge);
    const fitPadding = 1.08;
    let halfWidth = extents.width * 0.5 * fitPadding;
    let halfHeight = extents.height * 0.5 * fitPadding;
    if (halfWidth / Math.max(halfHeight, 1e-3) < outputAspect) {
      halfWidth = halfHeight * outputAspect;
    } else {
      halfHeight = halfWidth / outputAspect;
    }
    const depth = computeAxisAlignedDepthRange(rolledPoints);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = depth.max + sphere.radius * 2.5 + 1;
    const minDepth = Math.max(0.01, distance - depth.max - sphere.radius * 0.5);
    const maxDepth = distance - depth.min + sphere.radius * 0.5;

    return {
      aspect: outputAspect,
      width: targetSize.width,
      height: targetSize.height,
      up: rolledBasis.up,
      distance,
      halfWidth: Math.max(halfWidth, 1e-3),
      halfHeight: Math.max(halfHeight, 1e-3),
      near: minDepth,
      far: Math.max(minDepth + 1, maxDepth)
    };
  }

  /**
   * Render a single-view screenshot and return data:image/png;base64.
   * @param {string} [mimeType]
   * @param {{ maxEdge?: number, maxWidth?: number, view?: 'iso'|'front'|'side'|'top' }} [opts]
   */
  function snapshot(mimeType = 'image/png', opts = {}) {
    try {
      const src = renderer.domElement;
      const srcW = Math.max(1, src.width);
      const srcH = Math.max(1, src.height);
      const viewKey = String(opts.view || 'iso').toLowerCase();
      const view = SNAPSHOT_VIEWS[viewKey] || SNAPSHOT_VIEWS.iso;
      const maxEdge = opts.maxEdge || opts.maxWidth || Math.max(srcW, srcH);

      // Fallback to single view if no model is present.
      if (!currentRoot) {
        renderer.render(scene, camera);
        return exportCanvasDataUrl(src, mimeType, maxEdge);
      }

      const box = new THREE.Box3().setFromObject(currentRoot);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const center = sphere.center.clone();
      // Each requested view computes its own oriented footprint and aspect ratio.
      const frame = computeSnapshotFrame(currentRoot, box, center, view, maxEdge);

      const oldPixelRatio = renderer.getPixelRatio();
      const oldSize = renderer.getSize(new THREE.Vector2());
      const oldAxesVisible = axes.visible;
      axes.visible = false;

      renderer.setPixelRatio(1);
      renderer.setSize(frame.width, frame.height, false);
      const snapshotCamera = new THREE.OrthographicCamera(
        -frame.halfWidth,
        frame.halfWidth,
        frame.halfHeight,
        -frame.halfHeight,
        frame.near,
        frame.far
      );
      snapshotCamera.position.copy(center).addScaledVector(view.dir, frame.distance);
      snapshotCamera.up.copy(frame.up);
      snapshotCamera.lookAt(center);
      snapshotCamera.updateProjectionMatrix();
      updateDirectionalLights(snapshotCamera, center);
      renderer.render(scene, snapshotCamera);
      const dataUrl = renderer.domElement.toDataURL(mimeType);

      axes.visible = oldAxesVisible;
      renderer.setPixelRatio(oldPixelRatio);
      renderer.setSize(oldSize.x, oldSize.y, false);
      renderer.render(scene, camera);

      return dataUrl;
    } catch (e) {
      return null;
    }
  }

  function exportCanvasDataUrl(canvas, mimeType, maxW) {
    const srcW = canvas.width;
    const srcH = canvas.height;
    if (!maxW || srcW <= maxW && srcH <= maxW) {
      return canvas.toDataURL(mimeType);
    }
    const scale = Math.min(maxW / srcW, maxW / srcH, 1);
    const tw = Math.max(1, Math.round(srcW * scale));
    const th = Math.max(1, Math.round(srcH * scale));
    const out = document.createElement('canvas');
    out.width = tw;
    out.height = th;
    const outCtx = out.getContext('2d');
    if (!outCtx) return canvas.toDataURL(mimeType);
    outCtx.drawImage(canvas, 0, 0, tw, th);
    return out.toDataURL(mimeType);
  }

  /* ---- Load STL mesh preview ---- */

  async function loadStl(url, onLog = () => {}, opts = {}) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    onLog(`STL parsing (${(buf.byteLength / 1024).toFixed(1)} KB)...`);

    const loader = new STLLoader();
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const group = new THREE.Group();

    const material = new THREE.MeshStandardMaterial({
      color: 0x8fa3ff,
      metalness: 0.25,
      roughness: 0.55,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    // STL has no topology face IDs
    group.add(mesh);

    const edges = new THREE.EdgesGeometry(geometry, 20);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x1a2340, transparent: true, opacity: 0.35
    });
    group.add(new THREE.LineSegments(edges, lineMat));

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

  function parseNumberList(value, fallback = []) {
    const text = String(value || '').trim();
    if (!text) return fallback.slice();
    const nums = text.split(/\s+/).map((item) => Number(item));
    return nums.every((num) => Number.isFinite(num)) ? nums : fallback.slice();
  }

  function parseVec3(value, fallback = [0, 0, 0]) {
    const nums = parseNumberList(value, fallback);
    return new THREE.Vector3(nums[0] ?? fallback[0], nums[1] ?? fallback[1], nums[2] ?? fallback[2]);
  }

  function parseQuat(value) {
    const nums = parseNumberList(value, []);
    if (nums.length < 4) return null;
    return new THREE.Quaternion(nums[1], nums[2], nums[3], nums[0]).normalize();
  }

  function parseEulerQuat(value, angleScale) {
    const nums = parseNumberList(value, []);
    if (nums.length < 3) return null;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      nums[0] * angleScale,
      nums[1] * angleScale,
      nums[2] * angleScale,
      'XYZ'
    ));
  }

  function elementChildren(node, tagName = null) {
    return Array.from(node?.children || [])
      .filter((child) => !tagName || child.tagName === tagName);
  }

  function getCompilerAngleScale(document) {
    const compiler = elementChildren(document.documentElement, 'compiler')[0];
    const angle = String(compiler?.getAttribute('angle') || 'degree').trim().toLowerCase();
    return angle === 'radian' ? 1 : Math.PI / 180;
  }

  function applyMjcfTransform(object, element, angleScale) {
    object.position.copy(parseVec3(element.getAttribute('pos')));
    const quat = parseQuat(element.getAttribute('quat')) || parseEulerQuat(element.getAttribute('euler'), angleScale);
    if (quat) object.quaternion.copy(quat);
  }

  function prepareMjcfSkeletonDocument(document) {
    const simDocument = document.cloneNode(true);
    for (const meshEl of Array.from(simDocument.getElementsByTagName('mesh'))) {
      meshEl.parentElement?.removeChild(meshEl);
    }
    for (const geomEl of Array.from(simDocument.getElementsByTagName('geom'))) {
      if (geomEl.hasAttribute('mesh') || String(geomEl.getAttribute('type') || '').trim().toLowerCase() === 'mesh') {
        geomEl.parentElement?.removeChild(geomEl);
      }
    }
    for (const bodyEl of Array.from(simDocument.getElementsByTagName('body'))) {
      const hasJoint = elementChildren(bodyEl).some((child) => child.tagName === 'joint' || child.tagName === 'freejoint');
      const hasInertial = elementChildren(bodyEl, 'inertial').length > 0;
      if (hasJoint && !hasInertial) {
        const inertial = simDocument.createElement('inertial');
        inertial.setAttribute('pos', '0 0 0');
        inertial.setAttribute('mass', '1');
        inertial.setAttribute('diaginertia', '1 1 1');
        bodyEl.insertBefore(inertial, bodyEl.firstChild);
      }
    }
    return simDocument;
  }

  async function createMjcfSimulation(root, document, meshAssets, onLog = () => {}) {
    const mujoco = await getMujoco();
    const vfs = new mujoco.MjVFS();
    try {
      const simDocument = document.cloneNode(true);
      let meshIndex = 0;
      for (const meshEl of Array.from(simDocument.getElementsByTagName('mesh'))) {
        const name = String(meshEl.getAttribute('name') || '').trim();
        const asset = meshAssets.get(name);
        if (!asset?.bytes) continue;
        const safeName = (name || 'asset').replace(/[^\w.-]+/g, '_');
        const vfsPath = `mesh_${meshIndex++}_${safeName}.stl`;
        vfs.addBuffer(vfsPath, asset.bytes);
        meshEl.setAttribute('file', vfsPath);
      }
      const xml = new XMLSerializer().serializeToString(simDocument);
      let model;
      let usingSkeleton = false;
      try {
        model = mujoco.MjModel.from_xml_string(xml, vfs);
      } catch (err) {
        const skeletonXml = new XMLSerializer().serializeToString(prepareMjcfSkeletonDocument(document));
        model = mujoco.MjModel.from_xml_string(skeletonXml);
        usingSkeleton = true;
      }
      const data = new mujoco.MjData(model);
      const sim = {
        mujoco,
        model,
        data,
        vfs,
        bodyBindings: [],
        defaultCtrl: null,
        defaultCtrlAccessor: null
      };
      if (Number(model.nu || 0) > 0) {
        try {
          const numeric = model.numeric('aicad_default_ctrl');
          sim.defaultCtrlAccessor = numeric;
          sim.defaultCtrl = Array.from(numeric.data || []).slice(0, Number(model.nu || 0));
          for (let i = 0; i < sim.defaultCtrl.length; i++) data.ctrl[i] = sim.defaultCtrl[i];
        } catch {
          sim.defaultCtrl = null;
        }
      }
      for (const body of root.userData.mjcfBodies || []) {
        const name = String(body.name || '').trim();
        if (!name) continue;
        try {
          const bodyAccessor = data.body(name);
          sim.bodyBindings.push({
            body,
            bodyAccessor,
            xpos: bodyAccessor.xpos,
            xquat: bodyAccessor.xquat
          });
        } catch {
          // Bodies that fail named lookup remain static in the local preview scene.
        }
      }
      mujoco.mj_forward(model, data);
      onLog(`MJCF MuJoCo simulation ready (${model.nbody} bodies, ${model.njnt} joints${usingSkeleton ? ', skeleton fallback' : ''})`);
      return sim;
    } catch (err) {
      vfs.delete?.();
      onLog(`MJCF MuJoCo simulation unavailable: ${err?.message || err}`);
      return null;
    }
  }

  function applyMjcfWorldPose(root, body, positionView, quaternionView) {
    const offset = root?.userData?.mjcfModelOffset;
    const worldPosition = new THREE.Vector3(
      (positionView?.[0] || 0) + (offset?.x || 0),
      (positionView?.[1] || 0) + (offset?.y || 0),
      (positionView?.[2] || 0) + (offset?.z || 0)
    );
    const worldQuaternion = new THREE.Quaternion(
      quaternionView?.[1] || 0,
      quaternionView?.[2] || 0,
      quaternionView?.[3] || 0,
      quaternionView?.[0] ?? 1
    ).normalize();
    const parent = body.parent;
    if (parent) {
      parent.updateMatrixWorld(true);
      body.position.copy(parent.worldToLocal(worldPosition));
      const parentWorldQuaternion = new THREE.Quaternion();
      parent.getWorldQuaternion(parentWorldQuaternion);
      body.quaternion.copy(parentWorldQuaternion.invert().multiply(worldQuaternion));
    } else {
      body.position.copy(worldPosition);
      body.quaternion.copy(worldQuaternion);
    }
  }

  function syncMjcfSimulationPose(root = currentMjcfRoot) {
    const sim = root?.userData?.mjcfSimulation;
    if (!root || !sim?.bodyBindings?.length) return false;
    for (const binding of sim.bodyBindings) {
      applyMjcfWorldPose(root, binding.body, binding.xpos, binding.xquat);
    }
    root.updateMatrixWorld(true);
    return true;
  }

  function stepMjcfSimulation(dt) {
    const sim = currentMjcfRoot?.userData?.mjcfSimulation;
    if (!sim) return false;
    const timestep = Math.max(1e-4, Number(sim.model?.opt?.timestep) || 0.002);
    let steps = Math.min(120, Math.max(1, Math.ceil(Math.max(0, dt || 0) / timestep)));
    while (steps-- > 0) {
      if (sim.defaultCtrl?.length) {
        for (let i = 0; i < sim.defaultCtrl.length; i++) sim.data.ctrl[i] = sim.defaultCtrl[i];
      }
      sim.mujoco.mj_step(sim.model, sim.data);
    }
    return syncMjcfSimulationPose(currentMjcfRoot);
  }

  function resolveMjcfMeshUrl(mjcfUrl, meshPath) {
    const raw = String(meshPath || '').trim();
    if (!raw) return null;
    if (/^(https?:|aicad:)/i.test(raw)) {
      try {
        return new URL(raw).toString();
      } catch {
        return raw;
      }
    }
    let normalized = raw.replace(/^package:\/\//i, '');
    if (/^[A-Za-z]:[\\/]/.test(normalized)) {
      normalized = normalized.replace(/\\/g, '/');
    }
    try {
      return new URL(normalized, mjcfUrl).toString();
    } catch {
      return null;
    }
  }

  async function loadStlAsset(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch ${url} failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const geometry = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    geometry.computeVertexNormals();
    return { geometry, bytes };
  }

  function parseMjcfXml(text) {
    const document = new DOMParser().parseFromString(String(text || ''), 'application/xml');
    const parserError = document.getElementsByTagName('parsererror')[0];
    if (parserError) throw new Error(`MJCF XML parse failed: ${parserError.textContent || 'invalid XML'}`);
    if (document.documentElement?.tagName !== 'mujoco') throw new Error('MJCF must contain a <mujoco> root element');
    return document;
  }

  async function loadMjcfDocumentScene({ url, mjcfText = null, baseUrl = url }, onLog = () => {}, opts = {}) {
    onLog('MJCF parsing ...');
    const baseForRelative = String(baseUrl || url).split('?')[0];

    const text = mjcfText != null ? mjcfText : await loadMjcfDocument(url, opts.paramsUrl);
    const document = parseMjcfXml(text);
    const angleScale = getCompilerAngleScale(document);
    const root = new THREE.Group();
    root.name = document.documentElement.getAttribute('model') || 'mjcf';
    root.userData.mjcfBodies = [];

    const meshAssets = new Map();
    for (const meshEl of Array.from(document.getElementsByTagName('mesh'))) {
      const name = String(meshEl.getAttribute('name') || '').trim();
      const file = String(meshEl.getAttribute('file') || '').trim();
      if (!name || !file) continue;
      const resolved = resolveMjcfMeshUrl(baseForRelative, file);
      if (!resolved) throw new Error(`Unsupported MJCF mesh path: ${file}`);
      if (!resolved.toLowerCase().endsWith('.stl')) throw new Error(`Unsupported MJCF mesh extension: ${file}`);
      const loaded = await loadStlAsset(resolved);
      meshAssets.set(name, {
        geometry: loaded.geometry,
        bytes: loaded.bytes,
        scale: parseVec3(meshEl.getAttribute('scale'), [1, 1, 1])
      });
    }

    function addGeom(parent, geomEl) {
      const meshName = String(geomEl.getAttribute('mesh') || '').trim();
      const type = String(geomEl.getAttribute('type') || '').trim().toLowerCase();
      if (!meshName && type !== 'mesh') return;
      const asset = meshAssets.get(meshName);
      if (!asset) throw new Error(`MJCF references unknown mesh asset: ${meshName}`);
      const mesh = new THREE.Mesh(
        asset.geometry.clone(),
        new THREE.MeshStandardMaterial({
          color: 0xb6c0cf,
          roughness: 0.65,
          metalness: 0.1,
          side: THREE.DoubleSide
        })
      );
      mesh.name = String(geomEl.getAttribute('name') || meshName || 'geom');
      applyMjcfTransform(mesh, geomEl, angleScale);
      const geomScale = parseVec3(geomEl.getAttribute('scale'), [1, 1, 1]);
      mesh.scale.set(asset.scale.x * geomScale.x, asset.scale.y * geomScale.y, asset.scale.z * geomScale.z);
      parent.add(mesh);
    }

    function addBody(parent, bodyEl) {
      const body = new THREE.Group();
      body.name = String(bodyEl.getAttribute('name') || 'body');
      applyMjcfTransform(body, bodyEl, angleScale);
      root.userData.mjcfBodies.push(body);
      parent.add(body);

      for (const child of elementChildren(bodyEl)) {
        if (child.tagName === 'geom') {
          addGeom(body, child);
        } else if (child.tagName === 'body') {
          addBody(body, child);
        }
      }
    }

    const worldbody = elementChildren(document.documentElement, 'worldbody')[0];
    if (!worldbody) throw new Error('MJCF must include a <worldbody> element');
    for (const child of elementChildren(worldbody)) {
      if (child.tagName === 'body') addBody(root, child);
      else if (child.tagName === 'geom') addGeom(root, child);
    }
    for (const asset of meshAssets.values()) asset.geometry.dispose();
    if (!root.children.length) throw new Error('MJCF loader returned empty scene');

    // Keep assembly centered for stable framing after all STL meshes are loaded.
    const initialBox = new THREE.Box3().setFromObject(root);
    const initialCenter = new THREE.Vector3();
    initialBox.getCenter(initialCenter);
    root.position.sub(initialCenter);
    root.userData.mjcfModelOffset = initialCenter.clone().multiplyScalar(-1);
    root.updateMatrixWorld(true);
    const simulation = await createMjcfSimulation(root, document, meshAssets, onLog);
    root.userData.mjcfSimulation = simulation;
    if (simulation) syncMjcfSimulationPose(root);
    replaceCurrentModel(root, { preserveView: !!opts.preserveView, isMjcf: true });

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    onLog('MJCF parse complete');
    return {
      faceCount: null,
      bbox: {
        min: { x: box.min.x, y: box.min.y, z: box.min.z },
        max: { x: box.max.x, y: box.max.y, z: box.max.z },
        size: { x: size.x, y: size.y, z: size.z }
      },
      faces: []
    };
  }

  async function loadMjcf(url, paramsUrl, onLog = () => {}, opts = {}) {
    onLog('MJCF loading ...');
    const mjcfText = await loadMjcfDocument(url, paramsUrl);
    return loadMjcfDocumentScene({ url, mjcfText, baseUrl: url }, onLog, opts);
  }

  /**
   * Unified entry: choose BREP/STL/MJCF loader by URL suffix or explicit format.
   * @param {string} url
   * @param {(msg:string)=>void} [onLog]
   * @param {{ format?: 'BREP'|'STL'|'MJCF', paramsUrl?: string, preserveView?: boolean }} [opts]
   */
  function loadModel(url, onLog = () => {}, opts = {}) {
    const fmt = (opts.format || '').toUpperCase();
    if (fmt === 'MJCF' || /\/asm\.xml(\?|$)/i.test(url)) return loadMjcf(url, opts.paramsUrl, onLog, opts);
    const isStl = fmt === 'STL' || /\.stl(\?|$)/i.test(url);
    return isStl ? loadStl(url, onLog, opts) : loadBrep(url, onLog, opts);
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
        setView(viewSpec);
      }
    });
    viewCube.setEnabled(!!currentRoot);
  }

  function setViewCubeEnabled(enabled) {
    if (viewCube) viewCube.setEnabled(!!enabled);
  }

  /* ---- Public API ---- */
  return {
    scene,
    camera,
    renderer,
    mountViewCube,
    setViewCubeEnabled,
    loadBrep,
    loadStl,
    loadMjcf,
    loadModel,
    snapshot,
    setView,
    fitView,
    cycleView,
    setSectionEnabled,
    setSectionNormalized,
    setSectionAxis,
    resetSection,
    setGhostEnabled,
    getSectionState,
    getCurrentView: () => currentViewKey,
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
      renderer.dispose();
    }
  };
}
