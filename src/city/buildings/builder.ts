import * as THREE from 'three';
import type { Vec2 } from '../../route/types';
import { STYLE } from './facadeMaterial';

const CORNER_COS = Math.cos(THREE.MathUtils.degToRad(25));

export function ringArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function ringCentroid(ring: Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}

/** Rectangle (optionally chamfered) centered at (cx, cz), long side along (ax, az). */
export function rectRing(cx: number, cz: number, ax: number, az: number, halfLen: number, halfDep: number, chamfer = 0): Vec2[] {
  const nx = -az;
  const nz = ax;
  const pts: [number, number][] =
    chamfer > 0
      ? [
          [halfLen - chamfer, -halfDep],
          [halfLen, -halfDep + chamfer],
          [halfLen, halfDep - chamfer],
          [halfLen - chamfer, halfDep],
          [-halfLen + chamfer, halfDep],
          [-halfLen, halfDep - chamfer],
          [-halfLen, -halfDep + chamfer],
          [-halfLen + chamfer, -halfDep],
        ]
      : [
          [halfLen, -halfDep],
          [halfLen, halfDep],
          [-halfLen, halfDep],
          [-halfLen, -halfDep],
        ];
  return pts.map(([u, v]) => [cx + ax * u + nx * v, cz + az * u + nz * v]);
}

/**
 * Facade u per edge of a CCW ring: meters from the start of its face, where
 * faces are runs of edges between sharp corners (so curved walls form one face).
 */
function faceCoords(pts: Vec2[]) {
  const n = pts.length;
  const len = new Float64Array(n);
  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const ex = q[0] - p[0];
    const ez = q[1] - p[1];
    const l = Math.hypot(ex, ez) || 1e-6;
    len[i] = l;
    dx[i] = ex / l;
    dz[i] = ez / l;
  }
  const corner = new Uint8Array(n);
  let start = -1;
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n;
    if (dx[i] * dx[j] + dz[i] * dz[j] < CORNER_COS) {
      corner[i] = 1;
      if (start < 0) start = i;
    }
  }
  if (start < 0) start = 0;
  corner[start] = 1;
  const u0 = new Float64Array(n);
  const u1 = new Float64Array(n);
  const flen = new Float64Array(n);
  let k = 0;
  while (k < n) {
    const edges: number[] = [];
    let faceLen = 0;
    do {
      const i = (start + k) % n;
      edges.push(i);
      faceLen += len[i];
      k++;
    } while (k < n && !corner[(start + k) % n]);
    let u = 0;
    for (const i of edges) {
      u0[i] = u;
      u += len[i];
      u1[i] = u;
      flen[i] = faceLen;
    }
  }
  return { u0, u1, flen };
}

/**
 * Accumulates extruded footprints into one indexed BufferGeometry with the
 * facade attributes (aEdge, aFac) expected by createFacadeMaterial.
 */
export class FacadeBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private edge: number[] = [];
  private fac: number[] = [];
  private idx: number[] = [];

  get empty(): boolean {
    return this.idx.length === 0;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, len: number, f: readonly number[]) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.edge.push(u, len);
    this.fac.push(f[0], f[1], f[2], f[3]);
    return this.pos.length / 3 - 1;
  }

  /**
   * Walls from y0 to y1 around `ring` (any winding, no closing duplicate), plus a
   * flat cap at y1. Facade u restarts at sharp corners so window bays align per face.
   * fac = [seed, style, podiumHeight, topY]
   */
  addPrism(ring: Vec2[], y0: number, y1: number, fac: readonly number[], cap = true, capStyle: number = STYLE.roof) {
    if (ring.length < 3) return;
    this.addLoft([ring, ring], [y0, y1], fac, cap, capStyle);
  }

  /**
   * Walls between consecutive rings (same vertex count and correspondence) at
   * heights ys; equal heights make horizontal setback ledges. Facade u comes
   * from the first ring so window columns stay continuous up a taper.
   */
  addLoft(rings: Vec2[][], ys: number[], fac: readonly number[], cap = true, capStyle: number = STYLE.roof) {
    const rs = ringArea(rings[0]) < 0 ? rings.map((r) => r.slice().reverse()) : rings;
    const pts = rs[0];
    const n = pts.length;
    const { u0, u1, flen } = faceCoords(pts);
    const v = new THREE.Vector3();
    const w = new THREE.Vector3();
    for (let l = 0; l < rs.length - 1; l++) {
      const ra = rs[l];
      const rb = rs[l + 1];
      const ya = ys[l];
      const yb = ys[l + 1];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p = ra[i];
        const q = ra[j];
        const P = rb[i];
        const Q = rb[j];
        // Outward normal from the quad diagonals (works for walls, tapers and flat ledges).
        v.set(P[0] - q[0], yb - ya, P[1] - q[1]);
        w.set(Q[0] - p[0], yb - ya, Q[1] - p[1]);
        v.cross(w);
        if (v.lengthSq() < 1e-12) continue;
        v.normalize();
        const a = this.vert(p[0], ya, p[1], v.x, v.y, v.z, u0[i], flen[i], fac);
        const b = this.vert(q[0], ya, q[1], v.x, v.y, v.z, u1[i], flen[i], fac);
        const c = this.vert(Q[0], yb, Q[1], v.x, v.y, v.z, u1[i], flen[i], fac);
        const d = this.vert(P[0], yb, P[1], v.x, v.y, v.z, u0[i], flen[i], fac);
        this.idx.push(a, d, c, a, c, b);
      }
    }
    if (!cap) return;
    this.addCap(rs[rs.length - 1], ys[ys.length - 1], [fac[0], capStyle, 0, ys[ys.length - 1]]);
  }

  private addCap(pts: Vec2[], y: number, capFac: readonly number[]) {
    const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = this.pos.length / 3;
    for (const p of pts) this.vert(p[0], y, p[1], 0, 1, 0, 0, 0, capFac);
    for (const [i0, i1, i2] of tris) {
      const p0 = pts[i0];
      const p1 = pts[i1];
      const p2 = pts[i2];
      const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      if (cross > 0) this.idx.push(base + i0, base + i2, base + i1);
      else this.idx.push(base + i0, base + i1, base + i2);
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.edge, 2));
    geo.setAttribute('aFac', new THREE.Float32BufferAttribute(this.fac, 4));
    const vc = this.pos.length / 3;
    geo.setIndex(new THREE.BufferAttribute(vc > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}
