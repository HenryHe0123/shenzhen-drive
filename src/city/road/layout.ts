import { CONFIG } from '../../config';
import type { Route } from '../../route/Route';
import type { Vec2 } from '../../route/types';

export type Interval = [number, number];

/**
 * Offsets of the roadside bands measured outward from a carriageway's outer
 * asphalt edge (edgeR on the right, the opposite carriageway's far edge on the left).
 */
export const SIDE = {
  curb: [0, 0.3],
  green: [0.3, 3.3],
  bike: [3.3, 5.8],
  walk: [5.8, 14.7],
  lawn: [14.7, 30.7],
} as const;

export const HEIGHT = { curb: 0.16, median: 0.2, medianGrass: 0.18, green: 0.12, walk: 0.15, lawn: 0.08, hedge: 0.95 };

/** Crosswalk / stop line placement relative to the edge of an intersection zone. */
export const XWALK = { near: 1.5, far: 6.5, stop0: 8.1, stop1: 8.5 };

export interface CrossStreet {
  s: number;
  name: string;
  /** Half width of the cross street (m). */
  hw: number;
}

export interface TurnLayout {
  s0: number;
  s1: number;
  name: string;
  left: boolean;
  radius: number;
  /** Approach frame: origin pointAt(s0), unit tangent (tx, tz), right normal (-tz, tx). */
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  /** Exit point pointAt(s1) in the approach frame. */
  exitAlong: number;
  exitD: number;
  oppA: number;
  oppE: number;
  /** Intersection box in the approach frame (along a0..a1, lateral d0..d1). */
  a0: number;
  a1: number;
  d0: number;
  d1: number;
  /** Cross road extent along the approach direction. */
  ns0: number;
  ns1: number;
  /** Route s where the approach scenery stops and where the exit scenery resumes. */
  sA: number;
  sB: number;
  /** Name of the road being left (shown as "straight ahead"). */
  fromName: string;
}

export interface RoadLayout {
  route: Route;
  /** Route-following scenery extent (a little past both ends). */
  s0: number;
  s1: number;
  /** Total extent including end plazas. */
  sMin: number;
  sMax: number;
  W: number;
  lanes: number;
  laneW: number;
  edgeL: number;
  edgeR: number;
  cross: CrossStreet[];
  turns: TurnLayout[];
  /** Effective opposite carriageway centerline (always leaves room for a median). */
  opp(s: number): number;
  gaps: {
    right: Interval[];
    lawn: Interval[];
    median: Interval[];
    far: Interval[];
    farLawn: Interval[];
    opp: Interval[];
    marks: Interval[];
  };
  /** Landmark footprints (world x/z) with bounding boxes, for keeping props clear. */
  footprints: { pts: Vec2[]; x0: number; x1: number; z0: number; z1: number }[];
}

/** Half width of wide boulevards crossed at grade (default CONFIG.city.crossHalfWidth). */
const WIDE_CROSS: Record<string, number> = { 深南大道: 27 };

/** Name of the road the route follows before its first turn. */
export const FIRST_ROAD = '深南大道';

const cache = new WeakMap<Route, RoadLayout>();

export function getRoadLayout(route: Route): RoadLayout {
  let l = cache.get(route);
  if (!l) {
    l = computeLayout(route);
    cache.set(route, l);
  }
  return l;
}

function computeLayout(route: Route): RoadLayout {
  const W = CONFIG.city.crossHalfWidth;
  const lanes = Math.max(1, route.data.road.lanes || 4);
  const laneW = (route.dMax - route.dMin) / lanes;
  const edgeL = route.dMin - 0.3;
  const edgeR = route.dMax + 0.3;
  const oppMax = route.dMin - 9;
  const opp = (s: number) => Math.min(route.oppositeOffsetAt(Math.min(route.length, Math.max(0, s))), oppMax);

  const turns: TurnLayout[] = [];
  let fromName = FIRST_ROAD;
  for (const tr of route.turns) {
    const prevName = fromName;
    fromName = tr.name;
    if (!(tr.s1 > tr.s0 && tr.s0 > 60 && tr.s1 < route.length - 5)) continue;
    const t = route.tangentAt(Math.max(0, tr.s0 - 3));
    const o = route.pointAt(tr.s0);
    const e = route.pointAt(tr.s1);
    const nx = -t.z;
    const nz = t.x;
    const exitAlong = (e.x - o.x) * t.x + (e.z - o.z) * t.z;
    const exitD = (e.x - o.x) * nx + (e.z - o.z) * nz;
    const left = tr.direction !== 'right';
    const oppA = opp(tr.s0 - 10);
    const oppE = opp(tr.s1 + 10);
    let ns0: number;
    let ns1: number;
    let d0: number;
    let d1: number;
    let sB: number;
    if (left) {
      ns0 = exitAlong + oppE - 7.3;
      ns1 = exitAlong + edgeR;
      d0 = Math.min(exitD, oppA - 7.3);
      d1 = edgeR;
      sB = tr.s1 + Math.max(0, exitD - (oppA - 7.3));
    } else {
      ns0 = exitAlong - edgeR;
      ns1 = exitAlong - (oppE - 7.3);
      d0 = oppA - 7.3;
      d1 = Math.max(exitD, edgeR);
      sB = tr.s1 + Math.max(0, edgeR - exitD);
    }
    const a0 = Math.min(0, ns0);
    turns.push({
      s0: tr.s0,
      s1: tr.s1,
      name: tr.name,
      left,
      radius: tr.radius ?? 30,
      ox: o.x,
      oz: o.z,
      tx: t.x,
      tz: t.z,
      exitAlong,
      exitD,
      oppA,
      oppE,
      a0,
      a1: ns1,
      d0,
      d1,
      ns0,
      ns1,
      sA: tr.s0 + a0,
      sB,
      fromName: prevName,
    });
  }

  const finishS = route.data.finish?.s ?? route.length;
  const cross: CrossStreet[] = [];
  const raw = (route.data.intersections ?? [])
    .filter((x) => x && Number.isFinite(x.s))
    .slice()
    .sort((a, b) => a.s - b.s);
  for (const x of raw) {
    const hw = WIDE_CROSS[x.name] ?? W;
    if (x.s < hw + 60 || x.s > route.length - hw - 40) continue;
    if (turns.some((t) => x.s > t.sA - hw - 70 && x.s < t.sB + hw + 40)) continue;
    if (Math.abs(x.s - finishS) < hw + 20) continue;
    const prev = cross[cross.length - 1];
    if (prev && x.s - hw - (prev.s + prev.hw) < 60) continue;
    cross.push({ s: x.s, name: x.name || '', hw });
  }

  const gaps: RoadLayout['gaps'] = { right: [], lawn: [], median: [], far: [], farLawn: [], opp: [], marks: [] };
  for (const c of cross) {
    const w = c.hw;
    gaps.right.push([c.s - w, c.s + w]);
    gaps.far.push([c.s - w, c.s + w]);
    gaps.lawn.push([c.s - w - 6, c.s + w + 6]);
    gaps.farLawn.push([c.s - w - 6, c.s + w + 6]);
    gaps.median.push([c.s - w - 7, c.s + w + 7]);
    gaps.marks.push([c.s - w - XWALK.stop1, c.s + w + XWALK.stop1]);
  }
  for (const turn of turns) {
    gaps.right.push([turn.sA, turn.sB]);
    gaps.lawn.push([turn.sA - 6, turn.sB]);
    gaps.median.push([turn.sA - 7, turn.sB + 7]);
    gaps.far.push([turn.sA - 15, turn.sB + 15]);
    gaps.farLawn.push([turn.sA - 15, turn.sB + 15]);
    gaps.opp.push([turn.sA, turn.sB]);
    gaps.marks.push([turn.sA - XWALK.stop1, turn.sB + XWALK.stop1]);
  }

  const footprints: RoadLayout['footprints'] = [];
  for (const lm of route.data.landmarks ?? []) {
    const pts = lm.footprint;
    if (!pts || pts.length < 3) continue;
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    footprints.push({ pts, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) });
  }

  const s0 = -20;
  const s1 = route.length + 3;
  return {
    route,
    s0,
    s1,
    sMin: s0 - 100,
    sMax: s1 + 100,
    W,
    lanes,
    laneW,
    edgeL,
    edgeR,
    cross,
    turns,
    opp,
    gaps,
    footprints,
  };
}

/** True when s lies inside an intersection zone (including crosswalks) or a turn box. */
export function inJunction(l: RoadLayout, s: number, margin = 0): boolean {
  for (const c of l.cross) if (Math.abs(s - c.s) < c.hw + 8 + margin) return true;
  for (const t of l.turns) if (s > t.sA - 8 - margin && s < t.sB + 8 + margin) return true;
  return false;
}

function inPolygon(pts: readonly Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function edgeDistance(pts: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j];
    const [bx, bz] = pts[i];
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
}

/** True when world point (x, z) lies inside a landmark footprint grown by `margin` meters. */
export function inLandmark(l: RoadLayout, x: number, z: number, margin = 3): boolean {
  for (const f of l.footprints) {
    if (x < f.x0 - margin || x > f.x1 + margin || z < f.z0 - margin || z > f.z1 + margin) continue;
    if (inPolygon(f.pts, x, z) || edgeDistance(f.pts, x, z) < margin) return true;
  }
  return false;
}

/** True when world point (x, z) lies inside one of the route's clear zones (landmark sight lines). */
export function inClearZone(route: Route, x: number, z: number): boolean {
  return (route.data.clearZones ?? []).some((zone) => zone.length >= 3 && inPolygon(zone, x, z));
}
