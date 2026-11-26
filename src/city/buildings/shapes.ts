import type { BuildingUse, SectionId, Vec2 } from '../../route/types';
import { FacadeBuilder, rectRing, ringArea, ringCentroid } from './builder';
import { STYLE } from './facadeMaterial';

/** Building massing shared by the corridor buildings and the whole-city detail tiles (also runs in a worker). */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromId(id: number): number {
  const lo = id % 2147483647;
  const hi = Math.floor(id / 2147483647);
  let h = Math.imul(lo ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(hi + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function pointInRing(ring: Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Facade family from use and age when known (offices glass, 1980s–90s housing tile, low industrial sheds metal). */
function styleByUse(h: number, r: number, use: BuildingUse | undefined, old: boolean): number | null {
  switch (use) {
    case 'office':
      if (old) return r < 0.4 ? STYLE.mixed : r < 0.7 ? STYLE.bronzeGlass : STYLE.tealGlass;
      return r < 0.45 ? STYLE.blueGlass : r < 0.75 ? STYLE.silverGlass : STYLE.tealGlass;
    case 'commercial':
      if (h < 24) return r < 0.6 ? STYLE.mixed : STYLE.stone;
      if (old) return r < 0.6 ? STYLE.mixed : STYLE.bronzeGlass;
      return r < 0.45 ? STYLE.blueGlass : r < 0.7 ? STYLE.silverGlass : STYLE.mixed;
    case 'residential':
      if (old || h < 60) return r < 0.8 ? STYLE.residential : STYLE.stone;
      return r < 0.65 ? STYLE.residential : STYLE.mixed;
    case 'public':
      return r < 0.55 ? STYLE.stone : STYLE.mixed;
    case 'industrial':
      return h < 20 ? STYLE.mech : STYLE.stone;
  }
  return null;
}

/**
 * Corridor buildings: by use and age when the data has them, else by zone: tech-park glass, OCT stone and
 * tile, Chegongmiao mixed, CBD glass towers.
 */
export function styleFor(zone: SectionId, h: number, r: number, use?: BuildingUse, age?: string): number {
  const byUse = styleByUse(h, r, use, age === '1980s' || age === '1990s');
  if (byUse !== null) return byUse;
  if (h < 18) return r < 0.45 ? STYLE.stone : r < 0.7 ? STYLE.residential : STYLE.mixed;
  switch (zone) {
    case 'nanshan':
      return r < 0.3 ? STYLE.tealGlass : r < 0.55 ? STYLE.blueGlass : r < 0.7 ? STYLE.silverGlass : r < 0.88 ? STYLE.mixed : STYLE.residential;
    case 'oct':
      if (h < 90 && r < 0.6) return r < 0.32 ? STYLE.stone : STYLE.residential;
      return r < 0.75 ? STYLE.mixed : r < 0.88 ? STYLE.bronzeGlass : STYLE.tealGlass;
    case 'chegongmiao':
      if (h < 120 && r < 0.25) return STYLE.residential;
      return r < 0.45 ? STYLE.mixed : r < 0.65 ? STYLE.blueGlass : r < 0.8 ? STYLE.silverGlass : r < 0.9 ? STYLE.bronzeGlass : STYLE.stone;
    case 'futian':
    default:
      return r < 0.35 ? STYLE.blueGlass : r < 0.55 ? STYLE.silverGlass : r < 0.7 ? STYLE.tealGlass : r < 0.82 ? STYLE.bronzeGlass : STYLE.mixed;
  }
}

/** Style random from the top 8 bits of a whole-city building seed: the mass tiles carry only those, so both LODs agree. */
export function styleSeed(seed: number): number {
  return (Math.floor(seed * 256) + 0.5) / 256;
}

/**
 * Whole-city buildings without a zone: by use and age when known; otherwise low buildings stone / tile,
 * slim towers (the residential towers that make up most of the skyline outside the CBDs) tile, broad
 * towers glass offices.
 */
export function metroStyle(h: number, area: number, r: number, use?: BuildingUse, age?: string): number {
  const byUse = styleByUse(h, r, use, age === '1980s' || age === '1990s');
  if (byUse !== null) return byUse;
  if (h < 18) return area > 3000 ? (r < 0.6 ? STYLE.mech : STYLE.stone) : r < 0.5 ? STYLE.residential : r < 0.8 ? STYLE.stone : STYLE.mixed;
  if (h < 60) return r < 0.6 ? STYLE.residential : r < 0.85 ? STYLE.mixed : STYLE.stone;
  if (area < 1400) return r < 0.7 ? STYLE.residential : r < 0.9 ? STYLE.mixed : STYLE.silverGlass;
  return r < 0.3 ? STYLE.blueGlass : r < 0.5 ? STYLE.silverGlass : r < 0.65 ? STYLE.tealGlass : r < 0.75 ? STYLE.bronzeGlass : STYLE.mixed;
}

/**
 * Extrudes one building from y0 (relative to `base`, the ground it stands on) to h with roof equipment and,
 * on some towers, a set-back crown. Heights are above `base`; the prism starts at base + y0.
 */
export function addBuilding(b: FacadeBuilder, ring: Vec2[], h: number, seed: number, style: number, podium: number, y0 = 0, base = 0, holes: Vec2[][] = []) {
  b.addPrism(ring, base + y0, base + h, [seed, style, podium, h], true, STYLE.roof, base, holes);
  const rng = mulberry32(Math.floor(seed * 1e9) ^ 0x5bd1e995);
  const area = Math.abs(ringArea(ring));
  if (h < 25 || area < 150) return;
  const [cx, cz] = ringCentroid(ring);
  if (!pointInRing(ring, cx, cz)) return;
  if (holes.some((hole) => pointInRing(hole, cx, cz))) return;
  // Long-edge axis for aligning roof boxes.
  let ax = 1;
  let az = 0;
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > best) {
      best = l;
      ax = (q[0] - p[0]) / l;
      az = (q[1] - p[1]) / l;
    }
  }
  const size = Math.sqrt(area);
  if (h > 90 && ring.length <= 10 && rng() < 0.75) {
    const k = 0.62 + rng() * 0.15;
    const crown = ring.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k] as Vec2);
    const ch = 5 + rng() * 9;
    b.addPrism(crown, base + h, base + h + ch, [seed, rng() < 0.5 ? style : STYLE.mech, 0, h + ch], true, STYLE.roof, base);
    h += ch;
  }
  const boxes = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < boxes; i++) {
    const w = Math.min(14, Math.max(3, size * (0.12 + rng() * 0.15)));
    const d = Math.min(10, Math.max(2.5, size * (0.08 + rng() * 0.12)));
    const ox = (rng() - 0.5) * size * 0.35;
    const oz = (rng() - 0.5) * size * 0.35;
    const bx = cx + ax * ox - az * oz;
    const bz = cz + az * ox + ax * oz;
    const box = rectRing(bx, bz, ax, az, w / 2, d / 2);
    if (!box.every(([x, z]) => pointInRing(ring, x, z))) continue;
    const bh = 2.5 + rng() * 4;
    b.addPrism(box, base + h, base + h + bh, [seed, STYLE.mech, 0, h + bh], true, STYLE.roof, base);
  }
}
