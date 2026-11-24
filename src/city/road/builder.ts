import * as THREE from 'three';
import type { Route, XZ } from '../../route/Route';

export type RGB = readonly [number, number, number];
/** Lateral coordinate, constant or varying along the run. */
export type DFn = number | ((a: number) => number);

export interface Style {
  color: RGB | ((a: number, b: number) => RGB);
  /** u = (b - uo) * uk and v = a * vk, unless uFn is given. */
  uk: number;
  vk: number;
  uo?: number;
  uFn?: (a: number, b: number) => number;
}

const val = (f: DFn, a: number) => (typeof f === 'number' ? f : f(a));
const colorOf = (st: Style, a: number, b: number) => (typeof st.color === 'function' ? st.color(a, b) : st.color);
const uOf = (st: Style, a: number, b: number) => (st.uFn ? st.uFn(a, b) : (b - (st.uo ?? 0)) * st.uk);

export function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Layer {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly t: number[] = [];
  readonly c: number[] = [];
  readonly i: number[] = [];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, col: RGB): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, v);
    this.c.push(col[0], col[1], col[2]);
    return this.p.length / 3 - 1;
  }

  /** Quad with corners a→b→c→d around its perimeter; winding chosen so it faces (nx, ny, nz). */
  quad(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number) {
    if (this.facing(a, b, c, nx, ny, nz) >= 0) this.i.push(a, b, c, a, c, d);
    else this.i.push(a, c, b, a, d, c);
  }

  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    if (this.facing(a, b, c, nx, ny, nz) >= 0) this.i.push(a, b, c);
    else this.i.push(a, c, b);
  }

  private facing(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    const p = this.p;
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const ex = p[b * 3] - ax;
    const ey = p[b * 3 + 1] - ay;
    const ez = p[b * 3 + 2] - az;
    const fx = p[c * 3] - ax;
    const fy = p[c * 3 + 1] - ay;
    const fz = p[c * 3 + 2] - az;
    return (ey * fz - ez * fy) * nx + (ez * fx - ex * fz) * ny + (ex * fy - ey * fx) * nz;
  }

  get empty() {
    return this.i.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Geometry layers bucketed into fixed-length chunks along s. */
export class ChunkSet {
  readonly count: number;
  readonly layers: Map<string, Layer>[];

  constructor(
    readonly sMin: number,
    readonly sMax: number,
    readonly len: number,
  ) {
    this.count = Math.max(1, Math.ceil((sMax - sMin) / len));
    this.layers = Array.from({ length: this.count }, () => new Map<string, Layer>());
  }

  index(s: number): number {
    return Math.min(this.count - 1, Math.max(0, Math.floor((s - this.sMin) / this.len)));
  }

  end(k: number): number {
    return k === this.count - 1 ? Infinity : this.sMin + (k + 1) * this.len;
  }

  layer(name: string, s: number): Layer {
    const m = this.layers[this.index(s)];
    let l = m.get(name);
    if (!l) {
      l = new Layer();
      m.set(name, l);
    }
    return l;
  }
}

/** Maps (a = along, b = lateral to the right) to world x/z. */
export interface Mapper {
  point(a: number, b: number, out: XZ): XZ;
  normal(a: number, out: XZ): XZ;
  tangent(a: number, out: XZ): XZ;
  chunkS(a: number): number;
  /** Sample positions covering [a0, a1]; each run lies inside one chunk. */
  runs(a0: number, a1: number): number[][];
}

export class RouteMapper implements Mapper {
  constructor(
    private readonly route: Route,
    private readonly chunks: ChunkSet,
  ) {}

  point(a: number, b: number, out: XZ) {
    return this.route.pointAt(a, b, out);
  }
  normal(a: number, out: XZ) {
    return this.route.normalAt(a, out);
  }
  tangent(a: number, out: XZ) {
    return this.route.tangentAt(a, out);
  }
  chunkS(a: number) {
    return a;
  }
  runs(a0: number, a1: number): number[][] {
    const { route, chunks } = this;
    const out: number[][] = [];
    let k = chunks.index(a0);
    let s = a0;
    while (s < a1 - 1e-6) {
      const e = Math.min(a1, chunks.end(k));
      const run = [s];
      let i = lowerBound(route.cum, s + 1e-3);
      while (i < route.n && route.cum[i] < e - 1e-3) run.push(route.cum[i++]);
      run.push(e);
      out.push(run);
      s = e;
      k++;
    }
    return out;
  }
}

/** Straight local frame: origin o, unit direction t, right normal (-t.z, t.x). */
export class FrameMapper implements Mapper {
  constructor(
    readonly ox: number,
    readonly oz: number,
    readonly tx: number,
    readonly tz: number,
    private readonly s: number,
  ) {}

  point(a: number, b: number, out: XZ) {
    out.x = this.ox + this.tx * a - this.tz * b;
    out.z = this.oz + this.tz * a + this.tx * b;
    return out;
  }
  normal(_a: number, out: XZ) {
    out.x = -this.tz;
    out.z = this.tx;
    return out;
  }
  tangent(_a: number, out: XZ) {
    out.x = this.tx;
    out.z = this.tz;
    return out;
  }
  chunkS() {
    return this.s;
  }
  runs(a0: number, a1: number): number[][] {
    return a1 - a0 > 1e-6 ? [[a0, a1]] : [];
  }
}

/** Emits ribbons, walls and boxes in (a, b) space into chunked layers. */
export class Painter {
  private readonly pa: XZ = { x: 0, z: 0 };
  private readonly pb: XZ = { x: 0, z: 0 };
  private readonly nv: XZ = { x: 0, z: 0 };

  constructor(readonly chunks: ChunkSet) {}

  /** Horizontal strip between lateral b0 < b1 at height y, facing up. */
  ribbon(layer: string, m: Mapper, a0: number, a1: number, b0: DFn, b1: DFn, y: number, st: Style) {
    for (const run of m.runs(a0, a1)) {
      const L = this.chunks.layer(layer, m.chunkS((run[0] + run[run.length - 1]) / 2));
      let ia0 = -1;
      let ib0 = -1;
      for (const a of run) {
        const da = val(b0, a);
        const db = val(b1, a);
        const A = m.point(a, da, this.pa);
        const ia = L.vert(A.x, y, A.z, 0, 1, 0, uOf(st, a, da), a * st.vk, colorOf(st, a, da));
        const B = m.point(a, db, this.pb);
        const ib = L.vert(B.x, y, B.z, 0, 1, 0, uOf(st, a, db), a * st.vk, colorOf(st, a, db));
        if (ia0 >= 0) L.quad(ia0, ib0, ib, ia, 0, 1, 0);
        ia0 = ia;
        ib0 = ib;
      }
    }
  }

  /** Vertical strip at lateral b, facing +b (facing = 1) or -b (facing = -1). */
  wall(layer: string, m: Mapper, a0: number, a1: number, b: DFn, y0: number, y1: number, facing: 1 | -1, st: Style) {
    for (const run of m.runs(a0, a1)) {
      const L = this.chunks.layer(layer, m.chunkS((run[0] + run[run.length - 1]) / 2));
      let i0 = -1;
      let i1 = -1;
      for (const a of run) {
        const d = val(b, a);
        const P = m.point(a, d, this.pa);
        const N = m.normal(a, this.nv);
        const nx = N.x * facing;
        const nz = N.z * facing;
        const col = colorOf(st, a, d);
        const lo = L.vert(P.x, y0, P.z, nx, 0, nz, a * st.vk, y0 * st.uk, col);
        const hi = L.vert(P.x, y1, P.z, nx, 0, nz, a * st.vk, y1 * st.uk, col);
        if (i0 >= 0) L.quad(i0, i1, hi, lo, nx, 0, nz);
        i0 = lo;
        i1 = hi;
      }
    }
  }

  /** Vertical end face across [b0, b1] at a, facing along +a (facing = 1) or -a. */
  cap(layer: string, m: Mapper, a: number, b0: number, b1: number, y0: number, y1: number, facing: 1 | -1, st: Style) {
    const L = this.chunks.layer(layer, m.chunkS(a));
    const T = m.tangent(a, this.nv);
    const nx = T.x * facing;
    const nz = T.z * facing;
    const col = colorOf(st, a, b0);
    const A = m.point(a, b0, this.pa);
    const v0 = L.vert(A.x, y0, A.z, nx, 0, nz, b0 * st.uk, y0 * st.uk, col);
    const v1 = L.vert(A.x, y1, A.z, nx, 0, nz, b0 * st.uk, y1 * st.uk, col);
    const B = m.point(a, b1, this.pb);
    const v2 = L.vert(B.x, y1, B.z, nx, 0, nz, b1 * st.uk, y1 * st.uk, col);
    const v3 = L.vert(B.x, y0, B.z, nx, 0, nz, b1 * st.uk, y0 * st.uk, col);
    L.quad(v0, v1, v2, v3, nx, 0, nz);
  }

  /** Raised block: top ribbon plus side walls and end caps down to just below ground. */
  box(top: string, side: string, m: Mapper, a0: number, a1: number, b0: DFn, b1: DFn, y: number, stTop: Style, stSide: Style) {
    if (a1 - a0 < 0.05) return;
    const yb = -0.05;
    this.ribbon(top, m, a0, a1, b0, b1, y, stTop);
    this.wall(side, m, a0, a1, b0, yb, y, -1, stSide);
    this.wall(side, m, a0, a1, b1, yb, y, 1, stSide);
    this.cap(side, m, a0, val(b0, a0), val(b1, a0), yb, y, -1, stSide);
    this.cap(side, m, a1, val(b0, a1), val(b1, a1), yb, y, 1, stSide);
  }

  /** Flat polygon (local x = lateral, y = along) placed at (a, b), pre-triangulated. */
  shape(layer: string, m: Mapper, a: number, b: number, pts: number[][], tris: number[][], y: number, st: Style) {
    const L = this.chunks.layer(layer, m.chunkS(a));
    const base = L.p.length / 3;
    for (const [px, py] of pts) {
      const P = m.point(a + py, b + px, this.pa);
      L.vert(P.x, y, P.z, 0, 1, 0, uOf(st, a + py, b + px), (a + py) * st.vk, colorOf(st, a + py, b + px));
    }
    for (const [i, j, k] of tris) L.tri(base + i, base + j, base + k, 0, 1, 0);
  }
}

/** Removes the union of `gaps` from [a, b]. */
export function subtract(a: number, b: number, gaps: [number, number][]): [number, number][] {
  const sorted = gaps.filter((g) => g[1] > a && g[0] < b).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let cur = a;
  for (const [g0, g1] of sorted) {
    if (g0 > cur) out.push([cur, Math.min(g0, b)]);
    cur = Math.max(cur, g1);
    if (cur >= b) break;
  }
  if (cur < b) out.push([cur, b]);
  return out.filter((iv) => iv[1] - iv[0] > 0.01);
}

/** Intersection of [a, b] with the union of `ranges`. */
export function intersect(a: number, b: number, ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [r0, r1] of ranges) {
    const lo = Math.max(a, r0);
    const hi = Math.min(b, r1);
    if (hi - lo > 0.01) out.push([lo, hi]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}
