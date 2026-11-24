import * as THREE from 'three';
import type { LandmarkMaterials } from './materials';

/** Merges thin square-section beams into one non-indexed geometry. */
class BeamBuilder {
  pos: number[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private s1 = new THREE.Vector3();
  private s2 = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private side = new THREE.Vector3(1, 0, 0);

  beam(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number) {
    const { a, b, dir, s1, s2 } = this;
    a.set(x0, y0, z0);
    b.set(x1, y1, z1);
    dir.subVectors(b, a).normalize();
    s1.crossVectors(dir, Math.abs(dir.y) > 0.9 ? this.side : this.up).normalize().multiplyScalar(t / 2);
    s2.crossVectors(dir, s1).normalize().multiplyScalar(t / 2);
    const c = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
    for (let k = 0; k < 4; k++) {
      const [u0, v0] = c[k];
      const [u1, v1] = c[(k + 1) % 4];
      const p = (base: THREE.Vector3, u: number, v: number) => [
        base.x + s1.x * u + s2.x * v,
        base.y + s1.y * u + s2.y * v,
        base.z + s1.z * u + s2.z * v,
      ];
      const A = p(a, u0, v0);
      const B = p(a, u1, v1);
      const C = p(b, u1, v1);
      const D = p(b, u0, v0);
      this.pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    }
  }

  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
    const g = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2).toNonIndexed();
    g.translate(cx, cy, cz);
    const arr = g.getAttribute('position').array;
    for (let i = 0; i < arr.length; i++) this.pos.push(arr[i]);
    g.dispose();
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.computeVertexNormals();
    return geo;
  }
}

/** Half-width of the tower profile at height y (Eiffel curve scaled to 108 m). */
const W = (y: number) => 20.8 * Math.exp(-y / 32) + 0.5;
const P1 = 19;
const P2 = 38;
const TOP = 108;

/**
 * Window of the World Eiffel Tower replica (108 m): four splayed lattice legs
 * with arches, two platforms, tapering shaft and spire; golden night lighting.
 */
export function buildEiffel(mats: LandmarkMaterials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'eiffel';
  const bb = new BeamBuilder();
  const legW = (y: number) => 7.2 - (3.2 * y) / P2;

  // Legs: 4 posts per leg with X bracing on each face.
  const legLevels = 10;
  for (const sx of [1, -1])
    for (const sz of [1, -1]) {
      const corners = (y: number): [number, number][] => {
        const w = W(y);
        const lw = legW(y);
        return [
          [sx * w, sz * w],
          [sx * (w - lw), sz * w],
          [sx * (w - lw), sz * (w - lw)],
          [sx * w, sz * (w - lw)],
        ];
      };
      for (let l = 0; l < legLevels; l++) {
        const y0 = (P2 * l) / legLevels;
        const y1 = (P2 * (l + 1)) / legLevels;
        const c0 = corners(y0);
        const c1 = corners(y1);
        for (let k = 0; k < 4; k++) {
          const m = (k + 1) % 4;
          bb.beam(c0[k][0], y0, c0[k][1], c1[k][0], y1, c1[k][1], 0.75);
          bb.beam(c0[k][0], y0, c0[k][1], c1[m][0], y1, c1[m][1], 0.3);
          bb.beam(c0[m][0], y0, c0[m][1], c1[k][0], y1, c1[k][1], 0.3);
          bb.beam(c1[k][0], y1, c1[k][1], c1[m][0], y1, c1[m][1], 0.3);
        }
      }
    }

  // Arches between legs below the first platform.
  for (let face = 0; face < 4; face++) {
    const seg = 18;
    const ys = 4.5;
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const span = W(ys) - legW(ys);
      const u = -span + 2 * span * t;
      const y = ys + (P1 - 2.2 - ys) * Math.sin(Math.PI * t);
      const off = W(y) - legW(y) * 0.5;
      const pt: [number, number, number] = face === 0 ? [u, y, off] : face === 1 ? [u, y, -off] : face === 2 ? [off, y, u] : [-off, y, u];
      if (prev) bb.beam(prev[0], prev[1], prev[2], pt[0], pt[1], pt[2], 0.6);
      prev = pt;
    }
  }

  // Platforms.
  bb.box(0, P1, 0, W(P1) + 0.8, 0.9, W(P1) + 0.8);
  bb.box(0, P2, 0, W(P2) + 0.6, 0.7, W(P2) + 0.6);
  bb.box(0, 92, 0, W(92) + 0.9, 1.2, W(92) + 0.9);

  // Upper shaft from the second platform.
  const shaftLevels = 14;
  for (let l = 0; l < shaftLevels; l++) {
    const y0 = P2 + ((92 - P2) * l) / shaftLevels;
    const y1 = P2 + ((92 - P2) * (l + 1)) / shaftLevels;
    const w0 = W(y0);
    const w1 = W(y1);
    const c0: [number, number][] = [
      [w0, w0],
      [-w0, w0],
      [-w0, -w0],
      [w0, -w0],
    ];
    const c1: [number, number][] = [
      [w1, w1],
      [-w1, w1],
      [-w1, -w1],
      [w1, -w1],
    ];
    for (let k = 0; k < 4; k++) {
      const m = (k + 1) % 4;
      bb.beam(c0[k][0], y0, c0[k][1], c1[k][0], y1, c1[k][1], 0.55);
      bb.beam(c0[k][0], y0, c0[k][1], c1[m][0], y1, c1[m][1], 0.22);
      bb.beam(c0[m][0], y0, c0[m][1], c1[k][0], y1, c1[k][1], 0.22);
      bb.beam(c1[k][0], y1, c1[k][1], c1[m][0], y1, c1[m][1], 0.22);
    }
  }
  bb.box(0, 96, 0, 0.9, 3.2, 0.9);
  bb.beam(0, 99, 0, 0, TOP, 0, 0.35);

  const lattice = new THREE.Mesh(bb.build(), mats.gold);
  group.add(lattice);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8).translate(0, TOP + 0.3, 0), mats.goldGlow);
  group.add(lamp);
  return group;
}
