/// <reference path="./declarations.d.ts" />

import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import occtImportJs from 'occt-import-js';
import { buildSceneFromOcctResult } from './viewer-loaders.js';
import { VIEWER_BACKGROUND_COLOR } from './viewer-materials.js';
import { createContactShadow, createViewerLighting, decorateModelForCadDisplay } from './viewer-scene.js';
import { disposeThreeObject } from './viewer-utils.js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type occtImportJsType from 'occt-import-js';

type OcctModule = Awaited<ReturnType<typeof occtImportJsType>>;

type BrepFaceRange = {
  faceIndex: number;
  triStart: number;
  triCount: number;
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  surfaceType: 'planar' | 'cylindrical' | 'other';
  area: number;
  radius?: number;
  axis?: THREE.Vector3;
  boundsMin?: THREE.Vector3;
  boundsMax?: THREE.Vector3;
};

type BrepFaceReference = {
  mesh: THREE.Mesh;
  range: BrepFaceRange;
};

type PrincipalAxis = 'X' | 'Y' | 'Z';

type SelectorSynthesis = {
  selector: string;
  matchCount: number;
  disambiguation?: string;
};

export type BrepFaceSelection = {
  index: number;
  centroid: [number, number, number];
  normal: [number, number, number];
  meshName: string | null;
  partId: string | number | null;
  surfaceType: 'planar' | 'cylindrical' | 'other';
  area: number;
  selector: string;
  matchCount: number;
  disambiguation?: string;
  screenshot?: string;
};

export type BrepViewerOptions = {
  faceSelection?: boolean;
  onSelectedFaceChange?: (selection: BrepFaceSelection | null) => void;
};

export type BrepViewer = {
  load(url: string): Promise<void>;
  clear(): void;
  refresh(): void;
  setFaceSelectionEnabled(enabled: boolean): void;
  setOnSelectedFaceChange(handler: ((selection: BrepFaceSelection | null) => void) | null): void;
  setSelectedFace(faceIndex: number | null): BrepFaceSelection | null;
  getSelectedFace(): BrepFaceSelection | null;
  dispose(): void;
};

const AXIS_ALIGNMENT_DOT = Math.cos(THREE.MathUtils.degToRad(10));
const FACE_FACING_DOT = 0.99;

function synthesizeSelector(face: BrepFaceReference, allFaces: BrepFaceReference[]): SelectorSynthesis {
  const refs = allFaces.length ? allFaces : [face];
  const tol = selectorTolerance(refs);
  const range = face.range;
  const centroid = range.centroid;
  const normalAxis = principalAxisForVector(range.normal, AXIS_ALIGNMENT_DOT);

  if (range.surfaceType === 'planar' && normalAxis) {
    const maxExtremeMatches = refs.filter((candidate) => isPlanarAxisExtreme(candidate.range, refs, normalAxis, 'max', tol));
    const minExtremeMatches = refs.filter((candidate) => isPlanarAxisExtreme(candidate.range, refs, normalAxis, 'min', tol));
    const direction = maxExtremeMatches.some((candidate) => candidate.range === range)
      ? 'max'
      : minExtremeMatches.some((candidate) => candidate.range === range)
        ? 'min'
        : null;
    if (direction) {
      const extremeMatches = direction === 'max' ? maxExtremeMatches : minExtremeMatches;
      const selector =
        normalAxis === 'Z' && direction === 'max'
          ? 'top_face'
          : normalAxis === 'Z' && direction === 'min'
            ? 'bottom_face'
            : `extreme_face(Axis.${normalAxis}, '${direction}')`;
      return withDisambiguation(selector, extremeMatches.length, centroid);
    }

    const value = axisValue(centroid, normalAxis);
    const matches = refs.filter((candidate) => isPlanarAxisFaceAt(candidate.range, normalAxis, value, tol));
    return withDisambiguation(`face_at(Axis.${normalAxis}, ${formatNumber(value)})`, matches.length, centroid);
  }

  if (range.surfaceType === 'cylindrical' && range.axis && Number.isFinite(range.radius)) {
    const cylinderAxis = principalAxisForVector(range.axis, AXIS_ALIGNMENT_DOT);
    if (cylinderAxis && range.radius != null) {
      const matches = refs.filter((candidate) => isCylindricalHoleMatch(candidate.range, cylinderAxis, range.radius!, tol));
      return withDisambiguation(
        `holes(radius=${formatNumber(range.radius)}, axis=Axis.${cylinderAxis})`,
        matches.length,
        centroid
      );
    }
  }

  const nx = formatNumber(range.normal.x);
  const ny = formatNumber(range.normal.y);
  const nz = formatNumber(range.normal.z);
  const matches = refs.filter((candidate) => candidate.range.normal.dot(range.normal) > FACE_FACING_DOT);
  return withDisambiguation(`face_facing([${nx}, ${ny}, ${nz}])`, Math.max(1, matches.length), centroid);
}

function withDisambiguation(selector: string, matchCount: number, centroid: THREE.Vector3): SelectorSynthesis {
  const normalizedCount = Math.max(1, matchCount);
  return {
    selector,
    matchCount: normalizedCount,
    disambiguation: normalizedCount > 1 ? `near (${formatVec3(centroid)})` : undefined
  };
}

function selectorTolerance(refs: BrepFaceReference[]): number {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const ref of refs) {
    min.min(ref.range.centroid);
    max.max(ref.range.centroid);
    if (ref.range.boundsMin) min.min(ref.range.boundsMin);
    if (ref.range.boundsMax) max.max(ref.range.boundsMax);
  }
  if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return 1e-3;
  const diag = min.distanceTo(max);
  return Math.max(1e-3, diag * 1e-5);
}

function principalAxisForVector(vector: THREE.Vector3, minDot: number): PrincipalAxis | null {
  const len = vector.length();
  if (!Number.isFinite(len) || len <= 1e-8) return null;
  const ax = Math.abs(vector.x) / len;
  const ay = Math.abs(vector.y) / len;
  const az = Math.abs(vector.z) / len;
  if (ax >= ay && ax >= az && ax >= minDot) return 'X';
  if (ay >= ax && ay >= az && ay >= minDot) return 'Y';
  if (az >= ax && az >= ay && az >= minDot) return 'Z';
  return null;
}

function axisValue(vector: THREE.Vector3, axis: PrincipalAxis): number {
  if (axis === 'X') return vector.x;
  if (axis === 'Y') return vector.y;
  return vector.z;
}

function isNearly(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function isPlanarAxisAligned(range: BrepFaceRange, axis: PrincipalAxis): boolean {
  if (range.surfaceType !== 'planar') return false;
  const axisComponent = Math.abs(axisValue(range.normal, axis));
  const length = range.normal.length() || 1;
  return axisComponent / length >= AXIS_ALIGNMENT_DOT;
}

function isPlanarAxisExtreme(
  range: BrepFaceRange,
  refs: BrepFaceReference[],
  axis: PrincipalAxis,
  direction: 'max' | 'min',
  tol: number
): boolean {
  if (!isPlanarAxisAligned(range, axis)) return false;
  const planarAxisFaces = refs.map((ref) => ref.range).filter((candidate) => isPlanarAxisAligned(candidate, axis));
  if (!planarAxisFaces.length) return false;
  const selectedValue = axisValue(range.centroid, axis);
  const extremeValue =
    direction === 'max'
      ? Math.max(...planarAxisFaces.map((candidate) => axisValue(candidate.centroid, axis)))
      : Math.min(...planarAxisFaces.map((candidate) => axisValue(candidate.centroid, axis)));
  return isNearly(selectedValue, extremeValue, tol);
}

function isPlanarAxisFaceAt(range: BrepFaceRange, axis: PrincipalAxis, value: number, tol: number): boolean {
  return isPlanarAxisAligned(range, axis) && isNearly(axisValue(range.centroid, axis), value, tol);
}

function isCylindricalHoleMatch(range: BrepFaceRange, axis: PrincipalAxis, radius: number, tol: number): boolean {
  if (range.surfaceType !== 'cylindrical' || !range.axis || !Number.isFinite(range.radius)) return false;
  const candidateAxis = principalAxisForVector(range.axis, AXIS_ALIGNMENT_DOT);
  return candidateAxis === axis && isNearly(range.radius!, radius, Math.max(tol, radius * 1e-3));
}

function formatVec3(vector: THREE.Vector3): string {
  return `${formatNumber(vector.x)}, ${formatNumber(vector.y)}, ${formatNumber(vector.z)}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.abs(value) < 1e-9 ? 0 : value;
  return rounded.toFixed(3).replace(/\.?0+$/, '');
}

export function createBrepViewer(host: HTMLElement, opts: BrepViewerOptions = {}): BrepViewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
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

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.position.set(140, 100, 140);

  let currentRoot: THREE.Object3D | null = null;
  let faceSelectionEnabled = !!opts.faceSelection;
  let onSelectedFaceChange = opts.onSelectedFaceChange || null;
  let selectedFace: BrepFaceSelection | null = null;
  let selectedFaceOverlay: THREE.Group | null = null;
  let facePickDown: { x: number; y: number } | null = null;
  const facePickRaycaster = new THREE.Raycaster();
  const facePickPointer = new THREE.Vector2();
  const lighting = createViewerLighting(scene, renderer, () => currentRoot);
  const contactShadow = createContactShadow(scene);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 2.4;
  controls.zoomSpeed = 1.4;
  controls.panSpeed = 0.9;
  controls.staticMoving = true;

  let occtPromise: Promise<OcctModule> | null = null;
  function getOcct(): Promise<OcctModule> {
    if (!occtPromise) {
      occtPromise = occtImportJs({
        locateFile: (file) => (file.endsWith('.wasm') ? occtWasmUrl : file)
      });
    }
    return occtPromise;
  }

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

  function getFaceRanges(mesh: THREE.Object3D): BrepFaceRange[] {
    const ranges = mesh.userData?.faceRanges;
    return Array.isArray(ranges) ? ranges : [];
  }

  function getAllFaceReferences(): BrepFaceReference[] {
    if (!currentRoot) return [];
    const refs: BrepFaceReference[] = [];
    currentRoot.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const range of getFaceRanges(child)) refs.push({ mesh: child, range });
    });
    return refs;
  }

  function partIdFromObject(object: THREE.Object3D | null): string | number | null {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      const part = cursor.userData?.materialPart;
      if (part?.id != null) return part.id;
      cursor = cursor.parent;
    }
    return null;
  }

  function selectionFromRange(mesh: THREE.Mesh, range: BrepFaceRange): BrepFaceSelection {
    const selector = synthesizeSelector({ mesh, range }, getAllFaceReferences());
    return {
      index: range.faceIndex,
      centroid: [range.centroid.x, range.centroid.y, range.centroid.z],
      normal: [range.normal.x, range.normal.y, range.normal.z],
      meshName: mesh.name || null,
      partId: partIdFromObject(mesh),
      surfaceType: range.surfaceType || 'other',
      area: Number.isFinite(range.area) ? range.area : 0,
      selector: selector.selector,
      matchCount: selector.matchCount,
      disambiguation: selector.disambiguation,
      screenshot: captureViewerScreenshot()
    };
  }

  function captureViewerScreenshot(): string | undefined {
    try {
      renderer.render(scene, camera);
      const source = renderer.domElement;
      const sourceWidth = source.width || source.clientWidth || 0;
      const sourceHeight = source.height || source.clientHeight || 0;
      if (!sourceWidth || !sourceHeight) return undefined;
      const maxSide = 512;
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return source.toDataURL('image/jpeg', 0.7);
      ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      return undefined;
    }
  }

  function disposeSelectedFaceOverlay() {
    if (!selectedFaceOverlay) return;
    selectedFaceOverlay.parent?.remove(selectedFaceOverlay);
    disposeThreeObject(selectedFaceOverlay);
    selectedFaceOverlay = null;
  }

  function createSelectedFaceOverlay(mesh: THREE.Mesh, range: BrepFaceRange): THREE.Group | null {
    const geometry = mesh.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return null;
    const position = geometry.getAttribute('position');
    if (!position) return null;
    const index = geometry.getIndex();
    const positions: number[] = [];
    const first = range.triStart;
    const last = range.triStart + range.triCount - 1;

    for (let tri = first; tri <= last; tri++) {
      for (let corner = 0; corner < 3; corner++) {
        const sourceIndex = index ? index.getX(tri * 3 + corner) : tri * 3 + corner;
        positions.push(
          position.getX(sourceIndex),
          position.getY(sourceIndex),
          position.getZ(sourceIndex)
        );
      }
    }
    if (!positions.length) return null;

    const faceGeometry = new THREE.BufferGeometry();
    faceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    faceGeometry.computeVertexNormals();

    const group = new THREE.Group();
    group.name = 'selected-brep-face';
    group.userData.isFaceSelectionOverlay = true;

    const fill = new THREE.Mesh(
      faceGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffd45a,
        transparent: true,
        opacity: 0.66,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
      })
    );
    fill.renderOrder = 20;
    fill.userData.isFaceSelectionOverlay = true;
    group.add(fill);

    const edges = new THREE.EdgesGeometry(faceGeometry, 1);
    const lines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0xfff0a3,
        transparent: true,
        opacity: 0.95,
        depthWrite: false
      })
    );
    lines.renderOrder = 21;
    lines.userData.isFaceSelectionOverlay = true;
    group.add(lines);

    return group;
  }

  function findFaceByIndex(faceIndex: number): { mesh: THREE.Mesh; range: BrepFaceRange } | null {
    if (!currentRoot || !Number.isInteger(faceIndex)) return null;
    let found: { mesh: THREE.Mesh; range: BrepFaceRange } | null = null;
    currentRoot.traverse((child) => {
      if (found || !(child instanceof THREE.Mesh)) return;
      const range = getFaceRanges(child).find((candidate) => candidate.faceIndex === faceIndex);
      if (range) found = { mesh: child, range };
    });
    return found;
  }

  function emitSelectedFaceChange() {
    onSelectedFaceChange?.(selectedFace);
  }

  function setSelectedFace(faceIndex: number | null): BrepFaceSelection | null {
    disposeSelectedFaceOverlay();
    selectedFace = null;

    if (faceIndex != null) {
      const found = findFaceByIndex(faceIndex);
      if (found) {
        selectedFaceOverlay = createSelectedFaceOverlay(found.mesh, found.range);
        if (selectedFaceOverlay) found.mesh.add(selectedFaceOverlay);
        selectedFace = selectionFromRange(found.mesh, found.range);
      }
    }

    emitSelectedFaceChange();
    return selectedFace;
  }

  function pickBrepFace(event: PointerEvent): { mesh: THREE.Mesh; range: BrepFaceRange } | null {
    if (!currentRoot || !faceSelectionEnabled) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    facePickPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    facePickPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    facePickRaycaster.setFromCamera(facePickPointer, camera);
    const hits = facePickRaycaster
      .intersectObject(currentRoot, true)
      .filter((hit) => !hit.object.userData?.isWireframe && !hit.object.userData?.isFaceSelectionOverlay);
    for (const hit of hits) {
      if (!(hit.object instanceof THREE.Mesh)) continue;
      if (!Number.isInteger(hit.faceIndex)) continue;
      const range = getFaceRanges(hit.object).find((candidate) => {
        return hit.faceIndex! >= candidate.triStart && hit.faceIndex! < candidate.triStart + candidate.triCount;
      });
      if (range) return { mesh: hit.object, range };
    }
    return null;
  }

  function handleFacePickPointerDown(event: PointerEvent) {
    if (!faceSelectionEnabled || event.button !== 0) return;
    facePickDown = { x: event.clientX, y: event.clientY };
  }

  function handleFacePickClick(event: MouseEvent) {
    if (!faceSelectionEnabled || event.button !== 0) return;
    if (facePickDown) {
      const dx = event.clientX - facePickDown.x;
      const dy = event.clientY - facePickDown.y;
      facePickDown = null;
      if (dx * dx + dy * dy > 16) return;
    }
    const picked = pickBrepFace(event as PointerEvent);
    const nextIndex = picked?.range.faceIndex ?? null;
    setSelectedFace(selectedFace?.index === nextIndex ? null : nextIndex);
  }

  renderer.domElement.addEventListener('pointerdown', handleFacePickPointerDown);
  renderer.domElement.addEventListener('click', handleFacePickClick);

  function clear() {
    setSelectedFace(null);
    if (currentRoot) {
      scene.remove(currentRoot);
      disposeThreeObject(currentRoot);
      currentRoot = null;
    }
    contactShadow.hide();
  }

  async function load(url: string) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();

    const occt = await getOcct();
    const res = occt.ReadBrepFile(new Uint8Array(buf), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5
    });
    if (!res.success) throw new Error('OCCT failed to parse BREP');

    const root = buildSceneFromOcctResult(res);
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
    renderer.domElement.removeEventListener('pointerdown', handleFacePickPointerDown);
    renderer.domElement.removeEventListener('click', handleFacePickClick);
    controls.dispose();
    onSelectedFaceChange = null;
    clear();
    contactShadow.dispose();
    lighting.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  }

  return {
    load,
    clear,
    refresh: fitView,
    setFaceSelectionEnabled(enabled: boolean) {
      faceSelectionEnabled = !!enabled;
      if (!faceSelectionEnabled) setSelectedFace(null);
    },
    setOnSelectedFaceChange(handler: ((selection: BrepFaceSelection | null) => void) | null) {
      onSelectedFaceChange = handler;
    },
    setSelectedFace,
    getSelectedFace: () => selectedFace,
    dispose
  };
}
