import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { createCadClayMaterial, createCadEdgeMaterial } from './viewer-materials.js';

type OcctMesh = {
  name?: string;
  color?: [number, number, number] | null;
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index: { array: ArrayLike<number> };
  brep_faces: Array<{ first: number; last: number }>;
};

type OcctResult = {
  meshes: OcctMesh[];
};

type FaceSurfaceType = 'planar' | 'cylindrical' | 'other';

type FaceRange = {
  faceIndex: number;
  triStart: number;
  triCount: number;
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  surfaceType: FaceSurfaceType;
  area: number;
  radius?: number;
  axis?: THREE.Vector3;
  boundsMin: THREE.Vector3;
  boundsMax: THREE.Vector3;
};

export function inferMaterialPartNameFromUrl(url: string): string {
  const raw = String(url || '').split('?')[0] || '';
  let path = raw;
  try {
    path = decodeURIComponent(raw.replace(/^[^:]*:\/\/[^/]*\//, '').replace(/^aicad:\/\/asset\//, ''));
  } catch {
    path = raw.replace(/^[^:]*:\/\/[^/]*\//, '').replace(/^aicad:\/\/asset\//, '');
  }
  const match = path.match(/(?:^|\/)parts\/([^/]+)\//i);
  return match?.[1] ?? '';
}

export function buildSceneFromOcctResult(
  occtResult: OcctResult,
  opts: { assemblyPartLabels?: string[] } = {}
): THREE.Group {
  const group = new THREE.Group();
  if (occtResult.meshes.length > 1) {
    return buildSceneFromOcctMeshes(occtResult, opts.assemblyPartLabels || []);
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: FaceRange[] = [];

  let vertexOffset = 0;
  let triOffset = 0;
  let globalFaceIdx = 0;

  for (const mesh of occtResult.meshes) {
    const posArr = mesh.attributes.position.array;
    const nrmArr = mesh.attributes.normal?.array;
    const idxArr = mesh.index.array;

    for (let i = 0; i < posArr.length; i++) positions.push(posArr[i] ?? 0);
    if (nrmArr && nrmArr.length === posArr.length) {
      for (let i = 0; i < nrmArr.length; i++) normals.push(nrmArr[i] ?? 0);
    } else {
      for (let i = 0; i < posArr.length; i++) normals.push(0);
    }
    for (let i = 0; i < idxArr.length; i++) indices.push((idxArr[i] ?? 0) + vertexOffset);

    for (const bf of mesh.brep_faces) {
      const triStart = triOffset + bf.first;
      const triCount = bf.last - bf.first + 1;
      const c = estimateFaceCentroidAndNormal(posArr, idxArr, bf.first, bf.last);

      faceRanges.push({
        faceIndex: globalFaceIdx++,
        triStart,
        triCount,
        centroid: c.centroid,
        normal: c.normal,
        surfaceType: c.surfaceType,
        area: c.area,
        radius: c.radius,
        axis: c.axis,
        boundsMin: c.boundsMin,
        boundsMax: c.boundsMax
      });
    }

    vertexOffset += posArr.length / 3;
    triOffset += idxArr.length / 3;
  }

  if (indices.length === 0) return group;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  if (normals.every((v) => v === 0)) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const threeMesh = new THREE.Mesh(geometry, createCadClayMaterial());
  threeMesh.userData.faceRanges = faceRanges;
  group.add(threeMesh);

  const edges = new THREE.EdgesGeometry(geometry, 20);
  const lines = new THREE.LineSegments(edges, createCadEdgeMaterial());
  lines.userData.isWireframe = true;
  group.add(lines);

  return group;
}

function buildSceneFromOcctMeshes(occtResult: OcctResult, assemblyPartLabels: string[] = []): THREE.Group {
  const group = new THREE.Group();
  let globalFaceIdx = 0;

  occtResult.meshes.forEach((mesh, meshIndex) => {
    const posArr = mesh.attributes.position.array;
    const nrmArr = mesh.attributes.normal?.array;
    const idxArr = mesh.index.array;
    if (!idxArr.length) return;

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const faceRanges: FaceRange[] = [];

    for (let i = 0; i < posArr.length; i++) positions.push(posArr[i] ?? 0);
    if (nrmArr && nrmArr.length === posArr.length) {
      for (let i = 0; i < nrmArr.length; i++) normals.push(nrmArr[i] ?? 0);
    } else {
      for (let i = 0; i < posArr.length; i++) normals.push(0);
    }
    for (let i = 0; i < idxArr.length; i++) indices.push(idxArr[i] ?? 0);

    for (const bf of mesh.brep_faces) {
      const triCount = bf.last - bf.first + 1;
      const c = estimateFaceCentroidAndNormal(posArr, idxArr, bf.first, bf.last);
      faceRanges.push({
        faceIndex: globalFaceIdx++,
        triStart: bf.first,
        triCount,
        centroid: c.centroid,
        normal: c.normal,
        surfaceType: c.surfaceType,
        area: c.area,
        radius: c.radius,
        axis: c.axis,
        boundsMin: c.boundsMin,
        boundsMax: c.boundsMax
      });
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    if (normals.every((v) => v === 0)) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const meshName = String(mesh.name || '').trim();
    const fallbackLabel = String(assemblyPartLabels[meshIndex] || '').trim();
    const partName = meshName || fallbackLabel || `part_${meshIndex}`;
    const threeMesh = new THREE.Mesh(geometry, createCadClayMaterial());
    threeMesh.name = partName;
    threeMesh.userData.faceRanges = faceRanges;
    threeMesh.userData.materialPart = {
      id: partName,
      name: partName,
      aliases: [partName, meshName, fallbackLabel, meshIndex].filter((item) => item !== '' && item != null),
      index: meshIndex,
      materialIndex: 0
    };
    group.add(threeMesh);

    const edges = new THREE.EdgesGeometry(geometry, 20);
    const lines = new THREE.LineSegments(edges, createCadEdgeMaterial());
    lines.name = `${partName}_edges`;
    lines.userData.isWireframe = true;
    group.add(lines);
  });

  return group;
}

function estimateFaceCentroidAndNormal(
  posArr: ArrayLike<number>,
  idxArr: ArrayLike<number>,
  firstTri: number,
  lastTri: number
): {
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  surfaceType: FaceSurfaceType;
  area: number;
  radius?: number;
  axis?: THREE.Vector3;
  boundsMin: THREE.Vector3;
  boundsMax: THREE.Vector3;
} {
  const centroid = new THREE.Vector3();
  const averageCentroid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const boundsMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const boundsMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const normalSamples: THREE.Vector3[] = [];
  const vertexSamples: THREE.Vector3[] = [];
  let area = 0;
  let vertexCount = 0;
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const triCentroid = new THREE.Vector3();
  for (let t = firstTri; t <= lastTri; t++) {
    const ia = idxArr[t * 3 + 0] ?? 0;
    const ib = idxArr[t * 3 + 1] ?? 0;
    const ic = idxArr[t * 3 + 2] ?? 0;
    v0.set(posArr[ia * 3] ?? 0, posArr[ia * 3 + 1] ?? 0, posArr[ia * 3 + 2] ?? 0);
    v1.set(posArr[ib * 3] ?? 0, posArr[ib * 3 + 1] ?? 0, posArr[ib * 3 + 2] ?? 0);
    v2.set(posArr[ic * 3] ?? 0, posArr[ic * 3 + 1] ?? 0, posArr[ic * 3 + 2] ?? 0);

    expandBounds(boundsMin, boundsMax, v0);
    expandBounds(boundsMin, boundsMax, v1);
    expandBounds(boundsMin, boundsMax, v2);
    averageCentroid.add(v0).add(v1).add(v2);
    vertexSamples.push(v0.clone(), v1.clone(), v2.clone());
    vertexCount += 3;

    e1.subVectors(v1, v0);
    e2.subVectors(v2, v0);
    n.crossVectors(e1, e2);
    const triArea = n.length() * 0.5;
    if (triArea > 0) {
      n.normalize();
      normalSamples.push(n.clone());
      normal.addScaledVector(n, triArea);
      triCentroid.copy(v0).add(v1).add(v2).multiplyScalar(1 / 3);
      centroid.addScaledVector(triCentroid, triArea);
      area += triArea;
    }
  }
  if (area > 0) {
    centroid.multiplyScalar(1 / area);
    if (normal.lengthSq() > 0) normal.normalize();
    else normal.set(0, 0, 1);
  } else if (vertexCount > 0) {
    centroid.copy(averageCentroid).multiplyScalar(1 / vertexCount);
    normal.set(0, 0, 1);
  }
  if (!Number.isFinite(boundsMin.x)) {
    boundsMin.set(0, 0, 0);
    boundsMax.set(0, 0, 0);
  }
  const surface = classifyFaceSurface(normalSamples, normal, vertexSamples, centroid);
  return {
    centroid,
    normal,
    surfaceType: surface.surfaceType,
    area,
    radius: surface.radius,
    axis: surface.axis,
    boundsMin,
    boundsMax
  };
}

function expandBounds(min: THREE.Vector3, max: THREE.Vector3, value: THREE.Vector3): void {
  min.x = Math.min(min.x, value.x);
  min.y = Math.min(min.y, value.y);
  min.z = Math.min(min.z, value.z);
  max.x = Math.max(max.x, value.x);
  max.y = Math.max(max.y, value.y);
  max.z = Math.max(max.z, value.z);
}

function classifyFaceSurface(
  normals: THREE.Vector3[],
  faceNormal: THREE.Vector3,
  vertices: THREE.Vector3[],
  centroid: THREE.Vector3
): { surfaceType: FaceSurfaceType; radius?: number; axis?: THREE.Vector3 } {
  if (normals.length <= 1) return { surfaceType: 'planar' };

  let minPlanarDot = 1;
  for (const sample of normals) {
    minPlanarDot = Math.min(minPlanarDot, Math.abs(sample.dot(faceNormal)));
  }
  if (minPlanarDot >= Math.cos(THREE.MathUtils.degToRad(7))) {
    return { surfaceType: 'planar' };
  }

  const axis = estimateCylindricalAxis(normals);
  if (axis) {
    let totalAxisNormal = 0;
    let maxAxisNormal = 0;
    for (const sample of normals) {
      const axisNormal = Math.abs(sample.dot(axis));
      totalAxisNormal += axisNormal;
      maxAxisNormal = Math.max(maxAxisNormal, axisNormal);
    }
    const averageAxisNormal = totalAxisNormal / normals.length;
    const radius = estimateRadiusFromAxis(vertices, centroid, axis);
    if (Number.isFinite(radius) && radius > 0 && averageAxisNormal < 0.18 && maxAxisNormal < 0.38) {
      return { surfaceType: 'cylindrical', axis, radius };
    }
  }
  return { surfaceType: 'other' };
}

function estimateCylindricalAxis(normals: THREE.Vector3[]): THREE.Vector3 | null {
  const samples: THREE.Vector3[] = [];
  const step = Math.max(1, Math.floor(normals.length / 64));
  for (let i = 0; i < normals.length && samples.length < 64; i += step) {
    const sample = normals[i];
    if (sample) samples.push(sample);
  }
  const axis = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let pairCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    if (!a) continue;
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j];
      if (!b || Math.abs(a.dot(b)) > 0.995) continue;
      cross.crossVectors(a, b);
      const len = cross.length();
      if (len <= 1e-8) continue;
      cross.multiplyScalar(1 / len);
      if (axis.lengthSq() > 0 && axis.dot(cross) < 0) cross.negate();
      axis.add(cross);
      pairCount++;
    }
  }
  if (pairCount < 2 || axis.lengthSq() <= 1e-8) return null;
  axis.normalize();

  let coherence = 0;
  let coherencePairs = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    if (!a) continue;
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j];
      if (!b || Math.abs(a.dot(b)) > 0.995) continue;
      cross.crossVectors(a, b);
      const len = cross.length();
      if (len <= 1e-8) continue;
      cross.multiplyScalar(1 / len);
      coherence += Math.abs(cross.dot(axis));
      coherencePairs++;
    }
  }
  if (coherencePairs === 0 || coherence / coherencePairs < 0.72) return null;
  return axis.clone();
}

function estimateRadiusFromAxis(vertices: THREE.Vector3[], centroid: THREE.Vector3, axis: THREE.Vector3): number {
  const radial = new THREE.Vector3();
  let total = 0;
  let count = 0;
  for (const vertex of vertices) {
    radial.subVectors(vertex, centroid);
    radial.addScaledVector(axis, -radial.dot(axis));
    const distance = radial.length();
    if (!Number.isFinite(distance)) continue;
    total += distance;
    count++;
  }
  return count > 0 ? total / count : NaN;
}

export function buildSceneFromStlBuffer(buffer: ArrayBuffer): { group: THREE.Group; geometry: THREE.BufferGeometry } {
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, createCadClayMaterial());
  group.add(mesh);

  const edges = new THREE.EdgesGeometry(geometry, 20);
  group.add(new THREE.LineSegments(edges, createCadEdgeMaterial()));

  return { group, geometry };
}

export function tagSceneAsMaterialPart(group: THREE.Group, partName: string): void {
  const key = String(partName || '').trim();
  if (!key) return;
  let index = 0;
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.name = child.name || key;
    child.userData.materialPart = {
      id: key,
      name: key,
      aliases: [key, index],
      index,
      materialIndex: 0
    };
    index++;
  });
}

function addAlias(aliases: Array<string | number>, value: unknown): void {
  const text = String(value ?? '').trim();
  if (!text) return;
  if (!aliases.some((alias) => String(alias) === text)) aliases.push(text);
}

function materialList(material: THREE.Material | THREE.Material[] | null | undefined): THREE.Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

export function applyCadStyleToGlbScene(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    for (const material of materialList(child.material)) {
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
    // Mark so the appearance controller knows this mesh carries colors baked
    // into the GLB (via build123d's _apply_viewer_colors). Without this flag,
    // a params.json __viewer.materials.default would overwrite every GLB
    // material whose name doesn't match a `parts.*` key — collapsing distinct
    // materials into one.
    child.userData.glbMaterialBaked = true;
    const geometry = child.geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return;
    if (child.children.some((c) => c instanceof THREE.LineSegments && c.userData.isWireframe)) return;
    const edges = new THREE.EdgesGeometry(geometry, 20);
    const lines = new THREE.LineSegments(edges, createCadEdgeMaterial());
    lines.name = `${child.name || 'glb-mesh'}_edges`;
    lines.userData.isWireframe = true;
    child.add(lines);
  });
}

export function tagGlbSceneMaterialParts(root: THREE.Object3D, assemblyPartLabels: string[] = []): void {
  let meshIndex = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const fallbackLabel = String(assemblyPartLabels[meshIndex] || '').trim();
    const aliases: Array<string | number> = [];
    addAlias(aliases, fallbackLabel);
    addAlias(aliases, child.name);
    addAlias(aliases, child.userData?.name);
    addAlias(aliases, child.geometry?.name);

    for (const material of materialList(child.material)) {
      addAlias(aliases, material.name);
    }

    let cursor: THREE.Object3D | null = child.parent;
    while (cursor) {
      addAlias(aliases, cursor.name);
      if (cursor === root) break;
      cursor = cursor.parent;
    }

    aliases.push(meshIndex);
    const partName = fallbackLabel || String(aliases.find((alias) => typeof alias === 'string') || `part_${meshIndex}`);
    child.name = child.name || partName;
    child.userData.materialPart = {
      id: partName,
      name: partName,
      aliases,
      index: meshIndex,
      materialIndex: 0
    };
    meshIndex++;
  });
}
