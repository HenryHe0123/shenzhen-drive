import type { Route } from '../../route/Route';
import type { BuildingRecord, BuildingsData, CityModelsData, Vec2 } from '../../route/types';
import { insideLandmarkSite, resolveLandmarkSites } from '../landmarks/placement';

export interface Box {
  ring: Vec2[];
  h: number;
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const DEG = 180 / Math.PI;

export function box(ring: Vec2[], h: number, id: number, margin = 0): Box {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { ring, h, id, minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

export function pointInRing(ring: Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Parameter t on p→q where it crosses segment a→b, or -1. */
export function crossT(px: number, pz: number, qx: number, qz: number, a: Vec2, b: Vec2): number {
  const rx = qx - px;
  const rz = qz - pz;
  const sx = b[0] - a[0];
  const sz = b[1] - a[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const ax = a[0] - px;
  const az = a[1] - pz;
  const t = (ax * sz - az * sx) / den;
  const u = (ax * rz - az * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Distance from (x, z) to the ring's outline, 0 inside. */
export function ringDistance(ring: Vec2[], x: number, z: number): number {
  if (pointInRing(ring, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const ex = ring[i][0] - ax;
    const ez = ring[i][1] - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
}

export function ringsOverlap(a: Vec2[], b: Vec2[]): boolean {
  if (a.some(([x, z]) => pointInRing(b, x, z)) || b.some(([x, z]) => pointInRing(a, x, z))) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) if (crossT(p[0], p[1], q[0], q[1], b[j], b[(j + 1) % b.length]) >= 0) return true;
  }
  return false;
}

/** True when ring `r` overlaps any box in `list`, or comes within `margin` meters of one. */
export function overlapsAny(r: Box, list: Box[], margin = 0): boolean {
  for (const k of list) {
    if (r.maxX < k.minX - margin || r.minX > k.maxX + margin || r.maxZ < k.minZ - margin || r.minZ > k.maxZ + margin) continue;
    if (ringsOverlap(r.ring, k.ring)) return true;
    if (margin > 0 && (r.ring.some(([x, z]) => ringDistance(k.ring, x, z) < margin) || k.ring.some(([x, z]) => ringDistance(r.ring, x, z) < margin))) {
      return true;
    }
  }
  return false;
}

export interface CityObstacles {
  /** OSM ids replaced by real-building models. */
  replaced: Set<number>;
  /** Real-building model footprints (grown by 3 m). */
  models: Box[];
  /** Landmark sight-line zones (route.json clearZones). */
  zones: Box[];
  /** Landmark footprints from the route data. */
  landmarks: Box[];
  /** Everything that can hide a screen: models, landmarks and extruded OSM buildings. */
  occluders: Box[];
  /** Extruded OSM buildings (same skip rules as src/city/buildings). */
  extruded: Box[];
  /** True when src/city/buildings really extrudes this OSM building. */
  rendered(b: BuildingRecord): boolean;
}

export function cityObstacles(route: Route, buildings: BuildingsData | null, cityModels: CityModelsData | null): CityObstacles {
  const sites = resolveLandmarkSites(route);
  const replaced = new Set<number>();
  const models: Box[] = [];
  for (const m of cityModels?.models ?? []) {
    for (const id of m.replacesOsm) replaced.add(id);
    if (m.footprint.length >= 3) models.push(box(m.footprint, m.height, -1, 3));
  }
  const zones = (route.data.clearZones ?? []).filter((z) => z.length >= 3).map((z) => box(z, 0, 0));
  const landmarks: Box[] = [];
  for (const l of route.data.landmarks ?? []) {
    if (l.footprint && l.footprint.length >= 3) landmarks.push(box(l.footprint, l.height ?? 60, -2));
  }
  const rendered = (b: BuildingRecord) => {
    let cx = 0;
    let cz = 0;
    for (const p of b.fp) {
      cx += p[0];
      cz += p[1];
    }
    if (insideLandmarkSite(sites, cx / b.fp.length, cz / b.fp.length, 5)) return false;
    if (b.far) return true;
    let right = false;
    let left = false;
    for (const p of b.fp) {
      const pr = route.project(p[0], p[1], b.s, 300);
      if (pr.d < 12 && pr.d > route.oppositeOffsetAt(route.clampS(pr.s)) - 8) return false;
      if (pr.d > 0) right = true;
      else left = true;
    }
    return !(right && left && Math.abs(b.d) < 60);
  };
  const extruded: Box[] = [];
  for (const b of buildings?.buildings ?? []) {
    if (b.fp?.length >= 3 && b.h > 2 && !replaced.has(b.id) && rendered(b)) extruded.push(box(b.fp, b.h, b.id));
  }
  return { replaced, models, zones, landmarks, occluders: [...models, ...landmarks, ...extruded], extruded, rendered };
}

/**
 * True when the sight line from (vx, vy, vz) to (x, y, z) is cut by an occluder's extruded
 * footprint (ignoring `selfId`).
 */
export function lineBlocked(occluders: Box[], vx: number, vy: number, vz: number, x: number, y: number, z: number, selfId = 0): boolean {
  const minX = Math.min(vx, x);
  const maxX = Math.max(vx, x);
  const minZ = Math.min(vz, z);
  const maxZ = Math.max(vz, z);
  for (const o of occluders) {
    if (o.id === selfId || o.maxX < minX || o.minX > maxX || o.maxZ < minZ || o.minZ > maxZ) continue;
    let tMin = Infinity;
    for (let i = 0; i < o.ring.length; i++) {
      const t = crossT(vx, vz, x, z, o.ring[i], o.ring[(i + 1) % o.ring.length]);
      if (t >= 0 && t < tMin) tMin = t;
    }
    if (tMin <= 1 && o.h > vy + (y - vy) * tMin) return true;
  }
  return false;
}
