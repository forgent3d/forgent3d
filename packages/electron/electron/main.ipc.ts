// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app: electronApp } = require('electron');
const bridgeTools = require('./agent-bridge-tools');
const { MODEL_EXAMPLES } = require('./model-examples');

/** Default Forgent3D agent (cad-agent) base URL when the desktop build is packaged. */
const PACKAGED_DEFAULT_FORGENT3D_AGENT_URL = 'https://agent.forgent3d.com';
const AGENT_DESKTOP_BRIDGE_VERSION = '0.1.0';
const MODEL_EXAMPLES_BY_ID = new Map((MODEL_EXAMPLES.examples || []).map((example) => [example.id, example]));
const DEFAULT_MODEL_EXAMPLE_ID = MODEL_EXAMPLES.defaultExampleId || 'mounting_plate';

function formatBridgeDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return '';
  }
}

function agentWebviewPreloadUrl() {
  return pathToFileURL(path.join(__dirname, 'agent-webview-preload.js')).toString();
}

function desktopAuthCallbackUrl(mcpPort) {
  if (electronApp?.isPackaged) return '';
  return `http://127.0.0.1:${mcpPort || 41234}/desktop-auth/callback`;
}

function safeTrashSegment(name) {
  return String(name || 'model')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'model';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFsError(error) {
  const code = error?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY';
}

function removeDirRecursive(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

function registerIpcHandlers({
  ipcMain,
  clipboard,
  dialog,
  shell,
  state,
  deps
}) {
  const {
    SCREENSHOT_VIEWS,
    CACHE_DIR
  } = deps.constants;

  function bridgeLog(message, detail, level = 'info') {
    const line = `[agent-bridge:main] ${message}${formatBridgeDetail(detail)}`;
    try { deps.sendLog?.(line, level); } catch {}
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  function writeTextViaTempFile(targetPath, content) {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, targetPath);
    } catch (e) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      throw e;
    }
  }

  function projectTrashTarget(projectPath, modelName) {
    const trashRoot = path.join(projectPath, CACHE_DIR, 'model-trash');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${safeTrashSegment(modelName)}-${stamp}`;
    let target = path.join(trashRoot, base);
    let suffix = 2;
    while (fs.existsSync(target)) {
      target = path.join(trashRoot, `${base}-${suffix++}`);
    }
    return { trashRoot, target };
  }

  async function moveModelToProjectTrash(projectPath, modelName, dir, { logSystemTrashFallback = false, systemTrashError = null } = {}) {
    const { trashRoot, target } = projectTrashTarget(projectPath, modelName);
    fs.mkdirSync(trashRoot, { recursive: true });

    let renameError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(dir, target);
        if (logSystemTrashFallback) {
          deps.sendLog?.(`System trash failed for model "${modelName}"; moved to ${path.relative(projectPath, target).replace(/\\/g, '/')}.`, 'warn');
        }
        return {
          mode: 'project-trash',
          path: target,
          error: systemTrashError?.message || (systemTrashError ? String(systemTrashError) : undefined)
        };
      } catch (error) {
        renameError = error;
        if (attempt < 2 && isRetryableFsError(error)) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        break;
      }
    }

    try {
      fs.cpSync(dir, target, { recursive: true, force: true });
      removeDirRecursive(dir);
      deps.sendLog?.(`Model "${modelName}" copied to ${path.relative(projectPath, target).replace(/\\/g, '/')} after rename retries.`, 'warn');
      return {
        mode: 'project-trash',
        path: target,
        error: [systemTrashError?.message || systemTrashError, renameError?.message || renameError].filter(Boolean).join('; ')
      };
    } catch (fallbackError) {
      const prefix = systemTrashError
        ? `System trash: ${systemTrashError?.message || systemTrashError}; `
        : '';
      throw new Error(`Failed to move model "${modelName}" to trash. ${prefix}project trash: ${renameError?.message || renameError}; copy/remove: ${fallbackError?.message || fallbackError}`);
    }
  }

  async function moveModelToTrash(projectPath, modelName, dir) {
    if (process.platform === 'win32') {
      return moveModelToProjectTrash(projectPath, modelName, dir);
    }

    let trashError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await shell.trashItem(dir);
        return { mode: 'system-trash' };
      } catch (error) {
        trashError = error;
        if (attempt < 1) await sleep(150);
      }
    }

    return moveModelToProjectTrash(projectPath, modelName, dir, {
      logSystemTrashFallback: true,
      systemTrashError: trashError
    });
  }

  function resolveParamsTarget(rawTarget) {
    const target = rawTarget && typeof rawTarget === 'object'
      ? rawTarget
      : { model: rawTarget };
    const modelName = String(target.model || target.name || state.activePart() || '').trim();
    const partName = target.part == null ? '' : String(target.part || '').trim();
    if (!modelName) throw new Error('Select a model first.');
    const source = deps.resolveModelSource(state.currentProjectPath(), modelName, state.currentKernel());
    if (!source) throw new Error(`Model does not exist: ${modelName}`);
    if (partName) {
      const partSource = deps.modelPartSource(state.currentProjectPath(), modelName, partName, state.currentKernel());
      if (!fs.existsSync(partSource)) {
        throw new Error(`Model part does not exist: models/${modelName}/parts/${partName}`);
      }
      return {
        model: modelName,
        part: partName,
        label: `${modelName}/parts/${partName}`,
        paramsPath: deps.modelPartParamsPath(state.currentProjectPath(), modelName, partName)
      };
    }
    return {
      model: modelName,
      part: null,
      label: modelName,
      paramsPath: deps.modelParamsPath(state.currentProjectPath(), modelName)
    };
  }

  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeText', (_evt, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  // Codex CLI's Ctrl+V image paste errors out when only text is on the clipboard,
  // so the renderer needs a synchronous-feeling probe to decide whether to forward
  // Ctrl+V to Codex (image present) or fall back to a plain text paste.
  ipcMain.handle('clipboard:hasImage', () => {
    try {
      const img = clipboard.readImage();
      return !!img && !img.isEmpty();
    } catch {
      return false;
    }
  });

  ipcMain.handle('mcp:status', () => deps.getMcpStatusPayload());
  ipcMain.handle('language:get', () => deps.getLanguage());
  ipcMain.handle('language:set', (_evt, language) => deps.setLanguage(language));

  /** Same data source as the MCP list_models tool, useful for UI validation. */
  ipcMain.handle('mcp:testListParts', () => deps.buildMcpContext().listParts());

  ipcMain.handle('dialog:confirm', async (_evt, { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel' }) => {
    const { response } = await dialog.showMessageBox(state.mainWindow(), {
      type: 'warning',
      buttons: [cancelLabel, confirmLabel],
      defaultId: 1,
      cancelId: 0,
      title: String(title || ''),
      message: String(message || ''),
    });
    return response === 1;
  });

  ipcMain.handle('dialog:chooseDirectory', async () => {
    const res = await dialog.showOpenDialog(state.mainWindow(), {
      title: 'Choose a parent directory for the new project',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('project:create', async (_evt, { parentDir, projectName, kernel }) => {
    if (!parentDir || !projectName) throw new Error('parentDir and projectName are required.');
    const k = deps.assertKernel(kernel);
    const projectPath = path.join(parentDir, projectName);
    if (fs.existsSync(projectPath)) throw new Error(`Project path already exists: ${projectPath}`);
    fs.mkdirSync(projectPath, { recursive: true });
    deps.initProjectLayout(projectPath, k);
    await deps.openProject(projectPath, { runImmediately: true });
    return projectPath;
  });

  ipcMain.handle('project:open', async (_evt, projectPath) => {
    if (!projectPath) {
      return deps.openProjectByDialog();
    }
    if (!fs.existsSync(projectPath)) throw new Error(`Path does not exist: ${projectPath}`);
    await deps.openProject(projectPath, { runImmediately: true });
    return projectPath;
  });

  ipcMain.handle('project:meta', () => {
    if (!state.currentProjectPath()) return null;
    const meta = deps.kernelMeta(state.currentKernel());
    return {
      path: state.currentProjectPath(),
      kernel: state.currentKernel(),
      kernelLabel: meta.label,
      sourceFile: meta.sourceFile,
      sourceFiles: Object.values(deps.sourceFileOptions(state.currentKernel())),
      previewFormat: meta.previewFormat,
      runner: meta.runner,
      kernels: deps.KERNELS.map((k) => ({ id: k, ...deps.kernelMeta(k) }))
    };
  });

  ipcMain.handle('project:rebuild', async () => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    if (state.activePart()) deps.scheduleBuild(state.activePart());
    return true;
  });

  ipcMain.handle('project:revealInFolder', async () => {
    if (!state.currentProjectPath()) return;
    shell.openPath(state.currentProjectPath());
  });

  ipcMain.handle('models:list', async () => {
    if (!state.currentProjectPath()) return { models: [], active: null };
    return { models: deps.listParts(state.currentProjectPath()), active: state.activePart() };
  });

  ipcMain.handle('models:select', async (_evt, name) => {
    if (!state.currentProjectPath()) return;
    await deps.selectPart(name);
    return state.activePart();
  });

  ipcMain.handle('models:create', async (_evt, payload) => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const request = payload && typeof payload === 'object' ? payload : {};
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    const finiteNumber = (key, fallback, min = 0.001) => {
      const value = Number(params[key]);
      return Number.isFinite(value) && value >= min ? value : fallback;
    };
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const template = MODEL_EXAMPLES_BY_ID.has(String(request.template))
      ? String(request.template)
      : DEFAULT_MODEL_EXAMPLE_ID;
    const example = MODEL_EXAMPLES_BY_ID.get(template) || MODEL_EXAMPLES_BY_ID.get(DEFAULT_MODEL_EXAMPLE_ID);
    const singlePartTemplates = new Set((MODEL_EXAMPLES.examples || [])
      .filter((entry) => entry.kind === 'single_part')
      .map((entry) => entry.id));
    const createSinglePart = (partName, partParams, description) => deps.createModelPackage(
      state.currentProjectPath(),
      state.currentKernel(),
      request.name,
      request.description,
      {
        partNames: [partName],
        partDescriptions: {
          [partName]: request.description || description
        },
        partTemplates: {
          [partName]: template
        },
        partParams: {
          [partName]: partParams
        }
      }
    );

    let result;
    if (singlePartTemplates.has(template)) {
      if (template === 'l_bracket') {
        const partName = example?.partName || template;
        const length = finiteNumber('length', 64);
        const height = finiteNumber('height', 48);
        const width = finiteNumber('width', 32);
        const thickness = clamp(finiteNumber('thickness', 5), 1, Math.min(length, height, width) / 2);
        result = createSinglePart(partName, {
          length,
          height,
          width,
          thickness,
          hole_diameter: clamp(finiteNumber('hole_diameter', 5), 1, Math.max(1, width - 4)),
          hole_offset: clamp(finiteNumber('hole_offset', 18), thickness + 3, Math.max(thickness + 3, length / 2 - 4)),
          edge_fillet: Math.min(1.2, Math.max(0.2, thickness * 0.14))
        }, example?.defaultDescription || 'Parametric L bracket with bolt holes on both legs.');
      } else if (template === 'bearing_block') {
        const partName = example?.partName || template;
        const length = finiteNumber('length', 72);
        const width = finiteNumber('width', 34);
        const height = finiteNumber('height', 42);
        const baseThickness = clamp(Math.max(6, height * 0.22), 3, height * 0.5);
        result = createSinglePart(partName, {
          length,
          width,
          height,
          bore_diameter: clamp(finiteNumber('bore_diameter', 16), 2, Math.max(2, Math.min(width, height) - 6)),
          mount_hole_spacing: clamp(finiteNumber('mount_hole_spacing', 52), 8, Math.max(8, length - 12)),
          mount_hole_diameter: clamp(finiteNumber('mount_hole_diameter', 5), 1, Math.max(1, width - 6)),
          base_thickness: baseThickness,
          edge_fillet: Math.min(1.2, Math.max(0.2, baseThickness * 0.12))
        }, example?.defaultDescription || 'Parametric bearing block with shaft bore and base mounting holes.');
      } else if (template === 'gear') {
        const partName = example?.partName || template;
        const pitchRadius = finiteNumber('pitch_radius', 28);
        const thickness = finiteNumber('thickness', 8);
        const toothDepth = finiteNumber('tooth_depth', 3);
        result = createSinglePart(partName, {
          teeth: Math.round(clamp(finiteNumber('teeth', 24), 8, 96)),
          pitch_radius: pitchRadius,
          thickness,
          bore_diameter: clamp(finiteNumber('bore_diameter', 8), 1, Math.max(1, pitchRadius * 1.2)),
          hub_diameter: clamp(finiteNumber('hub_diameter', 22), 4, Math.max(4, pitchRadius * 1.6)),
          tooth_depth: toothDepth
        }, example?.defaultDescription || 'Parametric spur gear blank with editable teeth and bore.');
      } else {
        const partName = example?.partName || template;
        const diameter = finiteNumber('diameter', 36);
        const height = finiteNumber('height', 18);
        result = createSinglePart(partName, {
          diameter,
          height,
          bore_diameter: clamp(finiteNumber('bore_diameter', 6), 1, Math.max(1, diameter - 6)),
          groove_count: Math.round(clamp(finiteNumber('groove_count', 18), 6, 64)),
          groove_depth: clamp(finiteNumber('groove_depth', 1.6), 0.1, Math.max(0.1, diameter / 6)),
          top_chamfer: clamp(finiteNumber('top_chamfer', 0.6, 0), 0, Math.max(0, height / 3))
        }, example?.defaultDescription || 'Parametric control knob with grip grooves and center bore.');
      }
      await deps.selectPart(result.name);
      return result;
    }

    const length = finiteNumber('length', 72);
    const width = finiteNumber('width', 44);
    const thickness = finiteNumber('thickness', 6);
    const holeSpacingX = clamp(finiteNumber('hole_spacing_x', Math.max(12, length - 20)), 8, Math.max(8, length - 12));
    const holeSpacingY = clamp(finiteNumber('hole_spacing_y', Math.max(12, width - 16)), 8, Math.max(8, width - 12));
    const cornerRadius = clamp(finiteNumber('corner_radius', 5, 0), 0, Math.max(0, Math.min(length, width) / 2 - 1));
    const edgeFillet = Math.min(1.2, Math.max(0.2, thickness * 0.14));
    const screwLength = Math.max(10, thickness + 10);
    result = deps.createModelPackage(
      state.currentProjectPath(),
      state.currentKernel(),
      request.name,
      request.description,
      {
        template,
        partNames: ['mounting_plate', 'fastener_stack'],
        partDescriptions: {
          mounting_plate: request.description || 'Parametric mounting plate with four standard clearance holes.',
          fastener_stack: 'Visible screw and washer stack for scale and assembly review.'
        },
        partTemplates: {
          fastener_stack: 'fastener_stack'
        },
        rootParams: {
          fastener_spacing_x: holeSpacingX,
          fastener_spacing_y: holeSpacingY,
          fastener_z: thickness + 0.2
        },
        partParams: {
          mounting_plate: {
            length,
            width,
            thickness,
            corner_radius: cornerRadius,
            hole_spacing_x: holeSpacingX,
            hole_spacing_y: holeSpacingY,
            edge_fillet: edgeFillet,
            screw_length: screwLength
          },
          fastener_stack: {
            screw_length: screwLength
          }
        }
      }
    );
    await deps.selectPart(result.name);
    return result;
  });

  ipcMain.handle('models:rebuild', async (_evt, name) => {
    const target = name || state.activePart();
    if (target) deps.scheduleBuild(target, { force: true });
    return true;
  });

  ipcMain.handle('models:rebuildAll', async () => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const projectPath = state.currentProjectPath();
    const kernel = state.currentKernel();
    const models = deps.listParts(projectPath);
    const tryUnlink = (p) => {
      if (!p) return;
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    };
    for (const model of models) {
      for (const view of SCREENSHOT_VIEWS) {
        tryUnlink(deps.partPng(projectPath, model.name, view, 'solid'));
        tryUnlink(deps.partPng(projectPath, model.name, view, 'xray'));
      }
      for (const part of (model.parts || [])) {
        tryUnlink(deps.partCache(projectPath, model.name, part.name, kernel));
        tryUnlink(deps.modelPartStlPath(projectPath, model.name, part.name));
      }
    }
    const ctx = deps.buildMcpContext();
    const results = [];
    for (const model of models) {
      const result = await ctx.rebuildPartSync(model.name);
      results.push({ name: model.name, ok: result?.ok ?? false, error: result?.error });
    }
    return { ok: results.every((r) => r.ok), results };
  });

  ipcMain.handle('models:reveal', async (_evt, name) => {
    if (!state.currentProjectPath() || !name) return;
    shell.openPath(deps.modelDir(state.currentProjectPath(), name));
  });

  ipcMain.handle('models:delete', async (_evt, name) => {
    if (!state.currentProjectPath() || !name) throw new Error('No project or model name.');
    const projectPath = state.currentProjectPath();
    const modelName = String(name);
    const wasActive = state.activePart() === modelName;
    const dir = deps.modelDir(state.currentProjectPath(), name);
    if (!fs.existsSync(dir)) throw new Error(`Model does not exist: ${modelName}`);
    const deletedModel = deps.listParts(projectPath).find((model) => model.name === modelName);
    await deps.prepareModelDeletion?.(modelName);
    await deps.ensureProjectDirectoryAccess?.(projectPath);
    await moveModelToTrash(projectPath, modelName, dir);
    const kernel = state.currentKernel();
    const tryUnlink = (p) => {
      if (!p) return;
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    };
    for (const view of SCREENSHOT_VIEWS) {
      tryUnlink(deps.partPng(projectPath, modelName, view, 'solid'));
      tryUnlink(deps.partPng(projectPath, modelName, view, 'xray'));
    }
    for (const part of (deletedModel?.parts || [])) {
      tryUnlink(deps.partCache(projectPath, modelName, part.name, kernel));
      tryUnlink(deps.modelPartStlPath(projectPath, modelName, part.name));
    }
    tryUnlink(deps.partCache(projectPath, modelName, modelName, kernel));
    const remaining = deps.listParts(projectPath).filter((model) => model.name !== modelName);
    if (wasActive) {
      const nextModel = remaining[0]?.name || null;
      if (nextModel) {
        await deps.selectPart(nextModel);
      } else {
        state.setActivePart?.(null);
        deps.broadcastPartsList?.();
      }
    } else {
      deps.broadcastPartsList?.();
    }
  });

  ipcMain.handle('models:export', async (_evt, { name, format, part }) => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const partName = String(name || state.activePart() || '').trim();
    if (!partName) throw new Error('Select a model first.');
    return deps.exportPartByRequest(partName, format, { partName: part });
  });

  ipcMain.handle('models:partStl', async (_evt, { model, part }) => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const modelName = String(model || '').trim();
    const partName = String(part || '').trim();
    if (!modelName || !partName) throw new Error('Model and part names are required.');
    const source = deps.resolveModelSource(state.currentProjectPath(), modelName, state.currentKernel());
    if (!source) throw new Error(`Model does not exist: ${modelName}`);
    const stlPath = await deps.ensurePartStlArtifact(modelName, partName);
    const rel = path.relative(state.currentProjectPath(), stlPath).replace(/\\/g, '/');
    const url = `aicad://asset/${rel.split('/').map((segment) => encodeURIComponent(segment)).join('/')}?t=${Date.now()}`;
    return { model: modelName, part: partName, path: stlPath, url };
  });

  ipcMain.handle('params:get', async (_evt, target) => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const resolved = resolveParamsTarget(target);
    const paramsPath = resolved.paramsPath;
    if (!fs.existsSync(paramsPath)) {
      return { model: resolved.model, part: resolved.part, label: resolved.label, exists: false, text: '{}\n' };
    }
    const text = fs.readFileSync(paramsPath, 'utf-8');
    return { model: resolved.model, part: resolved.part, label: resolved.label, exists: true, text };
  });

  ipcMain.handle('params:save', async (_evt, { name, target, text }) => {
    if (!state.currentProjectPath()) throw new Error('Open a project first.');
    const resolved = resolveParamsTarget(target ?? name);
    let parsed;
    try {
      parsed = JSON.parse(String(text ?? ''));
    } catch (e) {
      throw new Error(`params.json is invalid JSON: ${e.message}`);
    }
    const formatted = JSON.stringify(parsed, null, 2) + '\n';
    writeTextViaTempFile(resolved.paramsPath, formatted);
    deps.scheduleBuild(resolved.model, { force: true });
    return { model: resolved.model, part: resolved.part, label: resolved.label, text: formatted };
  });

  ipcMain.handle('viewer:partLoaded', async (_evt, payload) => {
    if (!state.currentProjectPath() || !payload?.part) return;
    const { part, faceCount, bbox, faces, snapshotDataURL, snapshotDataURLs } = payload;
    state.partInfoCache().set(part, {
      faceCount, bbox, faces,
      capturedAt: Date.now()
    });
    const snapshots = snapshotDataURLs && typeof snapshotDataURLs === 'object'
      ? snapshotDataURLs
      : { iso: snapshotDataURL };
    const snapshotsByMode = snapshots?.solid || snapshots?.xray
      ? snapshots
      : { solid: snapshots };
    for (const mode of ['solid', 'xray']) {
      const modeSnapshots = snapshotsByMode?.[mode];
      if (!modeSnapshots || typeof modeSnapshots !== 'object') continue;
      for (const view of SCREENSHOT_VIEWS) {
        const dataUrl = modeSnapshots?.[view];
        if (typeof dataUrl !== 'string') continue;
        const m = /^data:image\/[a-zA-Z]+;base64,(.*)$/.exec(dataUrl);
        if (!m) continue;
        try {
          fs.mkdirSync(path.join(state.currentProjectPath(), CACHE_DIR), { recursive: true });
          fs.writeFileSync(deps.partPng(state.currentProjectPath(), part, view, mode), Buffer.from(m[1], 'base64'));
        } catch (e) {
          deps.sendLog(`Failed to write screenshot cache (${mode}/${view}): ${e.message}`, 'warn');
        }
        if (mode === 'solid' && view === 'iso') {
          try {
            fs.writeFileSync(deps.partPng(state.currentProjectPath(), part), Buffer.from(m[1], 'base64'));
          } catch (e) {
            deps.sendLog(`Failed to write screenshot cache (legacy iso): ${e.message}`, 'warn');
          }
        }
      }
    }
    deps.resolvePartLoadedWaiters(part, {
      part,
      faceCount,
      capturedAt: Date.now()
    });
  });

  ipcMain.handle('python:status', async () => deps.getBuildRuntimeStatus());

  ipcMain.handle('agent:bridgeInfo', () => {
    const projectPath = state.currentProjectPath?.() || '';
    const language = deps.getLanguage?.() || 'en';
    bridgeLog('bridgeInfo requested', { projectPath, language });
    return {
      version: AGENT_DESKTOP_BRIDGE_VERSION,
      preloadUrl: agentWebviewPreloadUrl(),
      desktopCallbackUrl: desktopAuthCallbackUrl(deps.constants?.MCP_PORT),
      projectPath,
      language,
      capabilities: {
        desktop: true,
        tools: true,
        desktopPython: true
      }
    };
  });

  ipcMain.handle('agent:callTool', async (_evt, payload) => {
    const name = String(payload?.name || '').trim();
    const callId = String(payload?.callId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const startedAt = Date.now();
    if (!name) {
      bridgeLog('callTool missing tool name', { callId }, 'warn');
      return { isError: true, content: [{ type: 'text', text: 'Tool name is required.' }] };
    }
    const rawArgs = payload?.args;
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const projectPath = state.currentProjectPath?.() || '';
    bridgeLog('callTool received', {
      callId,
      name,
      projectPath,
      argKeys: args && typeof args === 'object' ? Object.keys(args || {}) : [],
      argType: typeof args
    });
    let mcpContext = null;
    try {
      bridgeLog('buildMcpContext start', { callId, name });
      mcpContext = deps.buildMcpContext ? deps.buildMcpContext() : null;
      bridgeLog('buildMcpContext done', { callId, name, elapsedMs: Date.now() - startedAt, hasMcpContext: !!mcpContext });
    } catch (e) {
      deps.sendLog?.(`buildMcpContext failed: ${e?.message || e}`, 'warn');
      bridgeLog('buildMcpContext failed', { callId, name, error: e?.message || String(e) }, 'warn');
    }
    try {
      bridgeLog('dispatch start', { callId, name });
      const result = await bridgeTools.dispatch(name, args, {
        projectPath,
        mcpContext,
        log: (message, detail, level) => bridgeLog(message, { callId, name, ...(detail || {}) }, level)
      });
      bridgeLog('dispatch done', {
        callId,
        name,
        elapsedMs: Date.now() - startedAt,
        isError: !!result?.isError,
        contentTypes: Array.isArray(result?.content) ? result.content.map((item) => item?.type) : []
      }, result?.isError ? 'warn' : 'info');
      return result;
    } catch (e) {
      bridgeLog('dispatch threw', { callId, name, elapsedMs: Date.now() - startedAt, error: e?.message || String(e) }, 'error');
      return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
    }
  });

  ipcMain.handle('agent:openNext', async (_evt, { projectPath, baseUrl, openExternal = true }) => {
    if (!projectPath) throw new Error('projectPath is required.');
    const resolved = path.resolve(String(projectPath).trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Project path does not exist: ${resolved}`);
    }
    const rawBase = String(
      baseUrl ||
        process.env.AICAD_FORGENT3D_URL ||
        process.env.AICAD_NEXT_AGENT_URL ||
        process.env.CAD_AGENT_URL ||
        (electronApp?.isPackaged ? PACKAGED_DEFAULT_FORGENT3D_AGENT_URL : 'http://localhost:3000')
    ).trim();
    const base = new URL(rawBase.replace(/\/+$/, '') + '/');
    // Prefer localhost for the embedded Forgent3D webview. In dev the Electron
    // renderer is served from http://localhost:7788, and using 127.0.0.1 for
    // the agent origin can make Auth.js CSRF cookies look cross-site during credential
    // POSTs.
    if (base.hostname === '127.0.0.1') base.hostname = 'localhost';
    const url = new URL(openExternal === false ? '/agent' : '/desktop-auth/start', base);
    if (!/^https?:$/i.test(url.protocol)) {
      throw new Error(`Unsupported Forgent3D URL protocol: ${url.protocol}`);
    }
    url.searchParams.set('projectPath', resolved);
    url.searchParams.set('lang', deps.getLanguage?.() || 'en');
    const callbackUrl = desktopAuthCallbackUrl(deps.constants?.MCP_PORT);
    if (callbackUrl) url.searchParams.set('desktopCallbackUrl', callbackUrl);
    if (openExternal === false) {
      url.searchParams.set('embedded', '1');
    }
    if (openExternal !== false) {
      await shell.openExternal(url.toString());
    }
    return {
      url: url.toString(),
      preloadUrl: agentWebviewPreloadUrl(),
      desktopCallbackUrl: callbackUrl
    };
  });
}

module.exports = {
  registerIpcHandlers
};
