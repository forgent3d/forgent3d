// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pythonChildProcessEnv } = require('./python-env');
const { DOMParser } = require('@xmldom/xmldom');
const dynamicImport = new Function('specifier', 'return import(specifier)');

/** GLTFExporter (binary GLB) uses FileReader; polyfill for Electron main / Node. */
function ensureGltfExporterGlobals() {
  if (globalThis.__aicadGltfExporterGlobals) return;
  globalThis.__aicadGltfExporterGlobals = true;

  if (typeof globalThis.FileReader !== 'undefined') return;

  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onerror = null;
    }

    _blobToArrayBuffer(blob) {
      if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
      if (blob instanceof ArrayBuffer) return Promise.resolve(blob);
      if (ArrayBuffer.isView(blob)) {
        return Promise.resolve(
          blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
        );
      }
      return Promise.reject(new Error('Unsupported blob type for FileReader polyfill'));
    }

    readAsArrayBuffer(blob) {
      this._blobToArrayBuffer(blob)
        .then((buf) => {
          this.result = buf;
          this.onloadend?.({ target: this });
        })
        .catch((err) => this.onerror?.(err));
    }

    readAsDataURL(blob) {
      this._blobToArrayBuffer(blob)
        .then((buf) => {
          const type = blob?.type || 'application/octet-stream';
          this.result = `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
          this.onloadend?.({ target: this });
        })
        .catch((err) => this.onerror?.(err));
    }
  };
}

function createMainExportTools({ dialog, state, deps }) {
  const stlExportPromises = new Map();
  let occtPromise = null;

  function elapsedMs(startMs) {
    return Math.max(0, Date.now() - startMs);
  }

  function formatDuration(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    if (safe < 1000) return `${safe} ms`;
    return `${(safe / 1000).toFixed(safe < 10000 ? 2 : 1)} s`;
  }

  function exportExt(format) {
    switch (String(format || '').toLowerCase()) {
      case 'step': return '.step';
      case 'stl': return '.stl';
      case 'obj': return '.obj';
      default: return null;
    }
  }

  function ensureExportFormat(format) {
    const f = String(format || '').toLowerCase();
    if (!deps.EXPORT_FORMATS.includes(f)) {
      throw new Error(`Unsupported export format: ${format}`);
    }
    return f;
  }

  async function runCommandCollect(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, opts);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  function appendExportSourceArg(args, sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return;
    args.push(
      '--source',
      path.relative(state.currentProjectPath(), sourcePath).replace(/\\/g, '/')
    );
  }

  async function runPythonExport(modelName, partName, format, outFile, sourcePath = null) {
    const runtime = await deps.detectBuildRuntime(state.currentKernel());
    if (!runtime) throw new Error(deps.missingRuntimeMessage(state.currentKernel()));
    const args = [
      '--project',
      state.currentProjectPath(),
      '--model',
      modelName,
      '--part-name',
      partName,
      '--export-format',
      format,
      '--output',
      outFile
    ];
    let explicitSource = sourcePath;
    if (!explicitSource) {
      if (partName !== modelName) {
        explicitSource = deps.modelPartSource(
          state.currentProjectPath(),
          modelName,
          partName,
          state.currentKernel()
        );
      } else {
        explicitSource = deps.resolveModelSource(
          state.currentProjectPath(),
          modelName,
          state.currentKernel()
        )?.sourcePath;
      }
    }
    appendExportSourceArg(args, explicitSource);
    const cmd = deps.buildRuntimeSpawn(runtime, args);
    const startedAt = Date.now();
    const ret = await runCommandCollect(cmd.cmd, cmd.args, {
      cwd: state.currentProjectPath(),
      shell: false,
      windowsHide: true,
      env: pythonChildProcessEnv()
    });
    if (ret.stdout?.trim()) deps.sendLog(ret.stdout.trimEnd());
    if (ret.stderr?.trim() && ret.code === 0) deps.sendLog(ret.stderr.trimEnd(), 'warn');
    if (ret.code !== 0) {
      throw new Error((ret.stderr || ret.stdout || `Python export failed with exit code ${ret.code}`).trim());
    }
    deps.sendLog(`[${modelName}/${partName}] ${String(format || '').toUpperCase()} export command time: ${formatDuration(elapsedMs(startedAt))}`);
  }

  function statMtimeMs(filePath) {
    try {
      return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  function modelInputMtime(modelName, source = null) {
    if (!state.currentProjectPath() || !modelName) return 0;
    const resolved = source || deps.resolveModelSource(state.currentProjectPath(), modelName, state.currentKernel());
    if (!resolved) return 0;
    const paramsPath = path.join(path.dirname(resolved.sourcePath), 'params.json');
    return Math.max(statMtimeMs(resolved.sourcePath), statMtimeMs(paramsPath));
  }

  function modelPartInputMtime(modelName, partName) {
    if (!state.currentProjectPath() || !modelName || !partName) return 0;
    return Math.max(
      statMtimeMs(deps.modelPartSource(state.currentProjectPath(), modelName, partName, state.currentKernel())),
      statMtimeMs(deps.modelPartParamsPath(state.currentProjectPath(), modelName, partName))
    );
  }

  function modelPartExportDependencyMtime(modelName, partName) {
    const inputMtime = modelPartInputMtime(modelName, partName);
    const cacheFile = deps.partCache?.(state.currentProjectPath(), modelName, partName, state.currentKernel());
    return Math.max(inputMtime, statMtimeMs(cacheFile));
  }

  function freshBrepPath(modelName, partName) {
    if (!state.currentProjectPath() || !modelName || !partName) return null;
    const cacheFile = deps.partCache?.(state.currentProjectPath(), modelName, partName, state.currentKernel());
    if (!cacheFile || path.extname(cacheFile).toLowerCase() !== '.brep') return null;
    const cacheMtime = statMtimeMs(cacheFile);
    if (cacheMtime <= 0 || cacheMtime < modelPartInputMtime(modelName, partName)) return null;
    return cacheFile;
  }

  function isPartExportFresh(outFile, modelName, partName) {
    const outMtime = statMtimeMs(outFile);
    return outMtime > 0 && outMtime >= modelPartExportDependencyMtime(modelName, partName);
  }

  async function getOcct() {
    if (!occtPromise) {
      const occtImportJs = require('occt-import-js');
      occtPromise = occtImportJs();
    }
    return occtPromise;
  }

  function occtMeshToThreeMesh(mesh, THREE) {
    const posArr = mesh?.attributes?.position?.array;
    const idxArr = mesh?.index?.array;
    if (!posArr || !idxArr || posArr.length < 9 || idxArr.length < 3) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const normalArr = mesh?.attributes?.normal?.array;
    if (normalArr && normalArr.length === posArr.length) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalArr, 3));
    }
    geometry.setIndex(Array.from(idxArr));
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb0b0b0 }));
  }

  async function exportFreshBrepToStl(modelName, partName, outFile) {
    const startedAt = Date.now();
    const brepPath = freshBrepPath(modelName, partName);
    if (!brepPath) return false;
    const THREE = require('three');
    const { STLExporter } = await dynamicImport('three/examples/jsm/exporters/STLExporter.js');
    const occt = await getOcct();
    const bytes = fs.readFileSync(brepPath);
    const result = occt.ReadBrepFile(bytes, {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5
    });
    if (!result?.success) throw new Error('OCCT failed to parse fresh BREP cache.');

    const scene = new THREE.Scene();
    try {
      for (const mesh of result.meshes || []) {
        const threeMesh = occtMeshToThreeMesh(mesh, THREE);
        if (threeMesh) scene.add(threeMesh);
      }
      scene.updateMatrixWorld(true);
      const stats = sceneGeometryStats(scene);
      if (stats.meshes <= 0 || stats.triangles <= 0) {
        throw new Error('Fresh BREP cache produced no STL triangles.');
      }
      const data = new STLExporter().parse(scene, { binary: true });
      const buffer = exportPayloadToBuffer(data, 'STL');
      const expectedBinaryStlSize = 84 + stats.triangles * 50;
      if (buffer.byteLength !== expectedBinaryStlSize) {
        throw new Error(`BREP to STL produced ${buffer.byteLength} bytes, expected ${expectedBinaryStlSize} bytes for ${stats.triangles} triangles.`);
      }
      fs.writeFileSync(outFile, buffer);
      deps.sendLog(`[${modelName}/${partName}] STL generated from fresh BREP (${stats.triangles} triangles, STL ${formatDuration(elapsedMs(startedAt))}).`);
      return true;
    } finally {
      scene.traverse((child) => {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material?.dispose?.();
      });
    }
  }

  async function generateStlIfNeeded(modelName, partName, outFile) {
    const normalizedOut = path.resolve(outFile);
    if (isPartExportFresh(normalizedOut, modelName, partName)) {
      return { path: normalizedOut, skipped: true, reason: 'fresh' };
    }
    const key = normalizedOut.toLowerCase();
    if (stlExportPromises.has(key)) return stlExportPromises.get(key);
    const promise = (async () => {
      fs.mkdirSync(path.dirname(normalizedOut), { recursive: true });
      if (isPartExportFresh(normalizedOut, modelName, partName)) {
        return { path: normalizedOut, skipped: true, reason: 'fresh' };
      }
      try {
        if (await exportFreshBrepToStl(modelName, partName, normalizedOut)) {
          return { path: normalizedOut, skipped: false, reason: 'fresh-brep' };
        }
      } catch (err) {
        deps.sendLog(`[${modelName}/${partName}] BREP to STL failed, falling back to build123d export: ${err?.message || err}`, 'warn');
      }
      await runPythonExport(modelName, partName, 'stl', normalizedOut);
      return { path: normalizedOut, skipped: false };
    })().finally(() => {
      stlExportPromises.delete(key);
    });
    stlExportPromises.set(key, promise);
    return promise;
  }

  async function convertStlToObj(stlPath, outPath, format) {
    const THREE = require('three');
    const [{ STLLoader }, { OBJExporter }] = await Promise.all([
      dynamicImport('three/examples/jsm/loaders/STLLoader.js'),
      dynamicImport('three/examples/jsm/exporters/OBJExporter.js')
    ]);

    const data = fs.readFileSync(stlPath);
    const loader = new STLLoader();
    const geometry = loader.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb0b0b0 }));
    const scene = new THREE.Scene();
    scene.add(mesh);

    if (format === 'obj') {
      const objText = new OBJExporter().parse(scene);
      fs.writeFileSync(outPath, objText, 'utf-8');
      return;
    }
    throw new Error(`Unsupported conversion format: ${format}`);
  }

  function parseNumberList(value, fallback = []) {
    const text = String(value || '').trim();
    if (!text) return fallback.slice();
    const nums = text.split(/\s+/).map((item) => Number(item));
    return nums.every((num) => Number.isFinite(num)) ? nums : fallback.slice();
  }

  function interpolateAssemblyParams(text, params = {}, sourceLabel = 'asm.xml') {
    const PARAM_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
    const PARAM_TOKEN_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g;
    const NUMERIC_EXPR_RE = /^[\d+\-*/().\sA-Za-z_$]+$/;
    const formatValue = (value) => Array.isArray(value)
      ? value.map((item) => formatValue(item)).join(' ')
      : String(value ?? '');
    const escapeAttr = (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const getPath = (key) => {
      if (!PARAM_PATH_RE.test(key)) throw new Error(`${sourceLabel} has unsupported parameter expression: \${${key}}`);
      let current = params;
      for (const segment of key.split('.')) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
          throw new Error(`${sourceLabel} references missing params.json value: \${${key}}`);
        }
        current = current[segment];
      }
      return current;
    };
    const evaluateExpression = (expression) => {
      const expr = String(expression || '').trim();
      if (PARAM_PATH_RE.test(expr)) return getPath(expr);
      if (!NUMERIC_EXPR_RE.test(expr)) throw new Error(`${sourceLabel} has unsupported parameter expression: \${${expr}}`);
      const values = [];
      const jsExpr = expr.replace(PARAM_TOKEN_RE, (key) => {
        const value = getPath(key);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`${sourceLabel} expression requires numeric params.json value: \${${key}}`);
        }
        values.push(value);
        return `__v[${values.length - 1}]`;
      });
      if (!/^[\d+\-*/().\s_[\]v]+$/.test(jsExpr)) throw new Error(`${sourceLabel} has unsupported parameter expression: \${${expr}}`);
      const result = Function('__v', `"use strict"; return (${jsExpr});`)(values);
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        throw new Error(`${sourceLabel} parameter expression did not produce a finite number: \${${expr}}`);
      }
      return result;
    };
    return String(text || '').replace(/<!--[\s\S]*?-->|(\$\{([^}]+)\})/g, (match, expr, rawKey) => {
      if (!expr) return match;
      return escapeAttr(formatValue(evaluateExpression(String(rawKey || '').trim())));
    });
  }

  function readAssemblyText(sourcePath) {
    const text = fs.readFileSync(sourcePath, 'utf-8');
    const paramsPath = path.join(path.dirname(sourcePath), 'params.json');
    let params = {};
    if (fs.existsSync(paramsPath)) params = JSON.parse(fs.readFileSync(paramsPath, 'utf-8'));
    return interpolateAssemblyParams(text, params, path.basename(sourcePath));
  }

  function parseAssemblyDocument(sourcePath) {
    const errors = [];
    const parser = new DOMParser({
      onError: (level, message) => {
        if (level === 'error' || level === 'fatalError') errors.push(message);
      }
    });
    const xmlText = readAssemblyText(sourcePath);
    if (!String(xmlText || '').trim()) {
      throw new Error(`MJCF XML parse failed: ${path.basename(sourcePath)} is empty`);
    }
    let document;
    try {
      document = parser.parseFromString(xmlText, 'application/xml');
    } catch (err) {
      throw new Error(`MJCF XML parse failed: ${err?.message || err}`);
    }
    const parserError = document?.getElementsByTagName?.('parsererror')?.[0];
    if (parserError) {
      throw new Error(`MJCF XML parse failed: ${parserError.textContent || 'invalid XML'}`);
    }
    const root = document?.documentElement;
    if (errors.length || !root) throw new Error(`MJCF XML parse failed: ${errors[0] || 'missing root element'}`);
    if (root.nodeName !== 'mujoco') throw new Error('MJCF must contain a <mujoco> root element');
    return document;
  }

  function elementChildren(node, tagName = null) {
    return Array.from(node?.childNodes || [])
      .filter((child) => child.nodeType === 1 && (!tagName || child.nodeName === tagName));
  }

  function compilerAngleScale(document) {
    const compiler = elementChildren(document.documentElement, 'compiler')[0];
    const angle = String(compiler?.getAttribute('angle') || 'degree').trim().toLowerCase();
    return angle === 'radian' ? 1 : Math.PI / 180;
  }

  function applyMjcfTransform(object, element, angleScale, THREE) {
    const pos = parseNumberList(element.getAttribute('pos'), [0, 0, 0]);
    object.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
    const quat = parseNumberList(element.getAttribute('quat'), []);
    if (quat.length >= 4) {
      object.quaternion.set(quat[1] ?? 0, quat[2] ?? 0, quat[3] ?? 0, quat[0] ?? 1).normalize();
      return;
    }
    const euler = parseNumberList(element.getAttribute('euler'), []);
    if (euler.length >= 3) {
      object.quaternion.setFromEuler(new THREE.Euler(
        (euler[0] ?? 0) * angleScale,
        (euler[1] ?? 0) * angleScale,
        (euler[2] ?? 0) * angleScale,
        'XYZ'
      ));
    }
  }

  function resolveAssemblyMeshPath(sourcePath, meshPath) {
    const raw = String(meshPath || '').trim();
    if (!raw) return null;
    if (/^(https?:|aicad:)/i.test(raw)) throw new Error(`Assembly export only supports local STL mesh paths: ${raw}`);
    const normalized = raw.replace(/^package:\/\//i, '').replace(/\\/g, '/');
    const abs = path.resolve(path.dirname(sourcePath), normalized);
    const partsRoot = path.join(path.dirname(sourcePath), 'parts');
    if (!abs.startsWith(`${partsRoot}${path.sep}`)) {
      throw new Error(`MJCF mesh path must stay inside this model package's parts/ directory: ${raw}`);
    }
    if (path.extname(abs).toLowerCase() !== '.stl') throw new Error(`Assembly export supports STL mesh assets only: ${raw}`);
    return abs;
  }

  async function buildAssemblyScene(sourcePath) {
    const THREE = require('three');
    const { STLLoader } = await dynamicImport('three/examples/jsm/loaders/STLLoader.js');
    const document = parseAssemblyDocument(sourcePath);
    const modelName = path.basename(path.dirname(sourcePath));
    const angleScale = compilerAngleScale(document);
    const scene = new THREE.Scene();
    const meshAssets = new Map();

    for (const meshEl of Array.from(document.getElementsByTagName('mesh'))) {
      const name = String(meshEl.getAttribute('name') || '').trim();
      const file = String(meshEl.getAttribute('file') || '').trim();
      if (!name || !file) continue;
      const meshPath = resolveAssemblyMeshPath(sourcePath, file);
      const partName = path.basename(meshPath, path.extname(meshPath));
      deps.sendLog(`[${modelName}] Preparing assembly mesh asset: ${path.relative(state.currentProjectPath(), meshPath).replace(/\\/g, '/')}`);
      await ensurePartStlArtifact(modelName, partName);
      if (!fs.existsSync(meshPath)) throw new Error(`MJCF mesh file not found: ${file}`);
      const data = fs.readFileSync(meshPath);
      const geometry = new STLLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      geometry.computeVertexNormals();
      const scale = parseNumberList(meshEl.getAttribute('scale'), [1, 1, 1]);
      meshAssets.set(name, {
        geometry,
        scale: new THREE.Vector3(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1),
        meshPath
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
        new THREE.MeshStandardMaterial({ color: 0xb0b0b0 })
      );
      mesh.name = String(geomEl.getAttribute('name') || meshName || 'geom');
      applyMjcfTransform(mesh, geomEl, angleScale, THREE);
      const geomScale = parseNumberList(geomEl.getAttribute('scale'), [1, 1, 1]);
      mesh.scale.set(
        asset.scale.x * (geomScale[0] ?? 1),
        asset.scale.y * (geomScale[1] ?? 1),
        asset.scale.z * (geomScale[2] ?? 1)
      );
      parent.add(mesh);
    }

    function addBody(parent, bodyEl) {
      const body = new THREE.Group();
      body.name = String(bodyEl.getAttribute('name') || 'body');
      applyMjcfTransform(body, bodyEl, angleScale, THREE);
      parent.add(body);
      for (const child of elementChildren(bodyEl)) {
        if (child.nodeName === 'geom') addGeom(body, child);
        else if (child.nodeName === 'body') addBody(body, child);
      }
    }

    const worldbody = elementChildren(document.documentElement, 'worldbody')[0];
    if (!worldbody) throw new Error('MJCF must include a <worldbody> element');
    for (const child of elementChildren(worldbody)) {
      if (child.nodeName === 'geom') addGeom(scene, child);
      else if (child.nodeName === 'body') addBody(scene, child);
    }
    if (!scene.children.length) throw new Error('Assembly contains no mesh geometry to export.');
    scene.updateMatrixWorld(true);
    for (const asset of meshAssets.values()) asset.geometry.dispose();
    return scene;
  }

  function sceneGeometryStats(scene) {
    const stats = { meshes: 0, triangles: 0, vertices: 0 };
    scene.traverse((child) => {
      if (!child.isMesh) return;
      const geometry = child.geometry;
      const position = geometry?.getAttribute?.('position');
      if (!position) return;
      const index = geometry.getIndex?.() || geometry.index || null;
      stats.meshes += 1;
      stats.vertices += position.count || 0;
      stats.triangles += index ? Math.floor((index.count || 0) / 3) : Math.floor((position.count || 0) / 3);
    });
    return stats;
  }

  function exportPayloadToBuffer(data, label) {
    if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') return Buffer.from(data, 'utf-8');
    throw new Error(`Unexpected ${label} exporter payload: ${Object.prototype.toString.call(data)}`);
  }

  async function exportAssemblyScene(sourcePath, outFile, format) {
    const scene = await buildAssemblyScene(sourcePath);
    try {
      scene.updateMatrixWorld(true);
      const stats = sceneGeometryStats(scene);
      if (stats.meshes <= 0 || stats.triangles <= 0) {
        throw new Error('Assembly export found no mesh triangles. Check asm.xml mesh/geom references and STL asset contents.');
      }
      deps.sendLog(`[${path.basename(path.dirname(sourcePath))}] Assembly export geometry: ${stats.meshes} meshes, ${stats.triangles} triangles.`);

      if (format === 'stl') {
        const { STLExporter } = await dynamicImport('three/examples/jsm/exporters/STLExporter.js');
        const data = new STLExporter().parse(scene, { binary: true });
        const buffer = exportPayloadToBuffer(data, 'STL');
        const expectedBinaryStlSize = 84 + stats.triangles * 50;
        if (buffer.byteLength !== expectedBinaryStlSize) {
          throw new Error(`STL export produced ${buffer.byteLength} bytes, expected ${expectedBinaryStlSize} bytes for ${stats.triangles} triangles.`);
        }
        fs.writeFileSync(outFile, buffer);
        const writtenSize = fs.statSync(outFile).size;
        if (writtenSize !== expectedBinaryStlSize) {
          throw new Error(`STL export wrote ${writtenSize} bytes, expected ${expectedBinaryStlSize} bytes.`);
        }
        return;
      }
      if (format === 'obj') {
        const { OBJExporter } = await dynamicImport('three/examples/jsm/exporters/OBJExporter.js');
        const objText = new OBJExporter().parse(scene);
        if (!/\nf\s+/.test(`\n${objText}`)) {
          throw new Error('OBJ export produced no faces.');
        }
        fs.writeFileSync(outFile, objText, 'utf-8');
        return;
      }
      throw new Error(`Assembly export supports STL/OBJ only, not ${format.toUpperCase()}.`);
    } finally {
      scene.traverse((child) => {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material?.dispose?.();
      });
    }
  }

  async function generateExportFile(partName, format, outFile, source = null, opts = {}) {
    const resolved = source || deps.resolveModelSource(state.currentProjectPath(), partName, state.currentKernel());
    if (!resolved) throw new Error(`Model does not exist: ${partName}`);

    if (resolved.kind === 'asm') {
      if (format === 'step') {
        throw new Error('MJCF assemblies can be exported as STL or OBJ only.');
      }
      if (format === 'stl' || format === 'obj') {
        await exportAssemblyScene(resolved.sourcePath, outFile, format);
        return;
      }
      throw new Error(`Unsupported export format: ${format}`);
    }

    if (format === 'step' || format === 'stl') {
      await runPythonExport(partName, partName, format, outFile, resolved.sourcePath);
      return;
    }
    if (format === 'obj') {
      const tmpStl = path.join(os.tmpdir(), `aicad-export-${partName}-${Date.now()}.stl`);
      try {
        await runPythonExport(partName, partName, 'stl', tmpStl, resolved.sourcePath);
        await convertStlToObj(tmpStl, outFile, 'obj');
      } finally {
        try {
          fs.unlinkSync(tmpStl);
        } catch {}
      }
      return;
    }
    throw new Error(`Unsupported export format: ${format}`);
  }

  async function ensurePartStlArtifact(modelName, partName) {
    const stlPath = deps.modelPartStlPath(state.currentProjectPath(), modelName, partName);
    await generateStlIfNeeded(modelName, partName, stlPath);
    return stlPath;
  }

  async function buildSceneFromStl(stlPath) {
    const THREE = require('three');
    const { STLLoader } = await dynamicImport('three/examples/jsm/loaders/STLLoader.js');
    const data = fs.readFileSync(stlPath);
    const geometry = new STLLoader().parse(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    );
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xb0b0b0 })
    );
    const scene = new THREE.Scene();
    scene.add(mesh);
    scene.updateMatrixWorld(true);
    return scene;
  }

  function disposeScene(scene) {
    scene.traverse((child) => {
      child.geometry?.dispose?.();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material?.dispose?.();
    });
  }

  async function exportSceneToGlb(scene) {
    ensureGltfExporterGlobals();
    const { GLTFExporter } = await dynamicImport('three/examples/jsm/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const data = await new Promise((resolve, reject) => {
      try {
        exporter.parse(
          scene,
          (result) => resolve(result),
          (err) => reject(err),
          { binary: true }
        );
      } catch (err) {
        reject(err);
      }
    });
    return exportPayloadToBuffer(data, 'GLB');
  }

  /**
   * Best-effort GLB generation for the share flow. Returns null on any failure.
   * - part / assembly (python): build the model-level STL, load it, export GLB.
   * - mjcf: rebuild the assembly scene (transforms applied), export GLB.
   */
  async function buildModelGlbBuffer(modelName, kind, source = null) {
    if (!state.currentProjectPath() || !modelName) return null;
    try {
      const startedAt = Date.now();
      const resolved =
        source || deps.resolveModelSource(state.currentProjectPath(), modelName, state.currentKernel());
      if (!resolved) {
        deps.sendLog(`[${modelName}] GLB skipped: model source not found.`, 'warn');
        return null;
      }

      if (kind === 'mjcf' || resolved.kind === 'asm') {
        const scene = await buildAssemblyScene(resolved.sourcePath);
        try {
          const buffer = await exportSceneToGlb(scene);
          deps.sendLog(`[${modelName}] GLB generated (${formatDuration(elapsedMs(startedAt))}).`);
          return buffer;
        } finally {
          disposeScene(scene);
        }
      }

      // part or build123d assembly: produce model-level STL then convert.
      const stlPath = path.join(
        os.tmpdir(),
        `aicad-share-${modelName}-${Date.now()}.stl`
      );
      try {
        await runPythonExport(modelName, modelName, 'stl', stlPath, resolved.sourcePath);
        const scene = await buildSceneFromStl(stlPath);
        try {
          const buffer = await exportSceneToGlb(scene);
          deps.sendLog(`[${modelName}] GLB generated (${formatDuration(elapsedMs(startedAt))}).`);
          return buffer;
        } finally {
          disposeScene(scene);
        }
      } finally {
        try { fs.unlinkSync(stlPath); } catch {}
      }
    } catch (err) {
      deps.sendLog(`[${modelName}] GLB generation failed: ${err?.message || err}`, 'warn');
      return null;
    }
  }

  async function exportPartByRequest(partName, format, opts = {}) {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const cleanPart = String(partName || '').trim();
    if (!cleanPart) throw new Error('Model name is required.');
    const source = deps.resolveModelSource(state.currentProjectPath(), cleanPart, state.currentKernel());
    if (!source) {
      throw new Error(`Model does not exist: ${cleanPart}`);
    }
    const fmt = ensureExportFormat(format);
    const ext = exportExt(fmt);
    const childPart = String(opts.partName || '').trim();
    if (fmt === 'step' && source.kind === 'asm' && !childPart) throw new Error('MJCF assemblies can be exported as STL or OBJ only.');
    const exportName = childPart || cleanPart;
    const saveRes = await dialog.showSaveDialog(state.mainWindow(), {
      title: `Export ${exportName} as ${fmt.toUpperCase()}`,
      defaultPath: path.join(deps.modelDir(state.currentProjectPath(), cleanPart), `${exportName}${ext}`),
      filters: [{ name: `${fmt.toUpperCase()} File`, extensions: [ext.replace(/^\./, '')] }]
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };

    deps.sendLog(`[${childPart ? `${cleanPart}/${childPart}` : cleanPart}] Exporting ${fmt.toUpperCase()}...`);
    if (childPart) {
      if (fmt === 'obj') {
        const stlPath = await ensurePartStlArtifact(cleanPart, childPart);
        await convertStlToObj(stlPath, saveRes.filePath, fmt);
      } else {
        await runPythonExport(cleanPart, childPart, fmt, saveRes.filePath);
      }
    } else {
      await generateExportFile(cleanPart, fmt, saveRes.filePath, source);
    }
    return { canceled: false, path: saveRes.filePath, format: fmt, part: exportName, model: cleanPart };
  }

  return {
    exportExt,
    ensureExportFormat,
    runCommandCollect,
    runPythonExport,
    convertStlToObj,
    generateExportFile,
    ensurePartStlArtifact,
    exportPartByRequest,
    buildModelGlbBuffer
  };
}

function initMainExportTools(mainContext) {
  const {
    electron,
    state,
    runtime,
    model,
    logging,
    constants
  } = mainContext;
  const dialog = electron?.dialog;
  if (!dialog) {
    throw new Error('Electron dialog API is required to initialize export tools.');
  }
  return createMainExportTools({
    dialog,
    state: {
      mainWindow: state.mainWindow,
      currentProjectPath: state.currentProjectPath,
      currentKernel: state.currentKernel
    },
    deps: {
      EXPORT_FORMATS: constants.EXPORT_FORMATS,
      detectBuildRuntime: runtime.detectBuildRuntime,
      missingRuntimeMessage: runtime.missingRuntimeMessage,
      buildRuntimeSpawn: runtime.buildRuntimeSpawn,
      modelDir: model.modelDir,
      modelPartSource: model.modelPartSource,
      modelPartParamsPath: model.modelPartParamsPath,
      modelPartStlPath: model.modelPartStlPath,
      partCache: model.partCache,
      modelCacheFile: model.modelCacheFile,
      resolveModelSource: model.resolveModelSource,
      sendLog: logging.sendLog
    }
  });
}

module.exports = {
  createMainExportTools,
  initMainExportTools
};
