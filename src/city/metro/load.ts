import { loadJson } from '../../route/Route';
import type { GridMeta, MetroMeta } from './types';

/** Fetches a binary file, gunzipping it when it is a .gz the server did not decode. */
export async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return buf;
}

/** Int16 decimetres with each row delta-coded (scripts/build_metro_data.py encode_heights) → metres. */
export function decodeHeights(buf: ArrayBuffer, nx: number, nz: number): Float32Array {
  const d = new Int16Array(buf);
  if (d.length !== nx * nz) throw new Error(`height grid: ${d.length} values, expected ${nx} x ${nz}`);
  const out = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    let v = 0;
    const r = j * nx;
    for (let i = 0; i < nx; i++) {
      v += d[r + i];
      out[r + i] = v * 0.1;
    }
  }
  return out;
}

/** Cell-centred grid sampled like GPU linear filtering (clamped at the edges); matches build_metro_data.bilinear. */
export class GridSampler<T extends Float32Array | Uint8Array = Float32Array> {
  constructor(
    readonly g: GridMeta,
    readonly values: T,
    readonly scale = 1,
  ) {}

  get x1(): number {
    return this.g.x0 + this.g.nx * this.g.cell;
  }

  get z1(): number {
    return this.g.z0 + this.g.nz * this.g.cell;
  }

  sample(x: number, z: number): number {
    const { x0, z0, cell, nx, nz } = this.g;
    let fx = (x - x0) / cell - 0.5;
    let fz = (z - z0) / cell - 0.5;
    fx = fx < 0 ? 0 : fx > nx - 1.0001 ? nx - 1.0001 : fx;
    fz = fz < 0 ? 0 : fz > nz - 1.0001 ? nz - 1.0001 : fz;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const v = this.values;
    const k = j * nx + i;
    const a = v[k] + (v[k + 1] - v[k]) * tx;
    const b = v[k + nx] + (v[k + nx + 1] - v[k + nx]) * tx;
    return (a + (b - a) * tz) * this.scale;
  }
}

/** Terrain height field: the 30 m inner grid fading into the 120 m outer one near its edge (same as the GPU). */
export class MetroTerrain {
  constructor(
    readonly meta: MetroMeta['terrain'],
    readonly inner: GridSampler,
    readonly outer: GridSampler,
    readonly corridor: GridSampler<Uint8Array> | null,
  ) {}

  /** 0 outside the inner grid … 1 more than innerBlend inside it. */
  innerWeight(x: number, z: number): number {
    const i = this.inner;
    const d = Math.min(x - i.g.x0, i.x1 - x, z - i.g.z0, i.z1 - z);
    const t = Math.min(1, Math.max(0, d / this.meta.innerBlend));
    return t * t * (3 - 2 * t);
  }

  heightAt(x: number, z: number): number {
    const w = this.innerWeight(x, z);
    if (w >= 1) return this.inner.sample(x, z);
    const o = this.outer.sample(x, z);
    return w <= 0 ? o : o + (this.inner.sample(x, z) - o) * w;
  }

  /** Lowest terrain under a footprint (vertices and centroid). */
  baseOf(ring: readonly (readonly [number, number])[]): number {
    let min = Infinity;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of ring) {
      min = Math.min(min, this.heightAt(x, z));
      cx += x;
      cz += z;
    }
    return Math.min(min, this.heightAt(cx / ring.length, cz / ring.length));
  }

  /** 1 inside the flattened route corridor, 0 in open country. */
  corridorAt(x: number, z: number): number {
    return this.corridor ? this.corridor.sample(x, z) : 0;
  }
}

export interface MetroData {
  meta: MetroMeta;
  /** URL prefix of the metro files (ends with '/'). */
  base: string;
  terrain: MetroTerrain;
}

/**
 * public/data/metro (scripts/build_metro_data.py), or null when it is missing. ?noMetro turns the
 * whole-city scenery off (the v0.5 corridor-only scene, for comparisons).
 */
export async function loadMetro(): Promise<MetroData | null> {
  if (new URLSearchParams(location.search).has('noMetro')) return null;
  const base = import.meta.env.BASE_URL + 'data/metro/';
  let meta: MetroMeta;
  try {
    meta = await loadJson<MetroMeta>(base + 'metro.json');
  } catch {
    return null;
  }
  const t = meta.terrain;
  const [hi, ho, co] = await Promise.all([
    fetchBinary(base + t.inner.file),
    fetchBinary(base + t.outer.file),
    t.corridor ? fetchBinary(base + t.corridor.file) : Promise.resolve(null),
  ]);
  const inner = new GridSampler(t.inner, decodeHeights(hi, t.inner.nx, t.inner.nz));
  const outer = new GridSampler(t.outer, decodeHeights(ho, t.outer.nx, t.outer.nz));
  const corridor = co && t.corridor ? new GridSampler(t.corridor, new Uint8Array(co), 1 / 255) : null;
  return { meta, base, terrain: new MetroTerrain(t, inner, outer, corridor) };
}
