import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { loadMjcfDocument } from './mjcf.js';
import { createCadClayMaterial } from './viewer-materials.js';

function parseNumberList(value, fallback = []) {
  const text = String(value || '').trim();
  if (!text) return fallback.slice();
  const nums = text.split(/\s+/).map((item) => Number(item));
  return nums.every((num) => Number.isFinite(num)) ? nums : fallback.slice();
}

function parseVec3(value, fallback = [0, 0, 0]) {
  const nums = parseNumberList(value, fallback);
  return new THREE.Vector3(nums[0] ?? fallback[0], nums[1] ?? fallback[1], nums[2] ?? fallback[2]);
}

function parseQuat(value) {
  const nums = parseNumberList(value, []);
  if (nums.length < 4) return null;
  return new THREE.Quaternion(nums[1], nums[2], nums[3], nums[0]).normalize();
}

function parseEulerQuat(value, angleScale) {
  const nums = parseNumberList(value, []);
  if (nums.length < 3) return null;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    nums[0] * angleScale,
    nums[1] * angleScale,
    nums[2] * angleScale,
    'XYZ'
  ));
}

function elementChildren(node, tagName = null) {
  return Array.from(node?.children || [])
    .filter((child) => !tagName || child.tagName === tagName);
}

function getCompilerAngleScale(document) {
  const compiler = elementChildren(document.documentElement, 'compiler')[0];
  const angle = String(compiler?.getAttribute('angle') || 'degree').trim().toLowerCase();
  return angle === 'radian' ? 1 : Math.PI / 180;
}

function applyMjcfTransform(object, element, angleScale) {
  object.position.copy(parseVec3(element.getAttribute('pos')));
  const quat = parseQuat(element.getAttribute('quat')) || parseEulerQuat(element.getAttribute('euler'), angleScale);
  if (quat) object.quaternion.copy(quat);
}

function prepareMjcfSkeletonDocument(document) {
  const simDocument = document.cloneNode(true);
  for (const meshEl of Array.from(simDocument.getElementsByTagName('mesh'))) {
    meshEl.parentElement?.removeChild(meshEl);
  }
  for (const geomEl of Array.from(simDocument.getElementsByTagName('geom'))) {
    if (geomEl.hasAttribute('mesh') || String(geomEl.getAttribute('type') || '').trim().toLowerCase() === 'mesh') {
      geomEl.parentElement?.removeChild(geomEl);
    }
  }
  for (const bodyEl of Array.from(simDocument.getElementsByTagName('body'))) {
    const hasJoint = elementChildren(bodyEl).some((child) => child.tagName === 'joint' || child.tagName === 'freejoint');
    const hasInertial = elementChildren(bodyEl, 'inertial').length > 0;
    if (hasJoint && !hasInertial) {
      const inertial = simDocument.createElement('inertial');
      inertial.setAttribute('pos', '0 0 0');
      inertial.setAttribute('mass', '1');
      inertial.setAttribute('diaginertia', '1 1 1');
      bodyEl.insertBefore(inertial, bodyEl.firstChild);
    }
  }
  return simDocument;
}

export function disposeMjcfSimulation(sim) {
  if (!sim) return;
  for (const binding of sim.bodyBindings || []) binding.bodyAccessor?.delete?.();
  sim.defaultCtrlAccessor?.delete?.();
  sim.data?.delete?.();
  sim.model?.delete?.();
  sim.vfs?.delete?.();
}

async function createMjcfSimulation(root, document, meshAssets, getMujoco, onLog = () => {}) {
  const mujoco = await getMujoco();
  const vfs = new mujoco.MjVFS();
  try {
    const simDocument = document.cloneNode(true);
    let meshIndex = 0;
    for (const meshEl of Array.from(simDocument.getElementsByTagName('mesh'))) {
      const name = String(meshEl.getAttribute('name') || '').trim();
      const asset = meshAssets.get(name);
      if (!asset?.bytes) continue;
      const safeName = (name || 'asset').replace(/[^\w.-]+/g, '_');
      const vfsPath = `mesh_${meshIndex++}_${safeName}.stl`;
      vfs.addBuffer(vfsPath, asset.bytes);
      meshEl.setAttribute('file', vfsPath);
    }
    const xml = new XMLSerializer().serializeToString(simDocument);
    let model;
    let usingSkeleton = false;
    try {
      model = mujoco.MjModel.from_xml_string(xml, vfs);
    } catch (err) {
      const skeletonXml = new XMLSerializer().serializeToString(prepareMjcfSkeletonDocument(document));
      model = mujoco.MjModel.from_xml_string(skeletonXml);
      usingSkeleton = true;
    }
    const data = new mujoco.MjData(model);
    const sim = {
      mujoco,
      model,
      data,
      vfs,
      bodyBindings: [],
      defaultCtrl: null,
      defaultCtrlAccessor: null
    };
    if (Number(model.nu || 0) > 0) {
      try {
        const numeric = model.numeric('aicad_default_ctrl');
        sim.defaultCtrlAccessor = numeric;
        sim.defaultCtrl = Array.from(numeric.data || []).slice(0, Number(model.nu || 0));
        for (let i = 0; i < sim.defaultCtrl.length; i++) data.ctrl[i] = sim.defaultCtrl[i];
      } catch {
        sim.defaultCtrl = null;
      }
    }
    for (const body of root.userData.mjcfBodies || []) {
      const name = String(body.name || '').trim();
      if (!name) continue;
      try {
        const bodyAccessor = data.body(name);
        sim.bodyBindings.push({
          body,
          bodyAccessor,
          xpos: bodyAccessor.xpos,
          xquat: bodyAccessor.xquat
        });
      } catch {
        // Bodies that fail named lookup remain static in the local preview scene.
      }
    }
    mujoco.mj_forward(model, data);
    onLog(`MJCF MuJoCo simulation ready (${model.nbody} bodies, ${model.njnt} joints${usingSkeleton ? ', skeleton fallback' : ''})`);
    return sim;
  } catch (err) {
    vfs.delete?.();
    onLog(`MJCF MuJoCo simulation unavailable: ${err?.message || err}`);
    return null;
  }
}

function applyMjcfWorldPose(root, body, positionView, quaternionView) {
  const offset = root?.userData?.mjcfModelOffset;
  const worldPosition = new THREE.Vector3(
    (positionView?.[0] || 0) + (offset?.x || 0),
    (positionView?.[1] || 0) + (offset?.y || 0),
    (positionView?.[2] || 0) + (offset?.z || 0)
  );
  const worldQuaternion = new THREE.Quaternion(
    quaternionView?.[1] || 0,
    quaternionView?.[2] || 0,
    quaternionView?.[3] || 0,
    quaternionView?.[0] ?? 1
  ).normalize();
  const parent = body.parent;
  if (parent) {
    parent.updateMatrixWorld(true);
    body.position.copy(parent.worldToLocal(worldPosition));
    const parentWorldQuaternion = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuaternion);
    body.quaternion.copy(parentWorldQuaternion.invert().multiply(worldQuaternion));
  } else {
    body.position.copy(worldPosition);
    body.quaternion.copy(worldQuaternion);
  }
}

export function syncMjcfSimulationPose(root) {
  const sim = root?.userData?.mjcfSimulation;
  if (!root || !sim?.bodyBindings?.length) return false;
  for (const binding of sim.bodyBindings) {
    applyMjcfWorldPose(root, binding.body, binding.xpos, binding.xquat);
  }
  root.updateMatrixWorld(true);
  return true;
}

export function stepMjcfSimulation(root, dt) {
  const sim = root?.userData?.mjcfSimulation;
  if (!sim) return false;
  const timestep = Math.max(1e-4, Number(sim.model?.opt?.timestep) || 0.002);
  let steps = Math.min(120, Math.max(1, Math.ceil(Math.max(0, dt || 0) / timestep)));
  while (steps-- > 0) {
    if (sim.defaultCtrl?.length) {
      for (let i = 0; i < sim.defaultCtrl.length; i++) sim.data.ctrl[i] = sim.defaultCtrl[i];
    }
    sim.mujoco.mj_step(sim.model, sim.data);
  }
  return syncMjcfSimulationPose(root);
}

function resolveMjcfMeshUrl(mjcfUrl, meshPath) {
  const raw = String(meshPath || '').trim();
  if (!raw) return null;
  if (/^(https?:|aicad:)/i.test(raw)) {
    try {
      return new URL(raw).toString();
    } catch {
      return raw;
    }
  }
  let normalized = raw.replace(/^package:\/\//i, '');
  if (/^[A-Za-z]:[\\/]/.test(normalized)) {
    normalized = normalized.replace(/\\/g, '/');
  }
  try {
    return new URL(normalized, mjcfUrl).toString();
  } catch {
    return null;
  }
}

async function loadStlAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const geometry = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  geometry.computeVertexNormals();
  return { geometry, bytes };
}

function parseMjcfXml(text) {
  const document = new DOMParser().parseFromString(String(text || ''), 'application/xml');
  const parserError = document.getElementsByTagName('parsererror')[0];
  if (parserError) throw new Error(`MJCF XML parse failed: ${parserError.textContent || 'invalid XML'}`);
  if (document.documentElement?.tagName !== 'mujoco') throw new Error('MJCF must contain a <mujoco> root element');
  return document;
}

export async function loadMjcfScene({ url, paramsUrl, mjcfText = null, baseUrl = url, getMujoco }, onLog = () => {}) {
  onLog('MJCF parsing ...');
  const baseForRelative = String(baseUrl || url).split('?')[0];

  const text = mjcfText != null ? mjcfText : await loadMjcfDocument(url, paramsUrl);
  const document = parseMjcfXml(text);
  const angleScale = getCompilerAngleScale(document);
  const root = new THREE.Group();
  root.name = document.documentElement.getAttribute('model') || 'mjcf';
  root.userData.mjcfBodies = [];

  const meshAssets = new Map();
  for (const meshEl of Array.from(document.getElementsByTagName('mesh'))) {
    const name = String(meshEl.getAttribute('name') || '').trim();
    const file = String(meshEl.getAttribute('file') || '').trim();
    if (!name || !file) continue;
    const resolved = resolveMjcfMeshUrl(baseForRelative, file);
    if (!resolved) throw new Error(`Unsupported MJCF mesh path: ${file}`);
    if (!resolved.toLowerCase().endsWith('.stl')) throw new Error(`Unsupported MJCF mesh extension: ${file}`);
    const loaded = await loadStlAsset(resolved);
    meshAssets.set(name, {
      geometry: loaded.geometry,
      bytes: loaded.bytes,
      scale: parseVec3(meshEl.getAttribute('scale'), [1, 1, 1])
    });
  }

  function addGeom(parent, geomEl) {
    const meshName = String(geomEl.getAttribute('mesh') || '').trim();
    const type = String(geomEl.getAttribute('type') || '').trim().toLowerCase();
    if (!meshName && type !== 'mesh') return;
    const asset = meshAssets.get(meshName);
    if (!asset) throw new Error(`MJCF references unknown mesh asset: ${meshName}`);
    const mesh = new THREE.Mesh(
      asset.geometry.clone(),
      createCadClayMaterial()
    );
    mesh.name = String(geomEl.getAttribute('name') || meshName || 'geom');
    applyMjcfTransform(mesh, geomEl, angleScale);
    const geomScale = parseVec3(geomEl.getAttribute('scale'), [1, 1, 1]);
    mesh.scale.set(asset.scale.x * geomScale.x, asset.scale.y * geomScale.y, asset.scale.z * geomScale.z);
    parent.add(mesh);
  }

  function addBody(parent, bodyEl) {
    const body = new THREE.Group();
    body.name = String(bodyEl.getAttribute('name') || 'body');
    applyMjcfTransform(body, bodyEl, angleScale);
    root.userData.mjcfBodies.push(body);
    parent.add(body);

    for (const child of elementChildren(bodyEl)) {
      if (child.tagName === 'geom') {
        addGeom(body, child);
      } else if (child.tagName === 'body') {
        addBody(body, child);
      }
    }
  }

  const worldbody = elementChildren(document.documentElement, 'worldbody')[0];
  if (!worldbody) throw new Error('MJCF must include a <worldbody> element');
  for (const child of elementChildren(worldbody)) {
    if (child.tagName === 'body') addBody(root, child);
    else if (child.tagName === 'geom') addGeom(root, child);
  }
  for (const asset of meshAssets.values()) asset.geometry.dispose();
  if (!root.children.length) throw new Error('MJCF loader returned empty scene');

  const initialBox = new THREE.Box3().setFromObject(root);
  const initialCenter = new THREE.Vector3();
  initialBox.getCenter(initialCenter);
  root.position.sub(initialCenter);
  root.userData.mjcfModelOffset = initialCenter.clone().multiplyScalar(-1);
  root.updateMatrixWorld(true);
  const simulation = await createMjcfSimulation(root, document, meshAssets, getMujoco, onLog);
  root.userData.mjcfSimulation = simulation;
  if (simulation) syncMjcfSimulationPose(root);

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  onLog('MJCF parse complete');

  return {
    root,
    simulation,
    partInfo: {
      faceCount: null,
      bbox: {
        min: { x: box.min.x, y: box.min.y, z: box.min.z },
        max: { x: box.max.x, y: box.max.y, z: box.max.z },
        size: { x: size.x, y: size.y, z: size.z }
      },
      faces: []
    }
  };
}
