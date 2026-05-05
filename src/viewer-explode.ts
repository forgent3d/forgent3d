import * as THREE from 'three';

type ExplodeTarget = {
  object: THREE.Object3D;
  direction: THREE.Vector3;
  distance: number;
  offset: THREE.Vector3;
  parentWorldQuaternion: THREE.Quaternion;
};

function hasSolidMesh(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if (found) return;
    if ((child as THREE.Mesh).isMesh && !child.userData?.isWireframe) found = true;
  });
  return found;
}

function hasDirectSolidMesh(object: THREE.Object3D): boolean {
  return object.children.some((child) => (child as THREE.Mesh).isMesh && !child.userData?.isWireframe);
}

function directSolidMeshCount(object: THREE.Object3D): number {
  return object.children.filter((child) => (child as THREE.Mesh).isMesh && !child.userData?.isWireframe).length;
}

function fallbackDirection(index: number): THREE.Vector3 {
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(Math.cos(angle), 0.28, Math.sin(angle)).normalize();
}

function siblingFanDirection(object: THREE.Object3D, index: number): THREE.Vector3 {
  const childIndex = Number.isFinite(object.userData?.mjcfChildIndex)
    ? Number(object.userData.mjcfChildIndex)
    : index;
  const depth = Math.max(0, Number(object.userData?.mjcfDepth) || 0);
  const angle = childIndex * Math.PI * (3 - Math.sqrt(5)) + depth * 0.62;
  return new THREE.Vector3(Math.cos(angle), 0.18 + depth * 0.04, Math.sin(angle)).normalize();
}

function removeTargetOffset(target: ExplodeTarget) {
  if (target.offset.lengthSq() <= 0) return;
  target.object.position.sub(target.offset);
  target.offset.set(0, 0, 0);
}

function hasTargetAncestor(object: THREE.Object3D, targetObjects: Set<THREE.Object3D>): boolean {
  let parent = object.parent;
  while (parent) {
    if (targetObjects.has(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

export function createExplodeController({
  getCurrentRoot
}: {
  getCurrentRoot: () => THREE.Object3D | null;
}) {
  const box = new THREE.Box3();
  const rootBox = new THREE.Box3();
  const rootCenter = new THREE.Vector3();
  const rootSize = new THREE.Vector3();
  const targetCenter = new THREE.Vector3();
  const parentCenter = new THREE.Vector3();
  const explodedCenter = new THREE.Vector3();
  const centerCorrectionFull = new THREE.Vector3();
  const worldOffset = new THREE.Vector3();
  const parentQuat = new THREE.Quaternion();
  const targetObjectSet = new Set<THREE.Object3D>();
  let enabled = false;
  let factor = 0;
  let targetFactor = 0;
  let targets: ExplodeTarget[] = [];
  let targetRoot: THREE.Object3D | null = null;

  function candidateTargets(root: THREE.Object3D): THREE.Object3D[] {
    const mjcfBodies = Array.isArray(root.userData?.mjcfBodies)
      ? root.userData.mjcfBodies.filter((body: THREE.Object3D) => hasDirectSolidMesh(body))
      : [];
    if (mjcfBodies.length >= 2) return mjcfBodies;

    const direct = root.children.filter((child) => hasSolidMesh(child));
    if (direct.length >= 2) return direct;

    const meshes: THREE.Object3D[] = [];
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && !child.userData?.isWireframe) meshes.push(child);
    });
    return meshes.length >= 2 ? meshes : [];
  }

  function bodyTreeDirection(object: THREE.Object3D, index: number, maxSize: number): THREE.Vector3 | null {
    if (!object.userData?.isMjcfBody) return null;
    const parentBody = object.userData.mjcfParentBody;
    const direction = new THREE.Vector3();
    if (parentBody && hasSolidMesh(parentBody)) {
      box.setFromObject(parentBody);
      if (!box.isEmpty()) {
        box.getCenter(parentCenter);
        direction.copy(targetCenter).sub(parentCenter);
      }
    } else {
      direction.copy(targetCenter).sub(rootCenter);
    }
    if (direction.lengthSq() < 1e-8) {
      direction.copy(siblingFanDirection(object, index));
    } else {
      direction.y += maxSize * (0.05 + Math.min(0.08, (Number(object.userData.mjcfDepth) || 0) * 0.015));
      direction.normalize();
    }
    return direction;
  }

  function rebuildTargets() {
    removeOffsets();
    const root = getCurrentRoot();
    targetRoot = root;
    targets = [];
    centerCorrectionFull.set(0, 0, 0);
    if (!root) return targets;

    root.updateMatrixWorld(true);
    rootBox.setFromObject(root);
    if (rootBox.isEmpty()) return targets;
    rootBox.getCenter(rootCenter);
    rootBox.getSize(rootSize);
    const maxSize = Math.max(rootSize.x, rootSize.y, rootSize.z, 1);
    const baseDistance = maxSize * 0.72;

    const candidates = candidateTargets(root);
    for (let i = 0; i < candidates.length; i++) {
      const object = candidates[i]!;
      box.setFromObject(object);
      if (box.isEmpty()) continue;
      box.getCenter(targetCenter);
      const direction = bodyTreeDirection(object, i, maxSize) || targetCenter.clone().sub(rootCenter);
      if (direction.lengthSq() < 1e-8) direction.copy(fallbackDirection(i));
      else if (!object.userData?.isMjcfBody) {
        direction.y += maxSize * 0.08;
        direction.normalize();
      }
      const depth = Math.max(0, Number(object.userData?.mjcfDepth) || 0);
      const treeScale = object.userData?.isMjcfBody ? (0.72 + Math.min(depth, 4) * 0.12) : 1;
      object.parent?.getWorldQuaternion(parentQuat);
      targets.push({
        object,
        direction,
        distance: baseDistance * treeScale * (directSolidMeshCount(object) > 1 ? 0.78 : 1),
        offset: new THREE.Vector3(),
        parentWorldQuaternion: parentQuat.clone()
      });
    }
    if (targets.length < 2) {
      enabled = false;
      targetFactor = 0;
      factor = 0;
    } else {
      computeCenterCorrection();
    }
    return targets;
  }

  function ensureTargets() {
    const root = getCurrentRoot();
    if (root !== targetRoot) rebuildTargets();
    return targets;
  }

  function removeOffsets() {
    for (const target of targets) removeTargetOffset(target);
    targetRoot?.updateMatrixWorld(true);
  }

  function applyOffsets(activeTargets: ExplodeTarget[], nextFactor: number, includeCenterCorrection = true) {
    targetObjectSet.clear();
    for (const target of activeTargets) targetObjectSet.add(target.object);
    for (const target of activeTargets) {
      worldOffset.copy(target.direction).multiplyScalar(target.distance * nextFactor);
      if (includeCenterCorrection && !hasTargetAncestor(target.object, targetObjectSet)) {
        worldOffset.addScaledVector(centerCorrectionFull, nextFactor);
      }
      target.offset.copy(worldOffset);
      target.object.parent?.getWorldQuaternion(target.parentWorldQuaternion);
      target.offset.applyQuaternion(target.parentWorldQuaternion.invert());
      target.object.position.add(target.offset);
    }
    targetRoot?.updateMatrixWorld(true);
  }

  function computeCenterCorrection() {
    centerCorrectionFull.set(0, 0, 0);
    if (!targetRoot || targets.length < 2) return;
    applyOffsets(targets, 1, false);
    rootBox.setFromObject(targetRoot);
    if (rootBox.isEmpty()) {
      removeOffsets();
      return;
    }
    rootBox.getCenter(explodedCenter);
    centerCorrectionFull.copy(rootCenter).sub(explodedCenter);
    removeOffsets();
  }

  function apply() {
    const activeTargets = ensureTargets();
    removeOffsets();
    if (!enabled || factor <= 0 || activeTargets.length < 2) return;
    applyOffsets(activeTargets, factor, true);
  }

  function setEnabled(nextEnabled: boolean) {
    if (nextEnabled) enabled = true;
    targetFactor = nextEnabled ? 1 : 0;
    apply();
    return getState();
  }

  function setFactor(nextFactor: number) {
    targetFactor = THREE.MathUtils.clamp(Number(nextFactor) || 0, 0, 1);
    factor = targetFactor;
    enabled = targetFactor > 0;
    apply();
    return getState();
  }

  function update(dt: number) {
    const next = THREE.MathUtils.damp(factor, targetFactor, 9, Math.max(0, dt || 0));
    factor = Math.abs(next - targetFactor) < 0.001 ? targetFactor : next;
    if (factor <= 0.001 && targetFactor <= 0) {
      factor = 0;
      enabled = false;
    }
    apply();
  }

  function reset() {
    enabled = false;
    factor = 0;
    targetFactor = 0;
    removeOffsets();
    targets = [];
    targetRoot = null;
  }

  function getState() {
    ensureTargets();
    return {
      enabled: targetFactor > 0,
      factor: targetFactor,
      available: targets.length >= 2,
      targets: targets.length
    };
  }

  return {
    apply,
    update,
    removeOffsets,
    rebuildTargets,
    setEnabled,
    setFactor,
    reset,
    getState,
    canExplode: () => getState().available
  };
}
