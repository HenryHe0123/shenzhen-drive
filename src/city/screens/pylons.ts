import type { Route } from '../../route/Route';
import type { BuildingsData, CityModelsData, Vec2 } from '../../route/types';
import { getRoadLayout, inJunction, SIDE } from '../road/layout';
import { box, cityObstacles, DEG, lineBlocked, overlapsAny } from './geom';

export type PylonSide = 'right' | 'median' | 'left';

export interface PylonWindow {
  name: string;
  /** Arc-length window of the screen center (m). */
  s0: number;
  s1: number;
  /** Sides tried, best first. */
  sides: readonly PylonSide[];
}

export interface PylonSpec {
  /** Screen face size and bottom edge above ground (m). */
  width: number;
  height: number;
  bottom: number;
  /** Face yaw from square-on to the road toward the carriageway (deg). */
  yawDeg: number;
  /** Ground footprint around the face center in face coordinates (m): half width beyond the face, back and front depth. */
  footprintPad: number;
  footprintBack: number;
  footprintFront: number;
  /** Gap kept between the footprint and the sidewalk / median curb (m). */
  clearance: number;
  /** Extra lateral offsets tried beyond the closest position (m). */
  extraOffsets: readonly number[];
  /** Candidate step along s (m). */
  sStep: number;
  /** Chase-camera distances before the screen (m) scored for visibility; at least `minVisible` must see it. */
  viewBack: readonly number[];
  minVisible: number;
  /** Street-tree canopy model for the sight lines: radius around the trunk row and top height (m). */
  canopyRadius: number;
  canopyTop: number;
  /** Chase-camera distances (every step from min to max, m) whose sight lines to the landmarks the face may not cut. */
  landmarkBackMin: number;
  landmarkBackMax: number;
  landmarkBackStep: number;
}

export interface PylonPlacement {
  window: string;
  side: PylonSide;
  /** Route coordinates of the face center's ground point. */
  s: number;
  d: number;
  x: number;
  z: number;
  /** Unit face normal (toward approaching traffic). */
  nx: number;
  nz: number;
  /** Face yaw from square-on toward the carriageway (deg). */
  yawDeg: number;
  width: number;
  height: number;
  bottom: number;
  /** Ground footprint (world x/z, counter-clockwise). */
  footprint: Vec2[];
  /** Entries of spec.viewBack from which the face is in view and not hidden by buildings. */
  visible: number[];
  /**
   * Of those, the ones whose sight lines also clear the street-tree rows modelled as continuous
   * canopy bands (above the canopy or through a junction gap). The real rows have gaps between
   * trees, so this is a pessimistic bonus, not a requirement.
   */
  overTrees: number[];
}

export interface PylonSkip {
  window: string;
  reason: string;
}

const CAM_D = 1.75;
const EYE_Y = 1.8;
const CHASE_BACK = 6.8;
/** Horizontal half field of view the screen center must fall in (deg); the 16:9 chase view spans about ±45°. */
const HALF_FOV = 38;
/** Largest angle between the face normal and the direction to the viewer (deg). */
const MAX_VIEW_ANGLE = 65;

/** True when segment a→b crosses the vertical face rectangle. */
export function segmentHitsFace(p: PylonPlacement, a: [number, number, number], b: [number, number, number]): boolean {
  const da = (a[0] - p.x) * p.nx + (a[2] - p.z) * p.nz;
  const db = (b[0] - p.x) * p.nx + (b[2] - p.z) * p.nz;
  if (da * db > 0 || da === db) return false;
  const t = da / (da - db);
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  const z = a[2] + (b[2] - a[2]) * t;
  const u = (x - p.x) * p.nz - (z - p.z) * p.nx;
  return Math.abs(u) <= p.width / 2 && y >= p.bottom && y <= p.bottom + p.height;
}

/**
 * Free-standing APEC LED screens: one per window, on the lawn beyond the right sidewalk (or in a
 * wide median / beyond the far sidewalk), yawed toward approaching traffic with the bottom edge
 * above the tree canopy. A candidate's whole ground footprint (face, cabinet, columns) must stay
 * off the carriageways, sidewalks and junctions, out of the landmark clear zones, off landmark,
 * real-building model and extruded building footprints, and may not cut the chase camera's sight
 * lines to the landmarks. The best candidate is the one seen unobstructed from the most approach
 * distances. Deterministic for a given data set.
 */
export function placePylons(
  route: Route,
  buildings: BuildingsData | null,
  cityModels: CityModelsData | null,
  windows: readonly PylonWindow[],
  spec: PylonSpec,
): { placed: PylonPlacement[]; skipped: PylonSkip[] } {
  const l = getRoadLayout(route);
  const obs = cityObstacles(route, buildings, cityModels);
  const solid = [...obs.landmarks, ...obs.models, ...obs.extruded];
  const marks = (route.data.landmarks ?? []).filter((m) => (m.height ?? 0) > 0);
  const placed: PylonPlacement[] = [];
  const skipped: PylonSkip[] = [];

  /** Lateral band (route d) the footprint must stay inside on each side, or null where there is none. */
  const band = (side: PylonSide, s: number): [number, number] | null => {
    const lawn = SIDE.lawn[1] - SIDE.lawn[0];
    if (side === 'right') return [l.walkR(s)[1] + spec.clearance, l.walkR(s)[1] + lawn + 40];
    if (side === 'left') return [l.walkL(s)[1] - lawn - 40, l.walkL(s)[1] - spec.clearance];
    const lo = l.opp(s) + 7.3 + 0.3 + spec.clearance;
    const hi = l.edgeL - 0.3 - spec.clearance;
    return hi > lo ? [lo, hi] : null;
  };

  /**
   * Street-tree rows as canopy bands (route d range, top height, junction gaps), after the layout
   * in src/city/props: right planting strip, median edges and far planting strip.
   */
  const inGap = (list: [number, number][], s: number, pad: number) => list.some(([a, b]) => s > a - pad && s < b + pad);
  const rows = [
    { d0: (s: number) => l.plantR(s) - spec.canopyRadius, d1: (s: number) => l.plantR(s) + spec.canopyRadius, gap: (s: number) => inGap(l.gaps.right, s, 4) },
    { d0: (s: number) => l.opp(s) + 7.6, d1: (_s: number) => l.edgeL - 0.3, gap: (s: number) => inGap(l.gaps.median, s, 3) },
    {
      d0: (s: number) => l.plantL(s) - spec.canopyRadius,
      d1: (s: number) => l.plantL(s) + spec.canopyRadius,
      gap: (s: number) => inGap(l.gaps.far, s, 4) || inGap(l.gaps.opp, s, 4),
    },
  ];
  /** True when the line from the chase camera at sc to (st, dt, yt) passes through a tree canopy band. */
  const canopyBlocked = (sc: number, st: number, dt: number, yt: number) => {
    for (const r of rows) {
      for (let k = 0; k <= 24; k++) {
        const f = k / 24;
        const sk = sc + (st - sc) * f;
        const dk = CAM_D + (dt - CAM_D) * f;
        if (dk < r.d0(sk) || dk > r.d1(sk)) continue;
        if (EYE_Y + (yt - EYE_Y) * f < spec.canopyTop && !r.gap(sk)) return true;
      }
    }
    return false;
  };
  const hw = spec.width / 2 + spec.footprintPad;
  const depth = spec.footprintBack + spec.footprintFront;
  const candidate = (w: PylonWindow, side: PylonSide, s: number, extra: number): PylonPlacement | string => {
    const b = band(side, s);
    if (!b) return 'no median';
    // The face is nearly square-on to traffic, so its width spans the band laterally.
    const yaw = spec.yawDeg / DEG;
    if (2 * hw * Math.cos(yaw) + depth * Math.sin(yaw) > b[1] - b[0]) return 'too wide for the band';
    const t = route.tangentAt(s);
    const rx = -t.z;
    const rz = t.x;
    // Toward the carriageway: left (-r) from the right lawn, right (+r) from the median or the far side.
    const k = side === 'right' ? -1 : 1;
    const nx = -t.x * Math.cos(yaw) + k * rx * Math.sin(yaw);
    const nz = -t.z * Math.cos(yaw) + k * rz * Math.sin(yaw);
    const ex = nz;
    const ez = -nx;
    const local: [number, number][] = [
      [-hw, -spec.footprintBack],
      [hw, -spec.footprintBack],
      [hw, spec.footprintFront],
      [-hw, spec.footprintFront],
    ];
    const rel = local.map(([u, v]) => [ex * u + nx * v, ez * u + nz * v] as const);
    const relD = rel.map(([x, z]) => x * rx + z * rz);
    const dLo = Math.min(...relD);
    const dHi = Math.max(...relD);
    let d: number;
    if (side === 'right') d = b[0] - dLo + extra;
    else if (side === 'left') d = b[1] - dHi - extra;
    else d = (b[0] + b[1]) / 2 - (dLo + dHi) / 2;
    const c = route.pointAt(s, d);
    const footprint: Vec2[] = rel.map(([x, z]) => [c.x + x, c.z + z]);
    // Every footprint edge sample stays in its band, clear of junctions and turn boxes.
    for (let i = 0; i < 4; i++) {
      const [ax, az] = footprint[i];
      const [bx, bz] = footprint[(i + 1) % 4];
      for (let j = 0; j < 8; j++) {
        const f = j / 8;
        const pr = route.project(ax + (bx - ax) * f, az + (bz - az) * f, s, 400);
        if (inJunction(l, pr.s, 8)) return 'junction';
        const pb = band(side, pr.s);
        if (!pb || pr.d < pb[0] - 0.05 || pr.d > pb[1] + 0.05) return 'off its band (road, sidewalk or curve)';
      }
    }
    const fpBox = box(footprint, 0, 0);
    if (overlapsAny(fpBox, obs.zones)) return 'clear zone';
    if (overlapsAny(fpBox, solid, 2)) return 'building or landmark footprint';
    const p: PylonPlacement = {
      window: w.name,
      side,
      s,
      d,
      x: c.x,
      z: c.z,
      nx,
      nz,
      yawDeg: spec.yawDeg,
      width: spec.width,
      height: spec.height,
      bottom: spec.bottom,
      footprint,
      visible: [],
      overTrees: [],
    };
    for (let back = spec.landmarkBackMin; back <= spec.landmarkBackMax; back += spec.landmarkBackStep) {
      const v = route.pointAt(route.clampS(s - back - CHASE_BACK), CAM_D);
      const eye: [number, number, number] = [v.x, EYE_Y, v.z];
      for (const m of marks) {
        const h = m.height ?? 0;
        for (const f of [0.5, 0.8]) if (segmentHitsFace(p, eye, [m.x, h * f, m.z])) return `hides ${m.id}`;
      }
    }
    // Slogan height across the face; at least two of the three must be in plain sight.
    const yT = spec.bottom + spec.height * 0.6;
    const targets = [-0.35, 0, 0.35].map((u) => {
      const x = c.x + ex * u * spec.width;
      const z = c.z + ez * u * spec.width;
      return { x, y: yT, z, pr: route.project(x, z, s, 100) };
    });
    for (const back of spec.viewBack) {
      const sv = route.clampS(s - back);
      const sc = route.clampS(sv - CHASE_BACK);
      const v = route.pointAt(sc, CAM_D);
      const f = route.tangentAt(sv);
      const dx = c.x - v.x;
      const dz = c.z - v.z;
      const len = Math.hypot(dx, dz);
      if ((f.x * dx + f.z * dz) / len < Math.cos(HALF_FOV / DEG)) continue;
      if (-(nx * dx + nz * dz) / len < Math.cos(MAX_VIEW_ANGLE / DEG)) continue;
      const seen = targets.filter((t) => !lineBlocked(obs.occluders, v.x, EYE_Y, v.z, t.x, t.y, t.z));
      if (seen.length < 2) continue;
      p.visible.push(back);
      if (seen.filter((t) => !canopyBlocked(sc, t.pr.s, t.pr.d, t.y)).length >= 2) p.overTrees.push(back);
    }
    return p;
  };

  for (const w of windows) {
    let best: { p: PylonPlacement; score: number } | null = null;
    const reasons = new Map<string, number>();
    w.sides.forEach((side, rank) => {
      for (let s = w.s0; s <= w.s1 + 1e-6; s += spec.sStep) {
        for (const extra of [0, ...spec.extraOffsets]) {
          const r = candidate(w, side, s, extra);
          if (typeof r === 'string') {
            reasons.set(r, (reasons.get(r) ?? 0) + 1);
            continue;
          }
          if (r.visible.length < spec.minVisible) {
            reasons.set('blocked from the approach', (reasons.get('blocked from the approach') ?? 0) + 1);
            continue;
          }
          // Most viewpoints, those over the tree rows counting extra (on 深南大道 the far side sits
          // behind the median trees, on the CBD streets it does not), then the preferred side, the
          // closest offset and the window middle.
          const score =
            100 * r.visible.length + 60 * r.overTrees.length - 150 * rank - 2 * extra - 0.01 * Math.abs(s - (w.s0 + w.s1) / 2);
          if (!best || score > best.score) best = { p: r, score };
          break;
        }
      }
    });
    if (best) placed.push((best as { p: PylonPlacement }).p);
    else skipped.push({ window: w.name, reason: [...reasons].map(([r, n]) => `${r} ×${n}`).join(', ') });
  }
  return { placed, skipped };
}
