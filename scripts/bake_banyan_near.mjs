#!/usr/bin/env node
// Bakes the near-LOD street banyan drawn for the trees closest to the car (src/city/props/treeNear.ts) from the
// Chinese banyan model (Sketchfab, Valery.Li, CC BY 4.0). Same tree frame, pruning, colour grade and bent foliage
// normals as the impostor (scripts/bake_banyan_impostor.mjs) so the two cross-fade without a visible change.
//
//   node scripts/bake_banyan_near.mjs [--src <glb>] [--out public/models/trees] [--debug <dir>]
//
// 1. Reads the GLB with gltf-transform, bakes node transforms, puts the trunk base at the origin (impostor frame).
// 2. Prunes aerial roots like the impostor, simplifies each part with meshoptimizer (leaf cards keep their outline,
//    only interior grid vertices go).
// 3. Bends foliage normals toward the canopy ellipsoid, bakes sky visibility per vertex (rays through a voxel
//    density grid of the foliage, scaled to the impostor's mean) and scales to the impostor's 12 m height.
// 4. Packs leaves, twigs, vines and branch caps into one alpha-tested atlas (alpha remapped so every source cutoff
//    lands on 0.5) and writes banyan_near.glb (geometry only), banyan_near_foliage.webp, banyan_near_bark.webp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const v = process.argv[i + 1];
  args[a.slice(2)] = v && !v.startsWith('--') ? (i++, v) : true;
}
const SRC = path.resolve(ROOT, args.src ?? 'data-raw/assets/sketchfab/chinese_banyan_ficus_microcarpa.glb');
const OUT = path.resolve(ROOT, args.out ?? 'public/models/trees');
const IMPOSTOR = path.resolve(ROOT, 'public/textures/trees/banyan.json');
const DEBUG = args.debug ? path.resolve(ROOT, args.debug) : null;

/** Must match the impostor bake (scripts/bake_banyan_impostor.mjs CONFIG). */
const SHARED = {
  bendLeaf: 0.7,
  bendTwig: 0.6,
  bendVine: 0.35,
  bendUp: 0.15,
  vineCutLo: 0.45,
  vineCutHi: 0.9,
  barkCutRadius: 2.6,
  /** Bark xz scale at the ground, easing back to 1 between these fractions of the canopy base height. */
  trunkSlim: 0.65,
  trunkSlimTop: [0.35, 1.0],
  gradeLeaf: [0.92, 1.18, 0.78],
  gradeBark: [0.8, 0.78, 0.76],
  groundNode: 'ChineseBanyan_Med',
};
const CONFIG = {
  /** Target triangles per part (model is ~111k). Leaf cards keep their count, only their interior grid goes. */
  target: { leaf: 3800, twig: 500, vine: 1000, cap: 120, bark: 1900 },
  /** Fraction of vine strands (after the pruning cut) kept. */
  vineKeep: 1,
  /** Leaf card scale about its centroid. */
  cardGrow: 1.3,
  atlasPx: 1024,
  barkPx: [256, 512],
  /** Voxel grid cell (model m) and rays per vertex for the sky-visibility bake. */
  aoCell: 0.6,
  aoRays: 48,
};

const CREDIT = {
  title: 'Chinese Banyan (Ficus Microcarpa)',
  author: 'Valery.Li',
  url: 'https://sketchfab.com/3d-models/chinese-banyan-ficus-microcarpa-2a0dbcdf8f5d48f5ad79987c7a8170ce',
  license: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
  changes:
    'Decimated to a near-LOD mesh (aerial roots pruned, trunk slimmed below the canopy, bark and leaf cards simplified with meshoptimizer, leaf cards enlarged), foliage normals bent toward the canopy, per-vertex sky visibility baked, leaf/twig/vine/cap textures colour-graded and packed into one atlas.',
};

const t0 = Date.now();
await MeshoptSimplifier.ready;
const imp = JSON.parse(fs.readFileSync(IMPOSTOR, 'utf8'));

// ---------------- Source parts in the impostor's tree frame ----------------
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);
const root = doc.getRoot();
const groundNode = root.listNodes().find((n) => n.getName() === SHARED.groundNode);
const groundY = groundNode.getWorldMatrix()[13];
const kindOf = (name) => (/Leaves/i.test(name) ? 'leaf' : /Branches/i.test(name) ? 'twig' : /Vines/i.test(name) ? 'vine' : /Cap/i.test(name) ? 'cap' : 'bark');

const parts = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const sg = mat.getExtension('KHR_materials_pbrSpecularGlossiness');
    const P = prim.getAttribute('POSITION');
    const N = prim.getAttribute('NORMAL');
    const T = prim.getAttribute('TEXCOORD_0');
    const n = P.getCount();
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const p = [0, 0, 0];
    const q = [0, 0, 0];
    const t = [0, 0];
    for (let i = 0; i < n; i++) {
      P.getElement(i, p);
      N.getElement(i, q);
      T.getElement(i, t);
      for (let r = 0; r < 3; r++) {
        pos[i * 3 + r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
        nor[i * 3 + r] = m[r] * q[0] + m[4 + r] * q[1] + m[8 + r] * q[2];
      }
      const l = Math.hypot(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]) || 1;
      for (let r = 0; r < 3; r++) nor[i * 3 + r] /= l;
      uv[i * 2] = t[0];
      uv[i * 2 + 1] = t[1];
    }
    const name = mat.getName();
    parts.push({
      name,
      kind: kindOf(name),
      pos,
      nor,
      uv,
      idx: Uint32Array.from(prim.getIndices().getArray()),
      image: sg.getDiffuseTexture().getImage(),
      cutoff: mat.getAlphaMode() === 'MASK' ? mat.getAlphaCutoff() : 0,
    });
  }
}

// Trunk axis: centroid of the bark between 0.3 m and 2.0 m above the ground (as the impostor bake).
let sx = 0;
let sz = 0;
let sn = 0;
for (const p of parts.filter((q) => q.kind === 'bark')) {
  for (let i = 0; i < p.pos.length; i += 3) {
    const y = p.pos[i + 1] - groundY;
    if (y > 0.3 && y < 2.0) {
      sx += p.pos[i];
      sz += p.pos[i + 2];
      sn++;
    }
  }
}
const axis = [sx / sn, groundY, sz / sn];
for (const p of parts) for (let i = 0; i < p.pos.length; i += 3) for (let r = 0; r < 3; r++) p.pos[i + r] -= axis[r];

let top = 0;
const leafMin = [Infinity, Infinity, Infinity];
const leafMax = [-Infinity, -Infinity, -Infinity];
const leafYs = [];
for (const p of parts) {
  for (let i = 0; i < p.pos.length; i += 3) {
    const y = p.pos[i + 1];
    if (y < -0.05) continue;
    top = Math.max(top, y);
    if (p.kind !== 'leaf') continue;
    for (let r = 0; r < 3; r++) {
      leafMin[r] = Math.min(leafMin[r], p.pos[i + r]);
      leafMax[r] = Math.max(leafMax[r], p.pos[i + r]);
    }
    leafYs.push(y);
  }
}
leafYs.sort((a, b) => a - b);
const canopyBottom = leafYs[Math.floor(leafYs.length * 0.02)];
const cC = leafMin.map((v, r) => (v + leafMax[r]) / 2);
const cR = leafMin.map((v, r) => (leafMax[r] - v) / 2);
cR[0] = cR[2] = Math.max(cR[0], cR[2]);
// Slimmer trunk (street banyans are younger than the source tree): bark pulled toward the axis below the canopy.
const slim = (y) => {
  const t = Math.min(1, Math.max(0, (y - canopyBottom * SHARED.trunkSlimTop[0]) / (canopyBottom * (SHARED.trunkSlimTop[1] - SHARED.trunkSlimTop[0]))));
  return SHARED.trunkSlim + (1 - SHARED.trunkSlim) * t * t * (3 - 2 * t);
};
let trunkR = 0;
for (const p of parts.filter((q) => q.kind === 'bark' || q.kind === 'cap')) {
  for (let i = 0; i < p.pos.length; i += 3) {
    const r = Math.hypot(p.pos[i], p.pos[i + 2]);
    if (p.kind === 'bark' && p.pos[i + 1] > 0.8 && p.pos[i + 1] < 1.2 && r < SHARED.barkCutRadius) trunkR = Math.max(trunkR, r);
    const f = slim(p.pos[i + 1]);
    p.pos[i] *= f;
    p.pos[i + 2] *= f;
  }
}
const scale = imp.height / top;
console.log(`[near] trunk radius at 1 m: ${trunkR.toFixed(2)} model m (${(trunkR * scale).toFixed(2)} m at ${imp.height} m), slimmed ×${SHARED.trunkSlim}`);
console.log(`[near] top ${top.toFixed(2)} m, canopy ${canopyBottom.toFixed(2)}..${leafMax[1].toFixed(2)}, scale ${scale.toFixed(4)} (impostor ${imp.model.scale})`);

// ---------------- Pruning (aerial roots end 45–90 % of the way down to the canopy base) ----------------
const cutLo = canopyBottom * SHARED.vineCutLo;
const cutHi = canopyBottom * SHARED.vineCutHi;
const fract = (x) => x - Math.floor(x);
const cellHash = (x, z) => fract(Math.sin(Math.floor(x * 2) * 12.9898 + Math.floor(z * 2) * 78.233) * 43758.5453);
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
for (const p of parts) {
  const r0 = p.kind === 'vine' ? -1 : p.kind === 'bark' || p.kind === 'cap' ? SHARED.barkCutRadius : null;
  if (r0 === null) continue;
  const keep = [];
  for (let i = 0; i < p.idx.length; i += 3) {
    let x = 0;
    let y = Infinity;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = p.idx[i + k] * 3;
      x += p.pos[v] / 3;
      z += p.pos[v + 2] / 3;
      y = Math.min(y, p.pos[v + 1]);
    }
    const cut = r0 < 0 || Math.hypot(x, z) > r0 * slim(y) ? cutLo + (cutHi - cutLo) * cellHash(x, z) : -1;
    if (y < cut) continue;
    if (p.kind === 'vine' && rand() > CONFIG.vineKeep) continue;
    keep.push(p.idx[i], p.idx[i + 1], p.idx[i + 2]);
  }
  p.idx = Uint32Array.from(keep);
}

// ---------------- Simplification ----------------
function compact(p) {
  const map = new Int32Array(p.pos.length / 3).fill(-1);
  let n = 0;
  for (const v of p.idx) if (map[v] < 0) map[v] = n++;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let v = 0; v < map.length; v++) {
    const j = map[v];
    if (j < 0) continue;
    pos.set(p.pos.subarray(v * 3, v * 3 + 3), j * 3);
    nor.set(p.nor.subarray(v * 3, v * 3 + 3), j * 3);
    uv.set(p.uv.subarray(v * 2, v * 2 + 2), j * 2);
  }
  Object.assign(p, { pos, nor, uv, idx: p.idx.map((v) => map[v]) });
}
const stats = {};
for (const p of parts) {
  const before = p.idx.length / 3;
  compact(p);
  const target = CONFIG.target[p.kind];
  const share = target * (before / parts.filter((q) => q.kind === p.kind).reduce((a, q) => a + q.idx.length / 3, 0));
  if (before > share) {
    const attrs = new Float32Array((p.pos.length / 3) * 5);
    for (let v = 0; v < p.pos.length / 3; v++) {
      attrs.set(p.nor.subarray(v * 3, v * 3 + 3), v * 5);
      attrs.set(p.uv.subarray(v * 2, v * 2 + 2), v * 5 + 3);
    }
    // Leaf / twig cards: UV-preserving collapses inside each card, borders free so cards flatten; bark: prune slivers.
    const card = p.kind !== 'bark' && p.kind !== 'cap';
    const weights = card ? [0.05, 0.05, 0.05, 1.5, 1.5] : [0.3, 0.3, 0.3, 0.2, 0.2];
    const [idx] = MeshoptSimplifier.simplifyWithAttributes(p.idx, p.pos, 3, attrs, 5, weights, null, Math.floor(share) * 3, 1, card ? [] : ['Prune']);
    p.idx = idx;
    compact(p);
  }
  stats[p.name] = `${before} → ${p.idx.length / 3}`;
}
console.log('[near] simplified', stats);

// Simplified leaf cards lose their curl and read thinner than the supersampled impostor: grow each card about its centroid.
for (const p of parts.filter((q) => q.kind === 'leaf')) {
  const n = p.pos.length / 3;
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (par[x] !== x) x = par[x] = par[par[x]];
    return x;
  };
  for (let i = 0; i < p.idx.length; i += 3) {
    const r = find(p.idx[i]);
    par[find(p.idx[i + 1])] = r;
    par[find(p.idx[i + 2])] = r;
  }
  const sum = new Float64Array(n * 4);
  for (let v = 0; v < n; v++) {
    const r = find(v);
    for (let k = 0; k < 3; k++) sum[r * 4 + k] += p.pos[v * 3 + k];
    sum[r * 4 + 3]++;
  }
  for (let v = 0; v < n; v++) {
    const r = find(v);
    for (let k = 0; k < 3; k++) {
      const c = sum[r * 4 + k] / sum[r * 4 + 3];
      p.pos[v * 3 + k] = c + (p.pos[v * 3 + k] - c) * CONFIG.cardGrow;
    }
  }
}

// ---------------- Bent foliage normals (as the impostor bake) ----------------
const bend = { leaf: SHARED.bendLeaf, twig: SHARED.bendTwig, vine: SHARED.bendVine };
for (const p of parts) {
  const b = bend[p.kind];
  if (b === undefined) continue;
  for (let i = 0; i < p.pos.length; i += 3) {
    const S = [0, 1, 2].map((r) => (p.pos[i + r] - cC[r]) / (cR[r] * cR[r]));
    let l = Math.hypot(...S);
    S[1] = S[1] / l + SHARED.bendUp;
    S[0] /= l;
    S[2] /= l;
    l = Math.hypot(...S);
    const Nv = [p.nor[i], p.nor[i + 1], p.nor[i + 2]];
    const d = Nv[0] * S[0] + Nv[1] * S[1] + Nv[2] * S[2];
    const sg = d < 0 ? -1 : 1;
    const out = [0, 1, 2].map((r) => Nv[r] * sg * (1 - b) + (S[r] / l) * b);
    const lo = Math.hypot(...out) || 1;
    for (let r = 0; r < 3; r++) p.nor[i + r] = out[r] / lo;
  }
}

// ---------------- Sky visibility: rays through a voxel grid of foliage + bark coverage ----------------
const decoded = new Map();
async function decode(image) {
  if (!decoded.has(image)) {
    const { data, info } = await sharp(Buffer.from(image)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    decoded.set(image, { data, w: info.width, h: info.height });
  }
  return decoded.get(image);
}
const cell = CONFIG.aoCell;
const g0 = [-cR[0] - 2, -0.5, -cR[2] - 2];
const gn = [Math.ceil((2 * cR[0] + 4) / cell), Math.ceil((top + 2) / cell), Math.ceil((2 * cR[2] + 4) / cell)];
const grid = new Float32Array(gn[0] * gn[1] * gn[2]);
const gi = (x, y, z) => {
  const ix = Math.floor((x - g0[0]) / cell);
  const iy = Math.floor((y - g0[1]) / cell);
  const iz = Math.floor((z - g0[2]) / cell);
  return ix < 0 || iy < 0 || iz < 0 || ix >= gn[0] || iy >= gn[1] || iz >= gn[2] ? -1 : (iz * gn[1] + iy) * gn[0] + ix;
};
// Splat area × mean coverage of every source triangle (sampled at its centroid) into its cell.
for (const p of parts) {
  const tex = await decode(p.image);
  for (let i = 0; i < p.idx.length; i += 3) {
    const [a, b, c] = [p.idx[i] * 3, p.idx[i + 1] * 3, p.idx[i + 2] * 3];
    const e1 = [0, 1, 2].map((r) => p.pos[b + r] - p.pos[a + r]);
    const e2 = [0, 1, 2].map((r) => p.pos[c + r] - p.pos[a + r]);
    const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    let alpha = 1;
    if (p.cutoff > 0) {
      const u = (p.uv[(a / 3) * 2] + p.uv[(b / 3) * 2] + p.uv[(c / 3) * 2]) / 3;
      const v = (p.uv[(a / 3) * 2 + 1] + p.uv[(b / 3) * 2 + 1] + p.uv[(c / 3) * 2 + 1]) / 3;
      const px = Math.min(tex.w - 1, Math.max(0, Math.floor(fract(u) * tex.w)));
      const py = Math.min(tex.h - 1, Math.max(0, Math.floor(fract(v) * tex.h)));
      alpha = tex.data[(py * tex.w + px) * 4 + 3] / 255 > p.cutoff ? 0.8 : 0.25;
    }
    const k = gi((p.pos[a] + p.pos[b] + p.pos[c]) / 3, (p.pos[a + 1] + p.pos[b + 1] + p.pos[c + 1]) / 3, (p.pos[a + 2] + p.pos[b + 2] + p.pos[c + 2]) / 3);
    if (k >= 0) grid[k] += (area * alpha) / (cell * cell * cell);
  }
}
const dirs = [];
for (let j = 0; j < CONFIG.aoRays; j++) {
  const y = 1 - (j + 0.5) / CONFIG.aoRays;
  const r = Math.sqrt(1 - y * y);
  const phi = j * Math.PI * (3 - Math.sqrt(5));
  dirs.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
}
/** Cosine-weighted transmittance over the upper hemisphere (rays start one cell out along the normal). */
function skyVis(p, n, foliage) {
  let acc = 0;
  let wsum = 0;
  for (const d of dirs) {
    const w = foliage ? 0.6 + 0.4 * d[1] : Math.max(0, d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
    if (w <= 0) continue;
    let tau = 0;
    for (let s = cell * 0.75; s < 24; s += cell * 0.75) {
      const k = gi(p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s);
      if (k < 0) break;
      tau += grid[k] * cell * 0.75;
    }
    acc += w * Math.exp(-tau);
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 1;
}
for (const p of parts) {
  const foliage = p.kind === 'leaf' || p.kind === 'twig' || p.kind === 'vine';
  p.ao = new Float32Array(p.pos.length / 3);
  for (let v = 0; v < p.ao.length; v++) {
    const pp = [p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]];
    const n = [p.nor[v * 3], p.nor[v * 3 + 1], p.nor[v * 3 + 2]];
    p.ao[v] = skyVis(
      pp.map((x, r) => x + n[r] * cell * 0.5),
      n,
      foliage,
    );
  }
}
// Match the mean foliage visibility to the impostor's baked AO (normal atlas alpha over covered texels).
const impNormal = await sharp(path.resolve(path.dirname(IMPOSTOR), imp.normal)).raw().toBuffer({ resolveWithObject: true });
const impColor = await sharp(path.resolve(path.dirname(IMPOSTOR), imp.color)).resize(impNormal.info.width, impNormal.info.height).raw().toBuffer({ resolveWithObject: true });
let impAo = 0;
let impN = 0;
for (let i = 0; i < impNormal.info.width * impNormal.info.height; i++) {
  if (impColor.data[i * 4 + 3] < 128) continue;
  impAo += impNormal.data[i * 4 + 3] / 255;
  impN++;
}
impAo /= impN;
let ourAo = 0;
let ourN = 0;
for (const p of parts.filter((q) => q.kind === 'leaf')) for (const a of p.ao) (ourAo += a), ourN++;
ourAo /= ourN;
const aoGamma = Math.log(impAo) / Math.log(ourAo);
for (const p of parts) for (let v = 0; v < p.ao.length; v++) p.ao[v] = Math.min(1, Math.max(1 / 255, p.ao[v] ** aoGamma));
console.log(`[near] sky visibility: impostor mean ${impAo.toFixed(3)}, raw ${ourAo.toFixed(3)} → gamma ${aoGamma.toFixed(2)}`);

// ---------------- Textures ----------------
const toLin = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (c) => {
  c = Math.min(1, Math.max(0, c));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
};
/** Linear-light colour grade; alpha remapped so the material's cutoff becomes 0.5. */
async function graded(p, w, h) {
  const g = p.kind === 'leaf' || p.kind === 'twig' ? SHARED.gradeLeaf : SHARED.gradeBark;
  const { data } = await sharp(Buffer.from(p.image)).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < w * h; i++) {
    for (let r = 0; r < 3; r++) data[i * 4 + r] = toSrgb(toLin[data[i * 4 + r]] * g[r]);
    const a = data[i * 4 + 3] / 255;
    const c = p.cutoff;
    data[i * 4 + 3] = c > 0 ? Math.round(255 * (a < c ? (0.5 * a) / c : 0.5 + (0.5 * (a - c)) / (1 - c))) : 255;
  }
  return data;
}
function dilate(px, w, h) {
  const valid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) valid[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  let frontier = [];
  for (let i = 0; i < w * h; i++) if (!valid[i]) frontier.push(i);
  for (let pass = 0; pass < 16 && frontier.length; pass++) {
    const fill = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i / w) | 0;
      let n = 0;
      const acc = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !valid[yy * w + xx]) continue;
          const j = (yy * w + xx) * 4;
          acc[0] += px[j];
          acc[1] += px[j + 1];
          acc[2] += px[j + 2];
          n++;
        }
      if (n) fill.push([i, acc.map((v) => Math.round(v / n))]);
    }
    for (const [i, c] of fill) {
      px.set(c, i * 4);
      valid[i] = 1;
    }
    frontier = frontier.filter((i) => !valid[i]);
  }
}
// Atlas regions (px, top-left origin like glTF UVs): leaves 512² each on top, twig strips, vines and caps below.
const A = CONFIG.atlasPx;
const regions = {
  BanyanTreeLeaves_1: [0, 0, 512, 512],
  BanyanTreeLeaves_2: [512, 0, 512, 512],
  Branches_03: [0, 512, 256, 512],
  Branches_04: [256, 512, 128, 512],
  Vines_01: [384, 512, 128, 512],
  Cap_03: [512, 512, 256, 256],
};
const atlas = Buffer.alloc(A * A * 4);
for (const p of parts) {
  if (p.kind === 'bark') continue;
  const [x0, y0, w, h] = regions[p.name];
  const px = await graded(p, w, h);
  for (let y = 0; y < h; y++) px.copy(atlas, ((y0 + y) * A + x0) * 4, y * w * 4, (y + 1) * w * 4);
  // Inset by 1.5 texels so bilinear taps stay inside the region.
  for (let v = 0; v < p.uv.length; v += 2) {
    const u = Math.min(1, Math.max(0, p.uv[v]));
    const t = Math.min(1, Math.max(0, p.uv[v + 1]));
    p.uv[v] = (x0 + 1.5 + u * (w - 3)) / A;
    p.uv[v + 1] = (y0 + 1.5 + t * (h - 3)) / A;
  }
}
dilate(atlas, A, A);
fs.mkdirSync(OUT, { recursive: true });
const raw = (buf, w, h) => sharp(buf, { raw: { width: w, height: h, channels: 4 } });
await raw(atlas, A, A).webp({ quality: 88, alphaQuality: 90, effort: 6 }).toFile(path.join(OUT, 'banyan_near_foliage.webp'));
const barkPart = parts.find((p) => p.kind === 'bark');
const [bw, bh] = CONFIG.barkPx;
const barkPx = await graded(barkPart, bw, bh);
await raw(barkPx, bw, bh).removeAlpha().webp({ quality: 85, effort: 6 }).toFile(path.join(OUT, 'banyan_near_bark.webp'));

// ---------------- GLB: two primitives (bark: opaque, tiling map; foliage: atlas, alpha-tested) ----------------
const out = new Document();
const buf = out.createBuffer();
const mesh = out.createMesh('banyan_near');
let tris = 0;
for (const group of ['bark', 'foliage']) {
  const ps = parts.filter((p) => (group === 'bark') === (p.kind === 'bark'));
  const nv = ps.reduce((a, p) => a + p.pos.length / 3, 0);
  const ni = ps.reduce((a, p) => a + p.idx.length, 0);
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const ao = new Uint8Array(nv);
  const idx = new Uint16Array(ni);
  let ov = 0;
  let oi = 0;
  for (const p of ps) {
    for (let i = 0; i < p.pos.length; i++) pos[ov * 3 + i] = p.pos[i] * scale;
    nor.set(p.nor, ov * 3);
    uv.set(p.uv, ov * 2);
    for (let v = 0; v < p.ao.length; v++) ao[ov + v] = Math.round(p.ao[v] * 255);
    for (let i = 0; i < p.idx.length; i++) idx[oi + i] = p.idx[i] + ov;
    ov += p.pos.length / 3;
    oi += p.idx.length;
  }
  if (nv > 65535) throw new Error(`${group}: ${nv} vertices exceed 16-bit indices`);
  tris += ni / 3;
  const acc = (type, arr, norm = false) => out.createAccessor().setType(type).setArray(arr).setBuffer(buf).setNormalized(norm);
  const prim = out
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', pos))
    .setAttribute('NORMAL', acc('VEC3', nor))
    .setAttribute('TEXCOORD_0', acc('VEC2', uv))
    .setAttribute('_AO', acc('SCALAR', ao, true))
    .setIndices(acc('SCALAR', idx))
    .setMaterial(out.createMaterial(group));
  mesh.addPrimitive(prim);
  console.log(`[near] ${group}: ${ni / 3} tris, ${nv} verts`);
}
const scene = out.createScene().addChild(out.createNode('banyan_near').setMesh(mesh));
out.getRoot().setDefaultScene(scene);
out.getRoot().getAsset().extras = {
  source: CREDIT,
  foliage: 'banyan_near_foliage.webp',
  bark: 'banyan_near_bark.webp',
  height: imp.height,
  tris,
  note: 'Tree frame of public/textures/trees/banyan.json (trunk axis at the origin, +y up, height = impostor height); _AO = sky visibility; foliage normals bent toward the canopy.',
};
await new NodeIO().writeBinary(out).then((b) => fs.writeFileSync(path.join(OUT, 'banyan_near.glb'), b));

if (DEBUG) {
  fs.mkdirSync(DEBUG, { recursive: true });
  await raw(atlas, A, A).flatten({ background: '#7f8a94' }).png().toFile(path.join(DEBUG, 'near_atlas_on_grey.png'));
}
const size = (f) => fs.statSync(path.join(OUT, f)).size;
const files = ['banyan_near.glb', 'banyan_near_foliage.webp', 'banyan_near_bark.webp'];
console.log(`[near] done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${tris} tris; ${files.map((f) => `${f} ${(size(f) / 1024).toFixed(0)} KB`).join(', ')}; total ${(files.reduce((a, f) => a + size(f), 0) / 1024).toFixed(0)} KB`);
