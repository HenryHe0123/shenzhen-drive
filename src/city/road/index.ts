import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { LIGHTING } from '../../render/presets';
import { getTimeOfDay, onTimeOfDayChange } from '../../render/timeOfDay';
import { ChunkSet, FrameMapper, intersect, type Mapper, Painter, RouteMapper, type RGB, type Style, subtract } from './builder';
import { groundMaterial } from './ground';
import { AUX, getRoadLayout, HEIGHT, type Interval, type RoadLayout, SIDE, type TurnLayout, XWALK } from './layout';
import { dashes, paintRouteMarkings, solid, WHITE, YELLOW, zebra } from './markings';
import { asphaltTextures, grassTexture, mulberry32, pavingTexture, wearTexture } from './textures';

const C_CURB: RGB = [1.4, 1.4, 1.34];
const C_WALK: RGB = [1, 1, 1];
const C_PLAZA: RGB = [0.82, 0.8, 0.78];
const C_BIKE: RGB = [1.7, 0.72, 0.58];
const C_GRASS: RGB = [1, 1, 1];
const C_LAWN: RGB = [1.08, 1.12, 0.92];
const C_HEDGE: RGB = [0.5, 0.72, 0.46];
const C_ASPHALT: RGB = [1, 1, 1.02];

const noiseTable = (() => {
  const r = mulberry32(99);
  return Float32Array.from({ length: 256 }, () => r());
})();
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = noiseTable[i & 255];
  const b = noiseTable[(i + 1) & 255];
  return a + (b - a) * f * f * (3 - 2 * f);
}

function laneTone(k: number, a: number): RGB {
  const n = noise1(a / 55 + k * 17.3);
  const patch = noise1(a / 190 + k * 5.1 + 100) > 0.74 ? 0.8 : 1;
  const v = (0.86 + 0.26 * n) * patch;
  return [v, v, v * 1.02];
}

const st = (color: Style['color'], uk: number, vk: number, uFn?: Style['uFn']): Style => ({ color, uk, vk, uFn });
const S_WALK = st(C_WALK, 1 / 2, 1 / 2);
const S_PLAZA = st(C_PLAZA, 1 / 2.5, 1 / 2.5);
const S_CURB = st(C_CURB, 1 / 8, 1 / 8, () => 0.31);
const S_GRASS = st(C_GRASS, 1 / 2, 1 / 2);
const S_LAWN = st(C_LAWN, 1 / 3, 1 / 3);
const S_HEDGE = st(C_HEDGE, 1 / 1.2, 1 / 1.2);
const S_BIKE = st(C_BIKE, 1 / 2.5, 1 / 7);
const S_FRAME_ASPHALT = st(C_ASPHALT, 1 / 3.5, 1 / 7);

interface SectionGaps {
  right: Interval[];
  lawn: Interval[];
  median: Interval[];
  far: Interval[];
  farLawn: Interval[];
  opp: Interval[];
}

/**
 * Boulevard cross-section (carriageways, median, both roadsides) between a0 and a1 of
 * a mapper. Used along the route and for the straight continuation past the turn.
 */
function crossSection(
  p: Painter,
  m: Mapper,
  l: RoadLayout,
  a0: number,
  a1: number,
  opp: (a: number) => number,
  gaps: SectionGaps,
  farClip = -Infinity,
  side?: RoadLayout['side'],
) {
  const { route, lanes, laneW, edgeL, edgeR } = l;
  const dMin = route.dMin;
  const dMax = route.dMax;

  // Drivable carriageway, one strip per lane so each lane gets its own wear tone.
  const bounds = [edgeL, dMin];
  for (let k = 1; k < lanes; k++) bounds.push(dMin + k * laneW);
  bounds.push(dMax, edgeR);
  for (let k = 0; k < bounds.length - 1; k++) {
    const lane = Math.min(lanes - 1, Math.max(0, k - 1));
    p.ribbon('asphalt', m, a0, a1, bounds[k], bounds[k + 1], 0, st((a) => laneTone(lane, a), 0, 1 / 7, (_a, b) => (b - dMin) / 3.5));
  }

  // Opposite carriageway.
  for (const [s, e] of subtract(a0, a1, gaps.opp)) {
    for (let k = 0; k < bounds.length - 1; k++) {
      const lane = Math.min(lanes - 1, Math.max(0, k - 1));
      const o0 = bounds[k];
      const o1 = bounds[k + 1];
      p.ribbon(
        'asphalt',
        m,
        s,
        e,
        (a) => opp(a) + o0,
        (a) => opp(a) + o1,
        0,
        st((a) => laneTone(lane + 4, a), 0, 1 / 7, (a, b) => (b - opp(a) - dMin) / 3.5),
      );
    }
  }

  // Median: curbs, grass, clipped hedge; asphalt where it is cut for crossings.
  const mIn0 = (a: number) => opp(a) + 7.3;
  const mIn1 = edgeL;
  for (const [s, e] of subtract(a0, a1, gaps.median)) {
    p.box('paving', 'paving', m, s, e, edgeL - 0.3, edgeL, HEIGHT.median, S_CURB, S_CURB);
    p.box('paving', 'paving', m, s, e, mIn0, (a) => mIn0(a) + 0.3, HEIGHT.median, S_CURB, S_CURB);
    p.box('green', 'paving', m, s, e, (a) => mIn0(a) + 0.3, edgeL - 0.3, HEIGHT.medianGrass, S_GRASS, S_CURB);
    const width = (edgeL - 0.3 - (opp(s) + 7.6));
    if (width > 1.6) {
      const hw = Math.min(0.75, width * 0.18);
      const mid = (a: number) => (mIn0(a) + 0.3 + edgeL - 0.3) / 2;
      p.box('green', 'green', m, s + 1.5, e - 1.5, (a) => mid(a) - hw, (a) => mid(a) + hw, HEIGHT.hedge, S_HEDGE, S_HEDGE);
    }
  }
  for (const [s, e] of subtract(a0, a1, gaps.opp).flatMap(([x, y]) => intersect(x, y, gaps.median))) {
    p.ribbon('asphalt', m, s, e, mIn0, mIn1, 0, st(C_ASPHALT, 1 / 3.5, 1 / 7));
  }

  // Right roadside: curb, planting strip, bike lane, sidewalk, lawn; where a side road runs: curb,
  // planted separator, side road, curb, bike lane, sidewalk, lawn.
  const runsR = side ? side.right.runs : [];
  const runsL = side ? side.left.runs : [];
  for (const [s, e] of subtract(a0, a1, [...gaps.right, ...runsR])) {
    p.box('paving', 'paving', m, s, e, edgeR + SIDE.curb[0], edgeR + SIDE.curb[1], HEIGHT.curb, S_CURB, S_CURB);
    p.box('green', 'paving', m, s, e, edgeR + SIDE.green[0], edgeR + SIDE.green[1], HEIGHT.green, S_GRASS, S_CURB);
    p.box('asphalt', 'paving', m, s, e, edgeR + SIDE.bike[0], edgeR + SIDE.bike[1], HEIGHT.walk, S_BIKE, S_CURB);
    p.box('paving', 'paving', m, s, e, edgeR + SIDE.walk[0], edgeR + SIDE.walk[1], HEIGHT.walk, S_WALK, S_CURB);
  }
  for (const [s, e] of subtract(a0, a1, [...gaps.lawn, ...runsR])) {
    p.box('green', 'green', m, s, e, edgeR + SIDE.lawn[0], edgeR + SIDE.lawn[1], HEIGHT.lawn, S_LAWN, S_LAWN);
  }
  if (side) {
    const r = side.right;
    for (const [s, e] of intersect(a0, a1, runsR).flatMap(([x, y]) => subtract(x, y, gaps.right))) {
      const out = (k: number) => (a: number) => r.outer(a) + k;
      p.box('paving', 'paving', m, s, e, edgeR, edgeR + 0.3, HEIGHT.median, S_CURB, S_CURB);
      p.box('green', 'paving', m, s, e, edgeR + 0.3, (a) => r.inner(a) - 0.3, HEIGHT.medianGrass, S_GRASS, S_CURB);
      p.box('paving', 'paving', m, s, e, (a) => r.inner(a) - 0.3, r.inner, HEIGHT.median, S_CURB, S_CURB);
      sideRoadSurface(p, m, s, e, r.inner, r.outer, r.lanes((s + e) / 2), 0);
      p.box('paving', 'paving', m, s, e, out(AUX.curb[0]), out(AUX.curb[1]), HEIGHT.curb, S_CURB, S_CURB);
      p.box('asphalt', 'paving', m, s, e, out(AUX.bike[0]), out(AUX.bike[1]), HEIGHT.walk, S_BIKE, S_CURB);
      p.box('paving', 'paving', m, s, e, out(AUX.walk[0]), out(AUX.walk[1]), HEIGHT.walk, S_WALK, S_CURB);
    }
    for (const [s, e] of intersect(a0, a1, runsR).flatMap(([x, y]) => subtract(x, y, gaps.lawn))) {
      p.box('green', 'green', m, s, e, (a) => r.outer(a) + AUX.lawn[0], (a) => r.outer(a) + AUX.lawn[1], HEIGHT.lawn, S_LAWN, S_LAWN);
    }
  }

  // Far roadside beyond the opposite carriageway (mirrored bands).
  const far = (off: number) => (a: number) => Math.max(farClip, opp(a) - 7.3 - off);
  const farBand = (layer: string, s: number, e: number, band: readonly [number, number], y: number, top: Style, side: Style) => {
    if (opp(s) - 7.3 - band[0] <= farClip + 0.2) return;
    p.box(layer, side === S_LAWN ? 'green' : 'paving', m, s, e, far(band[1]), far(band[0]), y, top, side);
  };
  for (const [s, e] of subtract(a0, a1, [...gaps.far, ...gaps.opp, ...runsL])) {
    farBand('paving', s, e, SIDE.curb, HEIGHT.curb, S_CURB, S_CURB);
    farBand('green', s, e, SIDE.green, HEIGHT.green, S_GRASS, S_CURB);
    farBand('asphalt', s, e, SIDE.bike, HEIGHT.walk, S_BIKE, S_CURB);
    farBand('paving', s, e, SIDE.walk, HEIGHT.walk, S_WALK, S_CURB);
  }
  for (const [s, e] of subtract(a0, a1, [...gaps.farLawn, ...gaps.opp, ...runsL])) {
    farBand('green', s, e, SIDE.lawn, HEIGHT.lawn, S_LAWN, S_LAWN);
  }
  if (side) {
    const q = side.left;
    const fe = (a: number) => opp(a) - 7.3;
    for (const [s, e] of intersect(a0, a1, runsL).flatMap(([x, y]) => subtract(x, y, [...gaps.far, ...gaps.opp]))) {
      const out = (k: number) => (a: number) => q.outer(a) - k;
      p.box('paving', 'paving', m, s, e, (a) => fe(a) - 0.3, fe, HEIGHT.median, S_CURB, S_CURB);
      p.box('green', 'paving', m, s, e, (a) => q.inner(a) + 0.3, (a) => fe(a) - 0.3, HEIGHT.medianGrass, S_GRASS, S_CURB);
      p.box('paving', 'paving', m, s, e, q.inner, (a) => q.inner(a) + 0.3, HEIGHT.median, S_CURB, S_CURB);
      sideRoadSurface(p, m, s, e, q.outer, q.inner, q.lanes((s + e) / 2), 8);
      p.box('paving', 'paving', m, s, e, out(AUX.curb[1]), out(AUX.curb[0]), HEIGHT.curb, S_CURB, S_CURB);
      p.box('asphalt', 'paving', m, s, e, out(AUX.bike[1]), out(AUX.bike[0]), HEIGHT.walk, S_BIKE, S_CURB);
      p.box('paving', 'paving', m, s, e, out(AUX.walk[1]), out(AUX.walk[0]), HEIGHT.walk, S_WALK, S_CURB);
    }
    for (const [s, e] of intersect(a0, a1, runsL).flatMap(([x, y]) => subtract(x, y, [...gaps.farLawn, ...gaps.opp]))) {
      p.box('green', 'green', m, s, e, (a) => q.outer(a) - AUX.lawn[1], (a) => q.outer(a) - AUX.lawn[0], HEIGHT.lawn, S_LAWN, S_LAWN);
    }
  }
}

/** Side road asphalt between b0 < b1 (lane tones from `toneBase`), white edge lines and dashed lane lines. */
function sideRoadSurface(p: Painter, m: Mapper, s: number, e: number, b0: (a: number) => number, b1: (a: number) => number, lanes: number, toneBase: number) {
  const n = Math.max(1, Math.round(lanes));
  const at = (k: number) => (a: number) => b0(a) + ((b1(a) - b0(a)) * k) / n;
  for (let k = 0; k < n; k++) {
    p.ribbon('asphalt', m, s, e, at(k), at(k + 1), 0, st((a) => laneTone(toneBase + k, a), 0, 1 / 7, (a, b) => (b - b0(a)) / 3.25));
  }
  solid(p, m, s, e, (a) => b0(a) + 0.15, (a) => b0(a) + 0.3, WHITE);
  solid(p, m, s, e, (a) => b1(a) - 0.3, (a) => b1(a) - 0.15, WHITE);
  for (let k = 1; k < n; k++) dashes(p, m, s, e, at(k), 0.15, 4, 6, WHITE);
}

/**
 * Visual side street: asphalt from `a0` outward, crosswalk aligned with the boulevard
 * sidewalk, stop line, lane lines and sidewalks. b < 0 carries traffic toward the boulevard.
 */
function sideStreet(
  p: Painter,
  m: Mapper,
  a0: number,
  len: number,
  hw: number,
  opts: { median?: [number, number]; lanes?: number[]; centre?: number; stop?: [number, number] } = {},
) {
  const a1 = a0 + len;
  const aWalk = a0 + SIDE.walk[1];
  p.ribbon('asphalt', m, a0, a1, -hw, hw, 0, S_FRAME_ASPHALT);
  zebra(p, m, a0 + 7.5, a0 + 12.5, -hw, hw);
  const stop = opts.stop ?? [-hw + 0.4, -0.3];
  solid(p, m, a0 + 13.5, a0 + 13.9, stop[0], stop[1], WHITE);
  if (opts.median) {
    const [m0, m1] = opts.median;
    p.box('paving', 'paving', m, aWalk, a1, m0, m1, HEIGHT.median, S_CURB, S_CURB);
    if (m1 - m0 > 1) p.box('green', 'paving', m, aWalk + 0.3, a1, m0 + 0.3, m1 - 0.3, HEIGHT.medianGrass, S_GRASS, S_CURB);
  } else {
    const c = opts.centre ?? 0;
    solid(p, m, a0 + 14.5, a1, c - 0.25, c - 0.1, YELLOW);
    solid(p, m, a0 + 14.5, a1, c + 0.1, c + 0.25, YELLOW);
  }
  for (const b of opts.lanes ?? [-hw / 2, hw / 2]) dashes(p, m, a0 + 14.5, a1, b, 0.15, 6, 9, WHITE);
  solid(p, m, a0 + 14.5, a1, -hw + 0.4, -hw + 0.6, WHITE);
  solid(p, m, a0 + 14.5, a1, hw - 0.6, hw - 0.4, WHITE);
  for (const sgn of [-1, 1]) {
    const b0 = sgn < 0 ? -hw - 6 : hw;
    const b1 = sgn < 0 ? -hw : hw + 6;
    p.box('paving', 'paving', m, aWalk, a1, b0, b1, HEIGHT.walk, S_WALK, S_CURB);
  }
}

/** Side street options for a cross street of half width hw (wide boulevards get a median and more lanes). */
function crossOpts(hw: number): Parameters<typeof sideStreet>[5] {
  if (hw < 20) return {};
  const lanes: number[] = [];
  for (let b = 3 + 4; b < hw - 1; b += 4) lanes.push(-b, b);
  return { median: [-3, 3], lanes, stop: [-hw + 0.4, -3.3] };
}

function buildIntersections(p: Painter, l: RoadLayout) {
  const { route, edgeR } = l;
  for (const c of l.cross) {
    const o = route.pointAt(c.s);
    const n = route.normalAt(c.s);
    const right = new FrameMapper(o.x, o.z, n.x, n.z, c.s);
    sideStreet(p, right, edgeR, 70, c.hw, crossOpts(c.hw));
    const left = new FrameMapper(o.x, o.z, -n.x, -n.z, c.s);
    sideStreet(p, left, 7.3 - l.opp(c.s), 70, c.hw, crossOpts(c.hw));
  }
}

/**
 * Four-arm junction at a turn: intersection pad, the entered road's stub behind the
 * turn (outer side), the road being left continuing straight on, corner sidewalks.
 */
function buildTurn(p: Painter, rm: Mapper, l: RoadLayout, t: TurnLayout) {
  const { route, edgeR } = l;
  const nx = -t.tz;
  const nz = t.tx;
  const A = new FrameMapper(t.ox, t.oz, t.tx, t.tz, t.s0);
  p.ribbon('pad', A, t.a0, t.a1, t.d0, t.d1, 0, S_FRAME_ASPHALT);

  // Entered road continuing beyond the junction, on the outer side of the turn.
  const mid = (t.ns0 + t.ns1) / 2;
  const hw = (t.ns1 - t.ns0) / 2;
  const legSign = t.left ? 1 : -1;
  const legStart = t.left ? edgeR : -t.d0;
  const leg = new FrameMapper(t.ox + t.tx * mid, t.oz + t.tz * mid, nx * legSign, nz * legSign, t.s0);
  // In the leg frame b = -(along - mid) for a left turn, along - mid for a right turn.
  const toB = (along: number) => (t.left ? -(along - mid) : along - mid);
  // Exit-road lateral d maps to approach-frame "along" (the exit road's right side faces +t after a left turn).
  const alongE = (d: number) => t.exitAlong + (t.left ? d : -d);
  const exitLanes = [-3.5, 0, 3.5].flatMap((o) => [toB(alongE(o)), toB(alongE(t.oppE + o))]);
  const medB = [toB(alongE(t.oppE + 7.3)), toB(alongE(-7.3))].sort((x, y) => x - y) as [number, number];
  const stopB = [toB(alongE(-7)), toB(alongE(7))].sort((x, y) => x - y) as [number, number];
  sideStreet(p, leg, legStart, 70, hw, { median: medB[1] - medB[0] > 0.8 ? medB : undefined, lanes: exitLanes, stop: stopB });

  // Corner sidewalks: near-right corner of a left turn, the inside of a right-turn arc, and the far-side near corner.
  if (t.left && t.ns0 > 0.5) {
    p.box('paving', 'paving', A, 0, t.ns0, edgeR, edgeR + SIDE.walk[1], HEIGHT.walk, S_WALK, S_CURB);
  }
  if (!t.left) {
    const w = Math.min(SIDE.walk[1], t.radius - edgeR - 1);
    if (w > 1) p.box('paving', 'paving', rm, t.s0, t.s1, edgeR, edgeR + w, HEIGHT.walk, S_WALK, S_CURB);
  }
  const far = t.oppA - 7.3;
  p.box('paving', 'paving', A, t.a0 - 15, t.ns0, far - SIDE.walk[1], far, HEIGHT.walk, S_WALK, S_CURB);

  // Road being left, continuing straight ahead past the junction.
  const len = 160;
  const e0 = t.a1;
  const e1 = t.a1 + len;
  const oppA = () => t.oppA;
  crossSection(
    p,
    A,
    l,
    e0,
    e1,
    oppA,
    { right: [], lawn: [[e0, e0 + 6]], median: [[e0, e0 + 7]], far: [], farLawn: [], opp: [] },
    t.left ? t.d0 : -Infinity,
  );
  const dMin = route.dMin;
  for (let k = 1; k < l.lanes; k++) {
    dashes(p, A, e0 + XWALK.far + 2, e1, dMin + k * l.laneW, 0.15, 6, 9, WHITE);
    dashes(p, A, e0 + XWALK.stop1, e1, t.oppA - 7 + k * l.laneW, 0.15, 6, 9, WHITE);
  }
  solid(p, A, e0 + XWALK.far + 2, e1, dMin + 0.1, dMin + 0.3, YELLOW);
  solid(p, A, e0 + XWALK.far + 2, e1, route.dMax - 0.3, route.dMax - 0.1, WHITE);
  solid(p, A, e0 + XWALK.stop1, e1, t.oppA + 6.7, t.oppA + 6.9, YELLOW);
  solid(p, A, e0 + XWALK.stop1, e1, t.oppA - 6.9, t.oppA - 6.7, WHITE);
  zebra(p, A, e0 + XWALK.near, e0 + XWALK.far, t.oppA - 7, route.dMax);
  solid(p, A, e0 + XWALK.stop0, e0 + XWALK.stop1, t.oppA - 6.9, t.oppA + 6.9, WHITE);
}

function buildEnds(p: Painter, l: RoadLayout) {
  const { route } = l;
  const b0 = l.opp(0) - 7.3 - SIDE.lawn[1];
  const b1 = l.edgeR + SIDE.lawn[1];
  const p0 = route.pointAt(l.s0);
  const t0 = route.tangentAt(0);
  const start = new FrameMapper(p0.x, p0.z, t0.x, t0.z, l.s0);
  p.box('paving', 'paving', start, -90, 0, b0, b1, HEIGHT.walk, S_PLAZA, S_CURB);
  const p1 = route.pointAt(l.s1);
  const t1 = route.tangentAt(route.length);
  const be0 = l.opp(route.length) - 7.3 - SIDE.lawn[1];
  const end = new FrameMapper(p1.x, p1.z, t1.x, t1.z, l.s1);
  p.box('paving', 'paving', end, 0, 90, be0, b1, HEIGHT.walk, S_PLAZA, S_CURB);
}

/**
 * Pulls the sky part of the lighting toward neutral grey: the reflection fully, the ambient
 * (hemisphere + environment irradiance) by 75 %, by `amount` (0..1, per preset). Under a blue sky
 * the shaded asphalt otherwise turns visibly blue; the direct sun and its color are untouched.
 */
function neutralSkyLight(mat: THREE.MeshStandardMaterial, amount: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyNeutral = amount;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSkyNeutral;')
      .replace(
        '#include <lights_fragment_end>',
        `{
  const vec3 sdLw = vec3(0.2126, 0.7152, 0.0722);
  radiance = mix(radiance, vec3(dot(radiance, sdLw)), uSkyNeutral);
  irradiance = mix(irradiance, vec3(dot(irradiance, sdLw)), 0.75 * uSkyNeutral);
  iblIrradiance = mix(iblIrradiance, vec3(dot(iblIrradiance, sdLw)), 0.75 * uSkyNeutral);
}
#include <lights_fragment_end>`,
      );
  };
  mat.customProgramCacheKey = () => 'sd-asphalt-neutral-sky';
}

export async function createRoad(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene, renderer } = ctx;
  const l = getRoadLayout(route);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const asphalt = asphaltTextures(aniso);
  const wear = wearTexture(aniso);
  const paving = pavingTexture(aniso);
  const grass = grassTexture(aniso);
  const ground = groundMaterial(aniso);

  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphalt.map,
    roughnessMap: asphalt.rough,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  const padMat = asphaltMat.clone();
  padMat.polygonOffset = true;
  padMat.polygonOffsetFactor = 1;
  padMat.polygonOffsetUnits = 2;
  const skyNeutral = { value: LIGHTING[getTimeOfDay()].roadSkyNeutral };
  for (const m of [asphaltMat, padMat]) neutralSkyLight(m, skyNeutral);
  const unsubscribe = onTimeOfDayChange((t) => (skyNeutral.value = LIGHTING[t].roadSkyNeutral));
  const mats: Record<string, THREE.Material> = {
    asphalt: asphaltMat,
    pad: padMat,
    mark: new THREE.MeshStandardMaterial({
      map: wear,
      vertexColors: true,
      roughness: 0.6,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
    paving: new THREE.MeshStandardMaterial({ map: paving, vertexColors: true, roughness: 0.85, metalness: 0 }),
    green: new THREE.MeshStandardMaterial({ map: grass, vertexColors: true, roughness: 0.95, metalness: 0 }),
  };

  const chunks = new ChunkSet(l.sMin, l.sMax, CONFIG.city.roadChunkLength);
  const p = new Painter(chunks);
  const rm = new RouteMapper(route, chunks);
  crossSection(p, rm, l, l.s0, l.s1, l.opp, l.gaps, -Infinity, l.side);
  paintRouteMarkings(p, rm, l);
  buildIntersections(p, l);
  for (const t of l.turns) buildTurn(p, rm, l, t);
  buildEnds(p, l);

  const root = new THREE.Group();
  root.name = 'road';
  const groups: { g: THREE.Group; s0: number; s1: number }[] = [];
  const order = ['pad', 'asphalt', 'paving', 'green', 'mark'];
  for (let k = 0; k < chunks.count; k++) {
    const g = new THREE.Group();
    g.name = `road-chunk-${k}`;
    for (const name of order) {
      const layer = chunks.layers[k].get(name);
      if (!layer || layer.empty) continue;
      const mesh = new THREE.Mesh(layer.geometry(), mats[name]);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
    }
    if (g.children.length) {
      root.add(g);
      groups.push({ g, s0: chunks.sMin + k * chunks.len, s1: chunks.end(k) });
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < route.n; i++) {
    minX = Math.min(minX, route.px[i]);
    maxX = Math.max(maxX, route.px[i]);
    minZ = Math.min(minZ, route.pz[i]);
    maxZ = Math.max(maxZ, route.pz[i]);
  }
  const groundMat = ground.material;
  // The metro terrain carries the same procedural ground inside its flattened route corridor.
  if (!ctx.metro) {
    const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000).rotateX(-Math.PI / 2), groundMat);
    groundMesh.position.set((minX + maxX) / 2, -0.02, (minZ + maxZ) / 2);
    groundMesh.receiveShadow = true;
    groundMesh.name = 'city-ground';
    root.add(groundMesh);
  }
  scene.add(root);
  if (ctx.debug) ((window as unknown as { __SCENERY__?: Record<string, THREE.Object3D> }).__SCENERY__ ??= {}).road = root;

  const ahead = CONFIG.city.roadViewAhead;
  const behind = CONFIG.city.roadViewBehind;
  let lastS = NaN;
  return {
    update(frame: FrameInfo) {
      if (Math.abs(frame.s - lastS) < 10) return;
      lastS = frame.s;
      for (const c of groups) c.g.visible = c.s1 > frame.s - behind && c.s0 < frame.s + ahead;
    },
    dispose() {
      unsubscribe();
      scene.remove(root);
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const m of [...Object.values(mats), groundMat]) m.dispose();
      for (const t of [asphalt.map, asphalt.rough, wear, paving, grass, ...ground.textures]) t.dispose();
    },
  };
}
