import * as THREE from 'three';
import { canvasTexture, makeCanvas } from '../road/textures';
import type { UVRect } from './geo';

export const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei",sans-serif';
const SIGN_BLUE = '#0b4fa8';

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
  uv: UVRect;
}

/** Shelf-packed canvas atlas for all sign faces, banners and chevrons (one draw call). */
export class SignAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly grey: UVRect;
  private x = 0;
  private y = 0;
  private rowH = 0;

  constructor(
    readonly W = 2048,
    readonly H = 2048,
  ) {
    [this.canvas, this.ctx] = makeCanvas(W, H);
    const g = this.alloc(16, 16);
    this.ctx.fillStyle = '#6c7076';
    this.ctx.fillRect(g.x - 2, g.y - 2, g.w + 4, g.h + 4);
    this.grey = g.uv;
  }

  alloc(w: number, h: number): Slot {
    const pad = 6;
    w = Math.round(w);
    h = Math.round(h);
    if (this.x + w + pad > this.W) {
      this.x = 0;
      this.y += this.rowH + pad;
      this.rowH = 0;
    }
    if (this.y + h + pad > this.H) {
      console.warn('[props] sign atlas full; reusing the last row');
      this.y = Math.max(0, this.H - h - pad);
    }
    const x = this.x + pad / 2;
    const y = this.y + pad / 2;
    this.x += w + pad;
    this.rowH = Math.max(this.rowH, h);
    // Inset by half a texel so mip filtering does not bleed neighbours into the face.
    const uv: UVRect = [(x + 1) / this.W, 1 - (y + h - 1) / this.H, (x + w - 1) / this.W, 1 - (y + 1) / this.H];
    return { x, y, w, h, uv };
  }

  texture(aniso: number): THREE.CanvasTexture {
    const t = canvasTexture(this.canvas, { repeat: false, aniso });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws text centred at (cx, cy), shrinking the font until it fits maxW. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, weight = 700, family = FONT) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxW && s > 8) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

function blueBase(ctx: CanvasRenderingContext2D, s: Slot) {
  ctx.fillStyle = SIGN_BLUE;
  ctx.fillRect(s.x, s.y, s.w, s.h);
  const b = Math.max(4, s.h * 0.035);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = b;
  roundRect(ctx, s.x + b * 1.6, s.y + b * 1.6, s.w - b * 3.2, s.h - b * 3.2, b * 2.5);
  ctx.stroke();
}

/** Big block arrow pointing left/right/up inside the box (x, y, w, h). */
function blockArrow(ctx: CanvasRenderingContext2D, dir: 'left' | 'right' | 'up', x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(dir === 'left' ? -Math.PI / 2 : dir === 'right' ? Math.PI / 2 : 0);
  const L = Math.min(dir === 'up' ? h : w, dir === 'up' ? w * 1.4 : h * 1.4) * 0.9;
  const sw = L * 0.16;
  const hw = L * 0.36;
  const hl = L * 0.42;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -L / 2);
  ctx.lineTo(hw, -L / 2 + hl);
  ctx.lineTo(sw, -L / 2 + hl);
  ctx.lineTo(sw, L / 2);
  ctx.lineTo(-sw, L / 2);
  ctx.lineTo(-sw, -L / 2 + hl);
  ctx.lineTo(-hw, -L / 2 + hl);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function globeIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = r * 0.09;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  for (const k of [0.45, 0.85]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * k, r, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const k of [-0.5, 0, 0.5]) {
    const yy = cy + k * r;
    const hw = Math.sqrt(1 - k * k) * r;
    ctx.beginPath();
    ctx.moveTo(cx - hw, yy);
    ctx.lineTo(cx + hw, yy);
    ctx.stroke();
  }
  // Self-drawn swoosh orbiting the globe (not any official mark).
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = '#7fd3ff';
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 1.35, r * 0.42, -0.35, Math.PI * 0.9, Math.PI * 2.15);
  ctx.stroke();
  ctx.restore();
}

/** Blue urban guide sign: optional big arrow / icon column, title and subtitle lines. */
export function drawGuide(
  atlas: SignAtlas,
  wPx: number,
  hPx: number,
  title: string,
  sub: string | undefined,
  opts: { arrow?: 'left' | 'right' | 'up'; icon?: 'globe' } = {},
): Slot {
  const s = atlas.alloc(wPx, hPx);
  const ctx = atlas.ctx;
  blueBase(ctx, s);
  let tx = s.x + s.w * 0.06;
  let tw = s.w * 0.88;
  const col = s.h * (opts.arrow === 'up' ? 0.6 : 0.85);
  if (opts.arrow === 'left' || opts.arrow === 'up' || opts.icon) {
    if (opts.arrow) blockArrow(ctx, opts.arrow, s.x + s.w * 0.05, s.y + s.h * 0.1, col, s.h * 0.8);
    else globeIcon(ctx, s.x + s.w * 0.05 + col / 2, s.y + s.h / 2, s.h * 0.27);
    tx = s.x + s.w * 0.05 + col;
    tw = s.w * 0.9 - col;
  }
  if (opts.arrow === 'right') {
    blockArrow(ctx, 'right', s.x + s.w * 0.95 - col, s.y + s.h * 0.1, col, s.h * 0.8);
    tw = s.w * 0.88 - col;
  }
  ctx.fillStyle = '#ffffff';
  if (sub) {
    fitText(ctx, title, tx + tw / 2, s.y + s.h * 0.36, tw, s.h * 0.3, 800);
    fitText(ctx, sub, tx + tw / 2, s.y + s.h * 0.7, tw, s.h * 0.2, 600);
  } else {
    fitText(ctx, title, tx + tw / 2, s.y + s.h * 0.5, tw, s.h * 0.36, 800);
  }
  return s;
}

/** Junction advance sign: cross diagram with the cross street left/right and the boulevard ahead. */
export function drawJunction(atlas: SignAtlas, wPx: number, hPx: number, cross: string, ahead: string): Slot {
  const s = atlas.alloc(wPx, hPx);
  const ctx = atlas.ctx;
  blueBase(ctx, s);
  const cx = s.x + s.w / 2;
  const cyBar = s.y + s.h * 0.56;
  const sw = s.h * 0.08;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - sw / 2, s.y + s.h * 0.34, sw, s.h * 0.52);
  ctx.beginPath();
  ctx.moveTo(cx, s.y + s.h * 0.2);
  ctx.lineTo(cx + sw * 1.6, s.y + s.h * 0.36);
  ctx.lineTo(cx - sw * 1.6, s.y + s.h * 0.36);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(s.x + s.w * 0.12, cyBar - sw / 2, s.w * 0.76, sw);
  for (const sgn of [-1, 1]) {
    const ex = cx + sgn * s.w * 0.4;
    ctx.beginPath();
    ctx.moveTo(ex + sgn * sw * 1.4, cyBar);
    ctx.lineTo(ex - sgn * sw * 0.6, cyBar - sw * 1.5);
    ctx.lineTo(ex - sgn * sw * 0.6, cyBar + sw * 1.5);
    ctx.closePath();
    ctx.fill();
  }
  fitText(ctx, ahead, cx, s.y + s.h * 0.12, s.w * 0.6, s.h * 0.13, 700);
  fitText(ctx, cross, s.x + s.w * 0.25, cyBar + s.h * 0.17, s.w * 0.36, s.h * 0.15, 800);
  fitText(ctx, cross, s.x + s.w * 0.75, cyBar + s.h * 0.17, s.w * 0.36, s.h * 0.15, 800);
  return s;
}

export function drawPlate(atlas: SignAtlas, name: string): Slot {
  const s = atlas.alloc(320, 88);
  const ctx = atlas.ctx;
  blueBase(ctx, s);
  ctx.fillStyle = '#ffffff';
  fitText(ctx, name, s.x + s.w / 2, s.y + s.h * 0.52, s.w * 0.84, s.h * 0.56, 800);
  return s;
}

export function drawBanner(atlas: SignAtlas, wPx: number, hPx: number, text: string, theme: 'start' | 'finish' | 'checkpoint'): Slot {
  const s = atlas.alloc(wPx, hPx);
  const ctx = atlas.ctx;
  if (theme === 'checkpoint') {
    ctx.fillStyle = '#0d1a26';
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = '#38e1ff';
    ctx.lineWidth = s.h * 0.06;
    ctx.strokeRect(s.x + s.h * 0.08, s.y + s.h * 0.08, s.w - s.h * 0.16, s.h - s.h * 0.16);
    ctx.fillStyle = '#7ff0ff';
    fitText(ctx, text, s.x + s.w / 2, s.y + s.h / 2, s.w * 0.9, s.h * 0.56, 700);
    return s;
  }
  const g = ctx.createLinearGradient(s.x, 0, s.x + s.w, 0);
  if (theme === 'start') {
    g.addColorStop(0, '#062a4f');
    g.addColorStop(0.5, '#0a6d8f');
    g.addColorStop(1, '#062a4f');
  } else {
    g.addColorStop(0, '#5a0b16');
    g.addColorStop(0.5, '#b3122a');
    g.addColorStop(1, '#5a0b16');
  }
  ctx.fillStyle = g;
  ctx.fillRect(s.x, s.y, s.w, s.h);
  const q = s.h / 4;
  for (const side of [0, 1]) {
    const x0 = side ? s.x + s.w - q * 4 : s.x;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#111111' : '#f4f4f4';
        ctx.fillRect(x0 + c * q, s.y + r * q, q, q);
      }
    }
  }
  ctx.fillStyle = '#ffffff';
  fitText(ctx, text, s.x + s.w / 2, s.y + s.h * 0.53, s.w - q * 10, s.h * 0.6, 800);
  return s;
}

export function drawChevron(atlas: SignAtlas, dir: 'left' | 'right'): Slot {
  const s = atlas.alloc(128, 160);
  const ctx = atlas.ctx;
  ctx.fillStyle = '#f5c400';
  ctx.fillRect(s.x, s.y, s.w, s.h);
  ctx.fillStyle = '#111111';
  const m = dir === 'left' ? 1 : -1;
  const cx = s.x + s.w / 2;
  for (const off of [-0.2, 0.22]) {
    const ox = cx + m * off * s.w;
    ctx.beginPath();
    ctx.moveTo(ox - m * s.w * 0.25, s.y + s.h / 2);
    ctx.lineTo(ox + m * s.w * 0.08, s.y + s.h * 0.14);
    ctx.lineTo(ox + m * s.w * 0.28, s.y + s.h * 0.14);
    ctx.lineTo(ox - m * s.w * 0.05, s.y + s.h / 2);
    ctx.lineTo(ox + m * s.w * 0.28, s.y + s.h * 0.86);
    ctx.lineTo(ox + m * s.w * 0.08, s.y + s.h * 0.86);
    ctx.closePath();
    ctx.fill();
  }
  return s;
}

/** Billboard atlas: four 3:1 slots stacked vertically; AI images replace the placeholders when present. */
export class BillboardAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly slots = 4;
  private readonly sw = 1536;
  private readonly sh = 512;

  constructor(aniso: number) {
    [this.canvas, this.ctx] = makeCanvas(this.sw, this.sh * this.slots);
    for (let i = 0; i < this.slots; i++) this.placeholder(i);
    this.texture = canvasTexture(this.canvas, { repeat: false, aniso });
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  uv(i: number): UVRect {
    const H = this.sh * this.slots;
    const y = (i % this.slots) * this.sh;
    return [0.002, 1 - (y + this.sh - 2) / H, 0.998, 1 - (y + 2) / H];
  }

  private placeholder(i: number) {
    const ctx = this.ctx;
    const y = i * this.sh;
    const W = this.sw;
    const H = this.sh;
    const themes = [
      { a: '#0b1f5c', b: '#b0127a', t: '深圳 · 创新之城', s: 'SHENZHEN · CITY OF INNOVATION' },
      { a: '#ff7a3d', b: '#7a1d6b', t: '湾区之光', s: 'GREATER BAY AREA · 2026' },
      { a: '#020a14', b: '#063247', t: '极速穿越 深南大道', s: 'SHENZHEN DRIVE' },
      { a: '#04594f', b: '#0d2a52', t: '鹏城夜色 欢迎您', s: 'WELCOME TO SHENZHEN' },
    ];
    const th = themes[i % themes.length];
    const g = ctx.createLinearGradient(0, y, W, y + H);
    g.addColorStop(0, th.a);
    g.addColorStop(1, th.b);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let k = 0; k < 26; k++) {
      const bw = 30 + ((k * 37) % 50);
      const bh = 60 + ((k * 53) % 200);
      ctx.fillRect(k * 60, y + H - bh, bw, bh);
    }
    ctx.fillStyle = i === 2 ? '#5ff3ff' : '#ffffff';
    fitText(ctx, th.t, W / 2, y + H * 0.42, W * 0.86, H * 0.36, 800);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    fitText(ctx, th.s, W / 2, y + H * 0.76, W * 0.8, H * 0.12, 600, 'Helvetica, Arial, sans-serif');
  }

  /**
   * Loads textures/ai/billboard_0N.jpg into the slots when the files exist. The 16:9 images are
   * cover-fitted into 3:1 slots; `anchorY` is the fraction of the excess height cropped from the
   * top, chosen so each slogan stays inside the slot.
   */
  loadAi(base: string) {
    const anchorY = [0.12, 0.5, 0.5, 0.08];
    for (let i = 0; i < this.slots; i++) {
      const img = new Image();
      img.onload = () => {
        const ctx = this.ctx;
        const y = i * this.sh;
        const r = Math.max(this.sw / img.width, this.sh / img.height);
        const w = img.width * r;
        const h = img.height * r;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y, this.sw, this.sh);
        ctx.clip();
        ctx.drawImage(img, (this.sw - w) / 2, y - (h - this.sh) * (anchorY[i] ?? 0.5), w, h);
        ctx.restore();
        this.texture.needsUpdate = true;
      };
      img.onerror = () => {};
      img.src = `${base}textures/ai/billboard_0${i + 1}.jpg`;
    }
  }
}
