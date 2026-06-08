import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyCadStyleToGlbScene, tagGlbSceneMaterialParts } from './viewer-loaders.js';
import { createViewerCore } from './viewer-core.js';
import type { ExplodeState, PreviewMode } from './types.js';

export type GlbViewer = {
  load(url: string, opts?: GlbLoadOptions): Promise<void>;
  clear(): void;
  refresh(): void;
  setExplodeEnabled(enabled: boolean): ExplodeState;
  setExplodeFactor(factor: number): ExplodeState;
  getExplodeState(): ExplodeState;
  setPreviewMode(mode: PreviewMode | string): PreviewMode;
  getPreviewMode(): PreviewMode;
  dispose(): void;
};

export type GlbLoadOptions = {
  unitScale?: number;
  coordinateSystem?: 'cad-z-up' | 'gltf-y-up' | string;
};

export type GlbViewerOptions = {
  /** Show an X/Y/Z reference axes gizmo at the model origin (Z-up). */
  referenceAxes?: boolean;
};

export function createGlbViewer(host: HTMLElement, opts: GlbViewerOptions = {}): GlbViewer {
  const core = createViewerCore(host, { fov: 40, referenceAxes: opts.referenceAxes });

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

    core.replaceRoot(root);
  }

  return {
    load,
    clear: core.clear,
    refresh: core.fitView,
    setExplodeEnabled: core.setExplodeEnabled,
    setExplodeFactor: core.setExplodeFactor,
    getExplodeState: core.getExplodeState,
    setPreviewMode: core.setPreviewMode,
    getPreviewMode: core.getPreviewMode,
    dispose: core.dispose
  };
}
