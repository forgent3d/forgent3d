import * as THREE from 'three';

export const VIEWER_BACKGROUND_COLOR = 0x0b0d12;
export const CAD_CLAY_COLOR = 0xc8d0dc;
export const CAD_EDGE_COLOR = 0x26324a;

export function createCadClayMaterial(overrides = {}) {
  return new THREE.MeshStandardMaterial({
    color: CAD_CLAY_COLOR,
    metalness: 0.04,
    roughness: 0.72,
    side: THREE.DoubleSide,
    ...overrides
  });
}

export function createCadEdgeMaterial(overrides = {}) {
  return new THREE.LineBasicMaterial({
    color: CAD_EDGE_COLOR,
    transparent: true,
    opacity: 0.46,
    ...overrides
  });
}
