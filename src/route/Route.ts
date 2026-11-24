import type { RouteData, SectionId } from './types';

export interface XZ {
  x: number;
  z: number;
}

export interface Projection {
  /** Arc length along the centerline; may be < 0 before the start or > length past the end. */
  s: number;
  /** Signed lateral offset, positive = right of driving direction. */
  d: number;
  /** Unit tangent of the centerline at s. */
  tx: number;
  tz: number;
}

/** Three.js yaw (rotation.y) that points an object's -Z axis along (dx, dz). */
export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Forward unit vector (-Z axis) of an object with rotation.y = yaw. */
export function dirFromYaw(yaw: number, out: XZ = { x: 0, z: 0 }): XZ {
  out.x = -Math.sin(yaw);
  out.z = -Math.cos(yaw);
  return out;
}

const DEFAULT_OPPOSITE_OFFSET = -18;

/**
 * Converts between world coordinates (x, z) and route coordinates (s, d).
 * Right normal of tangent (tx, tz) is (-tz, tx): with x east / z south, heading
 * east puts the right-hand side to the south.
 */
export class Route {
  readonly data: RouteData;
  readonly n: number;
  readonly length: number;
  readonly spacing: number;
  readonly dMin: number;
  readonly dMax: number;
  /** Sample positions. */
  readonly px: Float64Array;
  readonly pz: Float64Array;
  /** Cumulative arc length at each sample. */
  readonly cum: Float64Array;
  /** Smoothed unit tangent at each sample. */
  readonly vtx: Float64Array;
  readonly vtz: Float64Array;
  private readonly segLen: Float64Array;
  private readonly stx: Float64Array;
  private readonly stz: Float64Array;

  constructor(data: RouteData) {
    const pts = data.centerline;
    if (pts.length < 2) throw new Error('Route needs at least 2 centerline points');
    this.data = data;
    const n = pts.length;
    this.n = n;
    this.px = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.cum = new Float64Array(n);
    this.vtx = new Float64Array(n);
    this.vtz = new Float64Array(n);
    this.segLen = new Float64Array(n - 1);
    this.stx = new Float64Array(n - 1);
    this.stz = new Float64Array(n - 1);

    for (let i = 0; i < n; i++) {
      this.px[i] = pts[i][0];
      this.pz[i] = pts[i][1];
    }
    for (let i = 0; i < n - 1; i++) {
      const dx = this.px[i + 1] - this.px[i];
      const dz = this.pz[i + 1] - this.pz[i];
      const len = Math.hypot(dx, dz) || 1e-6;
      this.segLen[i] = len;
      this.stx[i] = dx / len;
      this.stz[i] = dz / len;
      this.cum[i + 1] = this.cum[i] + len;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 2, i);
      let tx = this.stx[a] + this.stx[b];
      let tz = this.stz[a] + this.stz[b];
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      this.vtx[i] = tx;
      this.vtz[i] = tz;
    }
    this.length = this.cum[n - 1];
    this.spacing = data.meta?.sampleSpacing || this.length / (n - 1);
    this.dMin = -data.road.halfWidthLeft;
    this.dMax = data.road.halfWidthRight;
  }

  clampS(s: number): number {
    return s < 0 ? 0 : s > this.length ? this.length : s;
  }

  /** Index i of the segment [i, i+1] containing s, clamped to valid segments. */
  segmentAt(s: number): number {
    const last = this.n - 2;
    let i = Math.floor(s / this.spacing);
    if (!(i >= 0)) return 0;
    if (i > last) i = last;
    while (i < last && this.cum[i + 1] < s) i++;
    while (i > 0 && this.cum[i] > s) i--;
    return i;
  }

  /** Smoothed unit tangent at s. */
  tangentAt(s: number, out: XZ = { x: 0, z: 0 }): XZ {
    const i = this.segmentAt(s);
    const t = Math.min(1, Math.max(0, (s - this.cum[i]) / this.segLen[i]));
    const tx = this.vtx[i] + (this.vtx[i + 1] - this.vtx[i]) * t;
    const tz = this.vtz[i] + (this.vtz[i + 1] - this.vtz[i]) * t;
    const len = Math.hypot(tx, tz) || 1;
    out.x = tx / len;
    out.z = tz / len;
    return out;
  }

  /** Right-hand unit normal at s (direction of positive d). */
  normalAt(s: number, out: XZ = { x: 0, z: 0 }): XZ {
    this.tangentAt(s, out);
    const tx = out.x;
    out.x = -out.z;
    out.z = tx;
    return out;
  }

  /** Yaw (rotation.y) facing along the route at s. */
  headingAt(s: number): number {
    const t = this.tangentAt(s);
    return yawFromDir(t.x, t.z);
  }

  /** World position of route coordinate (s, d). Extrapolates linearly beyond the ends. */
  pointAt(s: number, d = 0, out: XZ = { x: 0, z: 0 }): XZ {
    const i = this.segmentAt(s);
    const along = s - this.cum[i];
    let x = this.px[i] + this.stx[i] * along;
    let z = this.pz[i] + this.stz[i] * along;
    if (d !== 0) {
      const t = this.tangentAt(s, out);
      x += -t.z * d;
      z += t.x * d;
    }
    out.x = x;
    out.z = z;
    return out;
  }

  /**
   * Projects a world point onto the route. With hintS, only segments within
   * `window` meters of the hint are searched, which keeps the result stable
   * near bends; without it the whole route is searched.
   */
  project(x: number, z: number, hintS?: number, window = 80): Projection {
    let i0 = 0;
    let i1 = this.n - 2;
    if (hintS !== undefined && Number.isFinite(hintS)) {
      const c = this.segmentAt(hintS);
      const w = Math.ceil(window / this.spacing) + 1;
      i0 = Math.max(0, c - w);
      i1 = Math.min(this.n - 2, c + w);
    }
    let best = Infinity;
    let bi = i0;
    for (let i = i0; i <= i1; i++) {
      const ax = x - this.px[i];
      const az = z - this.pz[i];
      let t = ax * this.stx[i] + az * this.stz[i];
      if (t < 0) t = 0;
      else if (t > this.segLen[i]) t = this.segLen[i];
      const dx = ax - this.stx[i] * t;
      const dz = az - this.stz[i] * t;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bi = i;
      }
    }
    const last = this.n - 2;
    const ax = x - this.px[bi];
    const az = z - this.pz[bi];
    let along = ax * this.stx[bi] + az * this.stz[bi];
    if (!(bi === 0 && along < 0) && !(bi === last && along > this.segLen[bi])) {
      along = Math.min(this.segLen[bi], Math.max(0, along));
    }
    const s = this.cum[bi] + along;
    const cx = this.px[bi] + this.stx[bi] * along;
    const cz = this.pz[bi] + this.stz[bi] * along;
    const t = this.tangentAt(s);
    const rx = x - cx;
    const rz = z - cz;
    const side = rx * -t.z + rz * t.x;
    const dist = Math.hypot(rx, rz);
    return { s, d: side < 0 ? -dist : dist, tx: t.x, tz: t.z };
  }

  /** Lateral offset of the opposite carriageway centerline at s (negative, left side). */
  oppositeOffsetAt(s: number): number {
    const arr = this.data.oppositeOffset;
    if (!arr || arr.length !== this.n) return DEFAULT_OPPOSITE_OFFSET;
    const i = this.segmentAt(s);
    const t = Math.min(1, Math.max(0, (s - this.cum[i]) / this.segLen[i]));
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }

  sectionAt(s: number): { id: SectionId; name: string } {
    const secs = this.data.sections;
    for (const sec of secs) if (s < sec.s1) return sec;
    return secs[secs.length - 1];
  }
}

export async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return (await res.json()) as T;
}
