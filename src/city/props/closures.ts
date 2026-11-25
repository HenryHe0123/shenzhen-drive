import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { RGB } from '../road/builder';
import type { RoadLayout } from '../road/layout';
import { canvasTexture, makeCanvas } from '../road/textures';
import { placeMatrix, PropGeo, type UVRect } from './geo';
import { type InstanceItem, WindowedInstances } from './instances';
import { signPanel } from './roadSigns';
import { fitText } from './signs';

/** One closed cross-street mouth on one side of the carriageway. */
export interface ClosureRun {
  /** Cross street centre and name. */
  s: number;
  name: string;
  side: 'right' | 'left';
  /** Extent along the route. */
  s0: number;
  s1: number;
  /** Lateral position of the barrier centre line (just outside the drivable boundary). */
  d: number;
}

/** Water-filled barrier (水马): width across the road, length along it, height (m). */
const BARRIER = { w: 0.44, l: 1.45, h: 0.8 };
/** Median gap beyond the cross street half width on the left (matches road/layout gaps.median). */
const MEDIAN_GAP_EXTRA = 7;
const RED = new THREE.Color(0.78, 0.07, 0.06);
const WHITE = new THREE.Color(0.92, 0.92, 0.9);

/**
 * Barrier runs along the drivable boundary across every drawn cross street (layout.cross, which
 * already leaves out the route's own turns): on the right across the side street's mouth, on the
 * left across the median opening. The barrier's inner face sits outside [dMin, dMax], in line
 * with the curbs, so the car stops on the collision boundary just before it.
 */
export function closureRuns(l: RoadLayout): ClosureRun[] {
  const { route } = l;
  const off = 0.3 + BARRIER.w / 2;
  const runs: ClosureRun[] = [];
  for (const c of l.cross) {
    runs.push({ s: c.s, name: c.name, side: 'right', s0: c.s - c.hw, s1: c.s + c.hw, d: route.dMax + off });
    const e = c.hw + MEDIAN_GAP_EXTRA;
    runs.push({ s: c.s, name: c.name, side: 'left', s0: c.s - e, s1: c.s + e, d: route.dMin - off });
  }
  return runs;
}

/** Trapezoid barrier profile extruded along local z, centred on the origin, standing on y = 0. */
function barrierGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  const { w, l, h } = BARRIER;
  const prof: [number, number][] = [
    [-w / 2, 0],
    [w / 2, 0],
    [w / 2, 0.14],
    [w * 0.36, 0.24],
    [w * 0.24, h - 0.08],
    [w * 0.16, h],
    [-w * 0.16, h],
    [-w * 0.24, h - 0.08],
    [-w * 0.36, 0.24],
    [-w / 2, 0.14],
  ];
  const col: RGB = [1, 1, 1];
  const z0 = -l / 2;
  const z1 = l / 2;
  for (let i = 1; i < prof.length; i++) {
    const [ax, ay] = prof[i];
    const [bx, by] = prof[(i + 1) % prof.length];
    g.quad(null, [ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1], [0, 0, 1, 1], col);
  }
  for (const [z, sgn] of [
    [z1, 1],
    [z0, -1],
  ] as const) {
    const base = g.vertexCount;
    for (const [x, y] of prof) g.vertex(null, x, y, z, 0, 0, sgn, 0, 0, col);
    for (let i = 1; i < prof.length - 1; i++) {
      if (sgn > 0) g.idx.push(base, base + i, base + i + 1);
      else g.idx.push(base, base + i + 1, base + i);
    }
  }
  return g.geometry();
}

const SIGN_SIZE = 0.6;
const PLATE = { w: 0.62, h: 0.22 };
const SIGN_Y = 1.75;
const PLATE_Y = SIGN_Y - SIGN_SIZE / 2 - 0.05 - PLATE.h / 2;

/** 禁止驶入 face (red disc, white bar) beside a white 禁止驶入 plate, in one small texture. */
function signTexture(aniso: number): { tex: THREE.CanvasTexture; disc: UVRect; plate: UVRect } {
  const W = 512;
  const H = 256;
  const [canvas, ctx] = makeCanvas(W, H);
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, W, H);
  const r = 120;
  ctx.beginPath();
  ctx.arc(128, 128, r, 0, Math.PI * 2);
  ctx.fillStyle = '#c4121f';
  ctx.fill();
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(128 - r * 0.72, 128 - r * 0.16, r * 1.44, r * 0.32);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 6;
  ctx.strokeRect(264, 72, 240, 84);
  ctx.fillStyle = '#111111';
  fitText(ctx, '禁止驶入', 384, 118, 220, 60, 700);
  const tex = canvasTexture(canvas, { repeat: false, aniso });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const uv = (x0: number, y0: number, x1: number, y1: number): UVRect => [x0 / W, 1 - y1 / H, x1 / W, 1 - y0 / H];
  return { tex, disc: uv(8, 8, 248, 248), plate: uv(264, 72, 504, 156) };
}

/** Concrete planter with a clipped shrub; the sign post rises from it. Local +z faces traffic. */
function fixtureGeometry(faces: PropGeo, uv: { disc: UVRect; plate: UVRect }): THREE.BufferGeometry {
  const g = new PropGeo();
  const CONCRETE: RGB = [0.62, 0.61, 0.58];
  const SOIL: RGB = [0.22, 0.17, 0.12];
  const LEAF: RGB = [0.16, 0.36, 0.12];
  const LEAF2: RGB = [0.22, 0.45, 0.15];
  const GALV: RGB = [0.5, 0.52, 0.55];
  g.box(null, 0, 0.25, 0, 0.9, 0.5, 1.3, CONCRETE);
  g.box(null, 0, 0.51, 0, 0.78, 0.02, 1.18, SOIL);
  g.box(null, 0, 0.68, 0.25, 0.7, 0.34, 0.6, LEAF);
  g.box(null, 0, 0.64, -0.3, 0.66, 0.26, 0.5, LEAF2);
  g.cylinder(null, [0, 0.5, 0.05], [0, SIGN_Y + 0.05, 0.05], 0.035, 0.03, 8, GALV);
  const m = new THREE.Matrix4();
  signPanel(faces, g, m, 0, SIGN_Y, 0.1, SIGN_SIZE, false, uv.disc);
  const { w, h } = PLATE;
  faces.quad(m, [-w / 2, PLATE_Y - h / 2, 0.1], [w / 2, PLATE_Y - h / 2, 0.1], [w / 2, PLATE_Y + h / 2, 0.1], [-w / 2, PLATE_Y + h / 2, 0.1], uv.plate, [1, 1, 1]);
  g.box(null, 0, PLATE_Y, 0.08, w, h, 0.02, GALV);
  return g.geometry();
}

export interface Closures {
  readonly root: THREE.Group;
  readonly runs: ClosureRun[];
  update(s: number): void;
  dispose(): void;
}

/** Instanced side-street closures: barriers, planter + sign fixtures and sign faces (3 draw calls, +1 shadow pass for the barriers). */
export function createClosures(l: RoadLayout, aniso: number): Closures {
  const { route } = l;
  const C = CONFIG.city;
  const runs = closureRuns(l);
  const P = { x: 0, z: 0 };
  const place = (s: number, d: number, yawOff = 0) => {
    const p = route.pointAt(s, d, P);
    return placeMatrix(p.x, 0, p.z, route.headingAt(route.clampS(s)) + yawOff);
  };

  const barriers: InstanceItem[] = [];
  const fixtures: InstanceItem[] = [];
  for (const r of runs) {
    const n = Math.max(1, Math.round((r.s1 - r.s0) / C.closureBarrierPitch));
    const pitch = (r.s1 - r.s0) / n;
    for (let k = 0; k < n; k++) {
      const s = r.s0 + (k + 0.5) * pitch;
      barriers.push({ s, m: place(s, r.d), c: k % 2 ? WHITE : RED });
    }
    // Behind the barriers at mid-mouth, turned toward approaching traffic.
    const right = r.side === 'right';
    const dSign = r.d + (right ? 1 : -1) * C.closureSignSetback;
    const yaw = ((right ? -1 : 1) * C.closureSignAngleDeg * Math.PI) / 180;
    fixtures.push({ s: r.s, m: place(r.s, dSign, yaw) });
  }

  const { tex, disc, plate } = signTexture(aniso);
  const faces = new PropGeo();
  const fixtureGeo = fixtureGeometry(faces, { disc, plate });
  const barrierMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  const fixtureMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1 });
  const faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0 });
  const ahead = C.closureViewAhead;
  const behind = C.propViewBehind;
  const sets = [
    new WindowedInstances(barrierGeometry(), barrierMat, barriers, ahead, behind),
    new WindowedInstances(fixtureGeo, fixtureMat, fixtures, ahead, behind),
    new WindowedInstances(faces.geometry(), faceMat, fixtures, ahead, behind),
  ];
  const root = new THREE.Group();
  root.name = 'closures';
  ['closure-barriers', 'closure-fixtures', 'closure-signs'].forEach((name, i) => {
    const mesh = sets[i].mesh;
    mesh.name = name;
    mesh.castShadow = i === 0;
    mesh.receiveShadow = true;
    root.add(mesh);
  });
  for (const w of sets) w.update(0);

  return {
    root,
    runs,
    update(s: number) {
      for (const w of sets) w.update(s);
    },
    dispose() {
      for (const w of sets) w.mesh.geometry.dispose();
      for (const m of [barrierMat, fixtureMat, faceMat]) m.dispose();
      tex.dispose();
    },
  };
}
