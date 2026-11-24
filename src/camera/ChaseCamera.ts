import * as THREE from 'three';
import { CONFIG, KMH } from '../config';

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** Low third-person follow camera with smoothed yaw, speed-dependent distance and FOV. */
export class ChaseCamera {
  private yaw = 0;
  private pull = 0;
  private fov: number = CONFIG.camera.fovBase;
  private orbitAngle = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Jumps straight behind the car (after resets/teleports). */
  snap(x: number, z: number, yaw: number): void {
    this.yaw = yaw;
    this.pull = 0;
    this.place(x, z, 0);
  }

  update(dt: number, x: number, z: number, yaw: number, speed: number, longAccel: number): void {
    const C = CONFIG.camera;
    this.yaw += wrapAngle(yaw - this.yaw) * (1 - Math.exp(-C.yawLerp * dt));
    const pullTarget = THREE.MathUtils.clamp(longAccel * C.accelPull, -0.6, 0.6);
    this.pull += (pullTarget - this.pull) * (1 - Math.exp(-3 * dt));
    const sp = Math.min(1, Math.abs(speed) / (CONFIG.vehicle.maxSpeedKmh * KMH));
    const fovTarget = C.fovBase + (C.fovMax - C.fovBase) * sp ** 1.5;
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-C.fovLerp * dt));
    this.place(x, z, sp);
  }

  /** Slow orbit around the parked car for the start screen; the chase view blends in afterwards. */
  orbit(dt: number, x: number, z: number, carYaw: number): void {
    this.orbitAngle += dt * 0.12;
    this.yaw = carYaw + Math.PI * 0.8 + this.orbitAngle;
    this.pull = 1.2;
    this.place(x, z, 0);
  }

  private place(x: number, z: number, sp: number): void {
    const C = CONFIG.camera;
    const dist = C.distance + C.speedDistance * sp + this.pull;
    const height = C.height + C.speedHeight * sp;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const cam = this.camera;
    cam.position.set(x - fx * dist, height, z - fz * dist);
    cam.lookAt(x + fx * C.lookAhead, C.lookHeight, z + fz * C.lookAhead);
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
