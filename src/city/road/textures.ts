import * as THREE from 'three';

export type Rand = () => number;

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

export function canvasTexture(
  c: HTMLCanvasElement,
  opts: { srgb?: boolean; repeat?: boolean; aniso?: number } = {},
): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = opts.aniso ?? 8;
  return t;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Tileable smooth value noise in [0, 1] with cx × cy cells per tile. */
function tileNoise(w: number, h: number, cx: number, cy: number, rand: Rand): Float32Array {
  const grid = new Float32Array(cx * cy);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * cy;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    const sy = fy * fy * (3 - 2 * fy);
    const r0 = (y0 % cy) * cx;
    const r1 = ((y0 + 1) % cy) * cx;
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * cx;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const sx = fx * fx * (3 - 2 * fx);
      const c0 = x0 % cx;
      const c1 = (x0 + 1) % cx;
      const a = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * sx;
      const b = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * sx;
      out[y * w + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Tileable fBm; `aspect` = cells along y per cell along x. */
export function fbm(w: number, h: number, base: number, octaves: number, rand: Rand, aspect = 1): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = base << o;
    const n = tileNoise(w, h, cx, Math.max(1, Math.round(cx * aspect)), rand);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Wrapped polyline stroke so the pattern stays tileable. */
function strokeWrapped(ctx: CanvasRenderingContext2D, pts: number[][], w: number, h: number) {
  for (const ox of [-w, 0, w]) {
    for (const oy of [-h, 0, h]) {
      ctx.beginPath();
      pts.forEach((p, j) => (j ? ctx.lineTo(p[0] + ox, p[1] + oy) : ctx.moveTo(p[0] + ox, p[1] + oy)));
      ctx.stroke();
    }
  }
}

/**
 * Asphalt tile covering one lane (3.5 m across, u) × 7 m along the road (v):
 * u = (d - dMin) / 3.5 lines the polished wheel tracks and the darker oil strip up with the lanes.
 */
export function asphaltTextures(aniso: number) {
  const W = 512;
  const H = 1024;
  const rand = mulberry32(7);
  const low = fbm(W, H, 2, 5, rand, 2);
  const oilN = fbm(W, H, 2, 3, rand, 2);
  const [cc, cx] = makeCanvas(W, H);
  const [rc, rx] = makeCanvas(W, H);
  const col = cx.createImageData(W, H);
  const rough = rx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = (x + 0.5) / W;
      const track = Math.exp(-(((u - 0.27) / 0.06) ** 2)) + Math.exp(-(((u - 0.73) / 0.06) ** 2));
      const oil = Math.exp(-(((u - 0.5) / 0.05) ** 2)) * Math.max(0, oilN[i] - 0.42) * 2.2;
      const g = rand() - 0.5;
      const v = 0.3 + (low[i] - 0.5) * 0.12 + g * 0.08 + track * 0.035 - oil * 0.07;
      const o = i * 4;
      col.data[o] = clamp255(v * 247);
      col.data[o + 1] = clamp255(v * 252);
      col.data[o + 2] = clamp255(v * 268);
      col.data[o + 3] = 255;
      const r = clamp255((0.92 + g * 0.1 - track * 0.14 - oil * 0.3) * 255);
      rough.data[o] = r;
      rough.data[o + 1] = r;
      rough.data[o + 2] = r;
      rough.data[o + 3] = 255;
    }
  }
  for (let k = 0; k < 16000; k++) {
    const x = (rand() * W) | 0;
    const y = (rand() * H) | 0;
    const light = rand() < 0.6;
    const v = light ? 0.42 + rand() * 0.22 : 0.1 + rand() * 0.06;
    const sz = rand() < 0.25 ? 2 : 1;
    for (let dy = 0; dy < sz; dy++) {
      for (let dx = 0; dx < sz; dx++) {
        const o = (((y + dy) % H) * W + ((x + dx) % W)) * 4;
        col.data[o] = clamp255(v * 250);
        col.data[o + 1] = clamp255(v * 250);
        col.data[o + 2] = clamp255(v * 258);
      }
    }
  }
  cx.putImageData(col, 0, 0);
  rx.putImageData(rough, 0, 0);
  cx.strokeStyle = 'rgba(14,14,16,0.5)';
  cx.lineWidth = 1.3;
  for (let k = 0; k < 6; k++) {
    let x = rand() * W;
    let y = rand() * H;
    let ang = rand() * Math.PI * 2;
    const pts = [[x, y]];
    for (let j = 0; j < 12; j++) {
      ang += (rand() - 0.5) * 1.0;
      x += Math.cos(ang) * 10;
      y += Math.sin(ang) * 10;
      pts.push([x, y]);
    }
    strokeWrapped(cx, pts, W, H);
  }
  return { map: canvasTexture(cc, { aniso }), rough: canvasTexture(rc, { srgb: false, aniso }) };
}

/** Granite sidewalk slabs, 2 m × 2 m tile (running bond of 0.5 × 0.25 m slabs). */
export function pavingTexture(aniso: number) {
  const S = 512;
  const rand = mulberry32(21);
  const low = fbm(S, S, 2, 4, rand);
  const [c, ctx] = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const rows = 8;
  const cols = 4;
  const rh = S / rows;
  const cw = S / cols;
  const tones = new Float32Array(rows * cols);
  for (let i = 0; i < tones.length; i++) tones[i] = 0.84 + rand() * 0.32;
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / rh);
    const off = (row % 2) * (cw / 2);
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const xx = (x + off) % S;
      const colI = Math.floor(xx / cw);
      const joint = y % rh < 2 || xx % cw < 2;
      const v = joint
        ? 0.3 + rand() * 0.04
        : 0.55 * tones[row * cols + colI] + (low[i] - 0.5) * 0.12 + (rand() - 0.5) * 0.07;
      const o = i * 4;
      img.data[o] = clamp255(v * 255);
      img.data[o + 1] = clamp255(v * 249);
      img.data[o + 2] = clamp255(v * 238);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c, { aniso });
}

/** Grass / foliage, 2 m tile; hedges reuse it with a darker vertex tint. */
export function grassTexture(aniso: number) {
  const S = 256;
  const rand = mulberry32(33);
  const low = fbm(S, S, 2, 4, rand);
  const [c, ctx] = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 0.75 + (low[i] - 0.5) * 0.7 + (rand() - 0.5) * 0.3;
    const o = i * 4;
    img.data[o] = clamp255(52 * v);
    img.data[o + 1] = clamp255(86 * v);
    img.data[o + 2] = clamp255(38 * v);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 2600; k++) {
    const x = rand() * S;
    const y = rand() * S;
    const l = 2 + rand() * 4;
    const a = rand() * Math.PI;
    const light = rand() < 0.5;
    ctx.strokeStyle = light ? `rgba(120,160,70,${0.25 + rand() * 0.3})` : `rgba(18,32,14,${0.3 + rand() * 0.3})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  return canvasTexture(c, { aniso });
}

/** Paint wear for lane markings (mostly white with worn blotches). */
export function wearTexture(aniso: number) {
  const S = 256;
  const rand = mulberry32(44);
  const low = fbm(S, S, 3, 4, rand);
  const [c, ctx] = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const t = Math.min(1, Math.max(0, (low[i] - 0.55) / 0.25));
    const v = 0.95 - 0.45 * t * t - rand() * 0.12;
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = clamp255(v * 255);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c, { aniso });
}

/** Dark city ground (mix of trampled lawn and pavement), 80 m tile. */
export function groundTexture(aniso: number) {
  const S = 512;
  const rand = mulberry32(55);
  const low = fbm(S, S, 3, 5, rand);
  const [c, ctx] = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const m = Math.min(1, Math.max(0, (low[i] - 0.45) / 0.15));
    const g = (rand() - 0.5) * 8;
    const o = i * 4;
    img.data[o] = clamp255(40 + (30 - 40) * m + g);
    img.data[o + 1] = clamp255(41 + (44 - 41) * m + g);
    img.data[o + 2] = clamp255(43 + (30 - 43) * m + g);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c, { aniso });
}
