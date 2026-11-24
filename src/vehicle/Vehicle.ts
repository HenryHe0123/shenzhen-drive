import { CONFIG, KMH } from '../config';
import type { Route } from '../route/Route';
import { resolveRoadContact } from './collision';

export interface DriveInput {
  /** 0..1 */
  throttle: number;
  /** 0..1; brakes while moving forward, reverses once stopped. */
  brake: number;
  /** -1 (full left) .. +1 (full right). */
  steer: number;
}

export const NO_INPUT: Readonly<DriveInput> = { throttle: 0, brake: 0, steer: 0 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function moveTowards(v: number, target: number, maxDelta: number): number {
  return Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta;
}

/** Cornering limit (m/s^2) at speed v: full grip at low speed, somewhat less toward top speed. */
export function latAccelLimit(v: number): number {
  const V = CONFIG.vehicle;
  const u = Math.min(1, Math.abs(v) / (V.maxSpeedKmh * KMH));
  return V.latAccelMax - V.latAccelHighSpeedLoss * u * u;
}

/** Max front wheel angle (rad) at speed v: the angle that reaches latAccelLimit, capped at steerMaxLow. */
export function steerLimit(v: number): number {
  const V = CONFIG.vehicle;
  const v2 = v * v;
  if (v2 < 1e-6) return V.steerMaxLow;
  return Math.min(V.steerMaxLow, Math.atan((V.wheelbase * latAccelLimit(v)) / v2));
}

/**
 * Kinematic bicycle model with an independent pose; never follows the route by itself.
 * With a route attached, every step also resolves the road-boundary collision and keeps
 * the route coordinates (s, d) of the car center up to date.
 */
export class Vehicle {
  x = 0;
  z = 0;
  /** Three.js rotation.y; forward = (-sin yaw, -cos yaw). */
  yaw = 0;
  /** Signed speed along the heading (m/s), negative while reversing. */
  speed = 0;
  /** Normalized steering position, -1 (left) .. +1 (right). */
  steer = 0;
  /** True while the last step braked (S while rolling forward, W while rolling backward). */
  braking = false;
  s = 0;
  d = 0;
  /** Longitudinal / lateral (positive = toward the left) acceleration of the last step (m/s^2). */
  longAccel = 0;
  latAccel = 0;
  /** True when the last step touched a road boundary. */
  inContact = false;
  /** Seconds since the last boundary contact. */
  sinceContact = Infinity;
  /** Largest fresh-impact normal speed (m/s) since the owner last cleared it. */
  impact = 0;
  private stopHold = 0;
  private legal = { x: 0, z: 0, yaw: 0, s: 0 };

  constructor(readonly route?: Route) {}

  /** Places the car at route coordinates facing along the route, at rest. */
  place(s: number, d: number): void {
    const route = this.route;
    if (!route) throw new Error('place() needs a route');
    const p = route.pointAt(s, d);
    this.setPose(p.x, p.z, route.headingAt(s));
    this.s = s;
    this.d = d;
    this.saveLegal();
  }

  setPose(x: number, z: number, yaw: number, speed = 0): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = speed;
    this.steer = 0;
    this.braking = false;
    this.stopHold = 0;
    this.longAccel = 0;
    this.latAccel = 0;
    this.inContact = false;
    this.sinceContact = Infinity;
    if (this.route) {
      const p = this.route.project(x, z);
      this.s = p.s;
      this.d = p.d;
      this.saveLegal();
    }
  }

  step(input: DriveInput, dt: number): void {
    this.integrate(input, dt);
    const route = this.route;
    if (!route) return;
    const touching = resolveRoadContact(this, route, dt);
    this.inContact = touching;
    this.sinceContact = touching ? 0 : this.sinceContact + dt;
    const p = route.project(this.x, this.z, this.s, 20);
    this.s = p.s;
    this.d = p.d;
    const ok =
      Number.isFinite(this.x + this.z + this.yaw + this.speed + this.s) &&
      this.d > route.dMin - 1.5 &&
      this.d < route.dMax + 1.5 &&
      this.s > -2 &&
      this.s < route.length + 2;
    if (ok) this.saveLegal();
    else this.restoreLegal();
  }

  /** Kinematics only (no collision). */
  integrate(input: DriveInput, dt: number): void {
    const V = CONFIG.vehicle;
    const vmax = V.maxSpeedKmh * KMH;
    const vrev = V.maxReverseKmh * KMH;
    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    const v0 = this.speed;
    let v = v0;
    const drag = (u: number) => V.rollingDrag + V.airDrag * u * u;
    this.braking = false;

    if (brake > 0 && v > 0.01) {
      v = Math.max(0, v - (V.brakeDecel * brake + drag(v)) * dt);
      this.stopHold = 0;
      this.braking = true;
    } else if (throttle > 0 && v < -0.01) {
      v = Math.min(0, v + (V.brakeDecel * throttle + drag(v)) * dt);
      this.braking = true;
    } else if (brake > 0) {
      if (v > -0.01 && this.stopHold < V.reverseDelay) {
        this.stopHold += dt;
        v = 0;
      } else {
        const taper = Math.max(0, 1 - (v / vrev) ** 2);
        v = Math.max(-vrev, v - V.reverseAccel * brake * taper * dt);
      }
    } else if (throttle > 0) {
      const vf = Math.max(0, v);
      const drive = throttle * Math.min(V.accel, V.power / Math.max(vf, 1));
      v = Math.min(vmax, Math.max(0, vf + (drive - drag(vf)) * dt));
      this.stopHold = 0;
    } else {
      const dec = drag(v) * dt;
      v = Math.abs(v) <= dec ? 0 : v - Math.sign(v) * dec;
      this.stopHold = 0;
    }
    this.speed = v;

    const u = Math.min(1, Math.abs(v0) / vmax);
    const target = clamp(input.steer, -1, 1);
    const towardCenter = target * this.steer < 0 || Math.abs(target) < Math.abs(this.steer);
    const rate = towardCenter ? V.steerReturnRate : V.steerRate + (V.steerRateHigh - V.steerRate) * u * u;
    this.steer = moveTowards(this.steer, target, rate * dt);

    const vm = 0.5 * (v0 + v);
    const wheel = this.steer * steerLimit(vm);
    const yawRate = (-vm * Math.tan(wheel)) / V.wheelbase;
    const yawMid = this.yaw + yawRate * dt * 0.5;
    this.x += -Math.sin(yawMid) * vm * dt;
    this.z += -Math.cos(yawMid) * vm * dt;
    this.yaw += yawRate * dt;
    this.longAccel = (v - v0) / dt;
    this.latAccel = vm * yawRate;
  }

  private saveLegal(): void {
    this.legal.x = this.x;
    this.legal.z = this.z;
    this.legal.yaw = this.yaw;
    this.legal.s = this.s;
  }

  private restoreLegal(): void {
    const l = this.legal;
    this.x = l.x;
    this.z = l.z;
    this.yaw = l.yaw;
    this.s = l.s;
    this.speed = 0;
    this.steer = 0;
    if (this.route) this.d = this.route.project(l.x, l.z, l.s, 20).d;
  }
}
