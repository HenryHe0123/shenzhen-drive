import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../config';

function paintMaterial(): THREE.MeshPhysicalMaterial {
  const C = CONFIG.car;
  return new THREE.MeshPhysicalMaterial({
    name: C.paintMaterial,
    color: C.paintColor,
    metalness: C.paintMetalness,
    roughness: C.paintRoughness,
    clearcoat: C.paintClearcoat,
    clearcoatRoughness: C.paintClearcoatRoughness,
  });
}

function fallbackModel(): THREE.Object3D {
  const V = CONFIG.vehicle;
  const paint = paintMaterial();
  const dark = new THREE.MeshStandardMaterial({ color: '#111318', roughness: 0.4 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(V.width, 0.7, V.length), paint);
  body.position.y = 0.55;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(V.width * 0.85, 0.55, V.length * 0.5), dark);
  cabin.position.set(0, 1.15, 0.2);
  g.add(body, cabin);
  return g;
}

/** Xiaomi SU7 model with re-painted body and a little pitch/roll; falls back to boxes if the GLB fails. */
export class CarVisual {
  /** Positioned at the car center on the road, rotated by yaw. */
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private pitch = 0;
  private roll = 0;
  loadedModel = false;

  private constructor(model: THREE.Object3D, loaded: boolean) {
    this.loadedModel = loaded;
    this.root.name = 'player-car';
    this.body.add(model);
    this.root.add(this.body);
  }

  static async load(): Promise<CarVisual> {
    const C = CONFIG.car;
    try {
      const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + CONFIG.data.carModelUrl);
      const model = gltf.scene;
      model.scale.setScalar(C.modelScale);
      const paint = paintMaterial();
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => (m.name === C.paintMaterial ? paint : m));
        } else if (mesh.material.name === C.paintMaterial) {
          mesh.material = paint;
        }
      });
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      return new CarVisual(model, true);
    } catch (e) {
      console.error('[car] failed to load model, using fallback box:', e);
      return new CarVisual(fallbackModel(), false);
    }
  }

  /** Size of the loaded model (m), for debugging. */
  size(): THREE.Vector3 {
    return new THREE.Box3().setFromObject(this.body).getSize(new THREE.Vector3());
  }

  update(x: number, z: number, yaw: number, longAccel: number, latAccel: number, dt: number): void {
    const C = CONFIG.car;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
    const k = 1 - Math.exp(-C.bodyLerp * dt);
    const pitchTarget = THREE.MathUtils.clamp(longAccel * C.bodyPitchPerAccel, -0.05, 0.035);
    const rollTarget = THREE.MathUtils.clamp(-latAccel * C.bodyRollPerLatAccel, -0.05, 0.05);
    this.pitch += (pitchTarget - this.pitch) * k;
    this.roll += (rollTarget - this.roll) * k;
    this.body.rotation.set(this.pitch, 0, this.roll);
  }
}
