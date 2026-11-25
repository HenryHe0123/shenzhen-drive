import * as THREE from 'three';
import type { RGB } from '../road/builder';
import type { PropGeo } from './geo';

const CONCRETE: RGB = [0.6, 0.6, 0.58];
const STEEL: RGB = [0.42, 0.45, 0.49];
const GLASS: RGB = [0.3, 0.4, 0.45];
const FRAME: RGB = [0.2, 0.22, 0.24];
const ROOF: RGB = [0.74, 0.75, 0.77];
const SEAT: RGB = [0.5, 0.36, 0.22];
const LIGHT: RGB = [2.2, 2.2, 2.05];

/** Footbridge deck: underside clearance and slab, railing height, deck width (m). */
export const BRIDGE = { clearance: 5.5, slab: 0.7, rail: 1.1, width: 3.2, stairRun: 11, stairWidth: 2.2 };

/**
 * Pedestrian bridge across the road in the frame `m` (local +x = route right, z along the road):
 * deck from x0 to x1, piers at `piers` (x), a stair at each end descending along +z.
 * Visual only (no collision).
 */
export function footbridge(g: PropGeo, m: THREE.Matrix4, x0: number, x1: number, piers: number[]) {
  const { clearance: y0, slab, rail, width: w } = BRIDGE;
  const y1 = y0 + slab;
  const len = x1 - x0;
  const xc = (x0 + x1) / 2;
  g.box(m, xc, y0 + slab / 2, 0, len, slab, w, CONCRETE);
  for (const z of [-w / 2 + 0.05, w / 2 - 0.05]) {
    g.box(m, xc, y1 + rail / 2, z, len, rail - 0.1, 0.04, GLASS);
    g.box(m, xc, y1 + rail, z, len, 0.08, 0.1, STEEL);
  }
  for (const x of piers) g.box(m, x, y0 / 2, 0, 0.8, y0, 0.8, CONCRETE);
  for (const [xe, dir] of [
    [x0, 1],
    [x1, -1],
  ] as const) {
    const xs = xe + (dir * BRIDGE.stairWidth) / 2 + dir * 0.1;
    stair(g, m, xs, y1, w / 2);
  }
}

/** Straight flight from the deck edge (z = zTop, height h) down to the ground along +z. */
function stair(g: PropGeo, m: THREE.Matrix4, x: number, h: number, zTop: number) {
  const run = BRIDGE.stairRun;
  const len = Math.hypot(run, h);
  const ang = Math.atan2(h, run);
  const f = new THREE.Matrix4()
    .makeTranslation(x, h / 2, zTop + run / 2)
    .multiply(new THREE.Matrix4().makeRotationX(ang))
    .premultiply(m);
  const sw = BRIDGE.stairWidth;
  g.box(f, 0, 0, 0, sw, 0.3, len, CONCRETE);
  for (const sx of [-sw / 2, sw / 2]) {
    g.box(f, sx, 0.55, 0, 0.04, 0.9, len, GLASS);
    g.box(f, sx, 1.05, 0, 0.08, 0.08, len, STEEL);
  }
  g.box(m, x, h / 2, zTop + run + 0.4, sw, 0.05, 0.8, CONCRETE);
  g.box(m, x, (h - 0.35) / 2, zTop + 0.6, 0.6, h - 0.35, 0.6, CONCRETE);
}

/**
 * Bus shelter in the frame `m` (local +x away from the road, z along it): 8 m canopy, glass back
 * wall, bench, a plain light box at one end. Returns the local post spot for the stop sign.
 */
export function busShelter(g: PropGeo, glow: PropGeo, m: THREE.Matrix4): [number, number] {
  const L = 8;
  g.box(m, -0.05, 2.66, 0, 2.1, 0.12, L + 0.4, ROOF);
  for (const z of [-L / 2 + 0.2, 0, L / 2 - 0.2]) g.box(m, 0.8, 1.3, z, 0.1, 2.6, 0.1, FRAME);
  g.box(m, 0.82, 1.35, 0, 0.04, 2.1, L - 0.4, GLASS);
  g.box(m, 0.45, 0.46, 0, 0.42, 0.06, L * 0.55, SEAT);
  for (const z of [-L * 0.25, L * 0.25]) g.box(m, 0.45, 0.22, z, 0.1, 0.44, 0.1, FRAME);
  g.box(m, 0.2, 1.3, L / 2 + 0.05, 1.2, 1.9, 0.16, FRAME);
  glow.box(m, 0.2, 1.3, L / 2 + 0.14, 1.05, 1.7, 0.02, LIGHT);
  glow.box(m, 0.2, 1.3, L / 2 - 0.04, 1.05, 1.7, 0.02, LIGHT);
  g.cylinder(m, [-0.85, 0, -L / 2 - 0.6], [-0.85, 3.2, -L / 2 - 0.6], 0.05, 0.04, 8, STEEL);
  return [-0.85, -L / 2 - 0.6];
}

/** Subway entrance canopy in the frame `m` (local +x away from the road): glass box, open toward -z. */
export function subwayCanopy(g: PropGeo, glow: PropGeo, m: THREE.Matrix4) {
  const W = 3.4;
  const L = 7;
  const H = 3.0;
  g.box(m, 0, H - 0.12, 0, W + 0.3, 0.24, L + 0.3, ROOF);
  for (const x of [-W / 2, W / 2]) {
    g.box(m, x, (H - 0.24) / 2, 0, 0.05, H - 0.24, L, GLASS);
    for (const z of [-L / 2, 0, L / 2]) g.box(m, x, (H - 0.24) / 2, z, 0.12, H - 0.24, 0.12, FRAME);
  }
  g.box(m, 0, (H - 0.24) / 2, L / 2, W, H - 0.24, 0.12, FRAME);
  glow.box(m, 0, H - 0.27, -L / 2 - 0.12, W, 0.08, 0.04, LIGHT);
}
