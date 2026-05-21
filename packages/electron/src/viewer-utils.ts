import * as THREE from 'three';
import type { Vec3Tuple } from './types.js';

export function vec3From(value: THREE.Vector3 | Vec3Tuple | number[] | null | undefined): THREE.Vector3 {
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
  }
  return new THREE.Vector3();
}

export function disposeThreeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material?.map?.dispose?.();
        material?.dispose?.();
      }
      return;
    }
    if (child instanceof THREE.Sprite) {
      child.material?.map?.dispose?.();
      child.material?.dispose?.();
    }
  });
}
