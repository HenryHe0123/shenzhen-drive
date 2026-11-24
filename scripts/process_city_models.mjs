#!/usr/bin/env node
/**
 * Offline processing of the 3D Warehouse city models (docs/tasks/asset-upgrade.md, section A).
 *
 * For every entry of scripts/city_config.json `cityModels` it reads the raw GLB from
 * data-raw/assets/3dwarehouse/ (never shipped) and writes
 *   public/models/city/<id>.glb    one mesh, one opaque primitive (+ one alpha-cutout primitive
 *                                  when the model has cutout textures) sharing one WebP atlas
 *   public/models/city/index.json  per-model metadata for scripts/build_city_data.py
 *
 * Per model: drop line primitives and the satellite ground patch, re-origin (y = 0 at ground,
 * x/z = centroid of the footprint hull; native axes kept, north = -Z), drop underground and
 * ground-level horizontal faces, coincident duplicate faces, orient faces outward by ray casting,
 * then bake all materials into one atlas: unique photos as packed cells, repeating patterns as
 * full-width bands (the sampler repeats in u), flat colours and near-uniform textures as swatches.
 * Exports the footprint (convex hull of vertices > 3 m above ground) and a rasterised silhouette
 * used for registration against OSM.
 *
 * Usage: node scripts/process_city_models.mjs [--only id1,id2] [--meshopt]
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { meshopt as meshoptCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'scripts/city_config.json'), 'utf8'));
const DEF = CFG.cityModelDefaults;
const PROC = DEF.process;
const SRC_DIR = join(ROOT, DEF.assetDir);
const OUT_DIR = join(ROOT, DEF.outDir);
const INDEX = join(ROOT, DEF.index);

const args = process.argv.slice(2);
const argVal = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = argVal('--only')?.split(',');
const USE_MESHOPT = args.includes('--meshopt') || PROC.meshopt === true;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const stem = (f) => f.replace(/\.glb$/i, '');
const r1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------------------------
// colour helpers (atlas texels are sRGB; glTF factors are linear)
// ---------------------------------------------------------------------------------------------
const SRGB2LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const lin2srgb8 = (v) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

// ---------------------------------------------------------------------------------------------
// 1. read the raw GLB into a world-space triangle soup
// ---------------------------------------------------------------------------------------------
async function collect(doc) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const textures = [];
  const texByHash = new Map();
  const materials = [];
  const matByKey = new Map();
  const P = [];
  const N = [];
  const T = [];
  const M = [];
  let skipped = 0;
  const texRecord = (tex) => {
    if (!tex) return -1;
    const img = tex.getImage();
    const hash = createHash('sha1').update(img).digest('hex');
    if (!texByHash.has(hash)) {
      texByHash.set(hash, textures.length);
      textures.push({ id: textures.length, name: tex.getName() || tex.getURI(), image: Buffer.from(img) });
    }
    return texByHash.get(hash);
  };
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      const A = (r, c) => m[c * 4 + r];
      const det = A(0, 0) * (A(1, 1) * A(2, 2) - A(1, 2) * A(2, 1)) - A(0, 1) * (A(1, 0) * A(2, 2) - A(1, 2) * A(2, 0)) + A(0, 2) * (A(1, 0) * A(2, 1) - A(1, 1) * A(2, 0));
      // normal matrix (A^-1)^T = cofactor(A) / det, row-major
      const inv = [
        A(1, 1) * A(2, 2) - A(1, 2) * A(2, 1), A(1, 2) * A(2, 0) - A(1, 0) * A(2, 2), A(1, 0) * A(2, 1) - A(1, 1) * A(2, 0),
        A(0, 2) * A(2, 1) - A(0, 1) * A(2, 2), A(0, 0) * A(2, 2) - A(0, 2) * A(2, 0), A(0, 1) * A(2, 0) - A(0, 0) * A(2, 1),
        A(0, 1) * A(1, 2) - A(0, 2) * A(1, 1), A(0, 2) * A(1, 0) - A(0, 0) * A(1, 2), A(0, 0) * A(1, 1) - A(0, 1) * A(1, 0),
      ].map((v) => v / det);
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) {
          skipped++;
          continue;
        }
        const mat = prim.getMaterial();
        const sg = mat?.getExtension('KHR_materials_pbrSpecularGlossiness');
        const tex = sg ? sg.getDiffuseTexture() : (mat?.getBaseColorTexture() ?? null);
        const factor = sg ? sg.getDiffuseFactor() : mat ? mat.getBaseColorFactor() : [0.8, 0.8, 0.8, 1];
        const texId = texRecord(tex);
        const key = `${texId}|${factor.map((c) => c.toFixed(3)).join(',')}`;
        if (!matByKey.has(key)) {
          matByKey.set(key, materials.length);
          materials.push({ id: materials.length, name: mat?.getName() || '(none)', texName: tex?.getName() ?? '', texId, factor: [...factor] });
        }
        const mi = matByKey.get(key);
        const pos = prim.getAttribute('POSITION');
        const nrm = prim.getAttribute('NORMAL');
        const uv = prim.getAttribute('TEXCOORD_0');
        const idx = prim.getIndices();
        const count = idx ? idx.getCount() : pos.getCount();
        const v = [0, 0, 0];
        const t = [0, 0];
        const order = det < 0 ? [0, 2, 1] : [0, 1, 2];
        for (let f = 0; f + 2 < count; f += 3) {
          for (const k of order) {
            const i = idx ? idx.getScalar(f + k) : f + k;
            pos.getElement(i, v);
            P.push(m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]);
            if (nrm) {
              nrm.getElement(i, v);
              const nx = inv[0] * v[0] + inv[1] * v[1] + inv[2] * v[2];
              const ny = inv[3] * v[0] + inv[4] * v[1] + inv[5] * v[2];
              const nz = inv[6] * v[0] + inv[7] * v[1] + inv[8] * v[2];
              const l = Math.hypot(nx, ny, nz) || 1;
              N.push(nx / l, ny / l, nz / l);
            } else N.push(0, 0, 0);
            if (uv) {
              uv.getElement(i, t);
              T.push(t[0], t[1]);
            } else T.push(0.5, 0.5);
          }
          M.push(mi);
        }
      }
    }
    for (const c of node.listChildren()) visit(c);
  };
  for (const n of scene.listChildren()) visit(n);
  return {
    soup: { n: M.length, P: Float64Array.from(P), N: Float32Array.from(N), T: Float64Array.from(T), M: Int32Array.from(M) },
    textures,
    materials,
    skipped,
  };
}

function faceNormal(P, i, out) {
  const o = i * 9;
  const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
  const bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz);
  out[0] = l ? nx / l : 0;
  out[1] = l ? ny / l : 0;
  out[2] = l ? nz / l : 0;
  return l / 2;
}

function filterSoup(s, keep) {
  let n = 0;
  for (let i = 0; i < s.n; i++) if (keep[i]) n++;
  const out = { n, P: new Float64Array(n * 9), N: new Float32Array(n * 9), T: new Float64Array(n * 6), M: new Int32Array(n) };
  let j = 0;
  for (let i = 0; i < s.n; i++) {
    if (!keep[i]) continue;
    out.P.set(s.P.subarray(i * 9, i * 9 + 9), j * 9);
    out.N.set(s.N.subarray(i * 9, i * 9 + 9), j * 9);
    out.T.set(s.T.subarray(i * 6, i * 6 + 6), j * 6);
    out.M[j] = s.M[i];
    j++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. ground patch, ground level, underground / ground-level faces, duplicates
// ---------------------------------------------------------------------------------------------
const GROUND_RE = new RegExp(PROC.groundMaterialRegex, 'i');

function cleanGround(s, materials, opt, log) {
  const fn = [0, 0, 0];
  // per material: bounds and flatness
  const st = materials.map(() => ({ tris: 0, ylo: Infinity, yhi: -Infinity, xlo: Infinity, xhi: -Infinity, zlo: Infinity, zhi: -Infinity, horiz: 0 }));
  for (let i = 0; i < s.n; i++) {
    const g = st[s.M[i]];
    g.tris++;
    faceNormal(s.P, i, fn);
    if (Math.abs(fn[1]) > 0.98) g.horiz++;
    for (let k = 0; k < 3; k++) {
      const o = i * 9 + k * 3;
      g.xlo = Math.min(g.xlo, s.P[o]);
      g.xhi = Math.max(g.xhi, s.P[o]);
      g.ylo = Math.min(g.ylo, s.P[o + 1]);
      g.yhi = Math.max(g.yhi, s.P[o + 1]);
      g.zlo = Math.min(g.zlo, s.P[o + 2]);
      g.zhi = Math.max(g.zhi, s.P[o + 2]);
    }
  }
  const extra = opt.groundMaterials ? new RegExp(opt.groundMaterials, 'i') : null;
  const isGround = materials.map((m, i) => {
    const nm = `${m.name} ${m.texName}`;
    return st[i].tris > 0 && (GROUND_RE.test(nm) || (extra && extra.test(nm)));
  });
  // flat textured patch at the very bottom covering most of the model (unnamed satellite photos)
  let rest = { xlo: Infinity, xhi: -Infinity, zlo: Infinity, zhi: -Infinity, ylo: Infinity };
  materials.forEach((_, i) => {
    if (isGround[i] || !st[i].tris) return;
    const g = st[i];
    rest = { xlo: Math.min(rest.xlo, g.xlo), xhi: Math.max(rest.xhi, g.xhi), zlo: Math.min(rest.zlo, g.zlo), zhi: Math.max(rest.zhi, g.zhi), ylo: Math.min(rest.ylo, g.ylo) };
  });
  materials.forEach((m, i) => {
    const g = st[i];
    if (isGround[i] || !g.tris || m.texId < 0) return;
    const area = (g.xhi - g.xlo) * (g.zhi - g.zlo);
    if (g.horiz === g.tris && g.yhi - g.ylo < 0.5 && g.ylo <= rest.ylo + 0.5 && Math.max(g.xhi - g.xlo, g.zhi - g.zlo) > 30 && area > 0.5 * (rest.xhi - rest.xlo) * (rest.zhi - rest.zlo)) {
      isGround[i] = true;
    }
  });
  let gy = [];
  let gyLo = Infinity, gyHi = -Infinity;
  let bMin = Infinity;
  for (let i = 0; i < s.n; i++) {
    const ground = isGround[s.M[i]];
    for (let k = 0; k < 3; k++) {
      const y = s.P[i * 9 + k * 3 + 1];
      if (ground) {
        gy.push(y);
        gyLo = Math.min(gyLo, y);
        gyHi = Math.max(gyHi, y);
      } else bMin = Math.min(bMin, y);
    }
  }
  gy.sort((a, b) => a - b);
  const flat = gy.length > 0 && gyHi - gyLo < 0.5;
  const patchY = gy.length ? gy[gy.length >> 1] : null;
  let y0;
  let how;
  if (opt.groundY !== undefined) {
    y0 = opt.groundY;
    how = 'config';
  } else if (flat && patchY > bMin + 0.3) {
    y0 = patchY;
    how = 'patch';
  } else {
    y0 = bMin;
    how = gy.length ? (flat ? 'base (above patch)' : 'base (terrain patch)') : 'base';
  }
  const keep = new Uint8Array(s.n);
  let nGround = 0, nUnder = 0, nDecal = 0;
  for (let i = 0; i < s.n; i++) {
    if (isGround[s.M[i]]) {
      nGround++;
      continue;
    }
    const o = i * 9;
    const ys = [s.P[o + 1], s.P[o + 4], s.P[o + 7]];
    if (Math.max(...ys) < y0 - 0.3) {
      nUnder++;
      continue;
    }
    const area = faceNormal(s.P, i, fn);
    if (area < 1e-6) continue;
    if (Math.abs(fn[1]) > 0.95 && ys.every((y) => Math.abs(y - y0) < 0.3)) {
      nDecal++;
      continue;
    }
    keep[i] = 1;
  }
  const groundNames = [...new Set(materials.filter((_, i) => isGround[i] && st[i].tris).map((m) => m.name))];
  log.push(`ground: ${nGround} patch tris [${groundNames.join(', ')}], y0 ${y0.toFixed(2)} (${how}${patchY !== null ? `, patch ${gyLo.toFixed(1)}..${gyHi.toFixed(1)}` : ''}), ${nUnder} underground, ${nDecal} ground-level horizontal`);
  return { soup: filterSoup(s, keep), y0, groundTris: nGround, underground: nUnder, decals: nDecal, groundHow: how };
}

function cropSoup(s, opt, log) {
  if (!opt.keepBox && !opt.dropBox) return s;
  const keep = new Uint8Array(s.n);
  let dropped = 0;
  const inBox = (b, x, z) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3];
  for (let i = 0; i < s.n; i++) {
    const o = i * 9;
    const cx = (s.P[o] + s.P[o + 3] + s.P[o + 6]) / 3;
    const cz = (s.P[o + 2] + s.P[o + 5] + s.P[o + 8]) / 3;
    let k = true;
    // keepBox keeps faces centred inside; dropBox drops every face touching the box
    if (opt.keepBox && !inBox(opt.keepBox, cx, cz)) k = false;
    if (opt.dropBox && opt.dropBox.some((b) => [0, 3, 6].some((v) => inBox(b, s.P[o + v], s.P[o + v + 2])))) k = false;
    keep[i] = k ? 1 : 0;
    if (!k) dropped++;
  }
  log.push(`crop: dropped ${dropped} tris outside keepBox / inside dropBox (native coords)`);
  return filterSoup(s, keep);
}

function dedupeFaces(s) {
  const seen = new Set();
  const keep = new Uint8Array(s.n);
  let dups = 0;
  const q = (v) => Math.round(v * 200);
  for (let i = 0; i < s.n; i++) {
    const o = i * 9;
    const vs = [0, 1, 2].map((k) => `${q(s.P[o + k * 3])},${q(s.P[o + k * 3 + 1])},${q(s.P[o + k * 3 + 2])}`).sort();
    const key = vs.join('|');
    if (seen.has(key)) {
      dups++;
      continue;
    }
    seen.add(key);
    keep[i] = 1;
  }
  return { soup: dups ? filterSoup(s, keep) : s, dups };
}

// ---------------------------------------------------------------------------------------------
// 3. outward orientation: rays over each side's hemisphere; flip faces whose back side is
//    clearly more open (escapes to the sky / away from the building) than their front side
// ---------------------------------------------------------------------------------------------
function buildBVH(P, n) {
  const cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) cen[i * 3 + a] = (P[i * 9 + a] + P[i * 9 + 3 + a] + P[i * 9 + 6 + a]) / 3;
  }
  const order = new Uint32Array(n).map((_, i) => i);
  const bmin = [], bmax = [], left = [], right = [], start = [], count = [];
  const build = (s0, s1) => {
    const id = count.length;
    count.push(0); start.push(0); left.push(-1); right.push(-1); bmin.push(null); bmax.push(null);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const clo = [Infinity, Infinity, Infinity], chi = [-Infinity, -Infinity, -Infinity];
    for (let k = s0; k < s1; k++) {
      const t = order[k];
      for (let v = 0; v < 3; v++) {
        for (let a = 0; a < 3; a++) {
          const x = P[t * 9 + v * 3 + a];
          if (x < lo[a]) lo[a] = x;
          if (x > hi[a]) hi[a] = x;
        }
      }
      for (let a = 0; a < 3; a++) {
        const c = cen[t * 3 + a];
        if (c < clo[a]) clo[a] = c;
        if (c > chi[a]) chi[a] = c;
      }
    }
    bmin[id] = lo;
    bmax[id] = hi;
    if (s1 - s0 <= 4) {
      start[id] = s0;
      count[id] = s1 - s0;
      return id;
    }
    const ext = [chi[0] - clo[0], chi[1] - clo[1], chi[2] - clo[2]];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const sub = Array.from(order.subarray(s0, s1)).sort((p, q) => cen[p * 3 + axis] - cen[q * 3 + axis]);
    order.set(sub, s0);
    const mid = (s0 + s1) >> 1;
    left[id] = build(s0, mid);
    right[id] = build(mid, s1);
    return id;
  };
  build(0, n);
  return { P, order, bmin, bmax, left, right, start, count };
}

function rayHits(bvh, ox, oy, oz, dx, dy, dz, tmax) {
  const { P, order, bmin, bmax, left, right, start, count } = bvh;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    const lo = bmin[id], hi = bmax[id];
    let t0 = (lo[0] - ox) * ix, t1 = (hi[0] - ox) * ix;
    let tn = Math.min(t0, t1), tf = Math.max(t0, t1);
    t0 = (lo[1] - oy) * iy; t1 = (hi[1] - oy) * iy;
    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
    t0 = (lo[2] - oz) * iz; t1 = (hi[2] - oz) * iz;
    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
    if (tf < Math.max(tn, 0) || tn > tmax) continue;
    if (count[id]) {
      for (let k = start[id]; k < start[id] + count[id]; k++) {
        const o = order[k] * 9;
        const e1x = P[o + 3] - P[o], e1y = P[o + 4] - P[o + 1], e1z = P[o + 5] - P[o + 2];
        const e2x = P[o + 6] - P[o], e2y = P[o + 7] - P[o + 1], e2z = P[o + 8] - P[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - P[o], sy = oy - P[o + 1], sz = oz - P[o + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-3 && t < tmax) return true;
      }
    } else {
      stack.push(left[id], right[id]);
    }
  }
  return false;
}

const HEMI = Array.from({ length: PROC.orientRays }, (_, k) => {
  const r = Math.sqrt((k + 0.5) / PROC.orientRays);
  const phi = k * 2.399963229728653;
  return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - r * r))];
});

function orientOutward(s) {
  const bvh = buildBVH(s.P, s.n);
  const fn = [0, 0, 0];
  let flipped = 0;
  const openness = (cx, cy, cz, nx, ny, nz, rot) => {
    // tangent frame around n
    const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let tx = ny * ax[2] - nz * ax[1], ty = nz * ax[0] - nx * ax[2], tz = nx * ax[1] - ny * ax[0];
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    let open = 0;
    for (const [hx, hy, hz] of HEMI) {
      const u = hx * cr - hy * sr, v = hx * sr + hy * cr;
      const dx = tx * u + bx * v + nx * hz, dy = ty * u + by * v + ny * hz, dz = tz * u + bz * v + nz * hz;
      if (!rayHits(bvh, cx + nx * 0.02, cy + ny * 0.02, cz + nz * 0.02, dx, dy, dz, 5000)) open++;
    }
    return open;
  };
  for (let i = 0; i < s.n; i++) {
    const area = faceNormal(s.P, i, fn);
    if (area < 1e-6) continue;
    const o = i * 9;
    const cx = (s.P[o] + s.P[o + 3] + s.P[o + 6]) / 3;
    const cy = (s.P[o + 1] + s.P[o + 4] + s.P[o + 7]) / 3;
    const cz = (s.P[o + 2] + s.P[o + 5] + s.P[o + 8]) / 3;
    const rot = (i * 0.618034 % 1) * Math.PI * 2;
    const front = openness(cx, cy, cz, fn[0], fn[1], fn[2], rot);
    if (front >= HEMI.length - 1) continue;
    const back = openness(cx, cy, cz, -fn[0], -fn[1], -fn[2], rot);
    if (back >= 2 && back > front + 1) {
      // swap vertices 1 and 2 (positions, normals, uvs)
      for (let a = 0; a < 3; a++) {
        [s.P[o + 3 + a], s.P[o + 6 + a]] = [s.P[o + 6 + a], s.P[o + 3 + a]];
        [s.N[o + 3 + a], s.N[o + 6 + a]] = [s.N[o + 6 + a], s.N[o + 3 + a]];
      }
      const t = i * 6;
      for (let a = 0; a < 2; a++) [s.T[t + 2 + a], s.T[t + 4 + a]] = [s.T[t + 4 + a], s.T[t + 2 + a]];
      for (let k = 0; k < 9; k++) s.N[o + k] = -s.N[o + k];
      flipped++;
    }
  }
  // vertex normals must agree with the winding (three.js flips back-facing normals on DoubleSide)
  let fixedN = 0;
  for (let i = 0; i < s.n; i++) {
    faceNormal(s.P, i, fn);
    const o = i * 9;
    for (let k = 0; k < 3; k++) {
      const d = s.N[o + k * 3] * fn[0] + s.N[o + k * 3 + 1] * fn[1] + s.N[o + k * 3 + 2] * fn[2];
      if (!(d > 0.2)) {
        s.N[o + k * 3] = fn[0];
        s.N[o + k * 3 + 1] = fn[1];
        s.N[o + k * 3 + 2] = fn[2];
        fixedN++;
      }
    }
  }
  return { flipped, fixedN };
}

// ---------------------------------------------------------------------------------------------
// 4. footprint: convex hull of vertices above hMin, rasterised silhouette (1 m cells)
// ---------------------------------------------------------------------------------------------
function convexHull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function polyCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    const c = x0 * z1 - x1 * z0;
    a += c;
    cx += (x0 + x1) * c;
    cz += (z0 + z1) * c;
  }
  return Math.abs(a) < 1e-9 ? ring[0] : [cx / (3 * a), cz / (3 * a)];
}

function polyArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a) / 2;
}

function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    let best = -1, bi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best <= tol) return [a, b];
    return dp(pts.slice(0, bi + 1)).slice(0, -1).concat(dp(pts.slice(bi)));
  };
  // split the closed ring at the vertex farthest from vertex 0
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = dp(ring.slice(0, far + 1));
  const b = dp(ring.slice(far).concat([ring[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function silhouette(s, hMin, cell) {
  let xlo = Infinity, xhi = -Infinity, zlo = Infinity, zhi = -Infinity;
  const use = new Uint8Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const o = i * 9;
    if (Math.max(s.P[o + 1], s.P[o + 4], s.P[o + 7]) <= hMin) continue;
    use[i] = 1;
    for (let k = 0; k < 3; k++) {
      xlo = Math.min(xlo, s.P[o + k * 3]);
      xhi = Math.max(xhi, s.P[o + k * 3]);
      zlo = Math.min(zlo, s.P[o + k * 3 + 2]);
      zhi = Math.max(zhi, s.P[o + k * 3 + 2]);
    }
  }
  if (!Number.isFinite(xlo)) return [];
  const pad = 2;
  const W = Math.ceil((xhi - xlo) / cell) + 2 * pad, H = Math.ceil((zhi - zlo) / cell) + 2 * pad;
  const gx0 = xlo - pad * cell, gz0 = zlo - pad * cell;
  const g = new Uint8Array(W * H);
  const mark = (x, z) => {
    const i = Math.floor((x - gx0) / cell), j = Math.floor((z - gz0) / cell);
    if (i >= 0 && j >= 0 && i < W && j < H) g[j * W + i] = 1;
  };
  for (let t = 0; t < s.n; t++) {
    if (!use[t]) continue;
    const o = t * 9;
    const V = [[s.P[o], s.P[o + 2]], [s.P[o + 3], s.P[o + 5]], [s.P[o + 6], s.P[o + 8]]];
    for (let e = 0; e < 3; e++) {
      const [a, b] = [V[e], V[(e + 1) % 3]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(L / (cell * 0.5)));
      for (let k = 0; k <= steps; k++) mark(a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps);
    }
    const area2 = (V[1][0] - V[0][0]) * (V[2][1] - V[0][1]) - (V[2][0] - V[0][0]) * (V[1][1] - V[0][1]);
    if (Math.abs(area2) < cell * cell * 0.5) continue;
    const i0 = Math.max(0, Math.floor((Math.min(V[0][0], V[1][0], V[2][0]) - gx0) / cell));
    const i1 = Math.min(W - 1, Math.floor((Math.max(V[0][0], V[1][0], V[2][0]) - gx0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(V[0][1], V[1][1], V[2][1]) - gz0) / cell));
    const j1 = Math.min(H - 1, Math.floor((Math.max(V[0][1], V[1][1], V[2][1]) - gz0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = gx0 + (i + 0.5) * cell, pz = gz0 + (j + 0.5) * cell;
        let pos = 0, neg = 0;
        for (let e = 0; e < 3; e++) {
          const [a, b] = [V[e], V[(e + 1) % 3]];
          const c = (b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0]);
          if (c > 0) pos++;
          else if (c < 0) neg++;
        }
        if (!(pos && neg)) g[j * W + i] = 1;
      }
    }
  }
  // fill enclosed holes: flood the outside from the border
  const outside = new Uint8Array(W * H);
  const stack = [];
  for (let i = 0; i < W; i++) stack.push(i, (H - 1) * W + i);
  for (let j = 0; j < H; j++) stack.push(j * W, j * W + W - 1);
  while (stack.length) {
    const k = stack.pop();
    if (outside[k] || g[k]) continue;
    outside[k] = 1;
    const i = k % W, j = (k / W) | 0;
    if (i > 0) stack.push(k - 1);
    if (i < W - 1) stack.push(k + 1);
    if (j > 0) stack.push(k - W);
    if (j < H - 1) stack.push(k + W);
  }
  const inside = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !outside[j * W + i];
  // boundary edges with the inside on the left, chained into rings
  const edges = new Map();
  const addEdge = (a, b) => {
    const k = `${a[0]},${a[1]}`;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push(b);
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!inside(i, j)) continue;
      if (!inside(i, j - 1)) addEdge([i + 1, j], [i, j]);
      if (!inside(i, j + 1)) addEdge([i, j + 1], [i + 1, j + 1]);
      if (!inside(i - 1, j)) addEdge([i, j], [i, j + 1]);
      if (!inside(i + 1, j)) addEdge([i + 1, j + 1], [i + 1, j]);
    }
  }
  const rings = [];
  for (const [k0, list0] of edges) {
    while (list0.length) {
      const start = k0.split(',').map(Number);
      const ring = [start];
      let cur = list0.pop();
      let guard = 0;
      while (`${cur[0]},${cur[1]}` !== k0 && guard++ < 1e6) {
        ring.push(cur);
        const nx = edges.get(`${cur[0]},${cur[1]}`);
        if (!nx || !nx.length) break;
        cur = nx.pop();
      }
      // drop collinear points
      const pts = ring.filter((p, idx) => {
        const a = ring[(idx - 1 + ring.length) % ring.length], b = ring[(idx + 1) % ring.length];
        return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
      });
      const world = pts.map(([i, j]) => [gx0 + i * cell, gz0 + j * cell]);
      if (world.length >= 3 && polyArea(world) >= 4 * cell * cell) rings.push(simplifyRing(world, PROC.silhouetteSimplify));
    }
  }
  return rings.filter((r) => r.length >= 3).map((r) => r.map(([x, z]) => [r1(x), r1(z)]));
}

// ---------------------------------------------------------------------------------------------
// 5. atlas
// ---------------------------------------------------------------------------------------------
async function decodeTexture(tex) {
  if (tex.raw) return tex;
  let img = sharp(tex.image, { failOn: 'none' });
  const meta = await img.metadata();
  const maxSide = PROC.maxSourceTexture;
  if (Math.max(meta.width, meta.height) > maxSide) img = img.resize({ width: maxSide, height: maxSide, fit: 'inside' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  tex.raw = data;
  tex.w = info.width;
  tex.h = info.height;
  let sum = [0, 0, 0], sum2 = [0, 0, 0], transparent = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = data[i * 4 + c];
      sum[c] += SRGB2LIN[v];
      sum2[c] += v * v;
    }
    if (data[i * 4 + 3] < 128) transparent++;
  }
  tex.meanLin = sum.map((v) => v / n);
  tex.stdev = sum2.map((v, c) => {
    let m = 0;
    for (let i = 0; i < n; i++) m += data[i * 4 + c];
    m /= n;
    return Math.sqrt(Math.max(0, v / n - m * m));
  });
  tex.alphaFrac = meta.hasAlpha ? transparent / n : 0;
  return tex;
}

/** Jacobian-based metres per UV unit along u and v, plus the shifted UV rect of a triangle group. */
function groupStats(s, tris) {
  let area = 0, uvArea = 0;
  const jac = [];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const shift = new Map();
  const fn = [0, 0, 0];
  for (const i of tris) {
    const a = faceNormal(s.P, i, fn);
    area += a;
    const o = i * 9, t = i * 6;
    const us = [s.T[t], s.T[t + 2], s.T[t + 4]], vs = [s.T[t + 1], s.T[t + 3], s.T[t + 5]];
    const ku = Math.floor(Math.min(...us) + 0.01), kv = Math.floor(Math.min(...vs) + 0.01);
    shift.set(i, [ku, kv]);
    u0 = Math.min(u0, Math.min(...us) - ku);
    u1 = Math.max(u1, Math.max(...us) - ku);
    v0 = Math.min(v0, Math.min(...vs) - kv);
    v1 = Math.max(v1, Math.max(...vs) - kv);
    const du1 = us[1] - us[0], dv1 = vs[1] - vs[0], du2 = us[2] - us[0], dv2 = vs[2] - vs[0];
    const det = du1 * dv2 - du2 * dv1;
    uvArea += Math.abs(det) / 2;
    if (Math.abs(det) < 1e-10 || a < 1e-6) continue;
    const p1 = [s.P[o + 3] - s.P[o], s.P[o + 4] - s.P[o + 1], s.P[o + 5] - s.P[o + 2]];
    const p2 = [s.P[o + 6] - s.P[o], s.P[o + 7] - s.P[o + 1], s.P[o + 8] - s.P[o + 2]];
    const dPdu = p1.map((v, k) => (v * dv2 - p2[k] * dv1) / det);
    const dPdv = p2.map((v, k) => (v * du1 - p1[k] * du2) / det);
    jac.push([Math.hypot(...dPdu), Math.hypot(...dPdv), a]);
  }
  // metres per UV unit: isotropic scale from total world / UV area, anisotropy from the
  // area-weighted median Jacobian ratio (robust against slivers with near-degenerate UVs)
  const ratios = jac.filter((j) => Number.isFinite(j[0] / j[1]) && j[1] > 0).map((j) => [j[0] / j[1], j[2]]).sort((p, q) => p[0] - q[0]);
  const tot = ratios.reduce((acc, r) => acc + r[1], 0);
  let ratio = 1;
  for (let i = 0, acc = 0; i < ratios.length; i++) {
    acc += ratios[i][1];
    if (acc >= tot / 2) {
      ratio = Math.min(8, Math.max(1 / 8, ratios[i][0]));
      break;
    }
  }
  const iso = uvArea > 1e-9 ? Math.min(1e3, Math.sqrt(area / uvArea)) : 1e3;
  return { area, mu: iso * Math.sqrt(ratio), mv: iso / Math.sqrt(ratio), u0: Math.max(0, u0), u1, v0: Math.max(0, v0), v1, shift };
}

function shelfPack(items, W, H) {
  // items: {w, h} (already padded); returns false if they don't fit, else assigns x/y
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
  let x = 0, y = 0, rowH = 0;
  for (const it of sorted) {
    if (it.w > W) return false;
    if (x + it.w > W) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    if (y + it.h > H) return false;
    it.x = x;
    it.y = y;
    x += it.w;
    rowH = Math.max(rowH, it.h);
  }
  return true;
}

const pow2floor = (v) => 2 ** Math.max(0, Math.floor(Math.log2(Math.max(1, v))));

function layoutAtlas(items, S, k, pad) {
  // bands stacked from the top, cells/swatches shelf-packed below
  let y = 0;
  const cells = [];
  for (const it of items) {
    if (it.kind === 'swatch') {
      it.w = it.h = PROC.swatchSize;
      cells.push(it);
    } else if (it.kind === 'cell') {
      const pu = Math.min(it.W, k * it.mu), pv = Math.min(it.H, k * it.mv);
      it.w = Math.max(4, Math.round(it.Su * pu));
      it.h = Math.max(4, Math.round(it.Sv * pv));
      cells.push(it);
    } else {
      // band: periodic along the band (u for bandU, v for bandV after transposing)
      const [Wp, Hp, mp, mq, Sq] = it.kind === 'bandU' ? [it.W, it.H, it.mu, it.mv, it.Sv] : [it.H, it.W, it.mv, it.mu, it.Su];
      const pp = Math.min(Wp, k * mp);
      it.n = Math.min(S, pow2floor(S / Math.max(pp, 1)));
      const scale = S / it.n / Wp;
      it.h = Math.max(4, Math.round(Sq * Math.min(Hp, k * mq, Hp * scale * 1.5)));
      it.w = S;
      it.x = 0;
      it.y = y;
      y += it.h + 2 * pad;
    }
  }
  if (y > S) return false;
  const slots = cells.map((c) => ({ c, w: c.w + 2 * pad, h: c.h + 2 * pad }));
  if (!shelfPack(slots, S, S - y)) return false;
  for (const sl of slots) {
    sl.c.x = sl.x;
    sl.c.y = sl.y + y;
  }
  return true;
}

function makeRect(tex, x0, y0, Wn, Hn, transpose) {
  // native-resolution copy of a pixel rect with wrap-around (optionally transposed)
  const out = Buffer.alloc(Wn * Hn * 4);
  const { raw, w, h } = tex;
  for (let y = 0; y < Hn; y++) {
    for (let x = 0; x < Wn; x++) {
      const sx = transpose ? (((y0 + y) % w) + w) % w : (((x0 + x) % w) + w) % w;
      const sy = transpose ? (((x0 + x) % h) + h) % h : (((y0 + y) % h) + h) % h;
      raw.copy(out, (y * Wn + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
  return out;
}

async function resizeRaw(buf, w, h, W, H) {
  if (w === W && h === H) return buf;
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).resize(W, H, { fit: 'fill', kernel: 'mitchell' }).raw().toBuffer();
}

function tint(buf, factor, cutout) {
  const f = factor;
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = lin2srgb8(SRGB2LIN[buf[i]] * f[0]);
    buf[i + 1] = lin2srgb8(SRGB2LIN[buf[i + 1]] * f[1]);
    buf[i + 2] = lin2srgb8(SRGB2LIN[buf[i + 2]] * f[2]);
    if (!cutout) buf[i + 3] = 255;
  }
  return buf;
}

function blit(atlas, S, buf, w, h, x, y, pad, padX) {
  // copy with edge extension: pad rows above/below, padX columns left/right
  for (let yy = -pad; yy < h + pad; yy++) {
    const sy = Math.min(h - 1, Math.max(0, yy));
    const ay = y + pad + yy;
    if (ay < 0 || ay >= S) continue;
    for (let xx = -padX; xx < w + padX; xx++) {
      const sx = Math.min(w - 1, Math.max(0, xx));
      const ax = x + padX + xx;
      if (ax < 0 || ax >= S) continue;
      buf.copy(atlas, (ay * S + ax) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
}

async function buildAtlas(s, materials, textures, opt, log) {
  const groups = new Map();
  for (let i = 0; i < s.n; i++) {
    if (!groups.has(s.M[i])) groups.set(s.M[i], []);
    groups.get(s.M[i]).push(i);
  }
  const items = [];
  let cutoutAny = false;
  const dropTri = new Uint8Array(s.n);
  const counts = { cell: 0, bandU: 0, bandV: 0, swatch: 0, dropped: 0 };
  for (const [mi, allTris] of groups) {
    const mat = materials[mi];
    let tris = allTris;
    if (mat.texId >= 0) {
      // faces whose UVs cover less than ~1.5 texels just sample one colour: swatches by texel colour
      const tex = await decodeTexture(textures[mat.texId]);
      const buckets = new Map();
      tris = [];
      for (const t of allTris) {
        const us = [s.T[t * 6], s.T[t * 6 + 2], s.T[t * 6 + 4]], vs = [s.T[t * 6 + 1], s.T[t * 6 + 3], s.T[t * 6 + 5]];
        if ((Math.max(...us) - Math.min(...us)) * tex.w >= 1.5 || (Math.max(...vs) - Math.min(...vs)) * tex.h >= 1.5) {
          tris.push(t);
          continue;
        }
        const px = ((Math.floor(((us[0] + us[1] + us[2]) / 3) * tex.w) % tex.w) + tex.w) % tex.w;
        const py = ((Math.floor(((vs[0] + vs[1] + vs[2]) / 3) * tex.h) % tex.h) + tex.h) % tex.h;
        const o = (py * tex.w + px) * 4;
        if (tex.raw[o + 3] < 128 && tex.alphaFrac > PROC.cutoutMinFraction) {
          dropTri[t] = 1;
          counts.dropped++;
          continue;
        }
        const key = `${tex.raw[o] >> 3},${tex.raw[o + 1] >> 3},${tex.raw[o + 2] >> 3}`;
        if (!buckets.has(key)) buckets.set(key, { rgb: [tex.raw[o], tex.raw[o + 1], tex.raw[o + 2]], tris: [] });
        buckets.get(key).tris.push(t);
      }
      for (const b of buckets.values()) {
        const color = b.rgb.map((v, c) => SRGB2LIN[v] * mat.factor[c]);
        items.push({ mat, tris: b.tris, kind: 'swatch', color, factor: mat.factor, area: groupStats(s, b.tris).area, mu: 1, mv: 1 });
        counts.swatch++;
      }
      if (!tris.length) continue;
    }
    const g = groupStats(s, tris);
    const it = { mat, tris, ...g, factor: mat.factor };
    if (mat.texId >= 0) {
      const tex = textures[mat.texId];
      it.tex = tex;
      it.W = tex.w;
      it.H = tex.h;
      it.cutout = tex.alphaFrac > PROC.cutoutMinFraction;
      it.Su = Math.max(1 / tex.w, g.u1 - g.u0);
      it.Sv = Math.max(1 / tex.h, g.v1 - g.v0);
      const uniform = Math.max(...tex.stdev) < PROC.uniformStdev;
      if (uniform && !it.cutout) it.kind = 'swatch';
      else if (it.Su * it.Sv <= PROC.cellMaxRepeats) it.kind = 'cell';
      else if (it.Sv <= PROC.bandMaxCross) it.kind = 'bandU';
      else if (it.Su <= PROC.bandMaxCross) it.kind = 'bandV';
      else it.kind = it.cutout ? 'drop' : 'swatch';
      if (it.kind === 'swatch') {
        const tl = tex.meanLin;
        it.color = [tl[0] * mat.factor[0], tl[1] * mat.factor[1], tl[2] * mat.factor[2]];
      }
    } else {
      it.kind = 'swatch';
      it.color = mat.factor.slice(0, 3);
    }
    if (it.kind === 'drop') {
      for (const t of tris) dropTri[t] = 1;
      counts.dropped += tris.length;
      continue;
    }
    if (it.cutout) cutoutAny = true;
    counts[it.kind]++;
    items.push(it);
  }
  const pad = PROC.atlasPadding;
  const maxS = opt.atlas ?? DEF.atlas[opt.role];
  // smallest power-of-two atlas that holds everything at the target texel density (capped by the
  // native resolution), else maxS with the largest density k (px per metre) that fits
  const kMax = PROC.maxTexelDensity;
  let S = 0, k = 0;
  for (let size = 64; size <= maxS; size *= 2) {
    if (layoutAtlas(items, size, kMax, pad)) {
      S = size;
      k = kMax;
      break;
    }
  }
  if (!S) {
    S = maxS;
    let lo = 0.01, hi = kMax;
    // too many items even at minimum density: smallest textured items become swatches
    const byArea = items.filter((it) => it.kind !== 'swatch' && !it.cutout).sort((a, b) => a.area - b.area);
    while (!layoutAtlas(items, S, lo, pad)) {
      const it = byArea.shift();
      if (!it) throw new Error(`atlas: ${items.length} items do not fit into ${S}px even at minimum density`);
      counts[it.kind]--;
      counts.swatch++;
      it.kind = 'swatch';
      const tl = it.tex.meanLin;
      it.color = [tl[0] * it.factor[0], tl[1] * it.factor[1], tl[2] * it.factor[2]];
    }
    for (let it = 0; it < 30; it++) {
      const mid = Math.sqrt(lo * hi);
      if (layoutAtlas(items, S, mid, pad)) lo = mid;
      else hi = mid;
    }
    k = lo;
    layoutAtlas(items, S, k, pad);
  }
  const atlas = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) atlas.writeUInt32BE(0x808080ff, i * 4);
  const UV = new Float32Array(s.n * 6);
  for (const it of items) {
    if (it.kind === 'swatch') {
      const c = [lin2srgb8(it.color[0]), lin2srgb8(it.color[1]), lin2srgb8(it.color[2]), 255];
      const sw = it.w + 2 * pad;
      for (let yy = 0; yy < sw; yy++) for (let xx = 0; xx < sw; xx++) atlas.set(c, ((it.y + yy) * S + it.x + xx) * 4);
      const cu = (it.x + pad + it.w / 2) / S, cv = (it.y + pad + it.h / 2) / S;
      for (const t of it.tris) for (let k2 = 0; k2 < 3; k2++) UV.set([cu, cv], t * 6 + k2 * 2);
      continue;
    }
    const { tex } = it;
    if (it.kind === 'cell') {
      const x0 = Math.floor(it.u0 * tex.w), x1 = Math.ceil((it.u0 + it.Su) * tex.w);
      const y0 = Math.floor(it.v0 * tex.h), y1 = Math.ceil((it.v0 + it.Sv) * tex.h);
      const Wn = Math.max(1, x1 - x0), Hn = Math.max(1, y1 - y0);
      const buf = tint(await resizeRaw(makeRect(tex, x0, y0, Wn, Hn, false), Wn, Hn, it.w, it.h), it.factor, it.cutout);
      blit(atlas, S, buf, it.w, it.h, it.x, it.y, pad, pad);
      const U0 = x0 / tex.w, V0 = y0 / tex.h, SU = Wn / tex.w, SV = Hn / tex.h;
      for (const t of it.tris) {
        const [ku, kv] = it.shift.get(t);
        for (let k2 = 0; k2 < 3; k2++) {
          const lu = (s.T[t * 6 + k2 * 2] - ku - U0) / SU, lv = (s.T[t * 6 + k2 * 2 + 1] - kv - V0) / SV;
          UV[t * 6 + k2 * 2] = (it.x + pad + Math.min(1, Math.max(0, lu)) * it.w) / S;
          UV[t * 6 + k2 * 2 + 1] = (it.y + pad + Math.min(1, Math.max(0, lv)) * it.h) / S;
        }
      }
      continue;
    }
    // bands: one period of the texture along the band, `n` periods across the atlas width
    const tr = it.kind === 'bandV';
    const per = tr ? tex.h : tex.w; // native period (px) along the band
    const [c0, cS] = tr ? [it.u0, it.Su] : [it.v0, it.Sv]; // cross-band UV range
    const crossN = tr ? tex.w : tex.h;
    const y0 = Math.floor(c0 * crossN), y1 = Math.ceil((c0 + cS) * crossN);
    const Hn = Math.max(1, y1 - y0);
    const pw = S / it.n;
    const period = tint(await resizeRaw(makeRect(tex, 0, y0, per, Hn, tr), per, Hn, pw, it.h), it.factor, it.cutout);
    const row = Buffer.alloc(S * it.h * 4);
    for (let yy = 0; yy < it.h; yy++) {
      for (let r = 0; r < it.n; r++) period.copy(row, (yy * S + r * pw) * 4, yy * pw * 4, (yy + 1) * pw * 4);
    }
    blit(atlas, S, row, S, it.h, 0, it.y, pad, 0);
    const C0 = y0 / crossN, CS = Hn / crossN;
    for (const t of it.tris) {
      const [ku, kv] = it.shift.get(t);
      for (let k2 = 0; k2 < 3; k2++) {
        const u = s.T[t * 6 + k2 * 2], v = s.T[t * 6 + k2 * 2 + 1];
        const along = tr ? v : u;
        const cross = tr ? (u - ku - C0) / CS : (v - kv - C0) / CS;
        UV[t * 6 + k2 * 2] = along / it.n;
        UV[t * 6 + k2 * 2 + 1] = (it.y + pad + Math.min(1, Math.max(0, cross)) * it.h) / S;
      }
    }
  }
  const total = items.reduce((a, it) => a + it.area, 0) || 1;
  const textured = items.filter((it) => it.kind !== 'swatch').reduce((a, it) => a + it.area, 0);
  const cutoutTri = new Uint8Array(s.n);
  for (const it of items) if (it.cutout) for (const t of it.tris) cutoutTri[t] = 1;
  log.push(`atlas ${S}px (k ${k.toFixed(2)} px/m): ${counts.cell} cells, ${counts.bandU + counts.bandV} bands, ${counts.swatch} swatches${counts.dropped ? `, dropped ${counts.dropped} tiled cutout tris` : ''}${cutoutAny ? ', alpha cutouts' : ''}; textured ${(100 * textured / total).toFixed(0)}% of area`);
  return { atlas, S, UV, cutoutAny, cutoutTri, dropTri, texturedShare: textured / total };
}

// ---------------------------------------------------------------------------------------------
// 6. output GLB
// ---------------------------------------------------------------------------------------------
function weldTris(s, UV, triList) {
  const map = new Map();
  const pos = [], nrm = [], uv = [], idx = [];
  const q = (v, f) => Math.round(v * f);
  for (const t of triList) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3, u = t * 6 + k * 2;
      const key = `${q(s.P[o], 1e3)},${q(s.P[o + 1], 1e3)},${q(s.P[o + 2], 1e3)},${q(s.N[o], 1e3)},${q(s.N[o + 1], 1e3)},${q(s.N[o + 2], 1e3)},${q(UV[u], 1e5)},${q(UV[u + 1], 1e5)}`;
      let i = map.get(key);
      if (i === undefined) {
        i = pos.length / 3;
        map.set(key, i);
        pos.push(s.P[o], s.P[o + 1], s.P[o + 2]);
        nrm.push(s.N[o], s.N[o + 1], s.N[o + 2]);
        uv.push(UV[u], UV[u + 1]);
      }
      idx.push(i);
    }
  }
  return { pos, nrm, uv, idx };
}

async function writeGlb(id, s, at, outPath) {
  const doc = new Document();
  doc.createBuffer();
  doc.createExtension(EXTTextureWebP).setRequired(true);
  let img = sharp(at.atlas, { raw: { width: at.S, height: at.S, channels: 4 } });
  if (!at.cutoutAny) img = img.removeAlpha();
  const webp = await img.webp({ quality: PROC.webpQuality, alphaQuality: 90, effort: 6 }).toBuffer();
  const tex = doc.createTexture('atlas').setImage(webp).setMimeType('image/webp');
  const mkMat = (name, cutout) => {
    const m = doc.createMaterial(name).setBaseColorTexture(tex).setRoughnessFactor(0.85).setMetallicFactor(0).setDoubleSided(true);
    if (cutout) m.setAlphaMode('MASK').setAlphaCutoff(0.5);
    m.getBaseColorTextureInfo().setWrapS(10497).setWrapT(33071).setMagFilter(9729).setMinFilter(9987);
    return m;
  };
  const mesh = doc.createMesh(id);
  const lists = [[], []];
  for (let t = 0; t < s.n; t++) if (!at.dropTri[t]) lists[at.cutoutTri[t] ? 1 : 0].push(t);
  let tris = 0;
  for (const [li, list] of lists.entries()) {
    if (!list.length) continue;
    const w = weldTris(s, at.UV, list);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(w.pos)))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(w.nrm)))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(w.uv)))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(w.pos.length / 3 > 65535 ? new Uint32Array(w.idx) : new Uint16Array(w.idx)))
      .setMaterial(mkMat(li ? 'cutout' : 'atlas', li === 1));
    mesh.addPrimitive(prim);
    tris += list.length;
  }
  const node = doc.createNode(id).setMesh(mesh);
  doc.createScene(id).addChild(node);
  doc.getRoot().getAsset().generator = 'SHENZHEN DRIVE scripts/process_city_models.mjs';
  if (USE_MESHOPT) {
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    await doc.transform(meshoptCompress({ encoder: MeshoptEncoder, level: 'medium' }));
  }
  const glb = await io.writeBinary(doc);
  writeFileSync(outPath, glb);
  return { bytes: glb.length, tris, drawCalls: mesh.listPrimitives().length, texBytes: webp.length };
}

// ---------------------------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------------------------
async function processModel(entry, manifest) {
  const id = stem(entry.file);
  const opt = { role: entry.role, ...(entry.process ?? {}) };
  const log = [];
  const src = join(SRC_DIR, entry.file);
  const doc = await io.read(src);
  const { soup: raw, textures, materials, skipped } = await collect(doc);
  if (skipped) log.push(`skipped ${skipped} non-triangle primitives`);
  const cropped = cropSoup(raw, opt, log);
  const g = cleanGround(cropped, materials, opt, log);
  let s = g.soup;
  const d = dedupeFaces(s);
  s = d.soup;
  const or = PROC.orient ? orientOutward(s) : { flipped: 0, fixedN: 0 };
  log.push(`faces: ${d.dups} coincident duplicates removed, ${or.flipped} flipped outward, ${or.fixedN} vertex normals re-derived`);
  // re-origin: y0 -> 0, centroid of the footprint hull -> x = z = 0
  let height = 0;
  for (let i = 0; i < s.n * 3; i++) {
    s.P[i * 3 + 1] -= g.y0;
    height = Math.max(height, s.P[i * 3 + 1]);
  }
  const hMin = Math.min(PROC.footprintMinHeight, 0.3 * height);
  // all vertices of faces reaching above hMin (walls bring their ground corners, a pyramid its base)
  const high = [];
  for (let t = 0; t < s.n; t++) {
    const o = t * 9;
    if (Math.max(s.P[o + 1], s.P[o + 4], s.P[o + 7]) <= hMin) continue;
    for (let k = 0; k < 3; k++) high.push([s.P[o + k * 3], s.P[o + k * 3 + 2]]);
  }
  const hull0 = convexHull(high);
  const [cx, cz] = polyCentroid(hull0);
  for (let i = 0; i < s.n * 3; i++) {
    s.P[i * 3] -= cx;
    s.P[i * 3 + 2] -= cz;
  }
  const hull = hull0.map(([x, z]) => [r1(x - cx), r1(z - cz)]);
  const sil = silhouette(s, hMin, PROC.silhouetteCell);
  const towerSil = silhouette(s, 0.5 * height, PROC.silhouetteCell);
  const at = await buildAtlas(s, materials, textures, opt, log);
  const out = join(OUT_DIR, `${id}.glb`);
  const w = await writeGlb(id, s, at, out);
  const man = manifest.get(entry.file) ?? {};
  const photo = opt.photo ?? (!PROC.cleanAuthors.includes(man.author) && at.texturedShare >= PROC.photoMinShare);
  return {
    id,
    file: `${DEF.outDir.replace(/^public\//, '')}/${id}.glb`,
    source: entry.file,
    role: entry.role,
    bytes: w.bytes,
    texBytes: w.texBytes,
    tris: w.tris,
    drawCalls: w.drawCalls,
    height: r1(height),
    atlas: at.S,
    photoTextured: photo,
    texturedShare: Math.round(at.texturedShare * 100) / 100,
    nativeOrigin: [r1(-cx), r1(-cz)],
    groundOffset: Math.round(g.y0 * 100) / 100,
    groundHow: g.groundHow,
    footprint: hull,
    footprintArea: Math.round(polyArea(hull)),
    silhouette: sil,
    silhouetteArea: Math.round(sil.reduce((a, r) => a + polyArea(r), 0)),
    towerSilhouette: towerSil,
    flipped: or.flipped,
    lat: man.lat,
    lon: man.lon,
    credit: { title: man.title, author: man.author, url: man.url, license: man.license },
    log,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = new Map(JSON.parse(readFileSync(join(SRC_DIR, 'manifest.json'), 'utf8')).map((m) => [m.file, m]));
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { models: {} };
  const entries = CFG.cityModels.filter((e) => e.enabled !== false && (!ONLY || ONLY.includes(stem(e.file))));
  const t0 = Date.now();
  for (const e of entries) {
    const t1 = Date.now();
    try {
      const r = await processModel(e, manifest);
      index.models[r.id] = r;
      console.log(`[${r.id}] ${((Date.now() - t1) / 1000).toFixed(1)}s\n  ${r.log.join('\n  ')}`);
    } catch (err) {
      console.error(`[${stem(e.file)}] FAILED: ${err.stack}`);
      process.exitCode = 1;
    }
  }
  // keep metadata only for configured models
  const known = new Set(CFG.cityModels.map((e) => stem(e.file)));
  for (const k of Object.keys(index.models)) if (!known.has(k)) delete index.models[k];
  index.generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  index.note = 'Per-model metadata written by scripts/process_city_models.mjs. Local frame: origin on the ground at the footprint-hull centroid, native axes (north = -Z), metres. GLB: one mesh; primitive 0 = material atlas (opaque), optional primitive 1 = material cutout (alphaMode MASK); both sample one sRGB WebP atlas (sampler wrapS REPEAT, wrapT CLAMP_TO_EDGE); double-sided, faces oriented outward.';
  const ordered = { generatedAt: index.generatedAt, note: index.note, models: Object.fromEntries(Object.entries(index.models).sort()) };
  writeFileSync(INDEX, JSON.stringify(ordered, null, 1) + '\n');

  const rows = Object.values(ordered.models);
  const pad = (v, n) => String(v).padStart(n);
  console.log(`\n${'model'.padEnd(46)} ${'role'.padEnd(8)} ${pad('tris', 6)} ${pad('dc', 2)} ${pad('KB', 6)} ${pad('texKB', 5)} ${pad('atlas', 5)} ${pad('h m', 6)} photo ${pad('flip', 5)}`);
  let total = 0;
  for (const r of rows) {
    const bytes = existsSync(join(ROOT, 'public', r.file)) ? statSync(join(ROOT, 'public', r.file)).size : 0;
    total += bytes;
    console.log(`${r.id.slice(0, 46).padEnd(46)} ${r.role.padEnd(8)} ${pad(r.tris, 6)} ${pad(r.drawCalls, 2)} ${pad((bytes / 1024).toFixed(0), 6)} ${pad((r.texBytes / 1024).toFixed(0), 5)} ${pad(r.atlas, 5)} ${pad(r.height, 6)} ${r.photoTextured ? ' yes ' : '  -  '} ${pad(r.flipped, 5)}`);
  }
  console.log(`${rows.length} models, ${(total / 1048576).toFixed(2)} MB on disk (budget ${(DEF.maxTotalBytes / 1048576).toFixed(0)} MB), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
