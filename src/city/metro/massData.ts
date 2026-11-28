import type { BuildingUse } from '../../route/types';
import { metroStyle, styleSeed } from '../buildings/shapes';

const USES: (BuildingUse | undefined)[] = [undefined, 'residential', 'office', 'commercial', 'public', 'industrial'];
const AGES: (string | undefined)[] = [undefined, '1980s', '1990s', '2000s', '2010s', '2020s'];
const RECORD = 17;

/** Parsed mass-tile arrays (worker-safe, zero Three.js dependency). */
export interface MassArrays {
  /** Mesh origin (tile centre); instance positions are relative to it. */
  ox: number;
  oz: number;
  count: number;
  pos: Float32Array;
  size: Float32Array;
  rs: Float32Array;
  /** Bounding sphere centre relative to (ox, 0, oz) and radius. */
  bsCenter: [number, number, number];
  bsRadius: number;
}

/**
 * Mass tile / skyline file ('SZM1': n, origin x, z, span; per building <HHHHHhBBHB>: centre x, z quantised
 * over the span, half length / width dm, height dm, base dm, angle / 255 * pi, use | age << 3, footprint m2,
 * seed top byte) → instanced-box typed arrays ready to transfer from a Web Worker.
 */
export function parseMassArrays(buf: ArrayBuffer): MassArrays {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'SZM1') throw new Error('mass tile: bad magic');
  const n = dv.getUint32(4, true);
  const x0 = dv.getFloat32(8, true);
  const z0 = dv.getFloat32(12, true);
  const span = dv.getFloat32(16, true);
  const ox = x0 + span / 2;
  const oz = z0 + span / 2;
  const q = span / 65535;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n * 3);
  const rs = new Float32Array(n * 3);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  for (let k = 0; k < n; k++) {
    const o = 20 + k * RECORD;
    const cx = x0 + dv.getUint16(o, true) * q;
    const cz = z0 + dv.getUint16(o + 2, true) * q;
    const hl = dv.getUint16(o + 4, true) / 10;
    const hw = dv.getUint16(o + 6, true) / 10;
    const h = dv.getUint16(o + 8, true) / 10;
    const base = dv.getInt16(o + 10, true) / 10;
    const ang = (dv.getUint8(o + 12) / 255) * Math.PI;
    const ua = dv.getUint8(o + 13);
    const area = dv.getUint16(o + 14, true);
    const seed = (dv.getUint8(o + 16) + 0.5) / 256;
    pos[k * 3] = cx - ox;
    pos[k * 3 + 1] = base;
    pos[k * 3 + 2] = cz - oz;
    size[k * 3] = hl;
    size[k * 3 + 1] = h;
    size[k * 3 + 2] = hw;
    rs[k * 3] = ang;
    rs[k * 3 + 1] = metroStyle(h, area, styleSeed(seed), USES[ua & 7], AGES[ua >> 3]);
    rs[k * 3 + 2] = seed;
    const r = Math.max(hl, hw);
    minX = Math.min(minX, cx - r);
    maxX = Math.max(maxX, cx + r);
    minZ = Math.min(minZ, cz - r);
    maxZ = Math.max(maxZ, cz + r);
    maxY = Math.max(maxY, base + h);
  }
  const bsCenter: [number, number, number] = n ? [(minX + maxX) / 2 - ox, maxY / 2, (minZ + maxZ) / 2 - oz] : [0, 0, 0];
  const bsRadius = n ? Math.hypot(maxX - minX, maxZ - minZ, maxY) / 2 + 10 : 1;
  return { ox, oz, count: n, pos, size, rs, bsCenter, bsRadius };
}
