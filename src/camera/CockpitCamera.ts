import * as THREE from 'three';
import { CONFIG, KMH } from '../config';

/** Car state the driver's head reacts to. */
export interface CockpitDriveState {
  /** m/s, signed */
  readonly speed: number;
  /** -1 (left) .. +1 (right) */
  readonly steer: number;
  readonly longAccel: number;
  /** Positive = toward the left. */
  readonly latAccel: number;
}

const clamp = THREE.MathUtils.clamp;

/**
 * First-person camera at the driver's eye point in car body space (CarVisual.body, so it
 * rides the body pitch and roll). The head glances into turns and lags slightly against
 * acceleration.
 */
export class CockpitCamera {
  private look = 0;
  private leanX = 0;
  private leanZ = 0;
  private fov: number = CONFIG.cockpit.fovBase;
  private time = 0;
  private jolt = 0;
  private readonly offset = new THREE.Vector3();
  private readonly gaze = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly gazeQuat = new THREE.Quaternion();

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Drops the smoothed head motion (after resets/teleports and when entering the view). */
  reset(): void {
    this.look = this.leanX = this.leanZ = this.jolt = 0;
    this.fov = CONFIG.cockpit.fovBase;
  }

  /** Impact shake, strength 0..1. */
  bump(strength: number): void {
    this.jolt = Math.max(this.jolt, Math.min(1, strength));
  }

  update(dt: number, body: THREE.Object3D, car: CockpitDriveState): void {
    const K = CONFIG.cockpit;
    const vmax = CONFIG.vehicle.maxSpeedKmh * KMH;
    const sp = Math.min(1, Math.abs(car.speed) / vmax);
    const k = 1 - Math.exp(-K.lookLerp * dt);
    const fade = Math.min(1, Math.abs(car.speed) / (K.lookIntoFullKmh * KMH));
    this.look += (-car.steer * K.lookInto * fade - this.look) * k;
    this.leanX += (clamp(car.latAccel * K.leanPerAccel, -K.maxLean, K.maxLean) - this.leanX) * k;
    this.leanZ += (clamp(car.longAccel * K.leanPerAccel, -K.maxLean, K.maxLean) - this.leanZ) * k;
    const fovTarget = K.fovBase + (K.fovMax - K.fovBase) * sp ** 1.5;
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-CONFIG.camera.fovLerp * dt));
    this.time += dt;
    const t = this.time * Math.PI * 2;
    this.jolt *= Math.exp(-CONFIG.camera.joltDecay * dt);
    const j = K.jolt * this.jolt;
    const shake = K.vibration * sp * (0.6 * Math.sin(t * 11) + 0.4 * Math.sin(t * 17.3)) + j * Math.sin(t * 4.3);
    this.place(body, shake, j * 0.7 * Math.sin(t * 3.1 + 1));
  }

  private place(body: THREE.Object3D, shake: number, sway = 0): void {
    const K = CONFIG.cockpit;
    const cam = this.camera;
    body.updateWorldMatrix(true, false);
    body.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    this.offset.set(K.eyeX + this.leanX + sway, K.eyeY + shake, K.eyeZ + this.leanZ).applyQuaternion(cam.quaternion);
    cam.position.add(this.offset);
    this.gaze.set(K.pitch, this.look, 0);
    cam.quaternion.multiply(this.gazeQuat.setFromEuler(this.gaze));
    cam.updateMatrixWorld();
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
