import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../config';
import { registerReflective } from '../render/reflectionEnv';
import { steerLimit } from './Vehicle';

/** Driving state the wheels and brake lights follow (the Vehicle satisfies it). */
export interface CarDriveState {
  /** m/s, signed */
  readonly speed: number;
  /** Normalized steering, -1 (left) .. +1 (right). */
  readonly steer: number;
  /** Wheel angle as a fraction of the steering limit, including the stability counter-steer (defaults to steer). */
  readonly wheelSteer?: number;
  readonly braking: boolean;
}

const TAU = Math.PI * 2;
const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];
/** Longest plausible per-frame travel (m); anything longer is a teleport and does not spin the wheels. */
const MAX_FRAME_TRAVEL = 30;

/** Wheel index (front-left, front-right, rear-left, rear-right) of a body-space point; the car faces -Z. */
function cornerOf(x: number, z: number): number {
  return (z < 0 ? 0 : 2) + (x < 0 ? 0 : 1);
}

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

/**
 * The GLB wheels are unlit-looking: near-black tyre textures and a silver rim texture on a
 * non-metallic, roughness-0 material. Turns them into dark grey rubber and polished metal
 * that reflects scene.environment. Edits the loader's materials in place.
 */
function tuneWheelMaterial(m: THREE.MeshStandardMaterial): void {
  const C = CONFIG.car;
  if (m.name === C.tireTreadMaterial || m.name === C.tireSidewallMaterial) {
    m.color.setScalar(C.tireAlbedoScale);
    m.roughness = C.tireRoughness;
    m.metalness = 0;
  } else if (m.name === C.rimMaterial) {
    m.metalness = C.rimMetalness;
    m.roughness = C.rimRoughness;
  } else {
    return;
  }
  // The emissive maps only repeat the base color under a black emissive factor.
  m.emissiveMap = null;
  m.needsUpdate = true;
}

/** Thinner, less green window glass, so the view out of the cockpit is clearer. Edits in place. */
function tuneWindowGlass(m: THREE.MeshStandardMaterial): void {
  const C = CONFIG.car;
  if (m.name !== C.windowGlassMaterial) return;
  m.opacity = C.windowGlassOpacity;
  m.color.lerp(new THREE.Color(1, 1, 1), 1 - C.windowGlassTint);
}

/**
 * Splits the wheel meshes (each merges one material of all four wheels) into one pivot per
 * wheel at its hub, so it can spin and steer. Must run after the model is scaled and centered
 * and before it is parented, so matrixWorld maps into body space. The four per-wheel meshes
 * of a part share the baked vertex attributes and differ only in their index.
 */
function splitWheels(model: THREE.Object3D): THREE.Group[] {
  const C = CONFIG.car;
  const names = new Set<string>([C.tireTreadMaterial, C.tireSidewallMaterial, C.rimMaterial, C.brakeDiscMaterial]);
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && names.has(mesh.material.name)) meshes.push(mesh);
  });
  if (!meshes.length) return [];

  model.updateMatrixWorld(true);
  const treadBoxes = WHEEL_NAMES.map(() => new THREE.Box3());
  const allBoxes = WHEEL_NAMES.map(() => new THREE.Box3());
  const p = new THREE.Vector3();
  const parts = meshes.map((mesh) => {
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const n = index ? index.count : pos.count;
    const material = mesh.material as THREE.Material;
    const tread = material.name === C.tireTreadMaterial;
    const lists: number[][] = [[], [], [], []];
    for (let t = 0; t < n; t += 3) {
      const a = index ? index.getX(t) : t;
      const b = index ? index.getX(t + 1) : t + 1;
      const c = index ? index.getX(t + 2) : t + 2;
      const k = cornerOf(pos.getX(a) + pos.getX(b) + pos.getX(c), pos.getZ(a) + pos.getZ(b) + pos.getZ(c));
      lists[k].push(a, b, c);
      for (let j = 0; j < 3; j++) {
        p.fromBufferAttribute(pos, j === 0 ? a : j === 1 ? b : c);
        allBoxes[k].expandByPoint(p);
        if (tread) treadBoxes[k].expandByPoint(p);
      }
    }
    mesh.removeFromParent();
    mesh.geometry.dispose();
    return { geo, lists, material };
  });

  const pivots = WHEEL_NAMES.map((name, k) => {
    const pivot = new THREE.Group();
    pivot.name = `wheel-${name}`;
    // steer (Y) applied after spin (X): the axle turns with the wheel angle
    pivot.rotation.order = 'YXZ';
    (treadBoxes[k].isEmpty() ? allBoxes[k] : treadBoxes[k]).getCenter(pivot.position);
    return pivot;
  });
  for (const { geo, lists, material } of parts) {
    lists.forEach((list, k) => {
      if (!list.length) return;
      const g = new THREE.BufferGeometry();
      for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.getAttribute(name));
      g.setIndex(list);
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `${material.name}-${WHEEL_NAMES[k]}`;
      mesh.position.copy(pivots[k].position).negate();
      mesh.castShadow = true;
      pivots[k].add(mesh);
    });
  }
  for (const pivot of pivots) pivot.position.x += Math.sign(pivot.position.x) * C.wheelTrackOffset;
  return pivots;
}

/**
 * Cuts the steering wheel out of the dashboard meshes into a pivot at its hub that turns about
 * the column axis. Same preconditions as splitWheels; the remaining triangles stay in place.
 */
function splitSteeringWheel(model: THREE.Object3D): THREE.Group | null {
  const W = CONFIG.car.steeringWheel;
  const names: readonly string[] = W.materials;
  const center = new THREE.Vector3().fromArray(W.center);
  const axis = new THREE.Vector3().fromArray(W.axis).normalize();
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && names.includes(mesh.material.name)) meshes.push(mesh);
  });
  model.updateMatrixWorld(true);
  const pivot = new THREE.Group();
  pivot.name = 'steering-wheel';
  pivot.position.copy(center);
  const g = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const mesh of meshes) {
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    const index = src.getIndex();
    const n = index ? index.count : pos.count;
    const keep: number[] = [];
    const cut: number[] = [];
    for (let t = 0; t < n; t += 3) {
      const a = index ? index.getX(t) : t;
      const b = index ? index.getX(t + 1) : t + 1;
      const c = index ? index.getX(t + 2) : t + 2;
      g.fromBufferAttribute(pos, a).add(p.fromBufferAttribute(pos, b)).add(p.fromBufferAttribute(pos, c));
      g.divideScalar(3).applyMatrix4(mesh.matrixWorld).sub(center);
      const along = g.dot(axis);
      const radial = g.sub(p.copy(axis).multiplyScalar(along)).length();
      (radial < W.radius && along > W.axialMin && along < W.axialMax ? cut : keep).push(a, b, c);
    }
    if (!cut.length) continue;
    src.setIndex(keep);
    const geo = src.clone().applyMatrix4(mesh.matrixWorld);
    geo.setIndex(cut);
    geo.translate(-center.x, -center.y, -center.z);
    const part = new THREE.Mesh(geo, mesh.material);
    part.name = `${(mesh.material as THREE.Material).name}-steering`;
    part.castShadow = true;
    pivot.add(part);
  }
  return pivot.children.length ? pivot : null;
}

function findStandardMaterial(root: THREE.Object3D, name: string): THREE.MeshStandardMaterial | null {
  let found: THREE.MeshStandardMaterial | null = null;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!found && m && !Array.isArray(m) && m.isMeshStandardMaterial && m.name === name) found = m;
  });
  return found;
}

function registerCarReflections(model: THREE.Object3D, paint: THREE.MeshStandardMaterial): void {
  const C = CONFIG.car;
  const glass = new Set<THREE.MeshStandardMaterial>();
  const rims = new Set<THREE.MeshStandardMaterial>();
  const glassNames: readonly string[] = C.glassMaterials;
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const s = m as THREE.MeshStandardMaterial;
      if (!s.isMeshStandardMaterial) continue;
      if (glassNames.includes(s.name)) glass.add(s);
      else if (s.name === C.rimMaterial) rims.add(s);
    }
  });
  registerReflective([paint], C.hdriPaintGain);
  registerReflective(glass, C.hdriGlassGain);
  registerReflective(rims, C.hdriRimGain);
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

/**
 * Xiaomi SU7 model with re-painted body, a little pitch/roll, spinning and steering wheels
 * and brake lights; falls back to boxes if the GLB fails.
 */
export class CarVisual {
  /** Positioned at the car center on the road, rotated by yaw. */
  readonly root = new THREE.Group();
  /** Car body space (origin at the center on the road, facing -Z), including the pitch / roll; the cockpit camera rides in it. */
  readonly body = new THREE.Group();
  /** Wheel pivots at the hub centers: front-left, front-right, rear-left, rear-right (empty for the fallback). */
  private readonly wheels: THREE.Group[];
  /** Steering wheel pivot at the hub (null for the fallback or if the cut found nothing). */
  private readonly steeringWheel: THREE.Group | null;
  private readonly steeringAxis = new THREE.Vector3().fromArray(CONFIG.car.steeringWheel.axis).normalize();
  private readonly tailLight: THREE.MeshStandardMaterial | null;
  private readonly tailBase: number;
  private pitch = 0;
  private roll = 0;
  private slip = 0;
  private spin = 0;
  private brakeGlow = 0;
  private lastX = NaN;
  private lastZ = NaN;
  loadedModel = false;

  private constructor(
    model: THREE.Object3D,
    loaded: boolean,
    wheels: THREE.Group[] = [],
    steeringWheel: THREE.Group | null = null,
  ) {
    this.loadedModel = loaded;
    this.root.name = 'player-car';
    this.wheels = wheels;
    this.steeringWheel = steeringWheel;
    this.body.add(model, ...wheels);
    if (steeringWheel) this.body.add(steeringWheel);
    this.root.add(this.body);
    this.tailLight = findStandardMaterial(model, CONFIG.car.tailLightMaterial);
    this.tailBase = this.tailLight?.emissiveIntensity ?? 0;
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
        } else if ((mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          tuneWheelMaterial(mesh.material as THREE.MeshStandardMaterial);
          tuneWindowGlass(mesh.material as THREE.MeshStandardMaterial);
        }
      });
      registerCarReflections(model, paint);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      const wheels = splitWheels(model);
      return new CarVisual(model, true, wheels, splitSteeringWheel(model));
    } catch (e) {
      console.error('[car] failed to load model, using fallback box:', e);
      return new CarVisual(fallbackModel(), false);
    }
  }

  /** Size of the loaded model (m), for debugging. */
  size(): THREE.Vector3 {
    return new THREE.Box3().setFromObject(this.body).getSize(new THREE.Vector3());
  }

  /** Interpolated pose plus the vehicle state; wheels spin with the distance actually rendered. */
  update(x: number, z: number, yaw: number, longAccel: number, latAccel: number, dt: number, drive?: CarDriveState): void {
    const C = CONFIG.car;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
    const k = 1 - Math.exp(-C.bodyLerp * dt);
    const pitchTarget = THREE.MathUtils.clamp(longAccel * C.bodyPitchPerAccel, -0.05, 0.035);
    const rollTarget = THREE.MathUtils.clamp(-latAccel * C.bodyRollPerLatAccel, -0.05, 0.05);
    const slipTarget = THREE.MathUtils.clamp(latAccel * CONFIG.vehicle.visualSlipPerLatAccel, -0.05, 0.05);
    this.pitch += (pitchTarget - this.pitch) * k;
    this.roll += (rollTarget - this.roll) * k;
    this.slip += (slipTarget - this.slip) * k;
    this.body.rotation.set(this.pitch, this.slip, this.roll);

    const travel = (x - this.lastX) * -Math.sin(yaw) + (z - this.lastZ) * -Math.cos(yaw);
    this.lastX = x;
    this.lastZ = z;
    if (Math.abs(travel) < MAX_FRAME_TRAVEL) this.spin = (this.spin - travel / C.tireRadius) % TAU;
    const lock = THREE.MathUtils.clamp(steerLimit(drive?.speed ?? 0), C.wheelSteerMin, C.wheelSteerMax);
    const wheelAngle = (drive?.wheelSteer ?? drive?.steer ?? 0) * lock;
    for (let i = 0; i < this.wheels.length; i++) {
      this.wheels[i].rotation.x = this.spin;
      this.wheels[i].rotation.y = i < 2 ? -wheelAngle : 0;
    }
    this.steeringWheel?.quaternion.setFromAxisAngle(this.steeringAxis, wheelAngle * C.steeringWheel.ratio);

    if (this.tailLight) {
      this.brakeGlow += ((drive?.braking ? 1 : 0) - this.brakeGlow) * (1 - Math.exp(-20 * dt));
      this.tailLight.emissiveIntensity = this.tailBase * (1 + (C.brakeLightGain - 1) * this.brakeGlow);
    }
  }
}
