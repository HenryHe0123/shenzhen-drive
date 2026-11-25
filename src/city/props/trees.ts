import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { RGB } from '../road/builder';
import { canvasTexture, makeCanvas, mulberry32, type Rand } from '../road/textures';
import { PropGeo, type UVRect, type V3 } from './geo';
import { type InstanceItem, WindowedInstances } from './instances';
import type { Route } from '../../route/Route';
import { createImpostor, type Impostor, loadImpostor } from './treeImpostor';
import { BanyanLod, createNearMaterials, disposeNearModel, loadNearModel } from './treeNear';
import { treeSightCaps } from './treeSight';

/**
 * Foliage atlas (1024²): banyan leaf cluster (top-left), bougainvillea (top-right),
 * palm frond (left, third quarter), bark (left, bottom quarter), palm trunk rings
 * (right, third quarter). Alpha-tested.
 */
const LEAF: UVRect = [0.008, 0.508, 0.492, 0.992];
const FLOWER: UVRect = [0.508, 0.508, 0.992, 0.992];
const FROND: UVRect = [0.0, 0.25, 0.5, 0.5];
const BARK: UVRect = [0.0, 0.0, 0.5, 0.25];
const PALM_TRUNK: UVRect = [0.5, 0.25, 1.0, 0.5];

function leafClump(ctx: CanvasRenderingContext2D, rand: Rand, ox: number, oy: number, colors: (r: Rand, depth: number) => string, petals = false) {
  const cx = ox + 256;
  const cy = oy + 256;
  for (let c = 0; c < 70; c++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 185;
    const kx = cx + Math.cos(a) * r;
    const ky = cy + Math.sin(a) * r;
    const depth = (ky - (cy - 185)) / 370;
    for (let k = 0; k < 34; k++) {
      const la = rand() * Math.PI * 2;
      const lr = Math.sqrt(rand()) * 42;
      const x = kx + Math.cos(la) * lr;
      const y = ky + Math.sin(la) * lr;
      if (Math.hypot(x - cx, y - cy) > 238) continue;
      ctx.fillStyle = colors(rand, depth);
      ctx.beginPath();
      if (petals) ctx.arc(x, y, 3 + rand() * 3.5, 0, Math.PI * 2);
      else ctx.ellipse(x, y, 6 + rand() * 5, 2.6 + rand() * 2.2, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function foliageAtlas(aniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(1024, 1024);
  const rand = mulberry32(77);
  leafClump(ctx, rand, 0, 0, (r, d) => `hsl(${95 + r() * 30},${38 + r() * 22}%,${30 - d * 12 + r() * 12}%)`);
  leafClump(ctx, rand, 512, 0, (r, d) => `hsl(${100 + r() * 25},${35 + r() * 20}%,${22 - d * 8 + r() * 10}%)`);
  leafClump(ctx, rand, 512, 0, (r) => `hsl(${312 + r() * 22},${70 + r() * 25}%,${44 + r() * 18}%)`, true);

  // Palm frond: rib along the middle row, leaflets swept toward the tip.
  ctx.lineCap = 'round';
  for (let i = 0; i < 64; i++) {
    const x = 6 + i * 7.8;
    const t = x / 512;
    const L = 118 * Math.pow(Math.sin(Math.PI * Math.min(0.98, 0.08 + t)), 0.7);
    for (const sgn of [-1, 1]) {
      ctx.strokeStyle = `hsl(${88 + rand() * 20},${42 + rand() * 18}%,${26 + rand() * 14}%)`;
      ctx.lineWidth = 3.2 + rand() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, 640);
      ctx.quadraticCurveTo(x + L * 0.25, 640 + sgn * L * 0.6, x + L * 0.55, 640 + sgn * L * 0.95);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = 'hsl(70,35%,38%)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(2, 640);
  ctx.lineTo(510, 640);
  ctx.stroke();

  // Bark (opaque).
  ctx.fillStyle = '#5b5248';
  ctx.fillRect(0, 768, 512, 256);
  for (let k = 0; k < 900; k++) {
    ctx.fillStyle = `rgba(${30 + rand() * 60},${26 + rand() * 50},${20 + rand() * 40},0.5)`;
    ctx.fillRect(rand() * 512, 768 + rand() * 256, 2 + rand() * 3, 10 + rand() * 40);
  }
  // Palm trunk with growth rings (opaque).
  ctx.fillStyle = '#8f8a80';
  ctx.fillRect(512, 512, 512, 256);
  for (let y = 512; y < 768; y += 9 + rand() * 6) {
    ctx.fillStyle = `rgba(60,55,48,${0.35 + rand() * 0.3})`;
    ctx.fillRect(512, y, 512, 2);
  }
  for (let k = 0; k < 600; k++) {
    ctx.fillStyle = `rgba(${90 + rand() * 80},${85 + rand() * 70},${75 + rand() * 60},0.35)`;
    ctx.fillRect(512 + rand() * 512, 512 + rand() * 256, 6 + rand() * 20, 1 + rand() * 2);
  }
  const tex = canvasTexture(c, { repeat: false, aniso });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const v3 = new THREE.Vector3();
const t1 = new THREE.Vector3();
const t2 = new THREE.Vector3();

/** Leaf cards scattered in an ellipsoid; normals point away from the centre for soft volume shading. */
function cards(g: PropGeo, rand: Rand, n: number, c: V3, r: V3, size: [number, number], uv: UVRect, shadeLo: number) {
  const [u0, v0, u1, v1] = uv;
  for (let k = 0; k < n; k++) {
    let x: number;
    let y: number;
    let z: number;
    do {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      z = rand() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    const px = c[0] + x * r[0];
    const py = c[1] + y * r[1];
    const pz = c[2] + z * r[2];
    const sz = size[0] + rand() * (size[1] - size[0]);
    v3.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    t1.set(0, 1, 0).cross(v3);
    if (t1.lengthSq() < 1e-4) t1.set(1, 0, 0);
    t1.normalize();
    t2.copy(v3).cross(t1).normalize();
    const corners: V3[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => [px + (t1.x * a + t2.x * b) * sz * 0.5, py + (t1.y * a + t2.y * b) * sz * 0.5, pz + (t1.z * a + t2.z * b) * sz * 0.5]);
    const uvs = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    const idx = corners.map((p, i) => {
      const nx = (p[0] - c[0]) / (r[0] * r[0]);
      const ny = (p[1] - c[1]) / (r[1] * r[1]) + 0.25;
      const nz = (p[2] - c[2]) / (r[2] * r[2]);
      const l = Math.hypot(nx, ny, nz) || 1;
      const h = Math.min(1, Math.max(0, (p[1] - (c[1] - r[1])) / (2 * r[1])));
      const s = shadeLo + (1 - shadeLo) * h;
      const col: RGB = [s, s, s];
      return g.vertex(null, p[0], p[1], p[2], nx / l, ny / l, nz / l, uvs[i][0], uvs[i][1], col);
    });
    g.idx.push(idx[0], idx[1], idx[2], idx[0], idx[2], idx[3]);
  }
}

/** Broad banyan-like street tree, ~7 m tall, canopy radius ~2.4 m; fallback when the impostor atlas is missing. */
export function banyanGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  const rand = mulberry32(5);
  const barkCol: RGB = [0.9, 0.85, 0.8];
  g.cylinder(null, [0, 0, 0], [0.08, 3.1, 0.04], 0.3, 0.19, 8, barkCol, BARK);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + rand() * 0.6;
    g.cylinder(null, [0.06, 2.7, 0.03], [Math.cos(a) * 1.3, 3.9 + rand() * 0.5, Math.sin(a) * 1.3], 0.13, 0.05, 5, barkCol, BARK);
  }
  cards(g, rand, 34, [0, 4.6, 0], [2.3, 1.45, 2.3], [1.9, 2.7], LEAF, 0.45);
  return g.geometry();
}

/** Royal palm, ~11 m tall. */
export function palmGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  const rand = mulberry32(9);
  const H = 9.4;
  const segs = 4;
  const trunkCol: RGB = [1, 1, 1];
  const [tu0, tv0, tu1, tv1] = PALM_TRUNK;
  for (let i = 0; i < segs; i++) {
    const y0 = (H * i) / segs;
    const y1 = (H * (i + 1)) / segs;
    const x0 = 0.35 * (y0 / H) ** 2;
    const x1 = 0.35 * (y1 / H) ** 2;
    const r0 = 0.25 - (0.08 * i) / segs + (i === 0 ? 0.06 : 0);
    const r1 = 0.25 - (0.08 * (i + 1)) / segs;
    g.cylinder(null, [x0, y0, 0], [x1, y1, 0], r0, r1, 6, trunkCol, [tu0, tv0 + ((tv1 - tv0) * i) / segs, tu1, tv0 + ((tv1 - tv0) * (i + 1)) / segs]);
  }
  const crown: V3 = [0.37, H + 1.4, 0];
  g.cylinder(null, [0.35, H, 0], crown, 0.18, 0.16, 6, [0.5, 0.78, 0.42], PALM_TRUNK);

  const [fu0, fv0, fu1, fv1] = FROND;
  const fvm = (fv0 + fv1) / 2;
  const nF = 12;
  for (let i = 0; i < nF; i++) {
    const phi = (i / nF) * Math.PI * 2 + rand() * 0.3;
    const young = i % 4 === 0;
    const elev = young ? 1.0 + rand() * 0.25 : 0.35 + rand() * 0.35;
    const L = young ? 2.6 : 3.4 + rand() * 0.6;
    const hx = Math.cos(phi);
    const hz = Math.sin(phi);
    const sx = -hz;
    const sz = hx;
    let prev: number[] | null = null;
    const steps = 4;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const reach = L * t * Math.cos(elev);
      const px = crown[0] + hx * reach;
      const pz = crown[2] + hz * reach;
      const py = crown[1] + L * (Math.sin(elev) * t - (young ? 0.25 : 0.75) * t * t);
      const w = 1.25 * Math.sin(Math.PI * Math.min(0.97, 0.12 + t * 0.85));
      const drop = 0.28 * w;
      const u = fu0 + (fu1 - fu0) * t;
      const shade = 0.75 + 0.25 * t;
      const col: RGB = [shade, shade, shade * 0.95];
      const nx = hx * 0.3;
      const nz = hz * 0.3;
      const l = g.vertex(null, px - sx * w * 0.5, py - drop, pz - sz * w * 0.5, nx, 1, nz, u, fv0, col);
      const m = g.vertex(null, px, py, pz, nx, 1, nz, u, fvm, col);
      const r = g.vertex(null, px + sx * w * 0.5, py - drop, pz + sz * w * 0.5, nx, 1, nz, u, fv1, col);
      if (prev) {
        const [pl, pm, pr] = prev;
        g.idx.push(pl, l, m, pl, m, pm, pm, m, r, pm, r, pr);
      }
      prev = [l, m, r];
    }
  }
  return g.geometry();
}

/** Low flowering bougainvillea clump, ~1.1 m tall. */
export function shrubGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  const rand = mulberry32(13);
  cards(g, rand, 10, [0, 0.55, 0], [0.85, 0.5, 0.85], [0.8, 1.2], FLOWER, 0.55);
  return g.geometry();
}

/**
 * Placement scales banyans by 0.9–1.7 (sized for the small procedural tree); the impostor's canopy is
 * far wider, so heights grow as scale^0.6 (≈ 0.94–1.37 × treeBanyanHeight) to keep the skyline visible.
 */
const BANYAN_SCALE_EXP = 0.6;
/** Procedural banyan height (m) at scale 1: sight-line caps never shrink an impostor below it. */
const BANYAN_FALLBACK_HEIGHT = 7;

/**
 * Street banyans (小叶榕) as camera-facing impostors baked from the Chinese banyan model
 * (scripts/bake_banyan_impostor.mjs): one draw call plus one shadow draw for every banyan, canopy
 * shaded by the scene lights through baked normals and sky visibility. Banyans on landmark sight
 * lines are capped (treeSight.ts). Falls back to the procedural banyan with `fallback` if the atlas
 * can't be loaded.
 */
export async function banyanInstances(
  items: InstanceItem[],
  ahead: number,
  behind: number,
  fallback: THREE.Material,
  aniso: number,
  route: Route,
): Promise<WindowedInstances> {
  let imp: Impostor;
  let canopy: { radius: number; base: number };
  let dataHeight: number;
  const base = import.meta.env.BASE_URL;
  const nearLoad = loadNearModel(`${base}${CONFIG.city.treeNearUrl}`, aniso).catch((e: unknown) => {
    console.warn('[trees] near banyan mesh unavailable, impostors only:', e);
    return null;
  });
  const shading = {
    alphaTest: 0.5,
    mipAlphaGain: 0.25,
    aoIndirect: 0.55,
    aoDirect: 0.25,
    wrap: 0.8,
    translucency: 0.45,
    roughness: 0.9,
    shadowReach: 16,
    lampColor: CONFIG.city.lampColor,
    lampGlow: 0.3,
  };
  try {
    const { data, color, normal } = await loadImpostor(`${base}${CONFIG.city.treeImpostorUrl}`, aniso);
    canopy = { radius: data.canopyRadius / data.height, base: data.canopyBottom / data.height };
    dataHeight = data.height;
    imp = createImpostor(data, color, normal, { height: CONFIG.city.treeBanyanHeight, ...shading });
  } catch (e) {
    console.warn('[trees] banyan impostor unavailable, using procedural banyans:', e);
    nearLoad.then((m) => m && disposeNearModel(m));
    return new WindowedInstances(banyanGeometry(), fallback, items, ahead, behind);
  }
  const H = CONFIG.city.treeBanyanHeight;
  const scales = items.map((it) => it.m.getMaxScaleOnAxis());
  const trees = items.map((it, i) => {
    const h = H * scales[i] ** BANYAN_SCALE_EXP;
    return { x: it.m.elements[12], z: it.m.elements[14], h, r: h * canopy.radius };
  });
  const caps = treeSightCaps(route, trees, CONFIG.city.treeSightKeep, canopy.base);
  const k = new THREE.Vector3();
  const sized = items.map((it, i) => {
    const s = scales[i];
    const h = Math.min(trees[i].h, Math.max(caps[i], BANYAN_FALLBACK_HEIGHT * s));
    return { ...it, m: it.m.clone().scale(k.setScalar(h / (H * s))) };
  });
  const { sunDir } = imp;
  const near = await nearLoad;
  let w: WindowedInstances;
  if (near) {
    const { materials, depthMaterial } = createNearMaterials(near, CONFIG.city.treeBanyanHeight, { sunDir, foliageGain: 0.9, ...shading });
    const { treeNearCount: count, treeNearFull: full, treeNearFar: far } = CONFIG.city;
    const geometry = near.geometry;
    w = new BanyanLod(imp.geometry, imp.material, sized, ahead, behind, { geometry, materials, depthMaterial, scale: CONFIG.city.treeBanyanHeight / dataHeight }, { count, full, far });
    imp.geometry.addEventListener('dispose', () => {
      disposeNearModel(near);
      for (const m of [...materials, depthMaterial]) m.dispose();
    });
  } else {
    w = new WindowedInstances(imp.geometry, imp.material, sized, ahead, behind);
  }
  w.mesh.customDepthMaterial = imp.depthMaterial;
  w.mesh.receiveShadow = true;
  const target = new THREE.Vector3();
  let sun: THREE.DirectionalLight | null | undefined;
  w.mesh.onBeforeRender = (_r, scene, camera) => {
    if (w instanceof BanyanLod) w.setCamera(camera);
    if (sun === undefined) {
      sun = null;
      scene.traverse((o) => {
        if (!sun && (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) sun = o as THREE.DirectionalLight;
      });
    }
    if (sun) sunDir.setFromMatrixPosition(sun.matrixWorld).sub(target.setFromMatrixPosition(sun.target.matrixWorld)).normalize();
  };
  return w;
}

export function foliageMaterial(atlas: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: atlas,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
  });
}
