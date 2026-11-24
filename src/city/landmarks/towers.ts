import * as THREE from 'three';
import type { Vec2 } from '../../route/types';
import { FacadeBuilder, rectRing } from '../buildings/builder';
import { STYLE } from '../buildings/facadeMaterial';
import type { LandmarkMaterials } from './materials';

/**
 * Tencent Building (old HQ on Shennan Blvd, ~193 m): slim blue glass slab with
 * a stepped top, a vertical blade and a glowing open crown frame.
 */
export function buildTencent(mats: LandmarkMaterials, height = 193): THREE.Group {
  const group = new THREE.Group();
  group.name = 'tencent';
  const k = height / 193;
  const fb = new FacadeBuilder();
  fb.addPrism(rectRing(0, 0, 1, 0, 30, 21, 4), 0, 172 * k, [0.66, STYLE.tencent, 14, 172 * k], true, STYLE.roof);
  fb.addPrism(rectRing(-4, 0, 1, 0, 22, 16, 3), 172 * k, 184 * k, [0.18, STYLE.tencent, 0, 184 * k], true, STYLE.roof);
  fb.addPrism(rectRing(24, 0, 1, 0, 3, 18), 172 * k, height, [0.5, STYLE.mech, 0, height], true, STYLE.roof);
  fb.addPrism(rectRing(0, 34, 1, 0, 44, 16), 0, 16, [0.27, STYLE.mixed, 16, 16], true, STYLE.roof);
  group.add(new THREE.Mesh(fb.build(), mats.glassNear));

  const frame: THREE.BufferGeometry[] = [];
  const y = height - 2;
  for (const [cx, cz, sx, sz] of [
    [-4, 16, 23, 0.5],
    [-4, -16, 23, 0.5],
    [-27, 0, 0.5, 16.5],
    [19, 0, 0.5, 16.5],
  ]) {
    frame.push(new THREE.BoxGeometry(sx * 2, 0.8, sz * 2).translate(cx, y, cz));
  }
  for (const g of frame) group.add(new THREE.Mesh(g, mats.crownGlow));
  return group;
}

function roundedRect(hx: number, hz: number, r: number, seg = 3): Vec2[] {
  const out: Vec2[] = [];
  const corners: [number, number, number][] = [
    [hx - r, -hz + r, -Math.PI / 2],
    [hx - r, hz - r, 0],
    [-hx + r, hz - r, Math.PI / 2],
    [-hx + r, -hz + r, Math.PI],
  ];
  for (const [cx, cz, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  return out;
}

/** KK100 (~442 m): rounded slab with a gentle taper and an arched crown. */
export function buildKK100(mats: LandmarkMaterials, height = 442): THREE.Group {
  const group = new THREE.Group();
  group.name = 'kk100';
  const k = height / 442;
  const levels: [number, number, number][] = [
    [0, 36, 24],
    [300, 34, 22],
    [400, 30, 19],
    [425, 22, 15],
    [442, 8, 12],
  ];
  const fb = new FacadeBuilder();
  fb.addLoft(
    levels.map(([, hx, hz]) => roundedRect(hx, hz, Math.min(hx, hz) * 0.45)),
    levels.map(([y]) => y * k),
    [0.58, STYLE.blueGlass, 0, 400 * k],
    true,
    STYLE.mech,
  );
  group.add(new THREE.Mesh(fb.build(), mats.glassFar));
  return group;
}

/** Lianhuashan: a forested ~100 m hill, dark green with tonal variation. */
export function buildHill(mats: LandmarkMaterials, radius: number, height: number): THREE.Mesh {
  const rings = 22;
  const segs = 72;
  const pos: number[] = [0, height, 0];
  const col: number[] = [];
  const base = new THREE.Color('#1d2a1a');
  const c = new THREE.Color();
  c.copy(base);
  col.push(c.r, c.g, c.b);
  const idx: number[] = [];
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const wob = 1 + 0.12 * Math.sin(a * 3 + 1.3) + 0.07 * Math.sin(a * 7 + 0.4);
      const rr = radius * t * wob;
      const h = height * Math.pow(Math.cos(t * Math.PI * 0.5), 1.6) * (1 + 0.08 * Math.sin(a * 5 + t * 9));
      pos.push(Math.cos(a) * rr, Math.max(0, h) - 0.5, Math.sin(a) * rr);
      const n = 0.75 + 0.5 * Math.abs(Math.sin(a * 13 + t * 31) * Math.cos(a * 7 - t * 17));
      c.copy(base).multiplyScalar(n);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segs;
    const b0 = 1 + r * segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s1, b0 + s, b0 + s, a0 + s1, b0 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.hill);
  mesh.name = 'lianhuashan';
  return mesh;
}
