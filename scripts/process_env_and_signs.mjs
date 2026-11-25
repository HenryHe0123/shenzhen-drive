// Processes downloaded raw assets (data-raw/assets/, never committed) into the files the game ships:
//   env:   data-raw/assets/hdri/<name>_2k.hdr → public/textures/env/<name>_1k.hdr (see HDRIS)
//          (2×2 box downsample in linear float, luminance capped, RLE RGBE; prints the sun / brightest-sky
//          equirect u that a scene.environmentRotation needs to put the map's sun at a preset's azimuth)
//   signs: data-raw/assets/sketchfab/chinese_road_signs_32_road_signs_and_more.glb → public/textures/signs/*.png
//          (base color texture of each chosen sign, flipped upright, cropped to the sign face, 248 px)
// Usage: node scripts/process_env_and_signs.mjs [signs] [env] [--preview <dir>]   (default: signs)
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW = path.join(ROOT, 'data-raw/assets');
const args = process.argv.slice(2);
const previewDir = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : null;
const parts = args.filter((a) => a === 'env' || a === 'signs');
const run = (p) => (parts.length === 0 ? p === 'signs' : parts.includes(p));

// ---------------------------------------------------------------- Radiance RGBE

function readHdr(buf) {
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < buf.length && buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
    pos++;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance file');
  for (let l = line(); l !== ''; l = line()) {
    if (l.startsWith('FORMAT=') && l !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`unsupported ${l}`);
  }
  const m = line().match(/^-Y (\d+) \+X (\d+)$/);
  if (!m) throw new Error('unsupported orientation');
  const H = +m[1];
  const W = +m[2];
  const rgb = new Float32Array(W * H * 3);
  const scan = new Uint8Array(W * 4);
  for (let y = 0; y < H; y++) {
    if (buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === W) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        for (let x = 0; x < W; ) {
          let n = buf[pos++];
          if (n > 128) {
            n -= 128;
            const v = buf[pos++];
            while (n--) scan[x++ * 4 + c] = v;
          } else {
            while (n--) scan[x++ * 4 + c] = buf[pos++];
          }
        }
      }
    } else {
      scan.set(buf.subarray(pos, pos + W * 4));
      pos += W * 4;
    }
    for (let x = 0; x < W; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? 2 ** (e - 136) : 0;
      const o = (y * W + x) * 3;
      rgb[o] = e ? (scan[x * 4] + 0.5) * f : 0;
      rgb[o + 1] = e ? (scan[x * 4 + 1] + 0.5) * f : 0;
      rgb[o + 2] = e ? (scan[x * 4 + 2] + 0.5) * f : 0;
    }
  }
  return { W, H, rgb };
}

function rleChannel(src, out) {
  const n = src.length;
  for (let i = 0; i < n; ) {
    let run = 1;
    while (i + run < n && run < 127 && src[i + run] === src[i]) run++;
    if (run >= 4) {
      out.push(128 + run, src[i]);
      i += run;
      continue;
    }
    let lit = 0;
    while (i + lit < n && lit < 128) {
      let r = 1;
      while (i + lit + r < n && r < 4 && src[i + lit + r] === src[i + lit]) r++;
      if (r >= 4) break;
      lit++;
    }
    out.push(lit);
    for (let k = 0; k < lit; k++) out.push(src[i + k]);
    i += lit;
  }
}

function writeHdr({ W, H, rgb }) {
  const out = [...Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`, 'latin1')];
  const ch = [0, 1, 2, 3].map(() => new Uint8Array(W));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const v = Math.max(rgb[o], rgb[o + 1], rgb[o + 2]);
      if (v < 1e-32) {
        ch[0][x] = ch[1][x] = ch[2][x] = ch[3][x] = 0;
        continue;
      }
      let e = Math.floor(Math.log2(v)) + 1;
      let k = 256 / 2 ** e;
      if (v * k >= 256) {
        e++;
        k /= 2;
      }
      ch[0][x] = Math.min(255, Math.floor(rgb[o] * k));
      ch[1][x] = Math.min(255, Math.floor(rgb[o + 1] * k));
      ch[2][x] = Math.min(255, Math.floor(rgb[o + 2] * k));
      ch[3][x] = e + 128;
    }
    out.push(2, 2, W >> 8, W & 255);
    for (const c of ch) rleChannel(c, out);
  }
  return Buffer.from(out);
}

function downsample2({ W, H, rgb }) {
  const w = W >> 1;
  const h = H >> 1;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const a = (2 * y * W + 2 * x) * 3 + c;
        out[(y * w + x) * 3 + c] = (rgb[a] + rgb[a + 3] + rgb[a + W * 3] + rgb[a + W * 3 + 3]) / 4;
      }
    }
  }
  return { W: w, H: h, rgb: out };
}

const lum = (rgb, o) => 0.2126 * rgb[o] + 0.7152 * rgb[o + 1] + 0.0722 * rgb[o + 2];

/**
 * Direction of the sun (luminance-weighted centroid of the brightest 0.02 % of pixels) and of the
 * brightest sky (45°–70° elevation, per 5° of azimuth), as equirect u
 * (three.js equirectUv: u = atan2(z, x) / 2π + 0.5) and elevation.
 */
function analyze({ W, H, rgb }) {
  const n = W * H;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lum(rgb, i * 3);
  const sorted = Float32Array.from(L).sort();
  const thr = sorted[Math.floor(n * 0.9998)];
  let sx = 0;
  let sy = 0;
  let sv = 0;
  let sw = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = L[y * W + x];
      if (v < thr) continue;
      const a = ((x + 0.5) / W) * 2 * Math.PI;
      sx += Math.cos(a) * v;
      sy += Math.sin(a) * v;
      sv += (0.5 - (y + 0.5) / H) * 180 * v;
      sw += v;
    }
  }
  const sunU = ((Math.atan2(sy, sx) / (2 * Math.PI)) % 1 + 1) % 1;
  // Above the building tops of both maps (the bund's nearest facade reaches ~44°).
  const bins = new Float64Array(72);
  const wsum = new Float64Array(72);
  for (let y = 0; y < H; y++) {
    const el = (0.5 - (y + 0.5) / H) * 180;
    if (el < 45 || el > 70) continue;
    const w = Math.cos((el * Math.PI) / 180);
    for (let x = 0; x < W; x++) {
      const b = Math.floor((x / W) * 72);
      bins[b] += Math.min(L[y * W + x], thr) * w;
      wsum[b] += w;
    }
  }
  let best = 0;
  for (let b = 1; b < 72; b++) if (bins[b] / wsum[b] > bins[best] / wsum[best]) best = b;
  /** Mean luminance (solid-angle weighted, sun clamped) between two elevations (deg). */
  const band = (e0, e1) => {
    let s = 0;
    let w = 0;
    for (let y = 0; y < H; y++) {
      const el = (0.5 - (y + 0.5) / H) * 180;
      if (el < e0 || el > e1) continue;
      const k = Math.cos((el * Math.PI) / 180);
      for (let x = 0; x < W; x++) {
        s += Math.min(L[y * W + x], thr) * k;
        w += k;
      }
    }
    return +(s / w).toFixed(4);
  };
  return {
    sunU: +sunU.toFixed(4),
    sunElevationDeg: +(sv / sw).toFixed(1),
    peak: +sorted[n - 1].toFixed(1),
    brightSkyU: +((best + 0.5) / 72).toFixed(4),
    sky: band(15, 90),
    horizon: band(-5, 15),
    ground: band(-90, -5),
  };
}

async function previewPng({ W, H, rgb }, file, exposure) {
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) {
    const v = rgb[i] * exposure;
    px[i] = Math.round(255 * Math.min(1, (v / (1 + v)) ** (1 / 2.2)));
  }
  await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}

/**
 * Shipped maps: shanghai_riverside (golden preset car reflections, src/render/reflectionEnv.ts).
 * shanghai_bund went with the retired dusk preset. maxLum caps pixel luminance (hue kept): the
 * sunset sun is a few hundred times the sky and would only add fireflies to the PMREM and bloom.
 */
const HDRIS = [{ name: 'shanghai_riverside', maxLum: 24 }];

function clampLum({ rgb }, maxLum) {
  let n = 0;
  for (let o = 0; o < rgb.length; o += 3) {
    for (let c = 0; c < 3; c++) if (!Number.isFinite(rgb[o + c]) || rgb[o + c] < 0) rgb[o + c] = 0;
    const L = lum(rgb, o);
    if (L <= maxLum) continue;
    const k = maxLum / L;
    rgb[o] *= k;
    rgb[o + 1] *= k;
    rgb[o + 2] *= k;
    n++;
  }
  return n;
}

async function processEnv() {
  const outDir = path.join(ROOT, 'public/textures/env');
  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, maxLum } of HDRIS) {
    const src = path.join(RAW, 'hdri', `${name}_2k.hdr`);
    const full = readHdr(fs.readFileSync(src));
    const half = downsample2(full);
    const raw = analyze(half);
    const clamped = clampLum(half, maxLum);
    console.log(`[env] ${name}: sun at u ${raw.sunU}, elevation ${raw.sunElevationDeg}°, peak ${raw.peak} → ${clamped} px clamped to luminance ${maxLum}`);
    const bytes = writeHdr(half);
    const dst = path.join(outDir, `${name}_1k.hdr`);
    fs.writeFileSync(dst, bytes);
    // RGBE shares one exponent per pixel, so the error is relative to the brightest channel.
    const back = readHdr(bytes);
    let err = 0;
    for (let i = 0; i < back.rgb.length; i += 3) {
      const m = Math.max(1e-4, half.rgb[i], half.rgb[i + 1], half.rgb[i + 2]);
      for (let c = 0; c < 3; c++) err = Math.max(err, Math.abs(back.rgb[i + c] - half.rgb[i + c]) / m);
    }
    const info = analyze(half);
    console.log(`[env] ${path.relative(ROOT, dst)} ${half.W}x${half.H} ${(bytes.length / 1024).toFixed(0)} KB (round trip max err ${(err * 100).toFixed(2)} % of pixel max)`, JSON.stringify(info));
    if (previewDir) {
      fs.mkdirSync(previewDir, { recursive: true });
      await previewPng(half, path.join(previewDir, `${name}.png`), name.includes('bund') ? 2 : 0.5);
    }
  }
}

// ---------------------------------------------------------------- Road signs

/**
 * Sign face regions in the pack's 1024² base color textures (pixels of the stored image). Every face
 * sits in the left half (the right half is the galvanised back) and is stored upside down: the meshes
 * map image-down to world-up. Centres come from the mesh UVs, refined on the thin dark outline the
 * textures draw around each face; the crop stays inside the white rim, just within that outline.
 */
const FACE = {
  // Base_LP_50_circle*: outline at radius 225.5 px around (279.5, 511.5).
  circle: { cx: 279.5, cy: 511.5, half: 223.5, corner: 0 },
  // Base_LP_square*: outline at x 32 / 505, y 274.5 / 748; rounded corners.
  square: { cx: 269, cy: 511.75, half: 234, corner: 14 },
};

/** Output name → pack material and face shape. */
const SIGNS = {
  straight: { material: 'Proceed_straight', shape: 'circle' },
  turn_left: { material: 'Turn_left', shape: 'circle' },
  turn_right: { material: 'Turn_right', shape: 'circle' },
  straight_left: { material: 'Proceed_straight_or_left', shape: 'circle' },
  straight_right: { material: 'Proceed_straight_or_right', shape: 'circle' },
  keep_right: { material: 'Keep_right_side_only', shape: 'circle' },
  no_stopping: { material: 'No_stopping', shape: 'circle' },
  no_parking: { material: 'No_parking', shape: 'circle' },
  no_u_turn: { material: 'No_u_turn', shape: 'circle' },
  no_left_turn: { material: 'No_left_turn', shape: 'circle' },
  crosswalk: { material: 'Crosswalk', shape: 'square' },
};

/** Output size (px); the runtime atlas pads each sign to a 256 px cell. */
const SIGN_PX = 248;

async function processSigns() {
  const src = path.join(RAW, 'sketchfab/chinese_road_signs_32_road_signs_and_more.glb');
  const doc = await new NodeIO().read(src);
  const materials = new Map(doc.getRoot().listMaterials().map((m) => [m.getName(), m]));
  const outDir = path.join(ROOT, 'public/textures/signs');
  fs.mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (const [name, { material, shape }] of Object.entries(SIGNS)) {
    const tex = materials.get(material)?.getBaseColorTexture();
    if (!tex) throw new Error(`material ${material} has no base color texture`);
    const f = FACE[shape];
    const size = Math.round(2 * f.half);
    const face = await sharp(Buffer.from(tex.getImage()))
      .extract({ left: Math.round(f.cx - f.half), top: Math.round(f.cy - f.half), width: size, height: size })
      .png()
      .toBuffer();
    const { data } = await sharp(face)
      .flip()
      .resize(SIGN_PX, SIGN_PX, { kernel: 'lanczos3' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Outside the disc / rounded corners: the rim's white instead of the texture background, so
    // mip filtering at the panel edge never pulls in grey.
    const c = (SIGN_PX - 1) / 2;
    const R = SIGN_PX / 2 - 0.5;
    const rc = shape === 'circle' ? R : (f.corner * SIGN_PX) / size;
    for (let y = 0; y < SIGN_PX; y++) {
      for (let x = 0; x < SIGN_PX; x++) {
        const qx = Math.max(0, Math.abs(x - c) - (R - rc));
        const qy = Math.max(0, Math.abs(y - c) - (R - rc));
        const t = Math.min(1, Math.max(0, Math.hypot(qx, qy) - (rc - 1)));
        if (t <= 0) continue;
        const o = (y * SIGN_PX + x) * 3;
        for (let k = 0; k < 3; k++) data[o + k] = Math.round(data[o + k] * (1 - t) + 250 * t);
      }
    }
    const dst = path.join(outDir, `${name}.png`);
    const png = await sharp(data, { raw: { width: SIGN_PX, height: SIGN_PX, channels: 3 } })
      .png({ palette: true, colours: 96, dither: 0.6, compressionLevel: 9, effort: 10 })
      .toBuffer();
    fs.writeFileSync(dst, png);
    total += png.length;
    console.log(`[signs] ${path.relative(ROOT, dst)} ← ${material} (${shape}) ${(png.length / 1024).toFixed(1)} KB`);
  }
  console.log(`[signs] ${Object.keys(SIGNS).length} signs, ${(total / 1024).toFixed(0)} KB`);
}

if (run('env')) await processEnv();
if (run('signs')) await processSigns();
