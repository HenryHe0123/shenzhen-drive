import * as THREE from 'three';
import type { Mapper, Painter, RGB, Style } from './builder';
import { intersect, subtract } from './builder';
import type { Interval, RoadLayout } from './layout';
import { XWALK } from './layout';

export const MARK_Y = 0.006;
export const WHITE: RGB = [0.92, 0.92, 0.9];
export const YELLOW: RGB = [0.95, 0.62, 0.07];
const BLACK: RGB = [0.025, 0.025, 0.028];

const markStyle = (color: RGB): Style => ({ color, uk: 1 / 1.5, vk: 1 / 3 });

/** Dashed line along a at lateral b; dash phase is global in a so chunks line up. */
export function dashes(
  p: Painter,
  m: Mapper,
  a0: number,
  a1: number,
  b: number | ((a: number) => number),
  w: number,
  on: number,
  off: number,
  color: RGB,
) {
  const period = on + off;
  const st = markStyle(color);
  const bl = typeof b === 'number' ? b - w / 2 : (a: number) => b(a) - w / 2;
  const br = typeof b === 'number' ? b + w / 2 : (a: number) => b(a) + w / 2;
  for (let k = Math.floor(a0 / period); k * period < a1; k++) {
    const s = Math.max(a0, k * period);
    const e = Math.min(a1, k * period + on);
    if (e - s > 0.3) p.ribbon('mark', m, s, e, bl, br, MARK_Y, st);
  }
}

export function solid(p: Painter, m: Mapper, a0: number, a1: number, b0: number | ((a: number) => number), b1: number | ((a: number) => number), color: RGB) {
  p.ribbon('mark', m, a0, a1, b0, b1, MARK_Y, markStyle(color));
}

/** Zebra crossing: stripes run along a (traffic direction), stacked across b. */
export function zebra(p: Painter, m: Mapper, a0: number, a1: number, b0: number, b1: number) {
  const st = markStyle(WHITE);
  for (let b = b0 + 0.3; b + 0.45 <= b1 - 0.2; b += 1.0) p.ribbon('mark', m, a0, a1, b, b + 0.45, MARK_Y, st);
}

const straightArrow = [
  [-0.15, 0],
  [0.15, 0],
  [0.15, 4.2],
  [0.48, 4.2],
  [0, 6],
  [-0.48, 4.2],
  [-0.15, 4.2],
];

function leftArrowPts(): number[][] {
  const pts: number[][] = [[0.15, 0], [0.15, 4.3]];
  for (const deg of [22.5, 45, 67.5]) {
    const t = (deg * Math.PI) / 180;
    pts.push([-0.15 + 0.3 * Math.cos(t), 4.3 + 0.3 * Math.sin(t)]);
  }
  pts.push([-0.15, 4.6], [-0.7, 4.6], [-0.7, 4.95], [-1.9, 4.45], [-0.7, 3.95], [-0.7, 4.3], [-0.15, 4.3], [-0.15, 0]);
  return pts.map(([x, y]) => [x + 0.85, y * 1.2]);
}

const triangulate = (pts: number[][]) =>
  THREE.ShapeUtils.triangulateShape(
    pts.map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );

const ARROWS = {
  straight: { pts: straightArrow, tris: triangulate(straightArrow) },
  left: (() => {
    const pts = leftArrowPts();
    return { pts, tris: triangulate(pts) };
  })(),
};

export function arrow(p: Painter, m: Mapper, a: number, b: number, kind: 'straight' | 'left') {
  const A = ARROWS[kind];
  p.shape('mark', m, a, b, A.pts, A.tris, MARK_Y, markStyle(WHITE));
}

/** Checkered band across [b0, b1] centred on a. */
export function checker(p: Painter, m: Mapper, a: number, b0: number, b1: number, size = 0.7) {
  const cols = Math.max(2, Math.round((b1 - b0) / size));
  const w = (b1 - b0) / cols;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cols; c++) {
      const col = (r + c) % 2 === 0 ? WHITE : BLACK;
      p.ribbon('mark', m, a - size + r * size, a + r * size, b0 + c * w, b0 + (c + 1) * w, MARK_Y + 0.001, markStyle(col));
    }
  }
}

/** All markings on the route-following carriageways. */
export function paintRouteMarkings(p: Painter, rm: Mapper, l: RoadLayout) {
  const { route, lanes, laneW, W, turn } = l;
  const dMin = route.dMin;
  const dMax = route.dMax;
  const len = route.length;
  const oppC = (a: number) => l.opp(a);

  // Solid lane lines (no lane change) before stop lines; dashes elsewhere.
  const solidOurs: Interval[] = [];
  const solidOpp: Interval[] = [];
  const stops: { s: number; zoneEnd: number }[] = l.cross.map((c) => ({ s: c.s - W, zoneEnd: c.s + W }));
  if (turn) stops.push({ s: turn.sA, zoneEnd: turn.sB });
  for (const st of stops) {
    solidOurs.push([st.s - XWALK.stop1 - 30, st.s - XWALK.stop1]);
    solidOpp.push([st.zoneEnd + XWALK.stop1, st.zoneEnd + XWALK.stop1 + 30]);
  }

  const lineGapsOurs = [...l.gaps.marks, ...solidOurs];
  const lineGapsOpp = [...l.gaps.marks, ...l.gaps.opp, ...solidOpp];
  for (let k = 1; k < lanes; k++) {
    const d = dMin + k * laneW;
    for (const [a, b] of subtract(l.s0, l.s1, lineGapsOurs)) dashes(p, rm, a, b, d, 0.15, 6, 9, WHITE);
    for (const [a, b] of intersect(l.s0, l.s1, solidOurs)) solid(p, rm, a, b, d - 0.075, d + 0.075, WHITE);
    const od = (a: number) => oppC(a) - 7 + k * laneW;
    for (const [a, b] of subtract(l.s0, l.s1, lineGapsOpp)) dashes(p, rm, a, b, od, 0.15, 6, 9, WHITE);
    for (const [a, b] of intersect(l.s0, l.s1, solidOpp)) solid(p, rm, a, b, (s) => od(s) - 0.075, (s) => od(s) + 0.075, WHITE);
  }

  // Edge lines: yellow next to the median, white on the outside.
  for (const [a, b] of subtract(l.s0, l.s1, l.gaps.marks)) {
    solid(p, rm, a, b, dMin + 0.1, dMin + 0.3, YELLOW);
    solid(p, rm, a, b, dMax - 0.3, dMax - 0.1, WHITE);
  }
  for (const [a, b] of subtract(l.s0, l.s1, [...l.gaps.marks, ...l.gaps.opp])) {
    solid(p, rm, a, b, (s) => oppC(s) + 6.7, (s) => oppC(s) + 6.9, YELLOW);
    solid(p, rm, a, b, (s) => oppC(s) - 6.9, (s) => oppC(s) - 6.7, WHITE);
  }

  // Intersections: crosswalks over both carriageways, stop lines, guide dashes through the box.
  for (const c of l.cross) {
    const z0 = c.s - W;
    const z1 = c.s + W;
    zebra(p, rm, z0 - XWALK.far, z0 - XWALK.near, oppC(c.s) - 7, dMax);
    zebra(p, rm, z1 + XWALK.near, z1 + XWALK.far, oppC(c.s) - 7, dMax);
    solid(p, rm, z0 - XWALK.stop1, z0 - XWALK.stop0, dMin + 0.1, dMax - 0.1, WHITE);
    solid(p, rm, z1 + XWALK.stop0, z1 + XWALK.stop1, (s) => oppC(s) - 6.9, (s) => oppC(s) + 6.9, WHITE);
    for (let k = 0; k <= lanes; k++) {
      const d = k === 0 ? dMin + 0.2 : k === lanes ? dMax - 0.2 : dMin + k * laneW;
      dashes(p, rm, z0 - XWALK.near + 0.8, z1 + XWALK.near - 0.8, d, 0.15, 2, 2, WHITE);
    }
    for (let k = 0; k < lanes; k++) arrow(p, rm, z0 - XWALK.stop1 - 24, dMin + (k + 0.5) * laneW, 'straight');
  }

  if (turn) {
    const oA = turn.oppA;
    zebra(p, rm, turn.sA - XWALK.far, turn.sA - XWALK.near, oA - 7, dMax);
    solid(p, rm, turn.sA - XWALK.stop1, turn.sA - XWALK.stop0, dMin + 0.1, dMax - 0.1, WHITE);
    zebra(p, rm, turn.sB + XWALK.near, turn.sB + XWALK.far, turn.oppE - 7, dMax);
    solid(p, rm, turn.sB + XWALK.stop0, turn.sB + XWALK.stop1, (s) => oppC(s) - 6.9, (s) => oppC(s) + 6.9, WHITE);
    for (let k = 0; k <= lanes; k++) {
      const d = k === 0 ? dMin + 0.2 : k === lanes ? dMax - 0.2 : dMin + k * laneW;
      dashes(p, rm, turn.sA - XWALK.near + 0.8, turn.sB + XWALK.near - 0.8, d, 0.15, 2, 2, WHITE);
    }
    for (const back of [30, 80, 130]) {
      const s = turn.sA - XWALK.stop1 - back;
      if (s < 20) continue;
      for (let k = 0; k < Math.min(2, lanes); k++) arrow(p, rm, s, dMin + (k + 0.5) * laneW, 'left');
    }
  }

  // Occasional straight arrows on open road.
  for (let s = 260; s < len - 200; s += 420) {
    if (stops.some((st) => s > st.s - 90 && s < st.zoneEnd + 40)) continue;
    if (turn && s > turn.sA - 200) continue;
    for (let k = 1; k < lanes - 1; k++) arrow(p, rm, s, dMin + (k + 0.5) * laneW, 'straight');
  }

  checker(p, rm, 0, dMin + 0.3, dMax - 0.3);
  const fin = route.data.finish?.s;
  if (fin !== undefined && fin > 0 && fin < len + 1) checker(p, rm, fin, dMin + 0.3, dMax - 0.3);
}
