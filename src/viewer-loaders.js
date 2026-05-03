import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { createCadClayMaterial, createCadEdgeMaterial } from './viewer-materials.js';

export function buildSceneFromOcctResult(occtResult) {
  const group = new THREE.Group();

  const positions = [];
  const normals = [];
  const indices = [];
  const faceRanges = [];

  let vertexOffset = 0;
  let triOffset = 0;
  let globalFaceIdx = 0;

  for (const mesh of occtResult.meshes) {
    const posArr = mesh.attributes.position.array;
    const nrmArr = mesh.attributes.normal?.array;
    const idxArr = mesh.index.array;

    for (let i = 0; i < posArr.length; i++) positions.push(posArr[i]);
    if (nrmArr && nrmArr.length === posArr.length) {
      for (let i = 0; i < nrmArr.length; i++) normals.push(nrmArr[i]);
    } else {
      for (let i = 0; i < posArr.length; i++) normals.push(0);
    }
    for (let i = 0; i < idxArr.length; i++) indices.push(idxArr[i] + vertexOffset);

    for (const bf of mesh.brep_faces) {
      const triStart = triOffset + bf.first;
      const triCount = bf.last - bf.first + 1;
      const c = estimateFaceCentroidAndNormal(posArr, idxArr, bf.first, bf.last);

      faceRanges.push({
        faceIndex: globalFaceIdx++,
        triStart,
        triCount,
        centroid: c.centroid,
        normal: c.normal
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

function estimateFaceCentroidAndNormal(posArr, idxArr, firstTri, lastTri) {
  const centroid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let triCount = 0;
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = firstTri; t <= lastTri; t++) {
    const ia = idxArr[t * 3 + 0];
    const ib = idxArr[t * 3 + 1];
    const ic = idxArr[t * 3 + 2];
    v0.set(posArr[ia * 3], posArr[ia * 3 + 1], posArr[ia * 3 + 2]);
    v1.set(posArr[ib * 3], posArr[ib * 3 + 1], posArr[ib * 3 + 2]);
    v2.set(posArr[ic * 3], posArr[ic * 3 + 1], posArr[ic * 3 + 2]);
    centroid.add(v0).add(v1).add(v2);
    e1.subVectors(v1, v0); e2.subVectors(v2, v0);
    n.crossVectors(e1, e2);
    if (n.lengthSq() > 0) { n.normalize(); normal.add(n); }
    triCount++;
  }
  if (triCount > 0) {
    centroid.multiplyScalar(1 / (triCount * 3));
    if (normal.lengthSq() > 0) normal.normalize();
    else normal.set(0, 0, 1);
  }
  return { centroid, normal };
}

export function buildSceneFromStlBuffer(buffer) {
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
