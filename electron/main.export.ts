// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DOMParser } = require('@xmldom/xmldom');
const dynamicImport = new Function('specifier', 'return import(specifier)');

function createMainExportTools({ dialog, state, deps }) {
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

  async function runPythonExport(partName, format, outFile) {
    const runtime = await deps.detectBuildRuntime(state.currentKernel());
    if (!runtime) throw new Error(deps.missingRuntimeMessage(state.currentKernel()));
    const cmd = deps.buildRuntimeSpawn(runtime, [
      '--project',
      state.currentProjectPath(),
      '--model',
      partName,
      '--export-format',
      format,
      '--output',
      outFile
    ]);
    const ret = await runCommandCollect(cmd.cmd, cmd.args, {
      cwd: state.currentProjectPath(),
      shell: false,
      windowsHide: true
    });
    if (ret.code !== 0) {
      throw new Error((ret.stderr || ret.stdout || `Python export failed with exit code ${ret.code}`).trim());
    }
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
    return String(text || '').replace(/<!--[\s\S]*?-->|(\$\{([^}]+)\})/g, (match, expr, rawKey) => {
      if (!expr) return match;
      return escapeAttr(formatValue(getPath(String(rawKey || '').trim())));
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
    const document = parser.parseFromString(readAssemblyText(sourcePath), 'application/xml');
    const root = document?.documentElement;
    if (errors.length || !root) throw new Error(`MJCF XML parse failed: ${errors[0] || 'empty document'}`);
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
    const projectRoot = path.resolve(state.currentProjectPath());
    if (abs !== projectRoot && !abs.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`MJCF mesh path escapes project root: ${raw}`);
    }
    if (path.extname(abs).toLowerCase() !== '.stl') throw new Error(`Assembly export supports STL mesh assets only: ${raw}`);
    return abs;
  }

  async function buildAssemblyScene(sourcePath) {
    const THREE = require('three');
    const { STLLoader } = await dynamicImport('three/examples/jsm/loaders/STLLoader.js');
    const document = parseAssemblyDocument(sourcePath);
    const angleScale = compilerAngleScale(document);
    const scene = new THREE.Scene();
    const meshAssets = new Map();

    for (const meshEl of Array.from(document.getElementsByTagName('mesh'))) {
      const name = String(meshEl.getAttribute('name') || '').trim();
      const file = String(meshEl.getAttribute('file') || '').trim();
      if (!name || !file) continue;
      const meshPath = resolveAssemblyMeshPath(sourcePath, file);
      const partName = path.basename(meshPath, path.extname(meshPath));
      if (!fs.existsSync(meshPath)) {
        deps.sendLog(`[${path.basename(path.dirname(sourcePath))}] Building missing assembly mesh asset: ${path.relative(state.currentProjectPath(), meshPath).replace(/\\/g, '/')}`);
        await ensurePartStlArtifact(partName);
      }
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

  async function exportAssemblyScene(sourcePath, outFile, format) {
    const scene = await buildAssemblyScene(sourcePath);
    try {
      if (format === 'stl') {
        const { STLExporter } = await dynamicImport('three/examples/jsm/exporters/STLExporter.js');
        const data = new STLExporter().parse(scene, { binary: true });
        fs.writeFileSync(outFile, Buffer.from(data));
        return;
      }
      if (format === 'obj') {
        const { OBJExporter } = await dynamicImport('three/examples/jsm/exporters/OBJExporter.js');
        fs.writeFileSync(outFile, new OBJExporter().parse(scene), 'utf-8');
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

  async function generateExportFile(partName, format, outFile, source = null) {
    if (source?.kind === 'asm') {
      await exportAssemblyScene(source.sourcePath, outFile, format);
      return;
    }
    if (format === 'step') {
      await runPythonExport(partName, 'step', outFile);
      return;
    }
    if (format === 'stl') {
      await runPythonExport(partName, 'stl', outFile);
      return;
    }

    const tmpStl = path.join(os.tmpdir(), `aicad-export-${partName}-${Date.now()}.stl`);
    try {
      await runPythonExport(partName, 'stl', tmpStl);
      await convertStlToObj(tmpStl, outFile, format);
    } finally {
      try { fs.unlinkSync(tmpStl); } catch {}
    }
  }

  async function ensurePartStlArtifact(partName) {
    const stlPath = path.join(deps.modelDir(state.currentProjectPath(), partName), `${partName}.stl`);
    await runPythonExport(partName, 'stl', stlPath);
    return stlPath;
  }

  async function buildStlForModel(modelName, outputPath = null) {
    if (!state.currentProjectPath()) throw new Error('No project is open in the preview app.');
    const clean = String(modelName || '').trim();
    if (!clean) throw new Error('Model name is required.');
    const source = deps.resolveModelSource(state.currentProjectPath(), clean, state.currentKernel());
    if (!source) throw new Error(`Model does not exist: ${clean}`);
    if (source.kind === 'asm') {
      throw new Error('build_stl currently supports part models only.');
    }
    const outFile = outputPath
      ? path.resolve(state.currentProjectPath(), String(outputPath))
      : path.join(deps.modelDir(state.currentProjectPath(), clean), `${clean}.stl`);
    const root = path.resolve(state.currentProjectPath());
    const normalizedOut = path.resolve(outFile);
    if (normalizedOut !== root && !normalizedOut.startsWith(`${root}${path.sep}`)) {
      throw new Error('Output path must stay inside the current project.');
    }
    fs.mkdirSync(path.dirname(normalizedOut), { recursive: true });
    await generateExportFile(clean, 'stl', normalizedOut, source);
    const size = fs.existsSync(normalizedOut) ? fs.statSync(normalizedOut).size : 0;
    return {
      ok: true,
      model: clean,
      format: 'stl',
      path: normalizedOut,
      relativePath: path.relative(state.currentProjectPath(), normalizedOut).replace(/\\/g, '/'),
      size
    };
  }

  async function exportPartByRequest(partName, format) {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const cleanPart = String(partName || '').trim();
    if (!cleanPart) throw new Error('Model name is required.');
    const source = deps.resolveModelSource(state.currentProjectPath(), cleanPart, state.currentKernel());
    if (!source) {
      throw new Error(`Model does not exist: ${cleanPart}`);
    }
    if (source.kind === 'asm' && !['stl', 'obj'].includes(String(format || '').toLowerCase())) {
      throw new Error('Assembly MJCF models can be exported as STL or OBJ only.');
    }

    const fmt = ensureExportFormat(format);
    const ext = exportExt(fmt);
    if (source.kind === 'asm' && fmt === 'step') {
      throw new Error('Assembly MJCF models can be exported as STL or OBJ only.');
    }
    const saveRes = await dialog.showSaveDialog(state.mainWindow(), {
      title: `Export ${cleanPart} as ${fmt.toUpperCase()}`,
      defaultPath: path.join(deps.modelDir(state.currentProjectPath(), cleanPart), `${cleanPart}${ext}`),
      filters: [{ name: `${fmt.toUpperCase()} File`, extensions: [ext.replace(/^\./, '')] }]
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };

    deps.sendLog(`[${cleanPart}] Exporting ${fmt.toUpperCase()}...`);
    await generateExportFile(cleanPart, fmt, saveRes.filePath, source);
    return { canceled: false, path: saveRes.filePath, format: fmt, part: cleanPart };
  }

  return {
    exportExt,
    ensureExportFormat,
    runCommandCollect,
    runPythonExport,
    convertStlToObj,
    generateExportFile,
    ensurePartStlArtifact,
    buildStlForModel,
    exportPartByRequest
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
      resolveModelSource: model.resolveModelSource,
      sendLog: logging.sendLog
    }
  });
}

module.exports = {
  createMainExportTools,
  initMainExportTools
};
