import * as THREE from 'three';
import { CONFIG, KMH } from '../config';

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** Yaw smoothing rate (1/s) of the chase camera at speed v (m/s). */
export function chaseYawLerp(speed: number): number {
  const C = CONFIG.camera;
  const sp = Math.min(1, Math.abs(speed) / (CONFIG.vehicle.maxSpeedKmh * KMH));
  return C.yawLerp + (C.yawLerpHigh - C.yawLerp) * sp * sp;
}

/** Low third-person follow camera with smoothed yaw, speed-dependent distance and FOV. */
export class ChaseCamera {
  private yaw = 0;
  private pull = 0;
  private fov: number = CONFIG.camera.fovBase;
  private orbitAngle = 0;
  private time = 0;
  private shake = 0;
  private sway = 0;
  private jolt = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Impact shake, strength 0..1. */
  bump(strength: number): void {
    this.jolt = Math.max(this.jolt, Math.min(1, strength));
  }

  /** Jumps straight behind the car (after resets/teleports). */
  snap(x: number, z: number, yaw: number): void {
    this.yaw = yaw;
    this.pull = 0;
    this.place(x, z, 0);
  }

  update(dt: number, x: number, z: number, yaw: number, speed: number, longAccel: number): void {
    const C = CONFIG.camera;
    const vmax = CONFIG.vehicle.maxSpeedKmh * KMH;
    const sp = Math.min(1, Math.abs(speed) / vmax);
    this.yaw += wrapAngle(yaw - this.yaw) * (1 - Math.exp(-chaseYawLerp(speed) * dt));
    const pullTarget = THREE.MathUtils.clamp(longAccel * C.accelPull, -0.6, 0.6);
    this.pull += (pullTarget - this.pull) * (1 - Math.exp(-3 * dt));
    const fovTarget = C.fovBase + (C.fovMax - C.fovBase) * sp ** 1.5;
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-C.fovLerp * dt));
    // Two incommensurate sines: a faint road buzz rather than a visible wobble.
    this.time += dt;
    const from = C.vibrationFromKmh * KMH;
    const level = Math.max(0, (Math.abs(speed) - from) / (vmax - from));
    const t = this.time * Math.PI * 2;
    this.shake = C.vibration * level * (0.6 * Math.sin(t * 13) + 0.4 * Math.sin(t * 21.7));
    this.jolt *= Math.exp(-C.joltDecay * dt);
    const j = C.jolt * this.jolt;
    this.shake += j * Math.sin(t * 4.3);
    this.sway = j * 0.7 * Math.sin(t * 3.1 + 1);
    this.place(x, z, sp);
  }

  /** Slow orbit around the parked car for the start screen; the chase view blends in afterwards. */
  orbit(dt: number, x: number, z: number, carYaw: number): void {
    this.orbitAngle += dt * 0.12;
    this.yaw = carYaw + Math.PI * 0.8 + this.orbitAngle;
    this.pull = 1.2;
    this.shake = this.sway = this.jolt = 0;
    this.place(x, z, 0);
  }

  private place(x: number, z: number, sp: number): void {
    const C = CONFIG.camera;
    const dist = C.distance + C.speedDistance * sp + this.pull;
    const height = C.height + C.speedHeight * sp + this.shake;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const cam = this.camera;
    cam.position.set(x - fx * dist - fz * this.sway, height, z - fz * dist + fx * this.sway);
    cam.lookAt(x + fx * C.lookAhead, C.lookHeight, z + fz * C.lookAhead);
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
