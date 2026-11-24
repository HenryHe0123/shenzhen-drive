import { describe, expect, it } from 'vitest';
import { CONFIG, KMH } from '../src/config';
import { Route } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';
import { carCorners } from '../src/vehicle/collision';
import { Vehicle, type DriveInput } from '../src/vehicle/Vehicle';

const DT = 1 / (CONFIG.physics.hz * CONFIG.physics.substeps);
const VMAX = CONFIG.vehicle.maxSpeedKmh * KMH;
const VREV = CONFIG.vehicle.maxReverseKmh * KMH;
const EAST = -Math.PI / 2;

function run(v: Vehicle, input: DriveInput, seconds: number, each?: (v: Vehicle) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    v.step(input, DT);
    each?.(v);
  }
}

function freeCar(speed = 0): Vehicle {
  const v = new Vehicle();
  v.setPose(0, 0, EAST, speed);
  return v;
}

describe('vehicle kinematics', () => {
  it('accelerates toward but never beyond max speed', () => {
    const v = freeCar();
    let peak = 0;
    let t100 = 0;
    let t = 0;
    run(v, { throttle: 1, brake: 0, steer: 0 }, 40, (c) => {
      t += DT;
      peak = Math.max(peak, c.speed);
      if (!t100 && c.speed >= 100 * KMH) t100 = t;
    });
    expect(peak).toBeLessThanOrEqual(VMAX + 1e-9);
    expect(v.speed).toBeGreaterThan(0.97 * VMAX);
    expect(t100).toBeGreaterThan(2.5);
    expect(t100).toBeLessThan(5);
    expect(v.x).toBeGreaterThan(0);
    expect(Math.abs(v.z)).toBeLessThan(1e-6);
  });

  it('coasts down without input', () => {
    const v = freeCar(30);
    run(v, { throttle: 0, brake: 0, steer: 0 }, 3);
    expect(v.speed).toBeLessThan(28);
    expect(v.speed).toBeGreaterThan(20);
  });

  it('brakes to a stop, then reverses while S is still held', () => {
    const v = freeCar(20);
    let stopped = false;
    let minSpeed = Infinity;
    run(v, { throttle: 0, brake: 1, steer: 0 }, 2, (c) => {
      if (c.speed === 0) stopped = true;
    });
    expect(stopped).toBe(true);
    run(v, { throttle: 0, brake: 1, steer: 0 }, 10, (c) => {
      minSpeed = Math.min(minSpeed, c.speed);
    });
    expect(v.speed).toBeLessThan(-0.9 * VREV);
    expect(minSpeed).toBeGreaterThanOrEqual(-VREV - 1e-9);
    // throttle while reversing brakes first, then drives forward
    run(v, { throttle: 1, brake: 0, steer: 0 }, 3);
    expect(v.speed).toBeGreaterThan(0);
  });

  it('steers left and right in the x-east / z-south frame', () => {
    const left = freeCar(15);
    run(left, { throttle: 0.3, brake: 0, steer: -1 }, 1);
    expect(left.yaw).toBeGreaterThan(EAST);
    expect(left.z).toBeLessThan(-0.5);

    const right = freeCar(15);
    run(right, { throttle: 0.3, brake: 0, steer: 1 }, 1);
    expect(right.yaw).toBeLessThan(EAST);
    expect(right.z).toBeGreaterThan(0.5);
  });

  it('is stable at top speed: a full-lock tap moves less than a few meters sideways', () => {
    const v = freeCar(VMAX);
    run(v, { throttle: 1, brake: 0, steer: 1 }, 0.3);
    run(v, { throttle: 1, brake: 0, steer: 0 }, 0.3);
    const heading = Math.abs(v.yaw - EAST);
    expect(heading).toBeLessThan(0.12);
    expect(v.z).toBeGreaterThan(0.2);
    expect(v.z).toBeLessThan(4);
  });
});

describe('road boundary collision', () => {
  const route = new Route(makeSyntheticRoute());

  function cornersInside(v: Vehicle, eps = 0.02): boolean {
    const c = carCorners(v.x, v.z, v.yaw);
    for (let k = 0; k < 4; k++) {
      const p = route.project(c[2 * k], c[2 * k + 1], v.s, 20);
      if (p.d > route.dMax + eps || p.d < route.dMin - eps) return false;
    }
    return true;
  }

  for (const steer of [1, -1]) {
    it(`keeps all corners inside at 180 km/h steering ${steer > 0 ? 'right' : 'left'} into the wall for 5 s`, () => {
      const v = new Vehicle(route);
      v.place(100, 1.75);
      v.speed = VMAX;
      const s0 = v.s;
      let allInside = true;
      let contacts = 0;
      run(v, { throttle: 1, brake: 0, steer }, 5, (c) => {
        if (!cornersInside(c)) allInside = false;
        if (c.inContact) contacts++;
      });
      expect(allInside).toBe(true);
      expect(contacts).toBeGreaterThan(100);
      expect(v.impact).toBeGreaterThan(CONFIG.collision.thudMinSpeed);
      expect(v.s - s0).toBeGreaterThan(100);
      expect(v.speed).toBeGreaterThan(10);
      expect(Math.abs(v.d)).toBeGreaterThan(5);
    });
  }

  it('stops on a head-on hit and can reverse away from the wall', () => {
    const v = new Vehicle(route);
    v.place(200, 0);
    v.yaw = route.headingAt(200) - Math.PI / 2 + 0.2; // pointing at the right wall
    v.speed = 25;
    let allInside = true;
    for (let i = 0; i < 600 && !v.inContact; i++) v.step({ throttle: 0, brake: 0, steer: 0 }, DT);
    expect(v.inContact).toBe(true);
    expect(v.speed).toBeLessThan(5);
    expect(v.impact).toBeGreaterThan(20);
    const dAtWall = v.d;
    run(v, { throttle: 0, brake: 1, steer: 0 }, 3, (c) => {
      if (!cornersInside(c)) allInside = false;
    });
    expect(allInside).toBe(true);
    expect(v.speed).toBeLessThan(0);
    expect(v.d).toBeLessThan(dAtWall - 2);
  });

  it('treats the route start as a wall', () => {
    const v = new Vehicle(route);
    v.place(10, 1.75);
    run(v, { throttle: 0, brake: 1, steer: 0 }, 8);
    expect(v.s).toBeGreaterThan(CONFIG.collision.startMargin + CONFIG.vehicle.length / 2 - 0.1);
  });

  it('can take the 30 m radius left turn at 60 km/h', () => {
    const data = route.data;
    const v = new Vehicle(route);
    v.place(data.turn.s0 - 120, 1.75);
    v.speed = 60 * KMH;
    let allInside = true;
    let contacts = 0;
    run(v, { throttle: 0, brake: 0, steer: 0 }, 0.01);
    // simple look-ahead steering controller, holding ~60 km/h
    const n = Math.round(14 / DT);
    for (let i = 0; i < n; i++) {
      const target = route.pointAt(v.s + 9, 1.0);
      const dx = target.x - v.x;
      const dz = target.z - v.z;
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      const cross = fx * dz - fz * dx; // > 0: target is to the right
      const steer = Math.max(-1, Math.min(1, cross / Math.hypot(dx, dz) / 0.15));
      const throttle = v.speed < 60 * KMH ? 0.6 : 0;
      v.step({ throttle, brake: 0, steer }, DT);
      if (!cornersInside(v)) allInside = false;
      if (v.inContact) contacts++;
    }
    expect(allInside).toBe(true);
    expect(contacts).toBe(0);
    expect(v.s).toBeGreaterThan(data.turn.s1 + 20);
    expect(v.speed).toBeGreaterThan(50 * KMH);
  });
});
