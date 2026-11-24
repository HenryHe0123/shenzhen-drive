import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec2 } from '../../route/types';
import { FacadeBuilder, rectRing } from '../buildings/builder';
import { STYLE } from '../buildings/facadeMaterial';
import type { LandmarkMaterials } from './materials';

const HALF_LEN = 243;
const HALF_DEP = 62;
const BODY_HALF = 44;
const THICK = 3.2;

function circleRing(cx: number, cz: number, r: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/** Roof height of a wing at local x (|x| >= BODY_HALF) and z: high at the body, dips, lifts at the tip, waves in depth. */
function wingY(x: number, z: number): number {
  const t = Math.min(1, Math.max(0, (Math.abs(x) - BODY_HALF) / (HALF_LEN - BODY_HALF)));
  const base = 50 + 10 * (1 - t) ** 3 + 9 * t ** 3 - 3 * Math.sin(Math.PI * t);
  const wave = 2.2 * Math.sin((z / HALF_DEP) * Math.PI * 1.0 + t * Math.PI * 2.0);
  const sag = 3 * (1 - (z / HALF_DEP) ** 2);
  return base + wave + sag;
}

/** Grid-shell panels: base fill, minor ribs, diagonal members, mid rib. */
function latticeTexture(colors = ['#26282c', '#3a3d42', '#a3a7ad', '#7d8187']): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  g.fillStyle = colors[0];
  g.fillRect(0, 0, size, size);
  g.strokeStyle = colors[1];
  g.lineWidth = 6;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * size;
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, size);
    g.stroke();
  }
  g.strokeStyle = colors[2];
  g.lineWidth = 14;
  for (let k = -1; k <= 1; k++) {
    g.beginPath();
    g.moveTo(k * size, 0);
    g.lineTo(k * size + size, size);
    g.stroke();
    g.beginPath();
    g.moveTo(k * size + size, 0);
    g.lineTo(k * size, size);
    g.stroke();
  }
  g.strokeStyle = colors[3];
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(0, size / 2);
  g.lineTo(size, size / 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** One wing surface (top or bottom) as an indexed grid, uv in lattice tiles. */
function wingSurface(sign: 1 | -1, bottom: boolean): THREE.BufferGeometry {
  const nx = 60;
  const nz = 16;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nx; i++) {
    const x = sign * (BODY_HALF + ((HALF_LEN - BODY_HALF) * i) / nx);
    for (let j = 0; j <= nz; j++) {
      const z = -HALF_DEP + (2 * HALF_DEP * j) / nz;
      pos.push(x, wingY(x, z) - (bottom ? THICK : 0), z);
      uv.push(x / 14, z / 14);
    }
  }
  const up = (sign > 0) !== bottom;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const a = i * (nz + 1) + j;
      const b = a + 1;
      const c = a + nz + 1;
      const d = c + 1;
      if (up) idx.push(a, b, c, c, b, d);
      else idx.push(a, c, b, c, d, b);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Fascia strip around a wing between top and bottom surfaces. */
function wingEdge(sign: 1 | -1): THREE.BufferGeometry {
  const pts: [number, number][] = [];
  const n = 60;
  for (let i = 0; i <= n; i++) pts.push([sign * (BODY_HALF + ((HALF_LEN - BODY_HALF) * i) / n), HALF_DEP]);
  for (let j = 1; j <= 16; j++) pts.push([sign * HALF_LEN, HALF_DEP - (2 * HALF_DEP * j) / 16]);
  for (let i = n - 1; i >= 0; i--) pts.push([sign * (BODY_HALF + ((HALF_LEN - BODY_HALF) * i) / n), -HALF_DEP]);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let u = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x, z] = pts[k];
    if (k > 0) u += Math.hypot(x - pts[k - 1][0], z - pts[k - 1][1]);
    const y = wingY(x, z);
    pos.push(x, y + 0.3, z, x, y - THICK - 0.3, z);
    uv.push(u / 14, 0, u / 14, 0.25);
    if (k > 0) {
      const a = (k - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Local (x, z) points of everything at ground level or overhead: roof outline and columns (for clearance checks). */
export function civicOutline(): Vec2[] {
  const pts: Vec2[] = [];
  for (let x = -HALF_LEN; x <= HALF_LEN; x += 6) pts.push([x, HALF_DEP + 3], [x, -HALF_DEP]);
  for (let z = -HALF_DEP; z <= HALF_DEP; z += 6) pts.push([HALF_LEN, z], [-HALF_LEN, z]);
  return pts;
}

/**
 * Shenzhen Civic Center in local coordinates: long axis = x (~486 m), main
 * facade toward +z (south, onto 福中三路). Central tower block with the
 * undulating grid-shell "bird wing" roof over a round west hall and a square
 * east hall, paved forecourt under the canopy, warm light at night only.
 */
export function buildCivicCenter(mats: LandmarkMaterials): {
  object: THREE.Group;
  disposables: { dispose(): void }[];
  setNight(night: number): void;
} {
  const group = new THREE.Group();
  group.name = 'civic_center';

  const fb = new FacadeBuilder();
  // Central body: tall block with a stepped top and a drum.
  fb.addPrism(rectRing(0, 0, 1, 0, BODY_HALF, 40), 0, 66, [0.21, STYLE.civic, 8, 66], true, STYLE.roof);
  fb.addPrism(rectRing(0, -4, 1, 0, BODY_HALF * 0.72, 30), 66, 74, [0.44, STYLE.civic, 0, 74], true, STYLE.roof);
  fb.addPrism(circleRing(0, -4, 16, 24), 74, 82, [0.52, STYLE.civic, 0, 82], true, STYLE.roof);
  // West hall (round) and east hall (square) under the wings.
  fb.addPrism(circleRing(-162, 0, 50, 36), 0, 34, [0.63, STYLE.civic, 6, 34], true, STYLE.roof);
  fb.addPrism(rectRing(162, 0, 1, 0, 50, 44), 0, 34, [0.71, STYLE.civic, 6, 34], true, STYLE.roof);
  // Lower links between the halls and the body.
  fb.addPrism(rectRing(-80, -26, 1, 0, 36, 16), 0, 14, [0.12, STYLE.civic, 5, 14], true, STYLE.roof);
  fb.addPrism(rectRing(80, -26, 1, 0, 36, 16), 0, 14, [0.33, STYLE.civic, 5, 14], true, STYLE.roof);
  group.add(new THREE.Mesh(fb.build(), mats.glassNear));

  // Wing roof; the underside reads as light grey metal panels in daylight.
  const lattice = latticeTexture();
  const latticeDay = latticeTexture(['#9da1a6', '#8a8e94', '#e4e6e8', '#c2c5c9']);
  const roofTop = new THREE.MeshStandardMaterial({
    name: 'CivicRoofTop',
    map: lattice,
    color: '#8d939b',
    metalness: 0.55,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
  const roofUnder = new THREE.MeshStandardMaterial({
    name: 'CivicRoofUnder',
    map: lattice,
    color: '#9a948c',
    roughness: 0.7,
    emissive: '#ffb070',
    emissiveMap: lattice,
    emissiveIntensity: 0.55,
    side: THREE.DoubleSide,
  });
  const tops: THREE.BufferGeometry[] = [];
  const unders: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1] as const) {
    tops.push(wingSurface(sign, false), wingEdge(sign));
    unders.push(wingSurface(sign, true));
  }
  const topGeo = mergeGeometries(tops)!;
  const underGeo = mergeGeometries(unders)!;
  const roof = new THREE.Mesh(topGeo, roofTop);
  const under = new THREE.Mesh(underGeo, roofUnder);
  roof.castShadow = true;
  group.add(roof, under);

  // Columns carrying the wings, visible in the open bays.
  const cols: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    for (const x of [62, 88, 120, 205, 232]) {
      for (const z of [-54, 54]) {
        const h = wingY(sign * x, z) - THICK;
        const c = new THREE.CylinderGeometry(1.6, 2.2, h, 10);
        c.translate(sign * x, h / 2, z);
        cols.push(c);
      }
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(cols)!, mats.stone));

  // Paved forecourt under the canopy only: the street side belongs to the road's sidewalk and lawn.
  const plazaGeo = new THREE.PlaneGeometry(HALF_LEN * 2, HALF_DEP * 2 + 3).rotateX(-Math.PI / 2).translate(0, 0.06, 1.5);
  const plaza = new THREE.Mesh(plazaGeo, mats.plaza);
  plaza.receiveShadow = true;
  group.add(plaza);
  // Uplight strip along the canopy edge (lit at night only, see goldGlow).
  const strip = new THREE.BoxGeometry(HALF_LEN * 1.9, 0.4, 0.6).translate(0, 0.3, HALF_DEP + 2);
  group.add(new THREE.Mesh(strip, mats.goldGlow));

  const setNight = (night: number) => {
    roofUnder.emissiveIntensity = 0.55 * THREE.MathUtils.smoothstep(night, 0.08, 1);
    roofUnder.map = night > 0.5 ? lattice : latticeDay;
    roofUnder.color.set(night > 0.5 ? '#9a948c' : '#d8d4cc');
  };
  return { object: group, disposables: [lattice, latticeDay, roofTop, roofUnder], setNight };
}
