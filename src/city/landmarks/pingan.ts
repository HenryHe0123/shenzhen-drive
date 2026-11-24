import * as THREE from 'three';
import type { Vec2 } from '../../route/types';
import { FacadeBuilder, rectRing } from '../buildings/builder';
import { STYLE } from '../buildings/facadeMaterial';
import type { LandmarkMaterials } from './materials';

/** Square plan with chamfered corners, half size a, centered at the origin (CCW). */
function octRing(a: number, chamferK = 0.24): Vec2[] {
  const c = a * chamferK;
  return [
    [a, -a + c],
    [a, a - c],
    [a - c, a],
    [-a + c, a],
    [-a, a - c],
    [-a, -a + c],
    [-a + c, -a],
    [a - c, -a],
  ];
}

/** [y, half size] profile: gentle taper, then a stepped crown (equal y = setback ledge). */
const PROFILE: [number, number][] = [
  [0, 33],
  [80, 32.2],
  [300, 29.5],
  [470, 25.2],
  [470, 24.2],
  [500, 21.5],
  [500, 19.5],
  [526, 16.0],
  [526, 14.0],
  [547, 9.5],
  [556, 3.2],
];
const SPIRE_BASE = 556;
const SPIRE_TOP = 599;

/**
 * Ping An Finance Center: chamfered square tower with 8 continuous stainless
 * ribs at the chamfer corners, stepped crown, spire and a red aviation light.
 * Built in local coordinates (faces along x/z); the caller positions it.
 */
export function buildPingAn(mats: LandmarkMaterials, scale = 1): { object: THREE.Group; beacon: THREE.Vector3 } {
  const group = new THREE.Group();
  group.name = 'pingan';
  const fb = new FacadeBuilder();
  const rings = PROFILE.map(([, a]) => octRing(a * scale));
  const ys = PROFILE.map(([y]) => y * scale);
  fb.addLoft(rings, ys, [0.37, STYLE.pingan, 0, 470 * scale], true, STYLE.mech);
  // Retail podium wrapped around the base.
  const pod = rectRing(0, 18 * scale, 1, 0, 62 * scale, 46 * scale, 6 * scale);
  fb.addPrism(pod, 0, 30 * scale, [0.81, STYLE.mixed, 30 * scale, 30 * scale]);
  const body = new THREE.Mesh(fb.build(), mats.glassFar);
  group.add(body);

  // Ribs: an outward blade at each of the 8 corners, following the taper/setbacks.
  const ribPos: number[] = [];
  const ribIdx: number[] = [];
  const ribW = 1.5 * scale;
  const ribD = 2.4 * scale;
  const ribProfile = PROFILE.slice(0, PROFILE.length - 1);
  for (let k = 0; k < 8; k++) {
    const base = ribPos.length / 3;
    for (const [y, a] of ribProfile) {
      const ring = octRing(a * scale);
      const p = ring[k];
      const prev = ring[(k + 7) % 8];
      const next = ring[(k + 1) % 8];
      // Outward bisector at the corner.
      let ex = next[0] - prev[0];
      let ez = next[1] - prev[1];
      const el = Math.hypot(ex, ez);
      ex /= el;
      ez /= el;
      const nx = ez;
      const nz = -ex;
      const yy = y * scale;
      ribPos.push(
        p[0] - ex * ribW, yy, p[1] - ez * ribW,
        p[0] - ex * ribW + nx * ribD, yy, p[1] - ez * ribW + nz * ribD,
        p[0] + ex * ribW + nx * ribD, yy, p[1] + ez * ribW + nz * ribD,
        p[0] + ex * ribW, yy, p[1] + ez * ribW,
      );
    }
    for (let l = 0; l < ribProfile.length - 1; l++) {
      const a0 = base + l * 4;
      const b0 = a0 + 4;
      for (let s = 0; s < 3; s++) {
        const a = a0 + s;
        const b = a0 + s + 1;
        const c = b0 + s + 1;
        const d = b0 + s;
        ribIdx.push(a, c, b, a, d, c);
      }
    }
  }
  const ribGeo = new THREE.BufferGeometry();
  ribGeo.setAttribute('position', new THREE.Float32BufferAttribute(ribPos, 3));
  ribGeo.setIndex(ribIdx);
  const ribs = new THREE.Mesh(ribGeo.toNonIndexed(), mats.steel);
  ribs.geometry.computeVertexNormals();
  group.add(ribs);

  // Crown lights: thin glowing bands just above each setback.
  const bands: number[] = [];
  for (const [y, a] of [
    [470, 24.2],
    [500, 19.5],
    [526, 14.0],
    [300, 29.6],
  ] as [number, number][]) {
    const ring = octRing(a * scale * 1.012);
    const y0 = y * scale + 0.4;
    const y1 = y0 + 0.9 * scale;
    for (let i = 0; i < 8; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % 8];
      bands.push(p[0], y0, p[1], q[0], y0, q[1], q[0], y1, q[1], p[0], y0, p[1], q[0], y1, q[1], p[0], y1, p[1]);
    }
  }
  const bandGeo = new THREE.BufferGeometry();
  bandGeo.setAttribute('position', new THREE.Float32BufferAttribute(bands, 3));
  group.add(new THREE.Mesh(bandGeo, mats.crownGlow));
  const spire = new THREE.CylinderGeometry(0.35 * scale, 2.6 * scale, (SPIRE_TOP - SPIRE_BASE) * scale, 8);
  spire.translate(0, ((SPIRE_BASE + SPIRE_TOP) / 2) * scale, 0);
  group.add(new THREE.Mesh(spire, mats.steel));

  return { object: group, beacon: new THREE.Vector3(0, SPIRE_TOP * scale + 1, 0) };
}
