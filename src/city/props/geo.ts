import * as THREE from 'three';
import type { RGB } from '../road/builder';

export type V3 = [number, number, number];
/** UV rectangle [u0, v0, u1, v1]. */
export type UVRect = readonly [number, number, number, number];

const ZERO_UV: UVRect = [0, 0, 1, 1];

/** Small static mesh builder (position/normal/uv/color) with per-call transforms. */
export class PropGeo {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly uv: number[] = [];
  readonly c: number[] = [];
  readonly idx: number[] = [];
  private readonly v = new THREE.Vector3();
  private readonly nv = new THREE.Vector3();
  private readonly nm = new THREE.Matrix3();
  private readonly tmp = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly dir = new THREE.Vector3();

  vertex(m: THREE.Matrix4 | null, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, col: RGB): number {
    this.v.set(x, y, z);
    this.nv.set(nx, ny, nz);
    if (m) {
      this.v.applyMatrix4(m);
      this.nv.applyMatrix3(this.nm.getNormalMatrix(m)).normalize();
    }
    this.p.push(this.v.x, this.v.y, this.v.z);
    this.n.push(this.nv.x, this.nv.y, this.nv.z);
    this.uv.push(u, w);
    this.c.push(col[0], col[1], col[2]);
    return this.p.length / 3 - 1;
  }

  /** Quad from 4 local corners (counter-clockwise seen from the front), flat normal. */
  quad(m: THREE.Matrix4 | null, a: V3, b: V3, c: V3, d: V3, uv: UVRect, col: RGB, normal?: V3) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const N = normal ?? [nx, ny, nz];
    const [u0, v0, u1, v1] = uv;
    const i0 = this.vertex(m, a[0], a[1], a[2], N[0], N[1], N[2], u0, v0, col);
    const i1 = this.vertex(m, b[0], b[1], b[2], N[0], N[1], N[2], u1, v0, col);
    const i2 = this.vertex(m, c[0], c[1], c[2], N[0], N[1], N[2], u1, v1, col);
    const i3 = this.vertex(m, d[0], d[1], d[2], N[0], N[1], N[2], u0, v1, col);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Axis-aligned box in local space (centre cx/cy/cz, size sx/sy/sz); `front` UV goes on the +z face. */
  box(m: THREE.Matrix4 | null, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: RGB, front: UVRect = ZERO_UV, other: UVRect = front, back?: UVRect) {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    this.quad(m, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], front, col);
    this.quad(m, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], back ?? other, col);
    this.quad(m, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], other, col);
    this.quad(m, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], other, col);
    this.quad(m, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], other, col);
    this.quad(m, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], other, col);
  }

  /** Open cylinder from local point a to b (radii ra → rb). UV u wraps around, v along the axis. */
  cylinder(m: THREE.Matrix4 | null, a: V3, b: V3, ra: number, rb: number, seg: number, col: RGB, uv: UVRect = ZERO_UV, colTop?: RGB) {
    this.dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = this.dir.length();
    this.dir.normalize();
    this.q.setFromUnitVectors(this.up, this.dir);
    this.tmp.makeRotationFromQuaternion(this.q).setPosition(a[0], a[1], a[2]);
    if (m) this.tmp.premultiply(m);
    const [u0, v0, u1, v1] = uv;
    const base = this.p.length / 3;
    const slope = (ra - rb) / len;
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const cs = Math.cos(t);
      const sn = Math.sin(t);
      const nl = Math.hypot(1, slope);
      const u = u0 + ((u1 - u0) * i) / seg;
      this.vertex(this.tmp, cs * ra, 0, sn * ra, cs / nl, slope / nl, sn / nl, u, v0, col);
      this.vertex(this.tmp, cs * rb, len, sn * rb, cs / nl, slope / nl, sn / nl, u, v1, colTop ?? col);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      this.idx.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
  }

  get vertexCount() {
    return this.p.length / 3;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** World matrix for an object standing at (x, y, z) facing yaw (Three.js rotation.y). */
export function placeMatrix(x: number, y: number, z: number, yaw: number, scale = 1, out = new THREE.Matrix4()): THREE.Matrix4 {
  const c = Math.cos(yaw) * scale;
  const s = Math.sin(yaw) * scale;
  return out.set(c, 0, s, x, 0, scale, 0, y, -s, 0, c, z, 0, 0, 0, 1);
}
