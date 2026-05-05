// @ts-nocheck
import * as THREE from 'three';
import { VIEWER_BACKGROUND_COLOR } from './viewer-materials.js';

const SNAPSHOT_VIEWS = {
  iso: {
    dir: new THREE.Vector3(1, 0.85, 1).normalize(),
    up: new THREE.Vector3(0, 1, 0)
  },
  front: {
    dir: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0)
  },
  side: {
    dir: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0)
  },
  top: {
    dir: new THREE.Vector3(0, 1, 0.02).normalize(),
    up: new THREE.Vector3(0, 0, -1)
  }
};

function buildViewBasis(dir, upHint) {
  const forward = dir.clone().normalize();
  let up = (upHint || new THREE.Vector3(0, 1, 0)).clone().normalize();
  let right = new THREE.Vector3().crossVectors(forward, up);
  if (right.lengthSq() < 1e-8) {
    up = Math.abs(forward.y) < 0.95
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
    right = new THREE.Vector3().crossVectors(forward, up);
  }
  right.normalize();
  up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, up };
}

function rotateViewBasis(basis, angle) {
  const q = new THREE.Quaternion().setFromAxisAngle(basis.forward, angle);
  return {
    forward: basis.forward.clone(),
    right: basis.right.clone().applyQuaternion(q).normalize(),
    up: basis.up.clone().applyQuaternion(q).normalize()
  };
}

function projectWorldPointToBasis(point, center, basis) {
  const delta = point.clone().sub(center);
  return {
    x: delta.dot(basis.right),
    y: delta.dot(basis.up),
    z: delta.dot(basis.forward)
  };
}

function appendBoundingBoxCorners(points, box) {
  const xs = [box.min.x, box.max.x];
  const ys = [box.min.y, box.max.y];
  const zs = [box.min.z, box.max.z];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        points.push(new THREE.Vector3(x, y, z));
      }
    }
  }
}

function collectModelSamplePoints(root, box, maxPoints = 4096) {
  const meshes = [];
  let totalVertices = 0;
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const pos = child?.geometry?.attributes?.position;
    if (!child?.isMesh || !pos) return;
    meshes.push({ child, pos });
    totalVertices += pos.count;
  });

  const step = Math.max(1, Math.ceil(totalVertices / Math.max(1, maxPoints)));
  const world = new THREE.Vector3();
  const sampled = [];
  for (const { child, pos } of meshes) {
    for (let i = 0; i < pos.count; i += step) {
      world.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
      sampled.push(world.clone());
    }
  }
  appendBoundingBoxCorners(sampled, box);
  return sampled;
}

function projectWorldPointsToBasis(points, center, basis) {
  return points.map((point) => projectWorldPointToBasis(point, center, basis));
}

function computePrincipalAngle2D(points) {
  if (!points.length) return 0;
  let meanX = 0;
  let meanY = 0;
  for (const p of points) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= points.length;
  meanY /= points.length;

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

function computeAxisAlignedExtents2D(points) {
  if (!points.length) return { width: 1, height: 1 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return {
    width: Math.max(1e-3, maxX - minX),
    height: Math.max(1e-3, maxY - minY)
  };
}

function computeAxisAlignedDepthRange(points) {
  if (!points.length) return { min: -1, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    min = Math.min(min, p.z);
    max = Math.max(max, p.z);
  }
  return { min, max };
}

function getSnapshotTargetSize(aspect, maxEdge = 1280) {
  const safeAspect = THREE.MathUtils.clamp(aspect || 1, 0.25, 4);
  const capped = Math.max(256, Math.round(maxEdge || 1280));
  if (safeAspect >= 1) {
    return {
      width: capped,
      height: Math.max(256, Math.round(capped / safeAspect))
    };
  }
  return {
    width: Math.max(256, Math.round(capped * safeAspect)),
    height: capped
  };
}

function computeSnapshotFrame(root, box, center, view, maxEdge) {
  const sampledPoints = collectModelSamplePoints(root, box);
  const initialBasis = buildViewBasis(view.dir, view.up);
  const initialPoints = projectWorldPointsToBasis(sampledPoints, center, initialBasis);
  const principalAngle = computePrincipalAngle2D(initialPoints);
  const rolledBasis = rotateViewBasis(initialBasis, principalAngle);
  const rolledPoints = projectWorldPointsToBasis(sampledPoints, center, rolledBasis);
  const extents = computeAxisAlignedExtents2D(rolledPoints);
  const actualAspect = extents.width / Math.max(extents.height, 1e-3);
  const outputAspect = THREE.MathUtils.clamp(actualAspect, 0.25, 4);
  const targetSize = getSnapshotTargetSize(outputAspect, maxEdge);
  const fitPadding = 1.08;
  let halfWidth = extents.width * 0.5 * fitPadding;
  let halfHeight = extents.height * 0.5 * fitPadding;
  if (halfWidth / Math.max(halfHeight, 1e-3) < outputAspect) {
    halfWidth = halfHeight * outputAspect;
  } else {
    halfHeight = halfWidth / outputAspect;
  }
  const depth = computeAxisAlignedDepthRange(rolledPoints);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const distance = depth.max + sphere.radius * 2.5 + 1;
  const minDepth = Math.max(0.01, distance - depth.max - sphere.radius * 0.5);
  const maxDepth = distance - depth.min + sphere.radius * 0.5;

  return {
    width: targetSize.width,
    height: targetSize.height,
    up: rolledBasis.up,
    distance,
    halfWidth: Math.max(halfWidth, 1e-3),
    halfHeight: Math.max(halfHeight, 1e-3),
    near: minDepth,
    far: Math.max(minDepth + 1, maxDepth)
  };
}

function exportCanvasDataUrl(canvas, mimeType, maxW) {
  const srcW = canvas.width;
  const srcH = canvas.height;
  if (!maxW || srcW <= maxW && srcH <= maxW) {
    return canvas.toDataURL(mimeType);
  }
  const scale = Math.min(maxW / srcW, maxW / srcH, 1);
  const tw = Math.max(1, Math.round(srcW * scale));
  const th = Math.max(1, Math.round(srcH * scale));
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const outCtx = out.getContext('2d');
  if (!outCtx) return canvas.toDataURL(mimeType);
  outCtx.drawImage(canvas, 0, 0, tw, th);
  return out.toDataURL(mimeType);
}

export function createSnapshotRenderer({
  renderer,
  scene,
  camera,
  axes,
  getCurrentRoot,
  getPreviewMode,
  setPreviewMode,
  updateDirectionalLights
}) {
  return function snapshot(mimeType = 'image/png', opts = {}) {
    let restoreSnapshotState = null;
    try {
      const src = renderer.domElement;
      const srcW = Math.max(1, src.width);
      const srcH = Math.max(1, src.height);
      const viewKey = String(opts.view || 'iso').toLowerCase();
      const view = SNAPSHOT_VIEWS[viewKey] || SNAPSHOT_VIEWS.iso;
      const mode = ['solid', 'xray', 'wireframe'].includes(String(opts.mode || opts.previewMode || 'solid').toLowerCase())
        ? String(opts.mode || opts.previewMode || 'solid').toLowerCase()
        : 'solid';
      const maxEdge = opts.maxEdge || opts.maxWidth || Math.max(srcW, srcH);
      const currentRoot = getCurrentRoot?.();

      if (!currentRoot) {
        renderer.render(scene, camera);
        return exportCanvasDataUrl(src, mimeType, maxEdge);
      }

      const box = new THREE.Box3().setFromObject(currentRoot);
      if (opts.axes !== false && axes) {
        const oldAxesVisibleForBounds = axes.visible;
        axes.visible = true;
        const axesBox = new THREE.Box3().setFromObject(axes);
        axes.visible = oldAxesVisibleForBounds;
        if (!axesBox.isEmpty()) box.union(axesBox);
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const center = sphere.center.clone();
      const frame = computeSnapshotFrame(currentRoot, box, center, view, maxEdge);

      const oldPixelRatio = renderer.getPixelRatio();
      const oldSize = renderer.getSize(new THREE.Vector2());
      const oldAxesVisible = axes.visible;
      const oldBackground = scene.background;
      const oldPreviewMode = getPreviewMode?.();
      if (setPreviewMode) setPreviewMode(mode);
      restoreSnapshotState = () => {
        if (setPreviewMode && oldPreviewMode) setPreviewMode(oldPreviewMode);
        axes.visible = oldAxesVisible;
        scene.background = oldBackground;
        renderer.setPixelRatio(oldPixelRatio);
        renderer.setSize(oldSize.x, oldSize.y, false);
        renderer.render(scene, camera);
      };
      axes.visible = opts.axes !== false;
      scene.background = new THREE.Color(VIEWER_BACKGROUND_COLOR);

      renderer.setPixelRatio(1);
      renderer.setSize(frame.width, frame.height, false);
      const snapshotCamera = new THREE.OrthographicCamera(
        -frame.halfWidth,
        frame.halfWidth,
        frame.halfHeight,
        -frame.halfHeight,
        frame.near,
        frame.far
      );
      snapshotCamera.position.copy(center).addScaledVector(view.dir, frame.distance);
      snapshotCamera.up.copy(frame.up);
      snapshotCamera.lookAt(center);
      snapshotCamera.updateProjectionMatrix();
      updateDirectionalLights(snapshotCamera, center);
      renderer.render(scene, snapshotCamera);
      const dataUrl = renderer.domElement.toDataURL(mimeType);

      restoreSnapshotState();
      restoreSnapshotState = null;

      return dataUrl;
    } catch {
      if (restoreSnapshotState) restoreSnapshotState();
      return null;
    }
  };
}
