/// <reference path="./declarations.d.ts" />

import * as THREE from 'three';
import occtImportJs from 'occt-import-js';
import { buildSceneFromOcctResult } from './viewer-loaders.js';
import { createViewerCore } from './viewer-core.js';
import { createBrepFaceSelectionController } from './viewer-face-selection.js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type occtImportJsType from 'occt-import-js';
import type { BrepFaceSelection } from './types.js';

export type { BrepFaceRange, BrepFaceReference, SelectorSynthesis } from './viewer-brep-selector.js';
export { synthesizeSelector } from './viewer-brep-selector.js';
export type { BrepFaceSelection } from './types.js';

type OcctModule = Awaited<ReturnType<typeof occtImportJsType>>;

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

export function createBrepViewer(host: HTMLElement, opts: BrepViewerOptions = {}): BrepViewer {
  const core = createViewerCore(host, { preserveDrawingBuffer: true });
  const faceSelection = createBrepFaceSelectionController({
    renderer: core.renderer,
    scene: core.scene,
    camera: core.camera,
    getCurrentRoot: core.getCurrentRoot
  });
  let requestedFaceSelection = !!opts.faceSelection;
  faceSelection.setOnSelectedFaceChange(opts.onSelectedFaceChange || null);

  let occtPromise: Promise<OcctModule> | null = null;
  function getOcct(): Promise<OcctModule> {
    if (!occtPromise) {
      occtPromise = occtImportJs({
        locateFile: (file) => (file.endsWith('.wasm') ? occtWasmUrl : file)
      });
    }
    return occtPromise;
  }

  function handleFacePickPointerDown(event: PointerEvent) {
    faceSelection.handlePointerDown(event);
  }

  function handleFacePickClick(event: MouseEvent) {
    faceSelection.handleClick(event);
  }

  core.renderer.domElement.addEventListener('pointerdown', handleFacePickPointerDown);
  core.renderer.domElement.addEventListener('click', handleFacePickClick);

  function clear() {
    faceSelection.clearSelection();
    core.clear();
    faceSelection.syncAvailability();
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

    core.replaceRoot(root);
    faceSelection.setEnabled(requestedFaceSelection);
  }

  function dispose() {
    core.renderer.domElement.removeEventListener('pointerdown', handleFacePickPointerDown);
    core.renderer.domElement.removeEventListener('click', handleFacePickClick);
    faceSelection.dispose();
    core.dispose();
  }

  return {
    load,
    clear,
    refresh: core.fitView,
    setFaceSelectionEnabled(enabled: boolean) {
      requestedFaceSelection = !!enabled;
      faceSelection.setEnabled(requestedFaceSelection);
    },
    setOnSelectedFaceChange(handler: ((selection: BrepFaceSelection | null) => void) | null) {
      faceSelection.setOnSelectedFaceChange(handler);
    },
    setSelectedFace: faceSelection.setSelectedFace,
    getSelectedFace: faceSelection.getSelectedFace,
    dispose
  };
}
