// @ts-nocheck
import * as THREE from 'three';
import { vec3From } from './viewer-utils.js';

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

export function createViewCubeOverlay(host, { onNavigate }) {
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
    const label = composeViewCubeLabel(spec.signs);
    addPickable(edgeMesh, {
      kind: 'edge',
      priority: 20,
      label,
      viewSpec: {
        key: label.toLowerCase().replace(/\s+/g, '-'),
        label,
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
        const label = composeViewCubeLabel(signs);
        addPickable(cornerMesh, {
          kind: 'corner',
          priority: 30,
          label,
          viewSpec: {
            key: label.toLowerCase().replace(/\s+/g, '-'),
            label,
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
