import * as THREE from 'three';

function createAxisLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 72;
  canvas.height = 72;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create 2D canvas context');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '700 34px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(6, 16, 24, 0.9)';
  ctx.fillStyle = color;
  ctx.strokeText(text, 36, 38);
  ctx.fillText(text, 36, 38);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.6, 3.6, 1);
  return sprite;
}

function createReferenceAxesObject(): THREE.Group {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 999;

  const helper = new THREE.AxesHelper(30);
  for (const material of Array.isArray(helper.material) ? helper.material : [helper.material]) {
    material.depthTest = false;
  }
  helper.renderOrder = 999;
  group.add(helper);

  const xLabel = createAxisLabel('X', '#ff6e6e');
  const yLabel = createAxisLabel('Y', '#4ade80');
  const zLabel = createAxisLabel('Z', '#6ee7ff');
  xLabel.position.set(33, 0, 0);
  yLabel.position.set(0, 33, 0);
  zLabel.position.set(0, 0, 33);
  group.add(xLabel, yLabel, zLabel);

  return group;
}

function disposeAxesObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const object = child as THREE.Object3D & {
      geometry?: { dispose?: () => void };
      material?: THREE.Material | THREE.Material[];
    };
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      (material as (THREE.Material & { map?: THREE.Texture }) | undefined)?.map?.dispose?.();
      material?.dispose?.();
    }
  });
}

export function createReferenceAxesController(scene: THREE.Scene) {
  const object = createReferenceAxesObject();
  scene.add(object);

  function updateForBox(box: THREE.Box3) {
    if (!box || box.isEmpty()) {
      object.visible = false;
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const length = THREE.MathUtils.clamp(Math.max(size.x, size.y, size.z) * 0.42, 12, 220);
    object.position.copy(center);
    object.scale.setScalar(length / 33);
    object.visible = true;
  }

  function hide() {
    object.visible = false;
  }

  function dispose() {
    scene.remove(object);
    disposeAxesObject(object);
  }

  return {
    object,
    updateForBox,
    hide,
    dispose
  };
}
