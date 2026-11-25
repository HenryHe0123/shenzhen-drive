import { describe, expect, it } from 'vitest';
import { Route } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';
import type { BuildingsData, CityModelsData, RouteData, SectionId, Vec2 } from '../src/route/types';

// Globs resolve to {} when the pipeline has not produced the file yet.
const routeJson =
  Object.values(import.meta.glob<RouteData>('../public/data/route.json', { eager: true, import: 'default' }))[0] ??
  null;
const buildingsJson =
  Object.values(
    import.meta.glob<BuildingsData>('../public/data/buildings.json', { eager: true, import: 'default' }),
  )[0] ?? null;
const cityModelsJson =
  Object.values(
    import.meta.glob<CityModelsData>('../public/data/city_models.json', { eager: true, import: 'default' }),
  )[0] ?? null;
const cityConfig = Object.values(
  import.meta.glob<{ viewCorridorDefaults?: { keepIds?: string[] } }>('../scripts/city_config.json', {
    eager: true,
    import: 'default',
  }),
)[0];
/** OSM buildings the view corridors deliberately keep inside clear zones (e.g. OCT Tower). */
const CLEAR_ZONE_KEEP = new Set((cityConfig?.viewCorridorDefaults?.keepIds ?? []).map((ref) => Number(ref.slice(1))));

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
  const turnOk = (t: RouteData['turn']) =>
    !!t &&
    isNum(t.s0) &&
    isNum(t.s1) &&
    ['left', 'right'].includes(t.direction) &&
    isStr(t.name) &&
    (t.radius === undefined || (isNum(t.radius) && t.radius > 0));
  req(turnOk(r.turn), 'turn {s0, s1, direction, name, radius?}');
  if (r.turns !== undefined) {
    req(Array.isArray(r.turns) && r.turns.length > 0, 'turns non-empty array');
    if (Array.isArray(r.turns) && r.turns.length) {
      e.push(...firstBad(r.turns, turnOk, 'turns'));
      const last = r.turns[r.turns.length - 1];
      req(
        r.turn && (['s0', 's1', 'direction', 'name'] as const).every((k) => last[k] === r.turn[k]),
        'turn must match the last of turns',
      );
    }
  }
  if (r.clearZones !== undefined) {
    req(Array.isArray(r.clearZones), 'clearZones array');
    if (Array.isArray(r.clearZones)) e.push(...firstBad(r.clearZones, (z) => Array.isArray(z) && z.length >= 3 && z.every(isVec2), 'clearZones'));
  }
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
  turnsOf(r).forEach((t, i, all) => {
    if (!(t.s0 > 0 && t.s0 < t.s1)) e.push(`turn ${i} [${t.s0}, ${t.s1}] must satisfy 0 < s0 < s1`);
    if (i > 0 && !(t.s0 > all[i - 1].s1)) e.push(`turn ${i} starts at ${t.s0}, before turn ${i - 1} ends (${all[i - 1].s1})`);
  });
  const lastTurn = turnsOf(r)[turnsOf(r).length - 1];
  if (!(lastTurn.s1 < r.finish.s)) e.push(`last turn ends at ${lastTurn.s1}, must be before finish ${r.finish.s}`);
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

const turnsOf = (r: RouteData) => (r.turns?.length ? r.turns : [r.turn]);

/** Heading change per sample < MAX_KINK_DEG, except around the deliberate turns. */
function kinkErrors(r: RouteData): string[] {
  const e: string[] = [];
  const pts = r.centerline;
  const turns = turnsOf(r);
  let s = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (turns.some((t) => s > t.s0 - TURN_MARGIN && s < t.s1 + TURN_MARGIN)) continue;
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

const CITY_MODEL_BUDGET_BYTES = 20 * 1024 * 1024;
const LANDMARK_IDS = ['tencent', 'eiffel', 'pingan', 'civic_center', 'kingkey100'];

function pointInPolygon(x: number, z: number, fp: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [xi, zi] = fp[i];
    const [xj, zj] = fp[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(fp: readonly Vec2[]): [number, number, number, number] {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of fp) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

/** Area shared by two polygons, sampled on a `cell` m grid over their bounding-box overlap. */
function overlapArea(a: readonly Vec2[], b: readonly Vec2[], cell = 0.5): number {
  const [ax0, az0, ax1, az1] = bbox(a);
  const [bx0, bz0, bx1, bz1] = bbox(b);
  const [x0, z0, x1, z1] = [Math.max(ax0, bx0), Math.max(az0, bz0), Math.min(ax1, bx1), Math.min(az1, bz1)];
  if (x0 >= x1 || z0 >= z1) return 0;
  let n = 0;
  for (let x = x0 + cell / 2; x < x1; x += cell) {
    for (let z = z0 + cell / 2; z < z1; z += cell) if (pointInPolygon(x, z, a) && pointInPolygon(x, z, b)) n++;
  }
  return n * cell * cell;
}

/** Footprint outline resampled every `step` m (vertices included). */
function outline(fp: readonly Vec2[], step = 1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < fp.length; i++) {
    const [x0, z0] = fp[i];
    const [x1, z1] = fp[(i + 1) % fp.length];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  }
  return out;
}

function cityModelErrors(c: CityModelsData): string[] {
  const e: string[] = [];
  const m = c.meta;
  if (!(m && isStr(m.generatedAt) && !Number.isNaN(Date.parse(m.generatedAt)))) e.push('meta.generatedAt must be a date string');
  if (!Array.isArray(c.models)) return [...e, 'models array missing'];
  if (m?.count !== c.models.length) e.push(`meta.count ${m?.count} != models.length ${c.models.length}`);
  const total = c.models.reduce((a, r) => a + r.bytes, 0);
  if (m?.totalBytes !== total) e.push(`meta.totalBytes ${m?.totalBytes} != sum of bytes ${total}`);
  const ids = new Set<string>();
  for (const r of c.models) {
    const why: string[] = [];
    if (!isStr(r.id) || ids.has(r.id)) why.push('id missing or duplicated');
    ids.add(r.id);
    if (r.file !== `models/city/${r.id}.glb`) why.push(`file ${r.file}`);
    if (!['landmark', 'frontage', 'skyline'].includes(r.role)) why.push(`role ${r.role}`);
    if (![r.x, r.z, r.yaw, r.s, r.d].every(isNum)) why.push('x/z/yaw/s/d');
    if (!(isNum(r.height) && r.height > 0 && r.height <= 650)) why.push(`height ${r.height}`);
    if (!(Array.isArray(r.footprint) && r.footprint.length >= 3 && r.footprint.every(isVec2) && polygonArea(r.footprint) > 1)) {
      why.push('footprint needs >= 3 points and area > 1 m2');
    }
    if (!(Array.isArray(r.replacesOsm) && r.replacesOsm.every((v) => Number.isInteger(v) && v > 0))) why.push('replacesOsm');
    if (r.replacesLandmark !== undefined && !LANDMARK_IDS.includes(r.replacesLandmark)) why.push(`replacesLandmark ${r.replacesLandmark}`);
    if (typeof r.photoTextured !== 'boolean') why.push('photoTextured');
    if (!(Number.isInteger(r.tris) && r.tris > 0)) why.push(`tris ${r.tris}`);
    const maxCalls = r.role === 'landmark' ? 8 : 2;
    if (!(Number.isInteger(r.drawCalls) && r.drawCalls >= 1 && r.drawCalls <= maxCalls)) why.push(`drawCalls ${r.drawCalls} (max ${maxCalls})`);
    if (!(Number.isInteger(r.bytes) && r.bytes > 0)) why.push(`bytes ${r.bytes}`);
    const cr = r.credit;
    if (!(cr && [cr.title, cr.author, cr.url, cr.license].every(isStr) && /3D Warehouse/.test(cr.license))) why.push('credit');
    if (why.length) e.push(`model ${r.id}: ${why.join(', ')}`);
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

  it('is the full real route, without cuts', () => {
    expect(r.meta.cuts).toEqual([]);
    const ratio = r.meta.length / r.meta.realLength;
    expect(ratio).toBeGreaterThanOrEqual(0.99);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('turns in the declared directions, each with a fillet radius of roughly 20 m or more', () => {
    const route = new Route(r);
    expect(route.turns.length).toBeGreaterThanOrEqual(1);
    for (const t of route.turns) {
      const delta = wrap(route.headingAt(t.s1 + TURN_MARGIN) - route.headingAt(t.s0 - TURN_MARGIN)) * DEG;
      // Yaw increases on a left turn.
      expect(Math.sign(delta), `turn onto ${t.name}`).toBe(t.direction === 'left' ? 1 : -1);
      expect(Math.abs(delta)).toBeGreaterThan(45);
      expect(Math.abs(delta)).toBeLessThan(135);
      // Radius over 3-sample windows; 18 m leaves room for coordinate rounding.
      const h = route.spacing;
      for (let s = t.s0; s + 3 * h <= t.s1; s += h) {
        const turned = Math.abs(wrap(route.headingAt(s + 3 * h) - route.headingAt(s)));
        expect((3 * h) / Math.max(turned, 1e-9), `${t.name} s=${s.toFixed(1)}`).toBeGreaterThan(18);
      }
    }
  });
});

describe.skipIf(!buildingsJson)('public/data/buildings.json', () => {
  it('has finite footprints (>= 3 points) and heights in [3, 650] m', () => {
    expect(buildingErrors(buildingsJson as BuildingsData)).toEqual([]);
  });
});

describe.skipIf(!cityModelsJson || !routeJson)('public/data/city_models.json', () => {
  const c = cityModelsJson as CityModelsData;
  const r = routeJson as RouteData;
  const route = new Route(r);

  it('matches the CityModelsData shape (ids, files, budgets per model, credits)', () => {
    expect(cityModelErrors(c)).toEqual([]);
  });

  it('references processed GLBs that exist under public/ with the recorded size', async () => {
    const fsId = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsId)) as {
      existsSync(p: string): boolean;
      statSync(p: string): { size: number };
    };
    const bad: string[] = [];
    for (const m of c.models) {
      const path = decodeURIComponent(new URL(`../public/${m.file}`, import.meta.url).pathname);
      if (!fs.existsSync(path)) bad.push(`${m.file} missing`);
      else if (fs.statSync(path).size !== m.bytes) bad.push(`${m.file}: ${fs.statSync(path).size} bytes on disk, ${m.bytes} recorded`);
    }
    expect(bad).toEqual([]);
  });

  it(`stays within the ${CITY_MODEL_BUDGET_BYTES / 1048576} MB download budget`, () => {
    expect(c.meta.totalBytes).toBeLessThanOrEqual(CITY_MODEL_BUDGET_BYTES);
  });

  it('keeps every footprint off the drivable carriageway', () => {
    const { halfWidthLeft, halfWidthRight } = r.road;
    const bad: string[] = [];
    for (const m of c.models) {
      const hit = outline(m.footprint).find(([x, z]) => {
        const p = route.project(x, z);
        return p.s > 0 && p.s < route.length && p.d > -halfWidthLeft && p.d < halfWidthRight;
      });
      const crossed = r.centerline.some(([x, z]) => pointInPolygon(x, z, m.footprint));
      if (hit || crossed) bad.push(`${m.id}${hit ? ` touches the road at (${hit[0].toFixed(1)}, ${hit[1].toFixed(1)})` : ' straddles the centerline'}`);
    }
    expect(bad).toEqual([]);
  });

  it('keeps models in the landmark clear zones below the sight lines unless they replace the landmark (or a kept building)', () => {
    const bad: string[] = [];
    for (const m of c.models) {
      if (m.replacesLandmark || m.replacesOsm.some((id) => CLEAR_ZONE_KEEP.has(id))) continue;
      const a = (r.clearZones ?? []).reduce((acc, z) => acc + overlapArea(m.footprint, z), 0);
      if (a <= 2) continue;
      if (m.viewCap === undefined) bad.push(`${m.id}: ${a.toFixed(0)} m2 inside clear zones without a viewCap`);
      else if (m.height > m.viewCap) bad.push(`${m.id}: ${m.height} m rises above the sight line (${m.viewCap} m)`);
    }
    expect(bad).toEqual([]);
  });

  it('has no mutually overlapping models', () => {
    const bad: string[] = [];
    c.models.forEach((a, i) => {
      for (const b of c.models.slice(i + 1)) {
        const area = overlapArea(a.footprint, b.footprint);
        if (area > 2) bad.push(`${a.id} / ${b.id}: ${area.toFixed(0)} m2`);
      }
    });
    expect(bad).toEqual([]);
  });

  it.skipIf(!buildingsJson)('removed the OSM footprints it replaces and the fillers under each model', () => {
    const blds = (buildingsJson as BuildingsData).buildings;
    const ids = new Set(blds.map((b) => b.id));
    const bad: string[] = [];
    for (const m of c.models) {
      const kept = m.replacesOsm.filter((id) => ids.has(id));
      if (kept.length) bad.push(`${m.id}: replaced OSM ${kept.join(', ')} still in buildings.json`);
      for (const b of blds) {
        if (b.id < 0 && overlapArea(m.footprint, b.fp, 1) > 2) bad.push(`${m.id}: procedural filler ${b.id} overlaps`);
      }
    }
    expect(bad).toEqual([]);
  });
});
