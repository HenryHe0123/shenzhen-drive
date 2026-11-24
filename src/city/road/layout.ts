import { CONFIG } from '../../config';
import type { Route } from '../../route/Route';

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
}

export interface TurnLayout {
  s0: number;
  s1: number;
  name: string;
  left: boolean;
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
  turn: TurnLayout | null;
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
}

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

  let turn: TurnLayout | null = null;
  const tr = route.data.turn;
  if (tr && tr.s1 > tr.s0 && tr.s0 > 60 && tr.s1 < route.length - 5) {
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
    turn = {
      s0: tr.s0,
      s1: tr.s1,
      name: tr.name,
      left,
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
    };
  }

  const finishS = route.data.finish?.s ?? route.length;
  const cross: CrossStreet[] = [];
  const raw = (route.data.intersections ?? [])
    .filter((x) => x && Number.isFinite(x.s))
    .slice()
    .sort((a, b) => a.s - b.s);
  for (const x of raw) {
    if (x.s < W + 60 || x.s > route.length - W - 40) continue;
    if (turn && x.s > turn.sA - W - 70 && x.s < turn.sB + W + 40) continue;
    if (Math.abs(x.s - finishS) < W + 20) continue;
    const prev = cross[cross.length - 1];
    if (prev && x.s - prev.s < 2 * W + 60) continue;
    cross.push({ s: x.s, name: x.name || '' });
  }

  const gaps: RoadLayout['gaps'] = { right: [], lawn: [], median: [], far: [], farLawn: [], opp: [], marks: [] };
  for (const c of cross) {
    gaps.right.push([c.s - W, c.s + W]);
    gaps.far.push([c.s - W, c.s + W]);
    gaps.lawn.push([c.s - W - 6, c.s + W + 6]);
    gaps.farLawn.push([c.s - W - 6, c.s + W + 6]);
    gaps.median.push([c.s - W - 7, c.s + W + 7]);
    gaps.marks.push([c.s - W - XWALK.stop1, c.s + W + XWALK.stop1]);
  }
  if (turn) {
    gaps.right.push([turn.sA, turn.sB]);
    gaps.lawn.push([turn.sA - 6, turn.sB]);
    gaps.median.push([turn.sA - 7, turn.sB + 7]);
    gaps.far.push([turn.sA - 15, turn.sB + 15]);
    gaps.farLawn.push([turn.sA - 15, turn.sB + 15]);
    gaps.opp.push([turn.sA, turn.sB]);
    gaps.marks.push([turn.sA - XWALK.stop1, turn.sB + XWALK.stop1]);
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
    turn,
    opp,
    gaps,
  };
}

/** True when s lies inside an intersection zone (including crosswalks) or the turn box. */
export function inJunction(l: RoadLayout, s: number, margin = 0): boolean {
  for (const c of l.cross) if (Math.abs(s - c.s) < l.W + 8 + margin) return true;
  if (l.turn && s > l.turn.sA - 8 - margin && s < l.turn.sB + 8 + margin) return true;
  return false;
}
