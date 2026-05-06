import * as THREE from 'three';

type ExplodeTarget = {
  object: THREE.Object3D;
  direction: THREE.Vector3;
  distance: number;
  offset: THREE.Vector3;
  parentWorldQuaternion: THREE.Quaternion;
};

function isSolidMesh(child: THREE.Object3D): boolean {
  return (child as THREE.Mesh).isMesh === true && !child.userData?.isWireframe;
}

function hasSolidMesh(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if (found) return;
    if (isSolidMesh(child)) found = true;
  });
  return found;
}

function hasDirectSolidMesh(object: THREE.Object3D): boolean {
  return object.children.some(isSolidMesh);
}

function fallbackDirection(index: number): THREE.Vector3 {
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(Math.cos(angle), 0.18, Math.sin(angle)).normalize();
}

function removeTargetOffset(target: ExplodeTarget) {
  if (target.offset.lengthSq() <= 0) return;
  target.object.position.sub(target.offset);
  target.offset.set(0, 0, 0);
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
  const explodedCenter = new THREE.Vector3();
  const centerCorrectionFull = new THREE.Vector3();
  const worldOffset = new THREE.Vector3();
  const parentQuat = new THREE.Quaternion();
  let enabled = false;
  let factor = 0;
  let targetFactor = 0;
  let targets: ExplodeTarget[] = [];
  let targetRoot: THREE.Object3D | null = null;

  function candidateTargets(root: THREE.Object3D): THREE.Object3D[] {
    const mjcfBodies: THREE.Object3D[] = Array.isArray(root.userData?.mjcfBodies)
      ? (root.userData.mjcfBodies as THREE.Object3D[]).filter(hasDirectSolidMesh)
      : [];

    let pool: THREE.Object3D[];
    if (mjcfBodies.length >= 2) {
      pool = mjcfBodies;
    } else {
      const direct = root.children.filter(hasSolidMesh);
      if (direct.length >= 2) {
        pool = direct;
      } else {
        const meshes: THREE.Object3D[] = [];
        root.traverse((child) => {
          if (isSolidMesh(child)) meshes.push(child);
        });
        pool = meshes;
      }
    }

    const set = new Set(pool);
    return pool.filter((object) => {
      let parent = object.parent;
      while (parent) {
        if (set.has(parent)) return false;
        parent = parent.parent;
      }
      return true;
    });
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

    const sortedSize = [rootSize.x, rootSize.y, rootSize.z].sort((a, b) => a - b);
    const medianSize = sortedSize[1] || sortedSize[2] || 1;
    const minRadius = Math.max(medianSize * 0.18, 1e-3);

    const candidates = candidateTargets(root);
    for (let i = 0; i < candidates.length; i++) {
      const object = candidates[i]!;
      box.setFromObject(object);
      if (box.isEmpty()) continue;
      box.getCenter(targetCenter);

      const direction = new THREE.Vector3().copy(targetCenter).sub(rootCenter);
      const radial = direction.length();
      if (radial < 1e-6) {
        direction.copy(fallbackDirection(i));
      } else {
        direction.divideScalar(radial);
      }

      object.parent?.getWorldQuaternion(parentQuat);
      targets.push({
        object,
        direction,
        distance: Math.max(radial, minRadius),
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
    const desiredWorld = new Map<THREE.Object3D, THREE.Vector3>();
    for (const target of activeTargets) {
      const wo = new THREE.Vector3()
        .copy(target.direction)
        .multiplyScalar(target.distance * nextFactor);
      if (includeCenterCorrection) {
        wo.addScaledVector(centerCorrectionFull, nextFactor);
      }
      desiredWorld.set(target.object, wo);
    }

    const ancestorAccum = new THREE.Vector3();
    for (const target of activeTargets) {
      const desired = desiredWorld.get(target.object)!;
      ancestorAccum.set(0, 0, 0);
      let p: THREE.Object3D | null = target.object.parent;
      while (p) {
        const ancestorOffset = desiredWorld.get(p);
        if (ancestorOffset) ancestorAccum.add(ancestorOffset);
        p = p.parent;
      }
      worldOffset.copy(desired).sub(ancestorAccum);
      target.object.parent?.getWorldQuaternion(target.parentWorldQuaternion);
      target.offset.copy(worldOffset).applyQuaternion(target.parentWorldQuaternion.invert());
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

  const FACTOR_MAX = 3;

  function setFactor(nextFactor: number) {
    targetFactor = THREE.MathUtils.clamp(Number(nextFactor) || 0, 0, FACTOR_MAX);
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
