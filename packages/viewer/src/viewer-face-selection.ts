import * as THREE from 'three';
import { synthesizeSelector } from './viewer-brep-selector.js';
import type { BrepFaceRange, BrepFaceReference } from './viewer-brep-selector.js';
import type { BrepFaceSelection } from './types.js';
import { disposeThreeObject } from './viewer-utils.js';

export function createBrepFaceSelectionController({
  renderer,
  scene,
  camera,
  getCurrentRoot
}: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  getCurrentRoot: () => THREE.Object3D | null;
}) {
  let enabled = false;
  let onSelectedFaceChange: ((selection: BrepFaceSelection | null) => void) | null = null;
  let selectedFace: BrepFaceSelection | null = null;
  let selectedFaceOverlay: THREE.Group | null = null;
  let facePickDown: { x: number; y: number } | null = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function getFaceRanges(object: THREE.Object3D): BrepFaceRange[] {
    const ranges = object.userData?.faceRanges;
    return Array.isArray(ranges) ? ranges : [];
  }

  function getAllFaceReferences(): BrepFaceReference[] {
    const root = getCurrentRoot();
    if (!root) return [];
    const refs: BrepFaceReference[] = [];
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      for (const range of getFaceRanges(child)) refs.push({ mesh: child, range });
    });
    return refs;
  }

  function canSelectFaces(): boolean {
    return getAllFaceReferences().length > 0;
  }

  function isActive(): boolean {
    return enabled && canSelectFaces();
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

  function selectionFromRange(mesh: THREE.Mesh, range: BrepFaceRange): BrepFaceSelection {
    const allFaces = getAllFaceReferences();
    const selector = synthesizeSelector({ mesh, range }, allFaces);
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
        positions.push(position.getX(sourceIndex), position.getY(sourceIndex), position.getZ(sourceIndex));
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
    const root = getCurrentRoot();
    if (!root || !Number.isInteger(faceIndex)) return null;
    let found: { mesh: THREE.Mesh; range: BrepFaceRange } | null = null;
    root.traverse((child) => {
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
    const root = getCurrentRoot();
    if (!root || !isActive()) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster
      .intersectObject(root, true)
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

  function handlePointerDown(event: PointerEvent) {
    if (!isActive() || event.button !== 0) return;
    facePickDown = { x: event.clientX, y: event.clientY };
  }

  function handleClick(event: MouseEvent) {
    if (!isActive() || event.button !== 0) return;
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

  function setEnabled(nextEnabled: boolean): boolean {
    enabled = !!nextEnabled && canSelectFaces();
    facePickDown = null;
    if (!enabled) setSelectedFace(null);
    return enabled;
  }

  function clearSelection() {
    facePickDown = null;
    setSelectedFace(null);
  }

  function syncAvailability() {
    if (!canSelectFaces()) setEnabled(false);
  }

  function dispose() {
    enabled = false;
    onSelectedFaceChange = null;
    disposeSelectedFaceOverlay();
    selectedFace = null;
    facePickDown = null;
  }

  return {
    canSelectFaces,
    isActive,
    setEnabled,
    setOnSelectedFaceChange(handler: ((selection: BrepFaceSelection | null) => void) | null) {
      onSelectedFaceChange = handler;
    },
    setSelectedFace,
    getSelectedFace: () => selectedFace,
    handlePointerDown,
    handleClick,
    clearSelection,
    syncAvailability,
    dispose
  };
}
