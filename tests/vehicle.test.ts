import { describe, expect, it } from 'vitest';
import { chaseYawLerp } from '../src/camera/ChaseCamera';
import { CONFIG, KMH } from '../src/config';
import { Route } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';
import { carCorners } from '../src/vehicle/collision';
import { latAccelLimit, Vehicle, type DriveInput } from '../src/vehicle/Vehicle';

const DT = 1 / (CONFIG.physics.hz * CONFIG.physics.substeps);
const VMAX = CONFIG.vehicle.maxSpeedKmh * KMH;
const VREV = CONFIG.vehicle.maxReverseKmh * KMH;
const EAST = -Math.PI / 2;
const G = 9.81;

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

/** Seconds and meters of full braking from `speed` to a stop. */
function brakeFrom(speed: number): { t: number; dist: number } {
  const v = freeCar(speed);
  let t = 0;
  while (v.speed > 0 && t < 30) {
    v.step({ throttle: 0, brake: 1, steer: 0 }, DT);
    t += DT;
  }
  return { t, dist: v.x };
}

describe('vehicle kinematics', () => {
  it('reaches but never exceeds 350 km/h, with an SU7 Ultra-like launch', () => {
    expect(CONFIG.vehicle.maxSpeedKmh).toBe(350);
    const v = freeCar();
    const at: Record<number, number> = {};
    let peak = 0;
    let t = 0;
    run(v, { throttle: 1, brake: 0, steer: 0 }, 40, (c) => {
      t += DT;
      peak = Math.max(peak, c.speed);
      for (const kmh of [100, 200, 300, 345]) if (!at[kmh] && c.speed >= kmh * KMH) at[kmh] = t;
    });
    expect(peak).toBeLessThanOrEqual(VMAX + 1e-9);
    expect(v.speed).toBeGreaterThan(VMAX - 1e-6);
    expect(at[100]).toBeGreaterThan(2.2);
    expect(at[100]).toBeLessThan(2.5);
    expect(at[200]).toBeGreaterThan(5.5);
    expect(at[200]).toBeLessThan(6.5);
    expect(at[300]).toBeGreaterThan(12);
    expect(at[300]).toBeLessThan(14);
    // slow approach to the limiter
    expect(at[345] - at[300]).toBeGreaterThan(5);
    expect(v.x).toBeGreaterThan(0);
    expect(Math.abs(v.z)).toBeLessThan(1e-6);
  });

  it('coasts down gently at city speed and noticeably at top speed', () => {
    const city = freeCar(100 * KMH);
    run(city, { throttle: 0, brake: 0, steer: 0 }, 3);
    expect(100 * KMH - city.speed).toBeGreaterThan(1);
    expect(100 * KMH - city.speed).toBeLessThan(3);

    const top = freeCar(VMAX);
    run(top, { throttle: 0, brake: 0, steer: 0 }, 3);
    expect(VMAX - top.speed).toBeGreaterThan(5);
    expect(VMAX - top.speed).toBeLessThan(12);
  });

  it('brakes hard: ~25 m from 100 km/h, under 7 s from 350 km/h', () => {
    const city = brakeFrom(100 * KMH);
    expect(city.dist).toBeGreaterThan(22);
    expect(city.dist).toBeLessThan(28);
    const top = brakeFrom(VMAX);
    expect(top.t).toBeLessThan(7);
    expect(top.dist).toBeGreaterThan(220);
    expect(top.dist).toBeLessThan(320);
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

  it('flags braking for the brake lights', () => {
    const v = freeCar(20);
    v.step({ throttle: 0, brake: 1, steer: 0 }, DT);
    expect(v.braking).toBe(true);
    v.step({ throttle: 1, brake: 0, steer: 0 }, DT);
    expect(v.braking).toBe(false);
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

  it('corners at ~1.05 g at city speed and ~0.87 g at top speed', () => {
    const city = freeCar(72 * KMH);
    run(city, { throttle: 0, brake: 0, steer: 1 }, 1);
    expect(Math.abs(city.latAccel) / G).toBeGreaterThan(1.0);
    expect(Math.abs(city.latAccel) / G).toBeLessThan(1.1);

    const top = freeCar(VMAX);
    run(top, { throttle: 1, brake: 0, steer: 1 }, 1);
    expect(Math.abs(top.latAccel)).toBeLessThanOrEqual(latAccelLimit(VMAX) + 1e-6);
    expect(Math.abs(top.latAccel) / G).toBeGreaterThan(0.8);
    expect(Math.abs(top.latAccel) / G).toBeLessThan(0.92);
  });

  it('slews the steering more slowly at high speed', () => {
    const slow = freeCar(10);
    const fast = freeCar(VMAX);
    run(slow, { throttle: 0, brake: 0, steer: 1 }, 0.2);
    run(fast, { throttle: 1, brake: 0, steer: 1 }, 0.2);
    expect(slow.steer).toBeGreaterThan(0.65);
    expect(fast.steer).toBeLessThan(0.4);
  });

  it('is stable at top speed: a full-lock tap moves less than a few meters sideways', () => {
    const v = freeCar(VMAX);
    run(v, { throttle: 1, brake: 0, steer: 1 }, 0.3);
    run(v, { throttle: 1, brake: 0, steer: 0 }, 0.3);
    const heading = Math.abs(v.yaw - EAST);
    expect(heading).toBeLessThan(0.03);
    expect(v.z).toBeGreaterThan(0.1);
    expect(v.z).toBeLessThan(2);
  });

  it('changes lanes smoothly at 300 km/h', () => {
    const v = freeCar(300 * KMH);
    let maxYawRate = 0;
    let lastYaw = v.yaw;
    const track = (c: Vehicle) => {
      maxYawRate = Math.max(maxYawRate, Math.abs(c.yaw - lastYaw) / DT);
      lastYaw = c.yaw;
    };
    run(v, { throttle: 1, brake: 0, steer: 1 }, 0.5, track);
    // counter-steer until the car points straight again
    let t = 0.5;
    while (v.yaw < EAST - 0.002 && t < 3) {
      v.step({ throttle: 1, brake: 0, steer: -1 }, DT);
      track(v);
      t += DT;
    }
    run(v, { throttle: 1, brake: 0, steer: 0 }, 0.3, track);
    // about one lane over in under 2 s, heading straight, no snap
    expect(t).toBeLessThan(1.6);
    expect(v.z).toBeGreaterThan(1.5);
    expect(v.z).toBeLessThan(5);
    expect(Math.abs(v.yaw - EAST)).toBeLessThan(0.01);
    expect(maxYawRate).toBeLessThan(0.12);
  });
});

describe('keyboard steering feel', () => {
  /** Speed pinned so only the steering is measured. */
  function cruise(v: Vehicle, kmh: number, steer: number, seconds: number, each?: (v: Vehicle) => void): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      v.speed = kmh * KMH;
      v.step({ throttle: 0, brake: 0, steer }, DT);
      each?.(v);
    }
  }

  /** Full right for `hold` s, then 3 s hands off: peak and final heading change (rad) and lateral offset (m). */
  function tap(kmh: number, hold: number) {
    const v = freeCar(kmh * KMH);
    let peak = 0;
    const track = (c: Vehicle) => (peak = Math.max(peak, Math.abs(c.yaw - EAST)));
    cruise(v, kmh, 1, hold, track);
    cruise(v, kmh, 0, 3, track);
    return { peak, final: Math.abs(v.yaw - EAST), lat: v.z };
  }

  // v0.3.1 kept 100 % of a tap's heading: 1.26° at 100, 0.50° at 200, 0.22° at 300 km/h after a 0.15 s tap.
  for (const [kmh, maxFinalDeg] of [
    [100, 0.7],
    [200, 0.28],
    [300, 0.12],
  ] as const) {
    it(`gives back about half of a 0.15 s tap's heading at ${kmh} km/h`, () => {
      const r = tap(kmh, 0.15);
      expect(r.final).toBeLessThan(0.55 * r.peak);
      expect(r.final).toBeGreaterThan(0.4 * r.peak);
      expect((r.final * 180) / Math.PI).toBeLessThan(maxFinalDeg);
      expect(r.lat).toBeGreaterThan(0.3);
    });
  }

  it('keeps the full heading of a deliberate hold', () => {
    const r = tap(100, 0.6);
    expect(r.final).toBeGreaterThan(0.99 * r.peak);
    expect((r.final * 180) / Math.PI).toBeGreaterThan(8);
  });

  it('lets a counter-steer cancel heading instead of giving it back', () => {
    const v = freeCar(200 * KMH);
    cruise(v, 200, 1, 0.6);
    cruise(v, 200, 0, 0.2);
    cruise(v, 200, -1, 0.15);
    cruise(v, 200, 0, 0.4);
    const yaw = v.yaw;
    cruise(v, 200, 0, 3);
    expect(Math.abs(v.yaw - yaw)).toBeLessThan(1e-4);
  });

  it('gives nothing back at parking speeds or in reverse', () => {
    const r = tap(30, 0.15);
    expect(r.final).toBeGreaterThan(0.99 * r.peak);
    const v = freeCar(-5);
    v.step({ throttle: 0, brake: 1, steer: 1 }, DT);
    expect(v.wheelSteer).toBeCloseTo(v.steer, 9);
  });

  it('keeps the tightest circle at 60 km/h near 26 m (CBD turns R30–R40, T1 at ~60 km/h)', () => {
    const v = freeCar(60 * KMH);
    cruise(v, 60, 1, 2);
    const y0 = v.yaw;
    cruise(v, 60, 1, 1);
    const r = (60 * KMH) / Math.abs(v.yaw - y0);
    expect(r).toBeGreaterThan(24);
    expect(r).toBeLessThan(29);
  });

  it('smooths the chase camera yaw more at top speed', () => {
    expect(chaseYawLerp(VMAX)).toBeLessThan(chaseYawLerp(0));
    expect(chaseYawLerp(VMAX)).toBeCloseTo(CONFIG.camera.yawLerpHigh, 9);
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
    it(`keeps all corners inside at 350 km/h steering ${steer > 0 ? 'right' : 'left'} into the wall for 5 s, and slides`, () => {
      const v = new Vehicle(route);
      v.place(100, 1.75);
      v.speed = VMAX;
      const s0 = v.s;
      let allInside = true;
      let contacts = 0;
      let afterHit = 0;
      run(v, { throttle: 1, brake: 0, steer }, 5, (c) => {
        if (!cornersInside(c)) allInside = false;
        if (c.inContact) {
          if (!contacts) afterHit = c.speed;
          contacts++;
        }
      });
      expect(allInside).toBe(true);
      expect(contacts).toBeGreaterThan(100);
      expect(v.impact).toBeGreaterThan(CONFIG.collision.thudMinSpeed);
      // punishing but recoverable: a clear speed loss on impact, still rolling along the wall
      expect(afterHit).toBeLessThan(0.85 * VMAX);
      expect(afterHit).toBeGreaterThan(0.5 * VMAX);
      expect(v.s - s0).toBeGreaterThan(200);
      expect(v.speed).toBeGreaterThan(30);
      expect(Math.abs(v.d)).toBeGreaterThan(5);
    });
  }

  it('does not tunnel when running straight into the 30 m turn at 350 km/h', () => {
    const turn = route.turns[0];
    const v = new Vehicle(route);
    v.place(turn.s0 - 150, 1.75);
    v.speed = VMAX;
    let allInside = true;
    let finite = true;
    let minSpeed = Infinity;
    run(v, { throttle: 0, brake: 0, steer: 0 }, 4, (c) => {
      if (!cornersInside(c, 0.05)) allInside = false;
      if (!Number.isFinite(c.x + c.z + c.yaw + c.speed)) finite = false;
      minSpeed = Math.min(minSpeed, Math.abs(c.speed));
    });
    expect(finite).toBe(true);
    expect(allInside).toBe(true);
    expect(minSpeed).toBeLessThan(0.5 * VMAX);
    expect(v.s).toBeGreaterThan(turn.s0 - 10);
    expect(v.d).toBeGreaterThan(route.dMin - 0.1);
    expect(v.d).toBeLessThan(route.dMax + 0.1);
  });

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

  it('can take the 30 m radius turn at 60 km/h', () => {
    const turn = route.turns[0];
    const v = new Vehicle(route);
    v.place(turn.s0 - 120, 1.75);
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
    expect(v.s).toBeGreaterThan(turn.s1 + 20);
    expect(v.speed).toBeGreaterThan(50 * KMH);
  });
});
