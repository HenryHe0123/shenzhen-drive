/// <reference lib="webworker" />
import type { BuildingUse, Vec2 } from '../../route/types';
import { FacadeBuilder, ringArea, type FacadeArrays } from '../buildings/builder';
import { addBuilding, metroStyle, styleSeed } from '../buildings/shapes';
import { parseMassArrays, type MassArrays } from './massData';

/** Decoded codes of scripts/build_metro_data.py (USE_CODE, AGE_CODE). */
const USES: (BuildingUse | undefined)[] = [undefined, 'residential', 'office', 'commercial', 'public', 'industrial'];
const AGES: (string | undefined)[] = [undefined, '1980s', '1990s', '2000s', '2010s', '2020s'];

export interface DetailTileRequest {
  key: string;
  buf: ArrayBuffer;
  kind?: 'bld' | 'road' | 'mass';
}

/** Road / rail tile geometry, relative to the tile centre. */
export interface RoadArrays {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
}

/** Linear-RGB surface tone per road class (motorway … service, rail) and of bridge concrete. */
const ROAD_TONE = [0.085, 0.09, 0.095, 0.1, 0.11, 0.12, 0.13, 0.17];
const CONCRETE: [number, number, number] = [0.42, 0.42, 0.4];

/**
 * Road tile (roads/<i>_<j>.bin, 'SZR1': n, centre x, z; per way <BBBBH> class, bridge, width x 4, -, points;
 * i16 x, z dm delta-coded; i16 y dm; bridges also i16 ground y dm) → ribbons on the terrain, bridges as a
 * deck with side faces and piers.
 */
export function buildRoadTile(buf: ArrayBuffer): { arrays: RoadArrays | null; ox: number; oz: number; count: number } {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'SZR1') throw new Error('road tile: bad magic');
  const n = dv.getUint32(4, true);
  const ox = dv.getFloat32(8, true);
  const oz = dv.getFloat32(12, true);
  let off = 16;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: readonly number[]) => {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    col.push(c[0], c[1], c[2]);
    return pos.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  for (let k = 0; k < n; k++) {
    const cls = dv.getUint8(off);
    const bridge = dv.getUint8(off + 1) === 1;
    const width = dv.getUint8(off + 2) / 4;
    const np = dv.getUint16(off + 4, true);
    off += 6;
    const xs = new Float32Array(np);
    const zs = new Float32Array(np);
    let x = 0;
    let z = 0;
    for (let i = 0; i < np; i++) {
      x += dv.getInt16(off, true);
      z += dv.getInt16(off + 2, true);
      off += 4;
      xs[i] = x / 10;
      zs[i] = z / 10;
    }
    const ys = new Float32Array(np);
    for (let i = 0; i < np; i++, off += 2) ys[i] = dv.getInt16(off, true) / 10;
    const gs = new Float32Array(np);
    if (bridge) for (let i = 0; i < np; i++, off += 2) gs[i] = dv.getInt16(off, true) / 10;
    // Mitred left / right edges.
    const lx = new Float32Array(np);
    const lz = new Float32Array(np);
    const hw = width / 2;
    for (let i = 0; i < np; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(np - 1, i + 1);
      let tx = xs[b] - xs[a];
      let tz = zs[b] - zs[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      lx[i] = -tz * hw;
      lz[i] = tx * hw;
    }
    const tone = ROAD_TONE[Math.min(cls, ROAD_TONE.length - 1)] * (bridge ? 1.15 : 1);
    const c: [number, number, number] = cls === 7 ? [tone * 1.05, tone, tone * 0.9] : [tone, tone, tone * 1.04];
    const top: number[] = [];
    for (let i = 0; i < np; i++) {
      top.push(vert(xs[i] + lx[i], ys[i], zs[i] + lz[i], 0, 1, 0, c), vert(xs[i] - lx[i], ys[i], zs[i] - lz[i], 0, 1, 0, c));
    }
    for (let i = 0; i < np - 1; i++) quad(top[i * 2], top[i * 2 + 2], top[i * 2 + 3], top[i * 2 + 1]);
    if (!bridge) continue;
    // Deck edges and underside (1.4 m deep), piers every ~36 m where the deck is clear of the ground.
    const depth = 1.4;
    for (const side of [1, -1]) {
      const e: number[] = [];
      for (let i = 0; i < np; i++) {
        const ex = xs[i] + lx[i] * side;
        const ez = zs[i] + lz[i] * side;
        const nx = (lx[i] / hw) * side;
        const nz = (lz[i] / hw) * side;
        e.push(vert(ex, ys[i], ez, nx, 0, nz, CONCRETE), vert(ex, ys[i] - depth, ez, nx, 0, nz, CONCRETE));
      }
      for (let i = 0; i < np - 1; i++) {
        if (side > 0) quad(e[i * 2], e[i * 2 + 1], e[i * 2 + 3], e[i * 2 + 2]);
        else quad(e[i * 2], e[i * 2 + 2], e[i * 2 + 3], e[i * 2 + 1]);
      }
    }
    const under: number[] = [];
    for (let i = 0; i < np; i++) {
      under.push(vert(xs[i] + lx[i], ys[i] - depth, zs[i] + lz[i], 0, -1, 0, CONCRETE), vert(xs[i] - lx[i], ys[i] - depth, zs[i] - lz[i], 0, -1, 0, CONCRETE));
    }
    for (let i = 0; i < np - 1; i++) quad(under[i * 2], under[i * 2 + 1], under[i * 2 + 3], under[i * 2 + 2]);
    let acc = 18;
    for (let i = 1; i < np; i++) {
      acc += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
      if (acc < 36) continue;
      const clear = ys[i] - depth - gs[i];
      if (clear < 2.5) continue;
      acc = 0;
      const s = Math.min(1.1, hw * 0.25);
      const y0 = gs[i] - 1;
      const y1 = ys[i] - depth;
      const corners: [number, number][] = [
        [-s, -s],
        [s, -s],
        [s, s],
        [-s, s],
      ];
      for (let f = 0; f < 4; f++) {
        const [ax, az] = corners[f];
        const [bx, bz] = corners[(f + 1) % 4];
        const nx = (ax + bx) / (2 * s);
        const nz = (az + bz) / (2 * s);
        const a = vert(xs[i] + ax, y0, zs[i] + az, nx, 0, nz, CONCRETE);
        const b = vert(xs[i] + bx, y0, zs[i] + bz, nx, 0, nz, CONCRETE);
        const cc = vert(xs[i] + bx, y1, zs[i] + bz, nx, 0, nz, CONCRETE);
        const d = vert(xs[i] + ax, y1, zs[i] + az, nx, 0, nz, CONCRETE);
        quad(a, d, cc, b);
      }
    }
  }
  if (!idx.length) return { arrays: null, ox, oz, count: n };
  return {
    arrays: { position: new Float32Array(pos), normal: new Float32Array(nrm), color: new Float32Array(col), index: new Uint32Array(idx) },
    ox,
    oz,
    count: n,
  };
}

export interface DetailTileResult {
  key: string;
  arrays: FacadeArrays | RoadArrays | null;
  mass?: MassArrays | null;
  /** Tile centre: the geometry is relative to it. */
  ox: number;
  oz: number;
  count: number;
  error?: string;
}

/**
 * Detail tile (bld/<i>_<j>.bin, 'SZD1') → facade geometry arrays, relative to the tile centre:
 * header nBuildings, nRings, nVerts, centre x, z; per building <HhBBBBI> (height dm, base dm, rings, use,
 * age, flags, seed); u16 vertex count per ring (padded to 4 bytes); i16 x, z in dm, delta-coded per ring.
 */
export function buildDetailTile(buf: ArrayBuffer): Omit<DetailTileResult, 'key'> {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SZD1') throw new Error('detail tile: bad magic ' + magic);
  const nb = dv.getUint32(4, true);
  const nr = dv.getUint32(8, true);
  const ox = dv.getFloat32(16, true);
  const oz = dv.getFloat32(20, true);
  let off = 24;
  const bOff = off;
  off += nb * 12;
  const rOff = off;
  off += nr * 2;
  if (nr % 2) off += 2;
  let vOff = off;
  let ring = 0;
  const fb = new FacadeBuilder();
  for (let k = 0; k < nb; k++) {
    const o = bOff + k * 12;
    const h = dv.getUint16(o, true) / 10;
    const base = dv.getInt16(o + 2, true) / 10;
    const nRings = dv.getUint8(o + 4);
    const use = USES[dv.getUint8(o + 5)];
    const age = AGES[dv.getUint8(o + 6)];
    const seed = dv.getUint32(o + 8, true) / 4294967296;
    const rings: Vec2[][] = [];
    for (let r = 0; r < nRings; r++) {
      const n = dv.getUint16(rOff + (ring + r) * 2, true);
      const pts: Vec2[] = [];
      let x = 0;
      let z = 0;
      for (let v = 0; v < n; v++) {
        x += dv.getInt16(vOff, true);
        z += dv.getInt16(vOff + 2, true);
        vOff += 4;
        pts.push([x / 10, z / 10]);
      }
      rings.push(pts);
    }
    ring += nRings;
    const outer = rings[0];
    if (!outer || outer.length < 3 || !(h > 0)) continue;
    const area = Math.abs(ringArea(outer));
    // The style uses the seed's top byte, the only part the mass tiles carry, so both LODs agree.
    const style = metroStyle(h, area, styleSeed(seed), use, age);
    const podium = use === 'industrial' || h < 9 ? 0 : h > 24 ? 5.5 + seed * 6 : 5;
    addBuilding(fb, outer, h, seed, style, podium, -1, base, rings.slice(1));
  }
  return { arrays: fb.empty ? null : fb.arrays(), ox, oz, count: nb };
}

declare const WorkerGlobalScope: { new (): unknown } | undefined;
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e: MessageEvent<DetailTileRequest>) => {
    const { key, buf, kind } = e.data;
    try {
      if (kind === 'mass') {
        const m = parseMassArrays(buf);
        const res: DetailTileResult = { key, arrays: null, mass: m, ox: m.ox, oz: m.oz, count: m.count };
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, [m.pos.buffer, m.size.buffer, m.rs.buffer]);
        return;
      }
      const res: DetailTileResult = { key, ...(kind === 'road' ? buildRoadTile(buf) : buildDetailTile(buf)) };
      const a = res.arrays;
      const transfer = a ? Object.values(a).map((v: ArrayBufferView) => v.buffer) : [];
      (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, transfer as Transferable[]);
    } catch (err) {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ key, arrays: null, ox: 0, oz: 0, count: 0, error: String(err) } satisfies DetailTileResult);
    }
  };
}
