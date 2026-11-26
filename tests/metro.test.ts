import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { FacadeArrays } from '../src/city/buildings/builder';
import { buildDetailTile, buildRoadTile } from '../src/city/metro/buildingWorker';
import { decodeHeights, GridSampler, MetroTerrain } from '../src/city/metro/load';
import { parseMassTile } from '../src/city/metro/mass';
import type { MetroMeta } from '../src/city/metro/types';
import type { RouteData } from '../src/route/types';

const DATA = fileURLToPath(new URL('../public/data', import.meta.url));
const METRO = join(DATA, 'metro');
const path = { join };
const has = existsSync(path.join(METRO, 'metro.json')) && existsSync(path.join(DATA, 'route.json'));

const bin = (file: string): ArrayBuffer => {
  const raw = readFileSync(path.join(METRO, file));
  const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.runIf(has)('whole-city data (public/data/metro)', () => {
  const meta = has ? (JSON.parse(readFileSync(path.join(METRO, 'metro.json'), 'utf8')) as MetroMeta) : (null as unknown as MetroMeta);
  const route = has ? (JSON.parse(readFileSync(path.join(DATA, 'route.json'), 'utf8')) as RouteData) : (null as unknown as RouteData);
  const t = meta?.terrain;
  const terrain = has
    ? new MetroTerrain(
        t,
        new GridSampler(t.inner, decodeHeights(bin(t.inner.file), t.inner.nx, t.inner.nz)),
        new GridSampler(t.outer, decodeHeights(bin(t.outer.file), t.outer.nx, t.outer.nz)),
        t.corridor ? new GridSampler(t.corridor, new Uint8Array(bin(t.corridor.file)), 1 / 255) : null,
      )
    : (null as unknown as MetroTerrain);

  it('shares the route frame and lists only files that exist', () => {
    expect(meta.origin.lon).toBeCloseTo(route.meta.origin.lon, 6);
    expect(meta.origin.lat).toBeCloseTo(route.meta.origin.lat, 6);
    for (const f of [t.inner.file, t.outer.file, t.inner.albedo.file, t.outer.albedo.file, meta.water.file]) expect(existsSync(path.join(METRO, f)), f).toBe(true);
    for (const [i, j] of meta.buildings!.detail) expect(existsSync(path.join(METRO, 'bld', `${i}_${j}.bin.gz`))).toBe(true);
    for (const [i, j] of meta.buildings!.mass) expect(existsSync(path.join(METRO, 'mass', `${i}_${j}.bin.gz`))).toBe(true);
    for (const [i, j] of meta.roads!.tiles) expect(existsSync(path.join(METRO, 'roads', `${i}_${j}.bin.gz`))).toBe(true);
  });

  it('decodes the height grids within real elevations', () => {
    for (const g of [terrain.inner, terrain.outer]) {
      let min = Infinity;
      let max = -Infinity;
      for (const v of g.values) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      expect(min).toBeGreaterThan(-60);
      expect(max).toBeLessThan(1000);
      expect(max).toBeGreaterThan(400);
    }
    // the inner grid covers 深圳市; the outer one the whole horizon window around it
    expect(t.outer.x0).toBeLessThanOrEqual(t.inner.x0);
    expect(t.outer.z0).toBeLessThanOrEqual(t.inner.z0);
    expect(t.seaLevel).toBeCloseTo(-t.routeElevation, 2);
  });

  it('is flat at the old ground-plane height along the whole route', () => {
    const cl = route.centerline;
    for (let i = 0; i < cl.length; i += 25) {
      const [x, z] = cl[i];
      expect(Math.abs(terrain.heightAt(x, z) - t.groundY)).toBeLessThan(0.05);
      expect(terrain.corridorAt(x, z)).toBeGreaterThan(0.99);
    }
  });

  it('parses detail tiles into finite facade geometry', () => {
    const tiles = meta.buildings!.detail;
    for (const [i, j, count] of [tiles[0], tiles[Math.floor(tiles.length / 2)], tiles[tiles.length - 1]]) {
      const r = buildDetailTile(bin(`bld/${i}_${j}.bin.gz`));
      expect(r.count).toBe(count);
      expect(r.arrays).not.toBeNull();
      const a = r.arrays as FacadeArrays;
      expect(a.position.length % 3).toBe(0);
      expect(a.aBase.length).toBe(a.position.length / 3);
      for (let k = 0; k < a.position.length; k += 97) expect(Number.isFinite(a.position[k])).toBe(true);
      for (let k = 0; k < a.index.length; k += 101) expect(a.index[k]).toBeLessThan(a.position.length / 3);
    }
  });

  it('keeps every whole-city building clear of the route corridor and on the ground', () => {
    // detail tiles touching the route: no footprint vertex within 290 m of the centreline
    const cl = route.centerline;
    const near = (x: number, z: number) => {
      let best = Infinity;
      for (let i = 0; i < cl.length; i += 4) best = Math.min(best, Math.hypot(cl[i][0] - x, cl[i][1] - z));
      return best;
    };
    const tile = meta.buildings!.detailTile;
    const onRoute = meta.buildings!.detail.filter(([i, j]) => cl.some(([x, z]) => Math.floor(x / tile) === i && Math.floor(z / tile) === j)).slice(0, 4);
    expect(onRoute.length).toBeGreaterThan(0);
    for (const [i, j] of onRoute) {
      const buf = bin(`bld/${i}_${j}.bin.gz`);
      const dv = new DataView(buf);
      const nb = dv.getUint32(4, true);
      const nr = dv.getUint32(8, true);
      const ox = dv.getFloat32(16, true);
      const oz = dv.getFloat32(20, true);
      let vOff = 24 + nb * 12 + nr * 2 + (nr % 2 ? 2 : 0);
      let ring = 0;
      for (let k = 0; k < nb; k++) {
        const o = 24 + k * 12;
        const base = dv.getInt16(o + 2, true) / 10;
        const rings = dv.getUint8(o + 4);
        for (let r = 0; r < rings; r++) {
          const n = dv.getUint16(24 + nb * 12 + (ring + r) * 2, true);
          let x = 0;
          let z = 0;
          for (let v = 0; v < n; v++) {
            x += dv.getInt16(vOff, true);
            z += dv.getInt16(vOff + 2, true);
            vOff += 4;
            if (r === 0 && v === 0) {
              const wx = ox + x / 10;
              const wz = oz + z / 10;
              expect(near(wx, wz)).toBeGreaterThan(290);
              expect(base).toBeLessThanOrEqual(terrain.heightAt(wx, wz) + 0.2);
            }
          }
        }
        ring += rings;
      }
    }
  });

  it('parses mass tiles and the skyline set', () => {
    const [i, j, count] = meta.buildings!.mass[Math.floor(meta.buildings!.mass.length / 2)];
    const m = parseMassTile(bin(`mass/${i}_${j}.bin.gz`));
    expect(m.count).toBe(count);
    expect(m.geometry.instanceCount).toBe(count);
    const size = m.geometry.getAttribute('iSize').array as Float32Array;
    for (let k = 1; k < size.length; k += 3 * 37) {
      expect(size[k]).toBeGreaterThanOrEqual(3);
      expect(size[k]).toBeLessThan(meta.buildings!.skyline.minHeight);
    }
    const sky = parseMassTile(bin(meta.buildings!.skyline.file));
    expect(sky.count).toBe(meta.buildings!.skyline.count);
    const ss = sky.geometry.getAttribute('iSize').array as Float32Array;
    for (let k = 1; k < ss.length; k += 3 * 53) expect(ss[k]).toBeGreaterThanOrEqual(meta.buildings!.skyline.minHeight - 0.1);
  });

  it('parses road tiles and the water mesh', () => {
    const tiles = meta.roads!.tiles;
    for (const [i, j, count] of [tiles[0], tiles[Math.floor(tiles.length / 2)]]) {
      const r = buildRoadTile(bin(`roads/${i}_${j}.bin.gz`));
      expect(r.count).toBe(count);
      for (let k = 0; k < (r.arrays?.position.length ?? 0); k += 31) expect(Number.isFinite(r.arrays!.position[k])).toBe(true);
    }
    const w = new DataView(bin(meta.water.file));
    expect(String.fromCharCode(w.getUint8(0), w.getUint8(1), w.getUint8(2), w.getUint8(3))).toBe('SZW2');
    expect(w.getUint32(4, true)).toBe(meta.water.tiles);
  });
});
