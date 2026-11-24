import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { dirFromYaw, Route, yawFromDir } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';
import type { RouteData, Vec2 } from '../src/route/types';

const data = makeSyntheticRoute();
const route = new Route(data);
const { turn } = data;
const L = route.length;
const H = route.spacing;

/** Wraps an angle to (-π, π]. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function roundTrip(r: Route, s: number, d: number, hint: number | undefined = s) {
  const p = r.pointAt(s, d);
  const q = r.project(p.x, p.z, hint);
  return { ds: q.s - s, dd: q.d - d, q };
}

/** Max |Δs| and |Δd| of pointAt → project over s ∈ [s0, s1] and the given offsets. */
function maxRoundTripError(r: Route, s0: number, s1: number, offsets: number[], step: number) {
  let ds = 0;
  let dd = 0;
  for (let s = s0; s <= s1; s += step) {
    for (const d of offsets) {
      const e = roundTrip(r, s, d);
      ds = Math.max(ds, Math.abs(e.ds));
      dd = Math.max(dd, Math.abs(e.dd));
    }
  }
  return { ds, dd };
}

/**
 * Unrounded test route: 60 m east, an exact circular left turn of radius R (90°),
 * then 60 m north, sampled every h meters along the arc length.
 */
function exactTurnRoute(R: number, h = 2) {
  const L1 = 60;
  const La = (R * Math.PI) / 2;
  const total = L1 + La + 60;
  const pts: Vec2[] = [];
  for (let i = 0; i * h <= total + 1e-9; i++) {
    const s = i * h;
    if (s <= L1) pts.push([s, 0]);
    else if (s <= L1 + La) {
      const a = (s - L1) / R;
      pts.push([L1 + R * Math.sin(a), -R * (1 - Math.cos(a))]);
    } else pts.push([L1 + R, -R - (s - L1 - La)]);
  }
  const d: RouteData = { ...makeSyntheticRoute(), centerline: pts };
  d.meta = { ...d.meta, sampleSpacing: h };
  return { r: new Route(d), arc0: L1, arc1: L1 + La };
}

describe('synthetic route fixture', () => {
  it('starts at the origin heading east and ends after a left turn heading north', () => {
    const p0 = route.pointAt(0);
    expect(p0.x).toBeCloseTo(0, 9);
    expect(p0.z).toBeCloseTo(0, 9);
    expect(route.headingAt(10)).toBeCloseTo(-Math.PI / 2, 9);
    expect(route.headingAt(L - 10)).toBeCloseTo(0, 9);
    expect(turn.direction).toBe('left');
    expect(data.finish.s).toBeGreaterThan(turn.s1);
    expect(data.finish.s).toBeLessThan(L);
  });

  it('has three ordered turns (right, left, left) and the legacy turn is the last one', () => {
    expect(route.turns.map((t) => t.direction)).toEqual(['right', 'left', 'left']);
    route.turns.forEach((t, i) => {
      expect(t.s1).toBeGreaterThan(t.s0);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.radius).toBeGreaterThan(20);
      if (i > 0) expect(t.s0).toBeGreaterThan(route.turns[i - 1].s1 + 300);
    });
    expect(route.turns.at(-1)).toMatchObject(turn);
  });

  it('turns ±90° at each turn in the declared direction', () => {
    for (const t of route.turns) {
      const delta = wrap(route.headingAt(t.s1 + 5) - route.headingAt(t.s0 - 5));
      expect(delta, t.name).toBeCloseTo(t.direction === 'left' ? Math.PI / 2 : -Math.PI / 2, 6);
    }
  });

  it('right turn: the inside of the arc is on the positive side', () => {
    const t = route.turns[0];
    const mid = (t.s0 + t.s1) / 2;
    const p = route.pointAt(mid, 10);
    expect(route.project(p.x, p.z, mid).d).toBeCloseTo(10, 1);
    // Overshooting straight on past a right turn ends up on the outside (d < 0).
    const t0 = route.pointAt(t.s0);
    const tan = route.tangentAt(t.s0 - 5);
    const q = route.project(t0.x + tan.x * 20, t0.z + tan.z * 20, t.s0);
    expect(q.d).toBeLessThan(0);
  });
});

describe('Route.nextTurn', () => {
  const [t1, t2, t3] = route.turns;

  it('returns the first turn not yet completed, then null after the last', () => {
    expect(route.nextTurn(0)).toBe(t1);
    expect(route.nextTurn(t1.s0 - 1)).toBe(t1);
    expect(route.nextTurn((t1.s0 + t1.s1) / 2)).toBe(t1);
    expect(route.nextTurn(t1.s1 + 0.01)).toBe(t2);
    expect(route.nextTurn(t2.s1 + 1)).toBe(t3);
    expect(route.nextTurn(t3.s1)).toBeNull();
    expect(route.nextTurn(L + 10)).toBeNull();
  });

  it('falls back to the legacy single turn when turns[] is missing', () => {
    const legacy = new Route({ ...data, turns: undefined });
    expect(legacy.turns).toEqual([data.turn]);
    expect(legacy.nextTurn(0)).toEqual(data.turn);
  });
});

describe('pointAt → project round trip', () => {
  it('is exact on the centerline (d = 0) along the whole route, straights and arcs', () => {
    for (let s = 0; s <= L; s += 0.37) {
      const e = roundTrip(route, s, 0);
      expect(Math.abs(e.ds), `s=${s}`).toBeLessThan(1e-3);
      expect(Math.abs(e.dd), `s=${s}`).toBeLessThan(1e-3);
    }
  });

  it('is exact on the centerline without a hint (global search)', () => {
    for (let s = 0; s <= L; s += 25) {
      const e = roundTrip(route, s, 0, undefined);
      expect(Math.abs(e.ds), `s=${s}`).toBeLessThan(1e-3);
      expect(Math.abs(e.dd), `s=${s}`).toBeLessThan(1e-3);
    }
  });

  it('is exact off the centerline on straights (first and last straight)', () => {
    const offsets = [-7, -3.5, -1, 1, 3.5, 7];
    const first = maxRoundTripError(route, 5, 690, offsets, 0.29);
    const last = maxRoundTripError(route, turn.s1 + 10, L - 2, offsets, 0.29);
    expect(first.ds).toBeLessThan(1e-3);
    expect(first.dd).toBeLessThan(1e-3);
    expect(last.ds).toBeLessThan(1e-3);
    expect(last.dd).toBeLessThan(1e-3);
  });

  // pointAt offsets along the interpolated vertex normal while project drops a
  // perpendicular onto the chord, so off-centerline s differs by up to |d|·h/(2R) on an
  // arc of radius R sampled every h meters; d stays within |d|·(h/2R)².
  for (const R of [30, 300, 1800]) {
    it(`is exact on the centerline and within |d|·h/2R off it on an exact R=${R} m arc`, () => {
      const { r, arc0, arc1 } = exactTurnRoute(R);
      const onLine = maxRoundTripError(r, arc0 + 1, arc1 - 1, [0], 0.05);
      expect(onLine.ds).toBeLessThan(1e-3);
      expect(onLine.dd).toBeLessThan(1e-3);
      for (const d of [-7, -3.5, 3.5, 7]) {
        const off = maxRoundTripError(r, arc0 + 1, arc1 - 1, [d], 0.05);
        const k = r.spacing / (2 * R);
        expect(off.ds, `d=${d}`).toBeLessThanOrEqual(Math.abs(d) * k + 1e-3);
        expect(off.dd, `d=${d}`).toBeLessThanOrEqual(Math.abs(d) * k * k + 1e-3);
      }
    });
  }

  it('stays on the correct point and side everywhere on the synthetic route (road width)', () => {
    for (let s = 0; s <= L; s += 0.53) {
      for (const d of [-7, -3.5, 3.5, 7]) {
        const e = roundTrip(route, s, d);
        expect(Math.abs(e.ds), `s=${s} d=${d}`).toBeLessThan(0.6);
        expect(Math.abs(e.dd), `s=${s} d=${d}`).toBeLessThan(0.05);
        expect(Math.sign(e.q.d)).toBe(Math.sign(d));
      }
    }
  });
});

describe('projection near the 90° turn', () => {
  it('tracks a corner-cutting line through the turn without jumping branches', () => {
    // Racing line: right side on entry, inside (left, d < 0) apex, right side on exit.
    const a = turn.s0 - 60;
    const b = turn.s1 + 60;
    const mid = (turn.s0 + turn.s1) / 2;
    let prev = a;
    for (let s = a; s <= b; s += 0.5) {
      const d = 5 - 11.5 * Math.exp(-(((s - mid) / 25) ** 2));
      const p = route.pointAt(s, d);
      const q = route.project(p.x, p.z, prev);
      // On the outside of a bend the foot can rest on a vertex for a few cm, so s is
      // non-decreasing rather than strictly increasing.
      if (s > a) {
        expect(q.s - prev, `s=${s}`).toBeGreaterThanOrEqual(0);
        expect(q.s - prev, `s=${s}`).toBeLessThan(1.5);
      }
      expect(Math.abs(q.s - s), `s=${s}`).toBeLessThan(0.6);
      expect(Math.abs(q.d - d), `s=${s}`).toBeLessThan(0.05);
      prev = q.s;
    }
  });

  it('keeps an overshooting car (straight on past the turn) on the turn, outside (d > 0)', () => {
    const t0 = route.pointAt(turn.s0);
    let prev = turn.s0;
    for (let k = 0; k <= 25; k += 0.5) {
      const q = route.project(t0.x + k, t0.z, prev);
      expect(q.s, `k=${k}`).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(q.s, `k=${k}`).toBeLessThan(turn.s1 + 1);
      // Synthetic metadata s values lag Route's chord-sum s by ~0.5 m near the turn.
      if (k >= 3) expect(q.d, `k=${k}`).toBeGreaterThan(0);
      prev = q.s;
    }
  });

  it('has the inside of the left turn on the negative side', () => {
    const mid = (turn.s0 + turn.s1) / 2;
    const p = route.pointAt(mid, -10);
    const q = route.project(p.x, p.z, mid);
    expect(q.d).toBeCloseTo(-10, 1);
  });

  it('only searches within the window around the hint', () => {
    const p = route.pointAt(1000, 0);
    expect(route.project(p.x, p.z).s).toBeCloseTo(1000, 6);
    const q = route.project(p.x, p.z, 3000);
    expect(Math.abs(q.s - 3000)).toBeLessThanOrEqual(80 + 2 * H);
    // Non-finite hints fall back to the global search.
    expect(route.project(p.x, p.z, Number.NaN).s).toBeCloseTo(1000, 6);
  });
});

describe('extrapolation beyond the ends', () => {
  it('extends the first segment before the start (s < 0)', () => {
    const c = route.pointAt(-25, 0);
    expect(c.x).toBeCloseTo(-25, 9);
    expect(c.z).toBeCloseTo(0, 9);
    const p = route.pointAt(-25, 4);
    expect(p.x).toBeCloseTo(-25, 9);
    expect(p.z).toBeCloseTo(4, 9);
    for (const hint of [0, undefined]) {
      const q = route.project(-25, 4, hint);
      expect(q.s).toBeCloseTo(-25, 6);
      expect(q.d).toBeCloseTo(4, 6);
    }
  });

  it('extends the last segment past the end (s > length)', () => {
    const end = route.pointAt(L);
    const p = route.pointAt(L + 30, 3);
    // Final straight heads north (-z); right of north is east (+x).
    expect(p.x).toBeCloseTo(end.x + 3, 6);
    expect(p.z).toBeCloseTo(end.z - 30, 6);
    for (const hint of [L, undefined]) {
      const q = route.project(p.x, p.z, hint);
      expect(q.s).toBeCloseTo(L + 30, 6);
      expect(q.d).toBeCloseTo(3, 6);
    }
  });

  it('clampS clamps to [0, length]', () => {
    expect(route.clampS(-5)).toBe(0);
    expect(route.clampS(L + 5)).toBe(L);
    expect(route.clampS(123)).toBe(123);
  });
});

describe('lateral sign (d > 0 is right of the driving direction)', () => {
  it('right of eastbound is south (+z)', () => {
    const p = route.pointAt(100, 5);
    expect(p.x).toBeCloseTo(100, 9);
    expect(p.z).toBeCloseTo(5, 9);
    const n = route.normalAt(100);
    expect(n.x).toBeCloseTo(0, 9);
    expect(n.z).toBeCloseTo(1, 9);
    expect(route.project(100, 5, 100).d).toBeCloseTo(5, 9);
    expect(route.project(100, -5, 100).d).toBeCloseTo(-5, 9);
  });

  it('right of northbound is east (+x)', () => {
    const s = L - 50;
    const c = route.pointAt(s);
    expect(route.pointAt(s, 3).x).toBeCloseTo(c.x + 3, 6);
    expect(route.project(c.x + 3, c.z, s).d).toBeCloseTo(3, 6);
    expect(route.project(c.x - 3, c.z, s).d).toBeCloseTo(-3, 6);
  });

  it('dMin/dMax come from the road half widths', () => {
    expect(route.dMin).toBe(-data.road.halfWidthLeft);
    expect(route.dMax).toBe(data.road.halfWidthRight);
  });
});

describe('heading and yaw conventions', () => {
  it('yawFromDir inverts dirFromYaw', () => {
    for (let yaw = -Math.PI + 0.01; yaw <= Math.PI; yaw += 0.05) {
      const v = dirFromYaw(yaw);
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(1, 12);
      expect(wrap(yawFromDir(v.x, v.z) - yaw)).toBeCloseTo(0, 9);
    }
  });

  it('dirFromYaw is the -Z axis of a Three.js object with rotation.y = yaw', () => {
    const o = new THREE.Object3D();
    const fwd = new THREE.Vector3();
    for (let yaw = -Math.PI; yaw <= Math.PI; yaw += 0.25) {
      o.rotation.set(0, yaw, 0);
      fwd.set(0, 0, -1).applyQuaternion(o.quaternion);
      const v = dirFromYaw(yaw);
      expect(fwd.x).toBeCloseTo(v.x, 9);
      expect(fwd.z).toBeCloseTo(v.z, 9);
    }
  });

  it('headingAt, tangentAt and normalAt agree at every sample', () => {
    for (let i = 0; i < route.n; i++) {
      const s = route.cum[i];
      const yaw = route.headingAt(s);
      const t = route.tangentAt(s);
      const f = dirFromYaw(yaw);
      expect(f.x).toBeCloseTo(t.x, 9);
      expect(f.z).toBeCloseTo(t.z, 9);
      const n = route.normalAt(s);
      const right = dirFromYaw(yaw - Math.PI / 2);
      expect(n.x).toBeCloseTo(right.x, 9);
      expect(n.z).toBeCloseTo(right.z, 9);
    }
  });

  it('a left turn increases yaw by ~90°', () => {
    const delta = wrap(route.headingAt(turn.s1 + 5) - route.headingAt(turn.s0 - 5));
    expect(delta).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('segmentAt', () => {
  const last = route.n - 2;

  it('clamps out-of-range and infinite s to the first/last segment', () => {
    expect(route.segmentAt(-5)).toBe(0);
    expect(route.segmentAt(-Infinity)).toBe(0);
    expect(route.segmentAt(0)).toBe(0);
    expect(route.segmentAt(L)).toBe(last);
    expect(route.segmentAt(L + 100)).toBe(last);
    expect(route.segmentAt(Infinity)).toBe(last);
  });

  it('returns a segment containing s, including exactly at sample positions', () => {
    const check = (r: Route, s: number) => {
      const i = r.segmentAt(s);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThanOrEqual(r.n - 2);
      expect(r.cum[i], `s=${s}`).toBeLessThanOrEqual(s);
      expect(r.cum[i + 1], `s=${s}`).toBeGreaterThanOrEqual(s);
    };
    for (let s = 0; s <= L; s += 0.13) check(route, s);
    for (let i = 0; i < route.n; i++) check(route, route.cum[i]);
  });

  it('works when actual sample spacing drifts from meta.sampleSpacing', () => {
    const pts: Vec2[] = [];
    let x = 0;
    for (let i = 0; i < 400; i++) {
      pts.push([x, 0]);
      x += i % 2 ? 3 : 1;
    }
    const r = new Route({ ...makeSyntheticRoute(), centerline: pts });
    expect(r.spacing).toBe(2);
    for (let s = 0; s <= r.length; s += 0.21) {
      const i = r.segmentAt(s);
      expect(r.cum[i]).toBeLessThanOrEqual(s);
      expect(r.cum[i + 1]).toBeGreaterThanOrEqual(s);
    }
  });
});

describe('sectionAt', () => {
  it('returns the section containing s and the last section past the end', () => {
    for (const sec of data.sections) {
      expect(route.sectionAt((sec.s0 + Math.min(sec.s1, L)) / 2).id).toBe(sec.id);
    }
    expect(route.sectionAt(L + 50).id).toBe(data.sections[data.sections.length - 1].id);
  });
});
