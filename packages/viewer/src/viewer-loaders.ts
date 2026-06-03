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

function occtColorToThreeColor(color: OcctMesh['color']): THREE.Color | null {
  if (!Array.isArray(color) || color.length < 3) return null;
  const values = color.slice(0, 3).map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return null;
  const scale = values.some((value) => value > 1) ? 255 : 1;
  const [r = 0, g = 0, b = 0] = values;
  return new THREE.Color(
    THREE.MathUtils.clamp(r / scale, 0, 1),
    THREE.MathUtils.clamp(g / scale, 0, 1),
    THREE.MathUtils.clamp(b / scale, 0, 1)
  );
}

function createOcctMeshMaterial(mesh: OcctMesh | undefined): THREE.MeshStandardMaterial {
  const color = occtColorToThreeColor(mesh?.color);
  return color ? createCadClayMaterial({ color }) : createCadClayMaterial();
}

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
  featureTag?: string;
  featureSelector?: string;
};

type FeatureRange = Pick<
  FaceRange,
  'surfaceType' | 'centroid' | 'normal' | 'axis' | 'area' | 'radius' | 'boundsMin' | 'boundsMax'
>;

type FeatureTagItem = {
  center?: [number, number, number];
  normal?: [number, number, number];
  axis?: [number, number, number];
  area?: number;
  radius?: number;
  bbox?: {
    min?: [number, number, number];
    max?: [number, number, number];
    center?: [number, number, number];
    size?: [number, number, number];
  };
};

type FeatureTagRecord = {
  target?: string;
  selector?: string;
  items?: FeatureTagItem[];
};

type PreparedFeatureTag = {
  name: string;
  selector: string;
  items: Array<{
    center?: THREE.Vector3;
    bboxCenter?: THREE.Vector3;
    bboxSize?: THREE.Vector3;
    normal?: THREE.Vector3;
    axis?: THREE.Vector3;
    area?: number;
    radius?: number;
  }>;
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
  opts: { assemblyPartLabels?: string[]; featureTags?: Record<string, unknown> } = {}
): THREE.Group {
  const group = new THREE.Group();
  const featureTags = prepareFeatureTags(opts.featureTags);
  if (occtResult.meshes.length > 1) {
    return buildSceneFromOcctMeshes(occtResult, opts.assemblyPartLabels || [], featureTags);
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
        boundsMax: c.boundsMax,
        ...matchingFeatureForRange(c, featureTags)
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

  const threeMesh = new THREE.Mesh(geometry, createOcctMeshMaterial(occtResult.meshes[0]));
  threeMesh.userData.faceRanges = faceRanges;
  group.add(threeMesh);

  const edges = new THREE.EdgesGeometry(geometry, 20);
  const lines = new THREE.LineSegments(edges, createCadEdgeMaterial());
  lines.userData.isWireframe = true;
  group.add(lines);

  return group;
}

function buildSceneFromOcctMeshes(
  occtResult: OcctResult,
  assemblyPartLabels: string[] = [],
  featureTags: PreparedFeatureTag[] = []
): THREE.Group {
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
        boundsMax: c.boundsMax,
        ...matchingFeatureForRange(c, featureTags)
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
    const partName = fallbackLabel || meshName || `part_${meshIndex}`;
    const threeMesh = new THREE.Mesh(geometry, createOcctMeshMaterial(mesh));
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

function tupleToVector(value: unknown): THREE.Vector3 | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (![x, y, z].every(Number.isFinite)) return undefined;
  return new THREE.Vector3(x, y, z);
}

function bboxCenterFromItem(item: FeatureTagItem | undefined): THREE.Vector3 | undefined {
  const explicit = tupleToVector(item?.bbox?.center);
  if (explicit) return explicit;
  const min = tupleToVector(item?.bbox?.min);
  const max = tupleToVector(item?.bbox?.max);
  if (!min || !max) return undefined;
  return min.add(max).multiplyScalar(0.5);
}

function prepareFeatureTags(raw: Record<string, unknown> | undefined): PreparedFeatureTag[] {
  if (!raw || typeof raw !== 'object') return [];
  const tags: PreparedFeatureTag[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const record = value as FeatureTagRecord;
    if (!record || typeof record !== 'object') continue;
    if (record.target && record.target !== 'faces') continue;
    const selector = String(record.selector || '').trim();
    if (!selector || !Array.isArray(record.items)) continue;
    const items = record.items
      .map((item) => ({
        center: tupleToVector(item?.center),
        bboxCenter: bboxCenterFromItem(item),
        bboxSize: tupleToVector(item?.bbox?.size),
        normal: tupleToVector(item?.normal)?.normalize(),
        axis: tupleToVector(item?.axis)?.normalize(),
        area: Number.isFinite(Number(item?.area)) ? Number(item?.area) : undefined,
        radius: Number.isFinite(Number(item?.radius)) ? Number(item?.radius) : undefined
      }))
      .filter((item) => item.center || item.bboxCenter || item.normal || item.axis || item.area != null || item.radius != null);
    if (items.length) tags.push({ name, selector, items });
  }
  return tags;
}

function matchingFeatureForRange(
  range: FeatureRange,
  tags: PreparedFeatureTag[]
): { featureTag?: string; featureSelector?: string } {
  if (!tags.length) return {};
  let best: { tag: PreparedFeatureTag; score: number } | null = null;
  for (const tag of tags) {
    for (const item of tag.items) {
      const score = featureMatchScore(range, item);
      if (score == null) continue;
      if (!best || score < best.score) best = { tag, score };
    }
  }
  return best ? { featureTag: best.tag.name, featureSelector: best.tag.selector } : {};
}

function bboxScore(
  rangeBBoxCenter: THREE.Vector3,
  rangeBBoxSize: THREE.Vector3,
  item: PreparedFeatureTag['items'][number]
): number | null {
  let score = 0;
  const sizeScale = item.bboxSize?.length() || rangeBBoxSize.length() || 1;
  const bboxTol = Math.max(1e-2, sizeScale * 5e-3);
  if (item.bboxCenter) {
    const distance = rangeBBoxCenter.distanceTo(item.bboxCenter);
    if (distance > bboxTol) return null;
    score += distance / bboxTol;
  }
  if (item.bboxSize) {
    const delta = rangeBBoxSize.distanceTo(item.bboxSize);
    if (delta > bboxTol) return null;
    score += delta / bboxTol;
  }
  return score;
}

function areaScore(rangeArea: number, itemArea: number | undefined): number {
  if (itemArea == null || !Number.isFinite(rangeArea)) return 0;
  const areaTol = Math.max(1e-2, Math.abs(itemArea) * 5e-3);
  const delta = Math.abs(rangeArea - itemArea);
  return Math.min(delta / areaTol, 10);
}

function featureMatchScore(range: FeatureRange, item: PreparedFeatureTag['items'][number]): number | null {
  const rangeBBoxCenter = new THREE.Vector3().addVectors(range.boundsMin, range.boundsMax).multiplyScalar(0.5);
  const rangeBBoxSize = new THREE.Vector3().subVectors(range.boundsMax, range.boundsMin);
  if (range.surfaceType === 'cylindrical') {
    return matchCylindricalFeature(range, item, rangeBBoxCenter, rangeBBoxSize);
  }
  if (range.surfaceType === 'planar') {
    return matchPlanarFeature(range, item, rangeBBoxCenter, rangeBBoxSize);
  }
  return null;
}

function matchPlanarFeature(
  range: FeatureRange,
  item: PreparedFeatureTag['items'][number],
  rangeBBoxCenter: THREE.Vector3,
  rangeBBoxSize: THREE.Vector3
): number | null {
  let score = 0;
  let checks = 0;
  if (item.normal) {
    const normalDot = Math.abs(range.normal.clone().normalize().dot(item.normal));
    if (normalDot < 0.995) return null;
    score += 1 - normalDot;
    checks++;
  }
  if (item.bboxCenter || item.bboxSize) {
    const part = bboxScore(rangeBBoxCenter, rangeBBoxSize, item);
    if (part == null) return null;
    score += part;
    checks++;
  } else if (item.center) {
    const distance = range.centroid.distanceTo(item.center);
    const centerTol = Math.max(1e-3, Math.sqrt(Math.max(0, Math.abs(range.area))) * 1e-3);
    if (distance > centerTol) return null;
    score += distance / centerTol;
    checks++;
  }
  if (item.area != null) {
    score += areaScore(range.area, item.area);
    checks++;
  }
  return checks > 0 ? score : null;
}

function matchCylindricalFeature(
  range: FeatureRange,
  item: PreparedFeatureTag['items'][number],
  rangeBBoxCenter: THREE.Vector3,
  rangeBBoxSize: THREE.Vector3
): number | null {
  let score = 0;
  let checks = 0;
  if (item.axis) {
    if (!range.axis) return null;
    const axisDot = Math.abs(range.axis.clone().normalize().dot(item.axis));
    if (axisDot < 0.995) return null;
    score += 1 - axisDot;
    checks++;
  }
  if (item.radius != null) {
    if (!Number.isFinite(range.radius ?? NaN)) return null;
    const radiusTol = Math.max(1e-3, Math.abs(item.radius) * 1e-3);
    const delta = Math.abs((range.radius ?? 0) - item.radius);
    if (delta > radiusTol) return null;
    score += delta / radiusTol;
    checks++;
  }
  if (item.bboxCenter) {
    // Soft penalty only: the tessellated cylinder bbox underestimates the true
    // radial extent, so a hard tolerance would reject genuine matches on coarse
    // meshes. Axis + radius already identify the feature, and every item of a
    // feature carries the same selector, so bbox can only help rank — never gate.
    const sizeScale = item.bboxSize?.length() || rangeBBoxSize.length() || 1;
    const bboxTol = Math.max(1e-2, sizeScale * 5e-3);
    score += Math.min(rangeBBoxCenter.distanceTo(item.bboxCenter) / bboxTol, 10);
    checks++;
  }
  if (item.area != null) {
    score += areaScore(range.area, item.area);
    checks++;
  }
  return checks > 0 ? score : null;
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
