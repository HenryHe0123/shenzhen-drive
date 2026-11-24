import { describe, expect, it } from 'vitest';
import { Route } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';
import type { BuildingsData, RouteData, SectionId, Vec2 } from '../src/route/types';

// Globs resolve to {} when the pipeline has not produced the file yet.
const routeJson =
  Object.values(import.meta.glob<RouteData>('../public/data/route.json', { eager: true, import: 'default' }))[0] ??
  null;
const buildingsJson =
  Object.values(
    import.meta.glob<BuildingsData>('../public/data/buildings.json', { eager: true, import: 'default' }),
  )[0] ?? null;

const SECTION_IDS: readonly string[] = ['nanshan', 'oct', 'chegongmiao', 'futian'] satisfies SectionId[];
const MAX_KINK_DEG = 2;
const TURN_MARGIN = 5;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const DEG = 180 / Math.PI;

/** Index of the first element failing `ok`, as an error message; [] when all pass. */
function firstBad<T>(arr: readonly T[], ok: (v: T) => boolean, what: string): string[] {
  const i = arr.findIndex((v) => !ok(v));
  return i < 0 ? [] : [`${what}[${i}] invalid: ${JSON.stringify(arr[i]).slice(0, 160)}`];
}

function routeShapeErrors(r: RouteData): string[] {
  const e: string[] = [];
  const req = (ok: unknown, msg: string) => {
    if (!ok) e.push(msg);
  };
  const m = r.meta;
  req(m && typeof m === 'object', 'meta missing');
  if (m) {
    req(isStr(m.generatedAt) && !Number.isNaN(Date.parse(m.generatedAt)), 'meta.generatedAt must be a date string');
    req(m.osmTimestamp === null || isStr(m.osmTimestamp), 'meta.osmTimestamp must be string | null');
    req(isStr(m.source), 'meta.source');
    req(isNum(m.origin?.lon) && isNum(m.origin?.lat), 'meta.origin {lon, lat}');
    req(isNum(m.realLength) && m.realLength > 0, 'meta.realLength > 0');
    req(isNum(m.length) && m.length > 0, 'meta.length > 0');
    req(isNum(m.sampleSpacing) && m.sampleSpacing > 0, 'meta.sampleSpacing > 0');
    req(Array.isArray(m.cuts), 'meta.cuts array');
    if (Array.isArray(m.cuts)) e.push(...firstBad(m.cuts, (c) => isNum(c.s0) && isNum(c.s1) && c.s0 < c.s1, 'meta.cuts'));
  }
  req(Array.isArray(r.centerline) && r.centerline.length >= 2, 'centerline needs >= 2 points');
  if (Array.isArray(r.centerline)) e.push(...firstBad(r.centerline, isVec2, 'centerline'));
  const road = r.road;
  req(
    road &&
      Number.isInteger(road.lanes) &&
      road.lanes >= 1 &&
      [road.laneWidth, road.halfWidthLeft, road.halfWidthRight].every((v) => isNum(v) && v > 0),
    'road {lanes, laneWidth, halfWidthLeft, halfWidthRight}',
  );
  if (r.oppositeOffset !== undefined) {
    req(
      Array.isArray(r.oppositeOffset) && r.oppositeOffset.length === r.centerline?.length,
      'oppositeOffset must have one value per centerline sample',
    );
    if (Array.isArray(r.oppositeOffset)) e.push(...firstBad(r.oppositeOffset, (v) => isNum(v) && v < 0, 'oppositeOffset'));
  }
  req(Array.isArray(r.sections) && r.sections.length > 0, 'sections non-empty');
  if (Array.isArray(r.sections)) {
    e.push(...firstBad(r.sections, (s) => SECTION_IDS.includes(s.id) && isStr(s.name) && isNum(s.s0) && isNum(s.s1), 'sections'));
  }
  req(Array.isArray(r.checkpoints) && r.checkpoints.length > 0, 'checkpoints non-empty');
  if (Array.isArray(r.checkpoints)) e.push(...firstBad(r.checkpoints, (c) => isNum(c.s) && isStr(c.name), 'checkpoints'));
  req(r.finish && isNum(r.finish.s) && isStr(r.finish.name), 'finish {s, name}');
  req(
    r.turn && isNum(r.turn.s0) && isNum(r.turn.s1) && ['left', 'right'].includes(r.turn.direction) && isStr(r.turn.name),
    'turn {s0, s1, direction, name}',
  );
  if (r.intersections !== undefined) {
    req(Array.isArray(r.intersections), 'intersections array');
    if (Array.isArray(r.intersections)) e.push(...firstBad(r.intersections, (x) => isNum(x.s) && isStr(x.name), 'intersections'));
  }
  req(Array.isArray(r.landmarks), 'landmarks array');
  if (Array.isArray(r.landmarks)) {
    e.push(
      ...firstBad(
        r.landmarks,
        (l) =>
          isStr(l.id) &&
          isStr(l.name) &&
          [l.x, l.z, l.s, l.d].every(isNum) &&
          (l.footprint === undefined || (l.footprint.length >= 3 && l.footprint.every(isVec2))) &&
          (l.height === undefined || (isNum(l.height) && l.height > 0)),
        'landmarks',
      ),
    );
  }
  req(Array.isArray(r.signs), 'signs array');
  if (Array.isArray(r.signs)) {
    e.push(...firstBad(r.signs, (g) => isNum(g.s) && (g.side === 'left' || g.side === 'right') && isStr(g.text), 'signs'));
  }
  return e;
}

/** Checkpoints, finish, turn and sections are ordered and lie on the route. */
function orderErrors(r: RouteData, length: number): string[] {
  const e: string[] = [];
  const cps = r.checkpoints.map((c) => c.s);
  if (!(cps[0] > 0)) e.push(`first checkpoint ${cps[0]} must be > 0`);
  for (let i = 1; i < cps.length; i++) {
    if (!(cps[i] > cps[i - 1])) e.push(`checkpoint ${i} (s=${cps[i]}) not after checkpoint ${i - 1} (s=${cps[i - 1]})`);
  }
  if (!(cps[cps.length - 1] < r.finish.s)) e.push(`last checkpoint ${cps[cps.length - 1]} must be < finish ${r.finish.s}`);
  if (!(r.finish.s < length)) e.push(`finish.s ${r.finish.s} must be < length ${length}`);
  if (!(r.turn.s0 > 0 && r.turn.s0 < r.turn.s1)) e.push(`turn [${r.turn.s0}, ${r.turn.s1}] must satisfy 0 < s0 < s1`);
  if (!(r.turn.s1 < r.finish.s)) e.push(`turn.s1 ${r.turn.s1} must be before finish ${r.finish.s}`);
  const secs = r.sections;
  if (Math.abs(secs[0].s0) > 1e-6) e.push(`first section starts at ${secs[0].s0}, expected 0`);
  secs.forEach((sec, i) => {
    if (!(sec.s0 < sec.s1)) e.push(`section ${sec.id} is empty [${sec.s0}, ${sec.s1}]`);
    if (i > 0 && Math.abs(sec.s0 - secs[i - 1].s1) > 1e-6) {
      e.push(`sections ${secs[i - 1].id} → ${sec.id} not contiguous (${secs[i - 1].s1} vs ${sec.s0})`);
    }
  });
  if (Math.abs(secs[secs.length - 1].s1 - length) > 1) {
    e.push(`last section ends at ${secs[secs.length - 1].s1}, route length is ${length}`);
  }
  for (const x of [...(r.intersections ?? []), ...r.signs]) {
    if (!(x.s >= 0 && x.s <= length)) e.push(`intersection/sign at s=${x.s} is off the route`);
  }
  return e;
}

function segmentLengths(pts: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  return out;
}

/** Uniform resampling: every segment ≈ sampleSpacing, the last one may be shorter. */
function spacingErrors(r: RouteData): string[] {
  const e: string[] = [];
  const h = r.meta.sampleSpacing;
  const segs = segmentLengths(r.centerline);
  const tol = 0.1 * h;
  segs.forEach((len, i) => {
    const isLast = i === segs.length - 1;
    const ok = isLast ? len > 1e-3 && len <= h + tol : Math.abs(len - h) <= tol;
    if (!ok && e.length < 10) e.push(`segment ${i} length ${len.toFixed(3)} (spacing ${h})`);
  });
  const total = segs.reduce((a, b) => a + b, 0);
  if (Math.abs(total - r.meta.length) > Math.max(1, 0.002 * r.meta.length)) {
    e.push(`polyline length ${total.toFixed(2)} differs from meta.length ${r.meta.length}`);
  }
  return e;
}

/** Heading change per sample < MAX_KINK_DEG, except around the deliberate turn. */
function kinkErrors(r: RouteData): string[] {
  const e: string[] = [];
  const pts = r.centerline;
  let s = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (s > r.turn.s0 - TURN_MARGIN && s < r.turn.s1 + TURN_MARGIN) continue;
    const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    const deg = Math.abs(wrap(b - a)) * DEG;
    if (deg >= MAX_KINK_DEG && e.length < 10) e.push(`kink of ${deg.toFixed(2)}° at sample ${i} (s≈${s.toFixed(1)})`);
  }
  return e;
}

function polygonArea(fp: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < fp.length; i++) {
    const [x0, z0] = fp[i];
    const [x1, z1] = fp[(i + 1) % fp.length];
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a) / 2;
}

function buildingErrors(b: BuildingsData): string[] {
  const e: string[] = [];
  const m = b.meta;
  if (!(m && isStr(m.generatedAt) && (m.osmTimestamp === null || isStr(m.osmTimestamp)))) e.push('meta {generatedAt, osmTimestamp}');
  if (!Array.isArray(b.buildings)) return [...e, 'buildings array missing'];
  if (m?.count !== b.buildings.length) e.push(`meta.count ${m?.count} != buildings.length ${b.buildings.length}`);
  const hs = m?.heightSources;
  if (!(hs && [hs.tag, hs.levels, hs.estimated].every((v) => isNum(v) && v >= 0))) e.push('meta.heightSources');
  for (let i = 0; i < b.buildings.length && e.length < 10; i++) {
    const r = b.buildings[i];
    const why: string[] = [];
    if (!isNum(r.id)) why.push('id');
    if (!isNum(r.s) || !isNum(r.d)) why.push('s/d');
    if (!(isNum(r.h) && r.h >= 3 && r.h <= 650)) why.push(`h=${r.h}`);
    if (!SECTION_IDS.includes(r.zone)) why.push(`zone=${r.zone}`);
    if (r.far !== undefined && typeof r.far !== 'boolean') why.push('far');
    if (!(Array.isArray(r.fp) && r.fp.length >= 3 && r.fp.every(isVec2))) why.push('fp needs >= 3 finite points');
    else {
      const [f, l] = [r.fp[0], r.fp[r.fp.length - 1]];
      if (f[0] === l[0] && f[1] === l[1]) why.push('fp repeats the closing point');
      if (!(polygonArea(r.fp) > 1e-3)) why.push('fp is degenerate (zero area)');
    }
    if (why.length) e.push(`building[${i}] id=${r.id}: ${why.join(', ')}`);
  }
  return e;
}

describe('data validators (self-check on synthetic data)', () => {
  const synth = makeSyntheticRoute();

  it('accept the synthetic route', () => {
    expect(routeShapeErrors(synth)).toEqual([]);
    expect(orderErrors(synth, synth.meta.length)).toEqual([]);
  });

  it('reject broken routes', () => {
    const bad = structuredClone(synth);
    bad.checkpoints.reverse();
    bad.sections[1].s0 += 10;
    bad.centerline[5] = [Number.NaN, 0];
    expect(orderErrors(bad, bad.meta.length).length).toBeGreaterThanOrEqual(2);
    expect(routeShapeErrors(bad)).toHaveLength(1);
  });

  it('detect kinks and spacing gaps on an otherwise straight line', () => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= 100; i++) pts.push([i * 2, 0]);
    const straight: RouteData = {
      ...synth,
      centerline: pts,
      meta: { ...synth.meta, length: 200, sampleSpacing: 2 },
      turn: { ...synth.turn, s0: 1000, s1: 1050 },
    };
    expect(kinkErrors(straight)).toEqual([]);
    expect(spacingErrors(straight)).toEqual([]);
    const kinked = structuredClone(straight);
    for (let i = 51; i <= 100; i++) kinked.centerline[i] = [100 + (i - 50) * 2 * Math.cos(0.05), (i - 50) * 2 * Math.sin(0.05)];
    expect(kinkErrors(kinked)).toHaveLength(1);
    const gappy = structuredClone(straight);
    gappy.centerline.splice(30, 1);
    expect(spacingErrors(gappy).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!routeJson)('public/data/route.json', () => {
  const r = routeJson as RouteData;

  it('matches the RouteData shape', () => {
    expect(routeShapeErrors(r)).toEqual([]);
  });

  it('starts at the local origin and heads east overall', () => {
    const [x0, z0] = r.centerline[0];
    const [x1] = r.centerline[r.centerline.length - 1];
    expect(Math.hypot(x0, z0)).toBeLessThan(0.5);
    expect(x1 - x0).toBeGreaterThan(3000);
  });

  it('is uniformly resampled at meta.sampleSpacing and its length matches meta.length', () => {
    expect(spacingErrors(r)).toEqual([]);
  });

  it(`has no kinks (< ${MAX_KINK_DEG}° per sample outside the turn ± ${TURN_MARGIN} m)`, () => {
    expect(kinkErrors(r)).toEqual([]);
  });

  it('has ordered checkpoints < finish < length and contiguous sections', () => {
    expect(orderErrors(r, r.meta.length)).toEqual([]);
  });

  it('is cut to 60–80 % of the real length', () => {
    const ratio = r.meta.length / r.meta.realLength;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(0.8);
  });

  it('turns once, in the declared direction, with a fillet radius of roughly 20 m or more', () => {
    const route = new Route(r);
    const delta = wrap(route.headingAt(r.turn.s1 + TURN_MARGIN) - route.headingAt(r.turn.s0 - TURN_MARGIN)) * DEG;
    // Yaw increases on a left turn.
    expect(Math.sign(delta)).toBe(r.turn.direction === 'left' ? 1 : -1);
    expect(Math.abs(delta)).toBeGreaterThan(45);
    expect(Math.abs(delta)).toBeLessThan(135);
    // Radius over 3-sample windows; 18 m leaves room for coordinate rounding.
    const h = route.spacing;
    for (let s = r.turn.s0; s + 3 * h <= r.turn.s1; s += h) {
      const turned = Math.abs(wrap(route.headingAt(s + 3 * h) - route.headingAt(s)));
      expect((3 * h) / Math.max(turned, 1e-9), `s=${s.toFixed(1)}`).toBeGreaterThan(18);
    }
  });
});

describe.skipIf(!buildingsJson)('public/data/buildings.json', () => {
  it('has finite footprints (>= 3 points) and heights in [3, 650] m', () => {
    expect(buildingErrors(buildingsJson as BuildingsData)).toEqual([]);
  });
});
