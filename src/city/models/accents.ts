import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { CityModelRecord, Vec2 } from '../../route/types';
import type { ModelGeometry } from './prepare';

const M = CONFIG.cityModels;

function convexHull(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Convex hull (x, z) of the model's vertices with y0 <= y <= y1. */
export function hullBetween(g: ModelGeometry, y0: number, y1: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < g.pos.length; i += 3) {
    const y = g.pos[i + 1];
    if (y >= y0 && y <= y1) pts.push([g.pos[i], g.pos[i + 2]]);
  }
  return convexHull(pts);
}

/**
 * Lowest horizontal layer between yMin and yMax with at least minArea m² of
 * near-horizontal triangles (1 m height bins): its height and the hull of its
 * vertices, e.g. the underside of a raised podium or a roof canopy.
 */
export function lowestLayer(g: ModelGeometry, yMin: number, yMax: number, minArea: number): { y: number; hull: Vec2[] } | null {
  const bins = new Map<number, { area: number; ySum: number; pts: Vec2[] }>();
  const { pos, idx } = g;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const yc = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
    // Either winding counts: the GLBs are double-sided, so up / down is not reliable.
    if (len < 1e-9 || yc < yMin || yc > yMax || Math.abs(ny / len) < 0.9) continue;
    const key = Math.round(yc);
    let bin = bins.get(key);
    if (!bin) bins.set(key, (bin = { area: 0, ySum: 0, pts: [] }));
    bin.area += len / 2;
    bin.ySum += (yc * len) / 2;
    bin.pts.push([pos[a], pos[a + 2]], [pos[b], pos[b + 2]], [pos[c], pos[c + 2]]);
  }
  const keys = [...bins.keys()].sort((p, q) => p - q);
  for (const k of keys) {
    // A layer is a bin plus its neighbours (slabs a few dm thick, slight slopes).
    let area = 0;
    let ySum = 0;
    const pts: Vec2[] = [];
    for (let d = -1; d <= 1; d++) {
      const bin = bins.get(k + d);
      if (!bin) continue;
      area += bin.area;
      ySum += bin.ySum;
      pts.push(...bin.pts);
    }
    if (area >= minArea) return { y: ySum / area, hull: convexHull(pts) };
  }
  return null;
}

/**
 * Lower rim of a roof canopy, following its curve: the outline (convex hull of
 * the vertices above yMin) sampled every `step` m, each sample at the lowest
 * height of the canopy edges passing within `radius` m of it in plan. Returns
 * open polylines [x, y, z, ...] (gaps where no edge is near the outline).
 */
export function rimLines(g: ModelGeometry, yMin: number, step = 2, radius = 2.5): number[][] {
  const { pos, idx } = g;
  const cell = 8;
  const grid = new Map<string, number[]>();
  const pts: Vec2[] = [];
  // Edges of triangles fully above yMin, bucketed by the plan cells their bounding box touches.
  const edges: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    if (v.some((i) => pos[i + 1] < yMin)) continue;
    for (const i of v) pts.push([pos[i], pos[i + 2]]);
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      const e = edges.length;
      edges.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2]);
      const x0 = Math.floor((Math.min(pos[a], pos[b]) - radius) / cell);
      const x1 = Math.floor((Math.max(pos[a], pos[b]) + radius) / cell);
      const z0 = Math.floor((Math.min(pos[a + 2], pos[b + 2]) - radius) / cell);
      const z1 = Math.floor((Math.max(pos[a + 2], pos[b + 2]) + radius) / cell);
      for (let i = x0; i <= x1; i++)
        for (let j = z0; j <= z1; j++) {
          const key = i + ',' + j;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(e);
        }
    }
  }
  const hull = convexHull(pts);
  const lines: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 6) lines.push(cur);
    cur = [];
  };
  for (let h = 0; h < hull.length; h++) {
    const [ax, az] = hull[h];
    const [bx, bz] = hull[(h + 1) % hull.length];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) {
      const px = ax + ((bx - ax) * s) / n;
      const pz = az + ((bz - az) * s) / n;
      let yLow = Infinity;
      for (const e of grid.get(Math.floor(px / cell) + ',' + Math.floor(pz / cell)) ?? []) {
        const ex = edges[e + 3] - edges[e];
        const ez = edges[e + 5] - edges[e + 2];
        const l2 = ex * ex + ez * ez;
        const u = l2 > 1e-9 ? Math.min(1, Math.max(0, ((px - edges[e]) * ex + (pz - edges[e + 2]) * ez) / l2)) : 0;
        const dx = edges[e] + ex * u - px;
        const dz = edges[e + 2] + ez * u - pz;
        if (dx * dx + dz * dz > radius * radius) continue;
        yLow = Math.min(yLow, edges[e + 1] + (edges[e + 4] - edges[e + 1]) * u);
      }
      if (Number.isFinite(yLow)) cur.push(px, yLow, pz);
      else flush();
    }
  }
  flush();
  return lines;
}

/** Ring pushed away from (m > 0) or toward (m < 0) its centroid by m meters. */
function offsetRing(ring: Vec2[], m: number): Vec2[] {
  let cx = 0;
  let cz = 0;
  for (const p of ring) {
    cx += p[0];
    cz += p[1];
  }
  cx /= ring.length;
  cz /= ring.length;
  return ring.map(([x, z]) => {
    const l = Math.hypot(x - cx, z - cz) || 1;
    return [x + ((x - cx) / l) * m, z + ((z - cz) / l) * m] as Vec2;
  });
}

/** Vertical ribbon along a closed loop from y0 to y1; brightness k0 at y0 fading to k1 at y1. */
function ribbon(loop: Vec2[], y0: number, y1: number, k0: number, k1: number, pos: number[], col: number[]): void {
  for (let i = 0; i < loop.length; i++) {
    const [ax, az] = loop[i];
    const [bx, bz] = loop[(i + 1) % loop.length];
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    col.push(k0, k0, k0, k0, k0, k0, k1, k1, k1, k0, k0, k0, k1, k1, k1, k1, k1, k1);
  }
}

/** Horizontal band (width w, inward) along a closed loop at height y. */
function band(loop: Vec2[], y: number, w: number, pos: number[], col: number[]): void {
  const inner = offsetRing(loop, -w);
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    const [ax, az] = loop[i];
    const [bx, bz] = loop[j];
    const [cx, cz] = inner[j];
    const [dx, dz] = inner[i];
    pos.push(ax, y, az, bx, y, bz, cx, y, cz, ax, y, az, cx, y, cz, dx, y, dz);
    for (let k = 0; k < 18; k++) col.push(1);
  }
}

type AccentKind = 'szse' | 'civic' | 'tequ';

/** Landmarks with night accents, from the record id / replaced landmark. */
function accentKind(rec: CityModelRecord): AccentKind | null {
  const id = rec.id.toLowerCase();
  if (/^stock_exchange/.test(id)) return 'szse';
  if (rec.role === 'landmark' && (rec.replacesLandmark === 'civic_center' || /^(citizen_cent(re|er)_|civic_center)/.test(id))) return 'civic';
  if (/^special_zone_daily/.test(id)) return 'tequ';
  return null;
}

/**
 * Subtle architectural night accents for the real-building landmarks: LED
 * strips under the Shenzhen Stock Exchange's raised podium, the Civic Center's
 * roof edge lights and a floodlight wash on the Special Zone Daily crown. All
 * scale with nightUniform (setNight) and are hidden by day, so they cost no
 * draw calls then.
 */
export class Accents {
  /** Opaque LED strips (vertex color = relative brightness). */
  private readonly ledMat = new THREE.MeshBasicMaterial({ name: 'AccentLed', side: THREE.DoubleSide, vertexColors: true });
  /** Additive floodlight wash, fading upward. */
  private readonly washMat = new THREE.MeshBasicMaterial({
    name: 'AccentWash',
    side: THREE.DoubleSide,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly ledBase = new THREE.Color(1.0, 0.86, 0.68);
  private readonly washBase = new THREE.Color(0.85, 0.9, 1.0);
  private readonly objects: THREE.Object3D[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private night = 0;

  /** Builds the accents for one model (model space); null when it has none. */
  build(rec: CityModelRecord, g: ModelGeometry, bounds: THREE.Box3): THREE.Group | null {
    const kind = accentKind(rec);
    if (!kind) return null;
    const led: number[] = [];
    const ledCol: number[] = [];
    const wash: number[] = [];
    const washCol: number[] = [];
    const height = bounds.max.y;
    if (kind === 'szse') {
      // Underside of the raised podium: two inset LED bands and a thin line along its lower edge.
      const u = lowestLayer(g, 15, height * 0.5, 2000);
      if (u && u.hull.length >= 3) {
        band(offsetRing(u.hull, -1.5), u.y - 0.08, 0.6, led, ledCol);
        band(offsetRing(u.hull, -10), u.y - 0.08, 0.4, led, ledCol);
        ribbon(offsetRing(u.hull, 0.12), u.y + 0.15, u.y + 0.45, 1, 1, led, ledCol);
      }
    }
    if (kind === 'civic') {
      // Lower edge of the big roof: a thin warm line just under the curved canopy rim.
      for (const line of rimLines(g, height * 0.45)) {
        for (let i = 0; i + 5 < line.length; i += 3) {
          const [ax, ay, az, bx, by, bz] = line.slice(i, i + 6);
          led.push(ax, ay - 0.7, az, bx, by - 0.7, bz, bx, by - 0.25, bz, ax, ay - 0.7, az, bx, by - 0.25, bz, ax, ay - 0.25, az);
          for (let k = 0; k < 18; k++) ledCol.push(1);
        }
      }
    }
    if (kind === 'tequ') {
      // Crown floodlit from below: a wash over the top ~12 % fading upward.
      const y0 = height * 0.86;
      const hull = hullBetween(g, y0, height * 0.97);
      if (hull.length >= 3) ribbon(offsetRing(hull, 0.3), y0, height * 0.99, 0.55, 0, wash, washCol);
    }
    const group = new THREE.Group();
    group.name = 'accents';
    for (const [p, c, mat] of [
      [led, ledCol, this.ledMat],
      [wash, washCol, this.washMat],
    ] as const) {
      if (!p.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      this.geometries.push(geo);
      group.add(mesh);
    }
    if (!group.children.length) return null;
    group.visible = this.night > 0.05;
    this.objects.push(group);
    return group;
  }

  /** Night level 0..1 (nightUniform.value); everything off by day. */
  setNight(night: number): void {
    this.night = night;
    const k = THREE.MathUtils.smoothstep(night, 0.08, 1);
    this.ledMat.color.copy(this.ledBase).multiplyScalar(k * M.accentStripIntensity);
    this.washMat.color.copy(this.washBase).multiplyScalar(k * M.accentWashIntensity);
    for (const o of this.objects) o.visible = night > 0.05;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.ledMat.dispose();
    this.washMat.dispose();
  }
}
