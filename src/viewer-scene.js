import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export function createViewerLighting(scene, renderer, getCurrentRoot) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  scene.add(new THREE.HemisphereLight(0xe9f3ff, 0x101624, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 1.22);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.018;
  scene.add(key);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight(0xb6c7ff, 0.44);
  scene.add(fill);
  scene.add(fill.target);

  const rim = new THREE.DirectionalLight(0xe6f8ff, 0.34);
  scene.add(rim);
  scene.add(rim.target);

  const keyOffset = new THREE.Vector3(0.85, 0.55, 0.35).normalize();
  const fillOffset = new THREE.Vector3(-0.65, 0.25, -0.55).normalize();
  const rimOffset = new THREE.Vector3(-0.3, 0.7, -0.95).normalize();
  const lightSphere = new THREE.Sphere();

  function updateDirectionalLights(viewCamera, orbitTarget) {
    key.target.position.copy(orbitTarget);
    fill.target.position.copy(orbitTarget);
    rim.target.position.copy(orbitTarget);
    let radius = 80;
    const currentRoot = getCurrentRoot?.();
    if (currentRoot) {
      new THREE.Box3().setFromObject(currentRoot).getBoundingSphere(lightSphere);
      radius = Math.max(lightSphere.radius, 1e-3);
    }
    const arm = Math.max(radius * 2.8, 120);
    keyOffset.set(0.85, 0.55, 0.35).normalize();
    fillOffset.set(-0.65, 0.25, -0.55).normalize();
    rimOffset.set(-0.3, 0.7, -0.95).normalize();
    keyOffset.applyQuaternion(viewCamera.quaternion);
    fillOffset.applyQuaternion(viewCamera.quaternion);
    rimOffset.applyQuaternion(viewCamera.quaternion);
    key.position.copy(viewCamera.position).addScaledVector(keyOffset, arm);
    fill.position.copy(viewCamera.position).addScaledVector(fillOffset, arm * 0.95);
    rim.position.copy(viewCamera.position).addScaledVector(rimOffset, arm * 1.1);
    key.target.updateMatrixWorld();
    fill.target.updateMatrixWorld();
    rim.target.updateMatrixWorld();
  }

  function updateShadowCameraForBox(box) {
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);
    const shadowCamera = key.shadow.camera;
    shadowCamera.left = -radius * 1.7;
    shadowCamera.right = radius * 1.7;
    shadowCamera.top = radius * 1.7;
    shadowCamera.bottom = -radius * 1.7;
    shadowCamera.near = 1;
    shadowCamera.far = Math.max(radius * 6, 120);
    key.target.position.copy(center);
    key.target.updateMatrixWorld();
    shadowCamera.updateProjectionMatrix();
  }

  return {
    updateDirectionalLights,
    updateShadowCameraForBox,
    dispose() {
      scene.environment?.dispose?.();
      scene.environment = null;
      pmrem.dispose();
    }
  };
}

export function createContactShadow(scene) {
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: 0.24,
      transparent: true,
      depthWrite: false
    })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.receiveShadow = true;
  contactShadow.visible = false;
  contactShadow.renderOrder = -5;
  scene.add(contactShadow);

  return {
    object: contactShadow,
    updateForBox(box) {
      if (!box || box.isEmpty()) {
        contactShadow.visible = false;
        return;
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const footprint = Math.max(size.x, size.z, 1);
      const lift = Math.max(size.y, footprint) * 0.0015;
      contactShadow.position.set(center.x, box.min.y - lift, center.z);
      contactShadow.scale.set(footprint * 1.42, footprint * 1.42, 1);
      contactShadow.material.opacity = THREE.MathUtils.clamp(0.2 + footprint / 5000, 0.2, 0.32);
      contactShadow.visible = true;
    },
    hide() {
      contactShadow.visible = false;
    },
    dispose() {
      scene.remove(contactShadow);
      contactShadow.geometry.dispose();
      contactShadow.material.dispose();
    }
  };
}

export function decorateModelForCadDisplay(root) {
  root.traverse((child) => {
    if (!child?.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = false;
  });
  root.traverse((child) => {
    if (child?.isLineSegments) {
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });
}
