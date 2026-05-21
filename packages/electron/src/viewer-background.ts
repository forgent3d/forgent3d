import * as THREE from 'three';

export type ViewerBackgroundTone = 'dark' | 'light';

type BrightnessSample = {
  luminance: number;
  weight: number;
};

const DARK_MODEL_THRESHOLD = 0.38;

function materialList(material: THREE.Material | THREE.Material[] | null | undefined): THREE.Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function getMaterialLuminance(material: THREE.Material): number | null {
  const materialWithColor = material as THREE.Material & { color?: THREE.Color };
  if (!materialWithColor.color) return null;
  const color = materialWithColor.color.clone().convertLinearToSRGB();
  return (0.2126 * color.r) + (0.7152 * color.g) + (0.0722 * color.b);
}

function getMeshWeight(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
  const position = geometry?.getAttribute?.('position');
  if (!position) return 1;
  const primitiveCount = geometry?.index ? geometry.index.count : position.count;
  return Math.max(1, primitiveCount / 3);
}

function sampleMeshBrightness(mesh: THREE.Mesh): BrightnessSample | null {
  const materials = materialList(mesh.material);
  let luminanceTotal = 0;
  let luminanceCount = 0;
  for (const material of materials) {
    const luminance = getMaterialLuminance(material);
    if (luminance == null) continue;
    luminanceTotal += luminance;
    luminanceCount += 1;
  }
  if (!luminanceCount) return null;
  return {
    luminance: luminanceTotal / luminanceCount,
    weight: getMeshWeight(mesh)
  };
}

export function estimateModelLuminance(root: THREE.Object3D | null): number | null {
  if (!root) return null;
  let weightedLuminance = 0;
  let totalWeight = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const sample = sampleMeshBrightness(child);
    if (!sample) return;
    weightedLuminance += sample.luminance * sample.weight;
    totalWeight += sample.weight;
  });
  return totalWeight > 0 ? weightedLuminance / totalWeight : null;
}

export function chooseViewerBackgroundTone(root: THREE.Object3D | null): ViewerBackgroundTone {
  const luminance = estimateModelLuminance(root);
  return luminance != null && luminance <= DARK_MODEL_THRESHOLD ? 'light' : 'dark';
}

export function createAdaptiveBackgroundController(host: HTMLElement) {
  function update(root: THREE.Object3D | null) {
    host.dataset.viewerBackground = chooseViewerBackgroundTone(root);
  }

  function reset() {
    host.dataset.viewerBackground = 'dark';
  }

  reset();

  return {
    update,
    reset
  };
}
