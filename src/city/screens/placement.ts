import type { Route } from '../../route/Route';
import type { BuildingRecord, BuildingsData, CityModelsData, Vec2 } from '../../route/types';
import { insideLandmarkSite, resolveLandmarkSites } from '../landmarks/placement';

export interface ScreenWindow {
  name: string;
  /** Arc-length window of the mount point (m). */
  s0: number;
  s1: number;
  /** Preferred side; the other side is used when nothing qualifies there. */
  side?: 'left' | 'right';
}

export interface ScreenSpec {
  /** Preferred / smallest screen width (m); height is width * 16 / 9. */
  width: number;
  minWidth: number;
  /** Preferred / lowest bottom edge above ground (m). */
  bottom: number;
  minBottom: number;
  /** Clearance between the screen top and the roof (m). */
  roofGap: number;
  /** Wall run kept free at each end of the screen (m). */
  edgeMargin: number;
  minHeight: number;
  /** Lateral distance of the wall from the centerline of the carriageway on its side (m). */
  minDist: number;
  maxDist: number;
  /** Largest angle between the wall normal and the direction to the road (deg). */
  maxFacingDeg: number;
  /** Preferred tilt of the wall normal toward approaching traffic (deg). */
  preferFacingDeg: number;
  /** Distances before the mount point (m) whose sight lines must reach the screen. */
  viewBack: readonly number[];
}

export interface ScreenPlacement {
  window: string;
  buildingId: number;
  buildingHeight: number;
  s: number;
  d: number;
  side: 'left' | 'right';
  /** Wall point under the screen center (world x, z). */
  x: number;
  z: number;
  /** Outward unit normal of the wall. */
  nx: number;
  nz: number;
  width: number;
  height: number;
  bottom: number;
  /** Wall normal tilt toward approaching traffic (deg, + = faces oncoming cars). */
  facingDeg: number;
  /** Approach viewpoints whose sight line is blocked. */
  blocked: number;
}

export interface ScreenSkip {
  window: string;
  reason: string;
}

interface Box {
  ring: Vec2[];
  h: number;
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const DEG = 180 / Math.PI;
const EYE_Y = 1.8;
const VIEW_D = 1.75;
const COLLINEAR_COS = Math.cos(5 / DEG);
const MAX_RUN_SAG = 0.6;

function box(ring: Vec2[], h: number, id: number, margin = 0): Box {
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

function pointInRing(ring: Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Parameter t on p→q where it crosses segment a→b, or -1. */
function crossT(px: number, pz: number, qx: number, qz: number, a: Vec2, b: Vec2): number {
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

function ringsOverlap(a: Vec2[], b: Vec2[]): boolean {
  if (a.some(([x, z]) => pointInRing(b, x, z)) || b.some(([x, z]) => pointInRing(a, x, z))) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) if (crossT(p[0], p[1], q[0], q[1], b[j], b[(j + 1) % b.length]) >= 0) return true;
  }
  return false;
}

function overlapsAny(r: Box, list: Box[]): boolean {
  for (const k of list) {
    if (r.maxX < k.minX || r.minX > k.maxX || r.maxZ < k.minZ || r.minZ > k.maxZ) continue;
    if (ringsOverlap(r.ring, k.ring)) return true;
  }
  return false;
}

/** Straight wall runs of a footprint: consecutive edges within 5° of the run's first edge, nearly flat. */
function wallRuns(fp: Vec2[]): { a: Vec2; b: Vec2 }[] {
  const n = fp.length;
  const dirs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = fp[i];
    const q = fp[(i + 1) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1e-9;
    dirs.push([(q[0] - p[0]) / l, (q[1] - p[1]) / l]);
  }
  const dot = (i: number, j: number) => dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
  let i0 = -1;
  for (let i = 0; i < n && i0 < 0; i++) if (dot((i + n - 1) % n, i) < COLLINEAR_COS) i0 = i;
  if (i0 < 0) return [];
  const runs: { a: Vec2; b: Vec2 }[] = [];
  let start = i0;
  for (let k = 1; k <= n; k++) {
    const i = (i0 + k) % n;
    if (k < n && dot(start, i) >= COLLINEAR_COS) continue;
    const a = fp[start];
    const b = fp[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let sag = 0;
    for (let j = (start + 1) % n; j !== i && len > 0; j = (j + 1) % n) {
      sag = Math.max(sag, Math.abs((fp[j][0] - a[0]) * (b[1] - a[1]) - (fp[j][1] - a[1]) * (b[0] - a[0])) / len);
    }
    if (sag <= MAX_RUN_SAG) runs.push({ a, b });
    start = i;
  }
  return runs;
}

/**
 * Picks one real OSM building wall per window for a facade LED screen: tall enough, beside the
 * road, not replaced by a city model or inside a landmark sight line, with a straight wall run
 * facing the road and visible from the approach. Deterministic for a given data set.
 */
export function placeScreens(
  route: Route,
  buildings: BuildingsData | null,
  cityModels: CityModelsData | null,
  windows: readonly ScreenWindow[],
  spec: ScreenSpec,
): { placed: ScreenPlacement[]; skipped: ScreenSkip[] } {
  const placed: ScreenPlacement[] = [];
  const skipped: ScreenSkip[] = [];
  if (!buildings?.buildings.length) {
    for (const w of windows) skipped.push({ window: w.name, reason: 'no buildings.json' });
    return { placed, skipped };
  }
  const sites = resolveLandmarkSites(route);
  const replaced = new Set<number>();
  const models: Box[] = [];
  for (const m of cityModels?.models ?? []) {
    for (const id of m.replacesOsm) replaced.add(id);
    if (m.footprint.length >= 3) models.push(box(m.footprint, m.height, -1, 3));
  }
  const zones = (route.data.clearZones ?? []).filter((z) => z.length >= 3).map((z) => box(z, 0, 0));
  const occluders: Box[] = [...models];
  for (const l of route.data.landmarks ?? []) {
    if (l.footprint && l.footprint.length >= 3) occluders.push(box(l.footprint, l.height ?? 60, -2));
  }
  for (const b of buildings.buildings) {
    if (b.fp?.length >= 3 && b.h > 2 && !replaced.has(b.id)) occluders.push(box(b.fp, b.h, b.id));
  }

  /** Same skip rules as src/city/buildings, so the wall is really extruded. */
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

  /** Approach viewpoints whose sight line to (x, y, z) on a wall facing (nx, nz) is blocked. */
  const blockedViews = (s: number, x: number, y: number, z: number, nx: number, nz: number, selfId: number) => {
    let blocked = 0;
    for (const back of spec.viewBack) {
      const v = route.pointAt(route.clampS(s - back), VIEW_D);
      if ((v.x - x) * nx + (v.z - z) * nz < 2) {
        blocked++;
        continue;
      }
      const minX = Math.min(v.x, x);
      const maxX = Math.max(v.x, x);
      const minZ = Math.min(v.z, z);
      const maxZ = Math.max(v.z, z);
      let hit = false;
      for (const o of occluders) {
        if (hit) break;
        if (o.id === selfId || o.maxX < minX || o.minX > maxX || o.maxZ < minZ || o.minZ > maxZ) continue;
        let tMin = Infinity;
        for (let i = 0; i < o.ring.length; i++) {
          const t = crossT(v.x, v.z, x, z, o.ring[i], o.ring[(i + 1) % o.ring.length]);
          if (t >= 0 && t < tMin) tMin = t;
        }
        if (tMin <= 1 && o.h > EYE_Y + (y - EYE_Y) * tMin) hit = true;
      }
      if (hit) blocked++;
    }
    return blocked;
  };

  const aspect = 16 / 9;
  for (const w of windows) {
    let best: (ScreenPlacement & { score: number }) | null = null;
    const counts = { tall: 0, rendered: 0, walls: 0, sized: 0 };
    for (const b of buildings.buildings) {
      if (!(b.id > 0) || replaced.has(b.id) || !(b.h >= spec.minHeight) || !b.fp || b.fp.length < 3) continue;
      if (b.s < w.s0 - 200 || b.s > w.s1 + 200 || Math.abs(b.d) > spec.maxDist + 150) continue;
      counts.tall++;
      if (!rendered(b)) continue;
      const self = box(b.fp, b.h, b.id);
      if (overlapsAny(self, zones) || overlapsAny(box(b.fp, b.h, b.id, 3), models)) continue;
      counts.rendered++;
      let area = 0;
      for (let i = 0; i < b.fp.length; i++) {
        const p = b.fp[i];
        const q = b.fp[(i + 1) % b.fp.length];
        area += p[0] * q[1] - q[0] * p[1];
      }
      const wind = area > 0 ? 1 : -1;
      for (const { a, b: e } of wallRuns(b.fp)) {
        const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
        const ex = (e[0] - a[0]) / len;
        const ez = (e[1] - a[1]) / len;
        const nx = ez * wind;
        const nz = -ex * wind;
        const mx = (a[0] + e[0]) / 2;
        const mz = (a[1] + e[1]) / 2;
        const pr = route.project(mx, mz, b.s, 400);
        if (pr.s < w.s0 || pr.s > w.s1) continue;
        const dist = pr.d > 0 ? pr.d : route.oppositeOffsetAt(route.clampS(pr.s)) - pr.d;
        if (dist < spec.minDist || dist > spec.maxDist) continue;
        const side = pr.d > 0 ? 'right' : 'left';
        const sg = pr.d > 0 ? -1 : 1;
        const tx = sg * -pr.tz;
        const tz = sg * pr.tx;
        const facingDeg = Math.atan2(nx * -pr.tx + nz * -pr.tz, nx * tx + nz * tz) * DEG;
        if (Math.abs(facingDeg) > spec.maxFacingDeg) continue;
        counts.walls++;
        const width = Math.min(spec.width, len - 2 * spec.edgeMargin);
        if (width < spec.minWidth) continue;
        const height = width * aspect;
        const bottom = Math.min(spec.bottom, b.h - spec.roofGap - height);
        if (bottom < spec.minBottom) continue;
        counts.sized++;
        const blocked = blockedViews(pr.s, mx + nx * 0.5, bottom + height / 2, mz + nz * 0.5, nx, nz, b.id);
        if (blocked * 2 > spec.viewBack.length) continue;
        const score =
          (w.side && side === w.side ? 25 : 0) -
          Math.abs(facingDeg - spec.preferFacingDeg) -
          0.2 * Math.max(0, dist - 45) -
          15 * blocked +
          width +
          0.25 * Math.min(40, b.h - spec.roofGap - bottom - height) -
          0.01 * Math.abs(pr.s - (w.s0 + w.s1) / 2);
        if (!best || score > best.score || (score === best.score && b.id < best.buildingId)) {
          best = {
            window: w.name,
            buildingId: b.id,
            buildingHeight: b.h,
            s: pr.s,
            d: pr.d,
            side,
            x: mx,
            z: mz,
            nx,
            nz,
            width,
            height,
            bottom,
            facingDeg,
            blocked,
            score,
          };
        }
      }
    }
    if (best) {
      const { score: _score, ...p } = best;
      placed.push(p);
    } else {
      skipped.push({
        window: w.name,
        reason:
          `no qualifying wall in s ${w.s0}–${w.s1}: ${counts.tall} tall buildings near, ${counts.rendered} rendered and clear, ` +
          `${counts.walls} walls facing the road, ${counts.sized} big enough (rest blocked from the approach)`,
      });
    }
  }
  return { placed, skipped };
}
