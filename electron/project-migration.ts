// @ts-nocheck
export {};
'use strict';

const fs = require('fs');
const path = require('path');

function isDirectory(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function sameFileBytes(a, b) {
  try {
    const left = fs.readFileSync(a);
    const right = fs.readFileSync(b);
    return left.length === right.length && left.equals(right);
  } catch {
    return false;
  }
}

function mergeMove(source, target) {
  if (!fs.existsSync(source)) return;
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return;
  }

  const sourceStat = fs.statSync(source);
  const targetStat = fs.statSync(target);
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      mergeMove(path.join(source, entry.name), path.join(target, entry.name));
    }
    if (fs.readdirSync(source).length === 0) fs.rmdirSync(source);
    return;
  }

  if (sourceStat.isFile() && targetStat.isFile() && sameFileBytes(source, target)) {
    fs.unlinkSync(source);
    return;
  }

  throw new Error(`Migration conflict: "${target}" already exists with different content.`);
}

function removeEmptyDirsUpTo(dir, stopDir) {
  let current = dir;
  const stop = path.resolve(stopDir);
  while (path.resolve(current).startsWith(stop)) {
    if (!isDirectory(current) || fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    if (path.resolve(current) === stop) return;
    current = path.dirname(current);
  }
}

function rewriteAssemblyReferences(projectPath, partNames, sendLog) {
  const assembliesRoot = path.join(projectPath, 'assemblies');
  if (!isDirectory(assembliesRoot) || partNames.length === 0) return 0;

  let changedFiles = 0;
  const files = [];
  for (const assembly of fs.readdirSync(assembliesRoot, { withFileTypes: true })) {
    if (!assembly.isDirectory()) continue;
    for (const fileName of ['asm.xml', 'params.json']) {
      const filePath = path.join(assembliesRoot, assembly.name, fileName);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) files.push(filePath);
    }
  }

  for (const filePath of files) {
    let text = fs.readFileSync(filePath, 'utf-8');
    const before = text;
    for (const partName of partNames) {
      const escaped = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const oldFlatRef = new RegExp(`\\.\\./${escaped}/${escaped}\\.stl`, 'g');
      text = text.replace(oldFlatRef, `../../parts/${partName}/${partName}.stl`);

      const oldProjectRef = new RegExp(`models/${escaped}/${escaped}\\.stl`, 'g');
      text = text.replace(oldProjectRef, `parts/${partName}/${partName}.stl`);
    }
    if (text !== before) {
      fs.writeFileSync(filePath, text, 'utf-8');
      changedFiles += 1;
      sendLog(`Migrated assembly mesh references: ${path.relative(projectPath, filePath).replace(/\\/g, '/')}`);
    }
  }
  return changedFiles;
}

function collectLegacyEntries(projectPath) {
  const legacyRoot = path.join(projectPath, 'models');
  if (!isDirectory(legacyRoot)) return [];
  const entries = [];

  const nested = [
    { kind: 'part', root: path.join(legacyRoot, 'parts') },
    { kind: 'asm', root: path.join(legacyRoot, 'assemblies') }
  ];
  for (const group of nested) {
    if (!isDirectory(group.root)) continue;
    for (const child of fs.readdirSync(group.root, { withFileTypes: true })) {
      if (child.isDirectory()) entries.push({ kind: group.kind, name: child.name, sourceDir: path.join(group.root, child.name) });
    }
  }

  for (const child of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === 'parts' || child.name === 'assemblies') continue;
    const sourceDir = path.join(legacyRoot, child.name);
    const hasPart = fs.existsSync(path.join(sourceDir, 'part.py'));
    const hasAsm = fs.existsSync(path.join(sourceDir, 'asm.xml'));
    if (hasPart) entries.push({ kind: 'part', name: child.name, sourceDir });
    if (hasAsm) entries.push({ kind: 'asm', name: child.name, sourceDir });
  }

  return entries;
}

function migrateLegacyModelsLayout(projectPath, { sendLog = () => {} } = {}) {
  const legacyRoot = path.join(projectPath, 'models');
  if (!isDirectory(legacyRoot)) return { migrated: false, moved: 0, rewritten: 0 };

  const entries = collectLegacyEntries(projectPath);
  if (entries.length === 0) return { migrated: false, moved: 0, rewritten: 0 };

  const movedParts = new Set();
  let moved = 0;
  for (const entry of entries) {
    const targetRoot = entry.kind === 'asm' ? 'assemblies' : 'parts';
    const targetDir = path.join(projectPath, targetRoot, entry.name);
    mergeMove(entry.sourceDir, targetDir);
    moved += 1;
    if (entry.kind === 'part') movedParts.add(entry.name);
    sendLog(`Migrated model: ${path.relative(projectPath, targetDir).replace(/\\/g, '/')}`);
  }

  const rewritten = rewriteAssemblyReferences(projectPath, Array.from(movedParts), sendLog);
  removeEmptyDirsUpTo(path.join(legacyRoot, 'parts'), legacyRoot);
  removeEmptyDirsUpTo(path.join(legacyRoot, 'assemblies'), legacyRoot);
  removeEmptyDirsUpTo(legacyRoot, legacyRoot);
  return { migrated: true, moved, rewritten };
}

module.exports = {
  migrateLegacyModelsLayout
};
