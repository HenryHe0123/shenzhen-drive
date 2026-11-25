import { describe, expect, it } from 'vitest';
import { CONFIG, KMH } from '../src/config';
import { Damage, impactTier } from '../src/vehicle/damage';
import { Vehicle } from '../src/vehicle/Vehicle';

const C = CONFIG.collision;
const DT = 1 / CONFIG.physics.hz;
const kmh = (v: number) => v * KMH;

function advance(d: Damage, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += DT) d.update(DT);
}

describe('impact tiers', () => {
  it('grades by the normal speed into the wall', () => {
    expect(impactTier(kmh(C.lightKmh - 1))).toBe('scrape');
    expect(impactTier(kmh(C.lightKmh + 1))).toBe('light');
    expect(impactTier(kmh(C.heavyKmh + 1))).toBe('heavy');
    expect(impactTier(kmh(C.severeKmh + 1))).toBe('severe');
    // a 300 km/h graze at 3° is a scrape-to-light hit, not a heavy one
    expect(impactTier(kmh(300) * Math.sin((3 * Math.PI) / 180))).toBe('light');
  });
});

describe('damage', () => {
  it('ignores scrapes and light hits', () => {
    const d = new Damage();
    expect(d.hit(kmh(30))).toBe('light');
    expect(d.active).toBe(false);
    expect(d.powerScale).toBe(1);
  });

  it('recovers linearly from a heavy hit', () => {
    const d = new Damage();
    expect(d.hit(kmh(C.heavyKmh))).toBe('heavy');
    expect(d.stall).toBe(0);
    expect(d.powerScale).toBeCloseTo(1 - C.damageLoss[0], 6);
    advance(d, C.damageSeconds[0] / 2);
    expect(d.powerScale).toBeCloseTo(1 - C.damageLoss[0] / 2, 2);
    advance(d, C.damageSeconds[0] / 2 + 0.01);
    expect(d.powerScale).toBe(1);
    expect(d.active).toBe(false);
  });

  it('stalls after a severe hit, then recovers from the full loss', () => {
    const d = new Damage();
    expect(d.hit(kmh(C.severeKmh + 20))).toBe('severe');
    expect(d.stall).toBe(C.stallSeconds);
    advance(d, C.stallSeconds);
    expect(d.stall).toBe(0);
    expect(d.powerScale).toBeCloseTo(1 - C.damageLoss[1], 2);
    expect(d.secondsLeft).toBeCloseTo(C.damageSeconds[1], 1);
    advance(d, C.damageSeconds[1] + 0.01);
    expect(d.active).toBe(false);
  });

  it('a weaker hit does not shorten a recovery, a stronger one restarts it', () => {
    const d = new Damage();
    d.hit(kmh(90));
    advance(d, 1);
    const before = { scale: d.powerScale, left: d.secondsLeft };
    d.hit(kmh(55));
    expect(d.powerScale).toBeCloseTo(before.scale, 6);
    expect(d.secondsLeft).toBeCloseTo(before.left, 6);
    d.hit(kmh(99));
    expect(d.powerScale).toBeLessThan(before.scale);
    expect(d.secondsLeft).toBeGreaterThan(before.left);
    d.reset();
    expect(d.active).toBe(false);
  });
});

describe('vehicle power scale', () => {
  it('caps the top speed of a damaged car and coasts down from above it', () => {
    const vmax = CONFIG.vehicle.maxSpeedKmh * KMH;
    const v = new Vehicle();
    v.powerScale = 0.5;
    for (let i = 0; i < 60 * CONFIG.physics.hz; i++) v.integrate({ throttle: 1, brake: 0, steer: 0 }, DT);
    expect(v.speed).toBeCloseTo(0.5 * vmax, 1);

    const fast = new Vehicle();
    fast.setPose(0, 0, 0, 0.9 * vmax);
    fast.powerScale = 0.5;
    fast.integrate({ throttle: 1, brake: 0, steer: 0 }, DT);
    expect(fast.speed).toBeLessThan(0.9 * vmax);
    expect(fast.speed).toBeGreaterThan(0.89 * vmax);
  });
});
