'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
      import('three/examples/jsm/loaders/STLLoader.js'),
      import('three/examples/jsm/exporters/OBJExporter.js')
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

  async function generateExportFile(partName, format, outFile) {
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
    await generateExportFile(clean, 'stl', normalizedOut);
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
    if (source.kind === 'asm') {
      throw new Error('Assembly XACRO models do not support direct export from this menu yet.');
    }

    const fmt = ensureExportFormat(format);
    const ext = exportExt(fmt);
    const saveRes = await dialog.showSaveDialog(state.mainWindow(), {
      title: `Export ${cleanPart} as ${fmt.toUpperCase()}`,
      defaultPath: path.join(deps.modelDir(state.currentProjectPath(), cleanPart), `${cleanPart}${ext}`),
      filters: [{ name: `${fmt.toUpperCase()} File`, extensions: [ext.replace(/^\./, '')] }]
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };

    deps.sendLog(`[${cleanPart}] Exporting ${fmt.toUpperCase()}...`);
    await generateExportFile(cleanPart, fmt, saveRes.filePath);
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
    dialog,
    state,
    runtime,
    model,
    logging,
    constants
  } = mainContext;
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
