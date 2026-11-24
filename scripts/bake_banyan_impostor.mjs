#!/usr/bin/env node
// Bakes the Chinese banyan model (Sketchfab, Valery.Li, CC BY 4.0) into the street-tree impostor used by
// src/city/props/trees.ts. The raw GLB stays in data-raw/ (gitignored); only the rendered atlases ship.
//
//   node scripts/bake_banyan_impostor.mjs [--src <glb>] [--out public/textures/trees] [--height 12] [--debug <dir>]
//
// 1. Reads the GLB with gltf-transform and moves the spec/gloss diffuse maps to baseColor (three's
//    GLTFLoader no longer reads KHR_materials_pbrSpecularGlossiness; only albedo, alpha and normals matter).
// 2. Serves scripts/bake/banyan_impostor.html (three.js from node_modules through an import map) on a
//    private port and renders it in system Chrome via Playwright (ANGLE/Metal on macOS).
// 3. Dilates colour into transparent texels (no dark fringes under filtering / mipmaps), writes
//    banyan_color.webp (albedo + coverage), banyan_normal.webp (frame-space normal + sky visibility)
//    and banyan.json (frame layout and real-world size).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const v = process.argv[i + 1];
  args[a.slice(2)] = v && !v.startsWith('--') ? (i++, v) : true;
}
const SRC = path.resolve(ROOT, args.src ?? 'data-raw/assets/sketchfab/chinese_banyan_ficus_microcarpa.glb');
const OUT = path.resolve(ROOT, args.out ?? 'public/textures/trees');
const DEBUG = args.debug ? path.resolve(ROOT, args.debug) : null;
/** Height (m) of the tree the impostor represents at instance scale 1 (深南大道 banyans: ~10–16 m). */
const HEIGHT = Number(args.height ?? 12);

const CONFIG = {
  frames: 16,
  cols: 4,
  rows: 4,
  framePx: 512,
  normalPx: 256,
  supersample: 4,
  aoLights: 64,
  groundBounce: 0.3,
  shadowMapSize: 4096,
  marginFrac: 0.015,
  /** Blend of foliage card normals toward the canopy ellipsoid normal, and its upward tilt. */
  bendLeaf: 0.7,
  bendTwig: 0.6,
  bendVine: 0.35,
  bendUp: 0.15,
  /** Aerial roots end between these fractions of the canopy base height (pruned street tree). */
  vineCutLo: 0.45,
  vineCutHi: 0.9,
  /** Bark farther than this from the trunk axis (model m) is aerial-root strands and gets the same cut. */
  barkCutRadius: 2.6,
  /** Linear albedo multipliers: leaves toward a deeper 小叶榕 green, bark / roots toward grey-brown. */
  gradeLeaf: [0.92, 1.18, 0.78],
  gradeBark: [0.8, 0.78, 0.76],
  /** Authored tree node; its origin (FBX z = 0) is the ground plane. */
  groundNode: 'ChineseBanyan_Med',
};

const CREDIT = {
  title: 'Chinese Banyan (Ficus Microcarpa)',
  author: 'Valery.Li',
  url: 'https://sketchfab.com/3d-models/chinese-banyan-ficus-microcarpa-2a0dbcdf8f5d48f5ad79987c7a8170ce',
  license: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
  changes: 'Rendered into a 16-azimuth impostor atlas (albedo, normals, ambient occlusion); the original mesh and textures are not shipped.',
};

async function convertModel() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(SRC);
  for (const m of doc.getRoot().listMaterials()) {
    const sg = m.getExtension('KHR_materials_pbrSpecularGlossiness');
    if (!sg) continue;
    const info = sg.getDiffuseTextureInfo();
    m.setBaseColorTexture(sg.getDiffuseTexture());
    if (info) m.getBaseColorTextureInfo().setTexCoord(info.getTexCoord());
    m.setBaseColorFactor(sg.getDiffuseFactor());
    m.setMetallicFactor(0);
    m.setRoughnessFactor(1 - sg.getGlossinessFactor());
    m.setExtension('KHR_materials_pbrSpecularGlossiness', null);
  }
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'KHR_materials_pbrSpecularGlossiness') ext.dispose();
  return Buffer.from(await io.writeBinary(doc));
}

function serve(glb) {
  const uploads = {};
  const three = path.join(ROOT, 'node_modules/three');
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname.startsWith('/upload/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        uploads[url.pathname.slice(8)] = { w: +url.searchParams.get('w'), h: +url.searchParams.get('h'), data: Buffer.concat(chunks) };
        res.end('ok');
      });
      return;
    }
    let file = null;
    if (url.pathname === '/bake.html') file = path.join(ROOT, 'scripts/bake/banyan_impostor.html');
    else if (url.pathname.startsWith('/three/')) file = path.join(three, path.normalize(url.pathname.slice(7)));
    if (url.pathname === '/bake-config.json') return res.end(JSON.stringify(CONFIG));
    if (url.pathname === '/model.glb') return res.end(glb);
    if (!file || !file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, uploads, port: server.address().port })));
}

/** GL rows are bottom-up; images are top-down. */
function flipRows(buf, w, h) {
  const out = Buffer.alloc(buf.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) buf.copy(out, (h - 1 - y) * row, y * row, (y + 1) * row);
  return out;
}

/** Breadth-first fill of invalid texels with the mean of their valid 8-neighbours (all channels in `ch`). */
function dilate(px, w, h, valid, ch) {
  const n = w * h;
  const queued = new Uint8Array(n);
  let frontier = [];
  const nb = (i, cb) => {
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx || dy) && xx >= 0 && xx < w) cb(yy * w + xx);
      }
    }
  };
  for (let i = 0; i < n; i++) {
    if (valid[i]) continue;
    let any = false;
    nb(i, (j) => (any ||= !!valid[j]));
    if (any) {
      queued[i] = 1;
      frontier.push(i);
    }
  }
  const acc = new Float64Array(4);
  while (frontier.length) {
    const vals = new Uint8Array(frontier.length * 4);
    frontier.forEach((i, f) => {
      acc.fill(0);
      let cnt = 0;
      nb(i, (j) => {
        if (!valid[j]) return;
        cnt++;
        for (const c of ch) acc[c] += px[j * 4 + c];
      });
      for (const c of ch) vals[f * 4 + c] = Math.round(acc[c] / cnt);
    });
    const next = [];
    frontier.forEach((i, f) => {
      for (const c of ch) px[i * 4 + c] = vals[f * 4 + c];
      valid[i] = 1;
    });
    for (const i of frontier) {
      nb(i, (j) => {
        if (!valid[j] && !queued[j]) {
          queued[j] = 1;
          next.push(j);
        }
      });
    }
    frontier = next;
  }
}

const t0 = Date.now();
const glb = await convertModel();
const { server, uploads, port } = await serve(glb);
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('console', (m) => {
    if (/\[bake\]/.test(m.text()) || m.type() === 'error') console.log(m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/bake.html`);
  await page.waitForFunction(() => window.__BAKE__?.done || window.__BAKE__?.error, null, { timeout: 600000 });
  const err = await page.evaluate(() => window.__BAKE__.error);
  if (err) throw new Error(err);
} finally {
  await browser.close();
  server.close();
}

const meta = JSON.parse(uploads.meta.data.toString());
const col = uploads.color;
const nor = uploads.normal;
const color = flipRows(col.data, col.w, col.h);
const normal = flipRows(nor.data, nor.w, nor.h);

const cValid = new Uint8Array(col.w * col.h);
for (let i = 0; i < cValid.length; i++) cValid[i] = color[i * 4 + 3] > 0 ? 1 : 0;
const nValid = new Uint8Array(nor.w * nor.h);
for (let i = 0; i < nValid.length; i++) nValid[i] = normal[i * 4] | normal[i * 4 + 1] | normal[i * 4 + 2] ? 1 : 0;
dilate(color, col.w, col.h, cValid, [0, 1, 2]);
dilate(normal, nor.w, nor.h, nValid, [0, 1, 2, 3]);

fs.mkdirSync(OUT, { recursive: true });
const raw = (buf, w, h) => sharp(buf, { raw: { width: w, height: h, channels: 4 } });
await raw(color, col.w, col.h).webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(path.join(OUT, 'banyan_color.webp'));
await raw(normal, nor.w, nor.h).webp({ quality: 92, alphaQuality: 100, effort: 6 }).toFile(path.join(OUT, 'banyan_normal.webp'));

const k = HEIGHT / meta.top;
const r2 = (v) => Math.round(v * 100) / 100;
const json = {
  version: 1,
  source: CREDIT,
  color: 'banyan_color.webp',
  normal: 'banyan_normal.webp',
  frames: CONFIG.frames,
  cols: CONFIG.cols,
  rows: CONFIG.rows,
  framePx: CONFIG.framePx,
  normalFramePx: CONFIG.normalPx,
  layout: 'frame k is the view from tree-local azimuth k * 360 / frames degrees (0 = +z, 90 = +x), orthographic and horizontal; column k % cols, row floor(k / cols), row 0 at the top of the image',
  colorEncoding: 'sRGB albedo (unlit), alpha = coverage',
  normalEncoding: 'rgb = frame-space normal * 0.5 + 0.5 (x right, y up, z toward the viewer), foliage bent toward the canopy ellipsoid; a = sky visibility',
  height: r2(HEIGHT),
  canopyRadius: r2(meta.radius * k),
  canopyBottom: r2(meta.canopyBottom * k),
  /** Frame rectangle (m) around the trunk axis: x in [-size / 2, size / 2], y in [bottom, bottom + size]. */
  quad: { size: r2(meta.size * k), bottom: r2(meta.bottom * k) },
  model: { height: r2(meta.top), radius: r2(meta.radius), tris: meta.tris, scale: Math.round(k * 1e4) / 1e4 },
};
fs.writeFileSync(path.join(OUT, 'banyan.json'), `${JSON.stringify(json, null, 1)}\n`);

if (DEBUG) {
  fs.mkdirSync(DEBUG, { recursive: true });
  await raw(color, col.w, col.h).flatten({ background: '#7f8a94' }).png().toFile(path.join(DEBUG, 'color_on_grey.png'));
  await raw(color, col.w, col.h).removeAlpha().png().toFile(path.join(DEBUG, 'color_rgb.png'));
  await raw(normal, nor.w, nor.h).removeAlpha().png().toFile(path.join(DEBUG, 'normal_rgb.png'));
  await raw(normal, nor.w, nor.h).extractChannel(3).png().toFile(path.join(DEBUG, 'ao.png'));
  fs.writeFileSync(path.join(DEBUG, 'meta.json'), JSON.stringify(meta, null, 1));
}
const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
console.log(`[bake] done in ${((Date.now() - t0) / 1000).toFixed(1)} s: banyan_color.webp ${size('banyan_color.webp')} KB, banyan_normal.webp ${size('banyan_normal.webp')} KB`);
console.log(`[bake] model ${meta.top.toFixed(2)} m tall, radius ${meta.radius.toFixed(2)} m, ${meta.tris} tris → impostor ${HEIGHT} m, canopy radius ${json.canopyRadius} m`);
