import { CONFIG } from '../config';
import type { Route } from '../route/Route';

export type MinimapMode = 'overview' | 'local';

type Side = 'above' | 'below' | 'left' | 'right';

interface MapLabel {
  x: number;
  z: number;
  text: string;
  side: Side;
  localSide: Side;
  footprint: Float32Array | null;
}

/** Static content rendered at one scale; world (x, z) maps to CSS px (x * k + ox, z * k + oy). */
interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  k: number;
  ox: number;
  oy: number;
  /** World rectangle covered by the layer (local cache only). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const MM = CONFIG.hud.minimap;
const ACCENT = '#2ec8de';
const WARN = '#ffb547';
const INK = 'rgba(4, 8, 14, 0.85)';
const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/** Route samples every `stride` (always keeping the last one): x, z interleaved, plus their arc length. */
function decimate(route: Route, stride: number): { pts: Float32Array; ss: Float32Array } {
  const last = route.n - 1;
  const pts = new Float32Array((Math.floor(last / stride) + 2) * 2);
  const ss = new Float32Array(pts.length / 2);
  let j = 0;
  for (let i = 0; ; i += stride) {
    const idx = Math.min(i, last);
    pts[2 * j] = route.px[idx];
    pts[2 * j + 1] = route.pz[idx];
    ss[j++] = route.cum[idx];
    if (idx === last) break;
  }
  return { pts: pts.subarray(0, 2 * j), ss: ss.subarray(0, j) };
}

/**
 * Canvas 2D minimap, north-up in both modes (x east → right, z south → down).
 * - overview: the whole route fitted into the panel;
 * - local: a MM.localSpan-wide window around the car, leading it by MM.localLookAhead m.
 * Route, turns, start/finish flags and landmark labels are pre-rendered into offscreen
 * layers (overview once; local into a 3×3-panel cache re-rendered when the view nears
 * its edge). A redraw (≤ MM.maxRedrawHz, skipped when nothing changed) blits the layer
 * and strokes the travelled trail, checkpoints and the car arrow, without allocating.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly W = MM.width;
  private readonly H = MM.height;
  private readonly ov: { pts: Float32Array; ss: Float32Array };
  private readonly lo: { pts: Float32Array; ss: Float32Array };
  private readonly cps: Float32Array;
  private readonly labels: MapLabel[] = [];
  private readonly ovFit: { k: number; ox: number; oy: number };
  private readonly lk: number;
  private readonly autoLocalS: number;
  private readonly modeEl: HTMLElement;
  private readonly scaleEl: HTMLElement;
  private overview: Layer | null = null;
  private local: Layer | null = null;
  private dpr = 0;
  private manual: MinimapMode | null = null;
  private current: MinimapMode = 'overview';
  private dirty = true;
  private lastDraw = -Infinity;
  private lx = NaN;
  private lz = NaN;
  private lyaw = NaN;
  private lpassed = -1;
  private leadX = 0;
  private leadZ = 0;
  private readonly p = { x: 0, z: 0 };

  constructor(
    private readonly route: Route,
    container: HTMLElement,
  ) {
    const data = route.data;
    for (const def of MM.landmarks) {
      const lm = data.landmarks.find((l) => l.id === def.id);
      if (!lm) continue;
      const fp = lm.footprint?.length ? new Float32Array(lm.footprint.flat()) : null;
      this.labels.push({ x: lm.x, z: lm.z, text: def.label, side: def.side, localSide: def.localSide, footprint: fp });
    }
    this.cps = new Float32Array(data.checkpoints.length * 2);
    data.checkpoints.forEach((cp, i) => {
      route.pointAt(cp.s, 0, this.p);
      this.cps[2 * i] = this.p.x;
      this.cps[2 * i + 1] = this.p.z;
    });
    const firstTurn = route.turns[0];
    this.autoLocalS = firstTurn ? firstTurn.s0 - MM.autoLocalBeforeTurn : Infinity;

    // Overview fit: route plus labelled landmarks, with room for labels above / below.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const grow = (x: number, z: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (let i = 0; i < route.n; i++) grow(route.px[i], route.pz[i]);
    for (const l of this.labels) grow(l.x, l.z);
    const padX = 12;
    const padTop = 26;
    const padBottom = 16;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxZ - minZ);
    const k = Math.min((this.W - 2 * padX) / bw, (this.H - padTop - padBottom) / bh);
    this.ovFit = {
      k,
      ox: (this.W - bw * k) / 2 - minX * k,
      oy: padTop + (this.H - padTop - padBottom - bh * k) / 2 - minZ * k,
    };
    this.lk = this.W / MM.localSpan;
    // Keep decimated points ~1 CSS px apart at each scale.
    this.ov = decimate(route, Math.max(1, Math.floor(1 / (k * route.spacing))));
    this.lo = decimate(route, Math.max(1, Math.floor(1 / (this.lk * route.spacing))));

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mm-canvas';
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.modeEl = document.createElement('div');
    this.modeEl.className = 'mm-mode';
    this.scaleEl = document.createElement('div');
    this.scaleEl.className = 'mm-scale hidden';
    const step = 200;
    this.scaleEl.style.width = `${Math.round(step * this.lk)}px`;
    this.scaleEl.innerHTML = `<span>${step} m</span>`;
    container.append(this.canvas, this.modeEl, this.scaleEl);
    this.applyMode();
    this.resize();
  }

  get mode(): MinimapMode {
    return this.current;
  }

  /** N: switches mode; the choice holds until reset(). */
  toggle(): void {
    this.manual = this.current === 'local' ? 'overview' : 'local';
    this.dirty = true;
  }

  /** New run: back to automatic mode (overview, local near the CBD loop). */
  reset(): void {
    this.manual = null;
    this.leadX = this.leadZ = 0;
    this.dirty = true;
  }

  /** Per frame with the rendered car pose; redraws at most MM.maxRedrawHz. */
  update(x: number, z: number, yaw: number, s: number, passed: number): void {
    const want = this.manual ?? (s >= this.autoLocalS ? 'local' : 'overview');
    if (want !== this.current) {
      this.current = want;
      this.applyMode();
      this.dirty = true;
    }
    const now = performance.now();
    if (!this.dirty && now - this.lastDraw < 1000 / MM.maxRedrawHz) return;
    if (!this.dirty && x === this.lx && z === this.lz && yaw === this.lyaw && passed === this.lpassed) return;
    if (window.devicePixelRatio !== this.dpr) this.resize();
    const dt = Math.min(0.1, (now - this.lastDraw) / 1000);
    this.lastDraw = now;
    this.dirty = false;
    this.lx = x;
    this.lz = z;
    this.lyaw = yaw;
    this.lpassed = passed;
    this.draw(x, z, yaw, s, passed, dt);
  }

  private applyMode(): void {
    const local = this.current === 'local';
    this.modeEl.textContent = local ? '局部 · N' : '全程 · N';
    this.scaleEl.classList.toggle('hidden', !local);
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    const f = this.ovFit;
    this.overview = this.makeLayer(this.W, this.H);
    this.overview.k = f.k;
    this.overview.ox = f.ox;
    this.overview.oy = f.oy;
    this.drawStatic(this.overview, this.ov.pts, false);
    this.local = null;
    this.dirty = true;
  }

  private makeLayer(w: number, h: number): Layer {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    const ctx = canvas.getContext('2d')!;
    return { canvas, ctx, k: 0, ox: 0, oy: 0, x0: 0, z0: 0, x1: 0, z1: 0 };
  }

  /** Local cache layer covering the view around (camX, camZ); re-rendered when the view leaves it. */
  private localLayer(camX: number, camZ: number): Layer {
    const k = this.lk;
    const hw = this.W / 2 / k;
    const hh = this.H / 2 / k;
    let L = this.local;
    if (L && camX - hw >= L.x0 && camX + hw <= L.x1 && camZ - hh >= L.z0 && camZ + hh <= L.z1) return L;
    L ??= this.makeLayer(this.W * 3, this.H * 3);
    L.k = k;
    L.x0 = camX - 3 * hw;
    L.x1 = camX + 3 * hw;
    L.z0 = camZ - 3 * hh;
    L.z1 = camZ + 3 * hh;
    L.ox = -L.x0 * k;
    L.oy = -L.z0 * k;
    this.drawStatic(L, this.lo.pts, true);
    this.local = L;
    return L;
  }

  /** Route (dim), landmark footprints, turns, flags and labels. */
  private drawStatic(L: Layer, pts: Float32Array, big: boolean): void {
    const c = L.ctx;
    const { k, ox, oy } = L;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, L.canvas.width, L.canvas.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.lineJoin = 'round';
    c.lineCap = 'round';

    if (big) {
      c.fillStyle = 'rgba(238, 243, 248, 0.16)';
      c.strokeStyle = 'rgba(238, 243, 248, 0.35)';
      c.lineWidth = 1;
      for (const l of this.labels) {
        const fp = l.footprint;
        if (!fp) continue;
        c.beginPath();
        for (let i = 0; i < fp.length; i += 2) c.lineTo(fp[i] * k + ox, fp[i + 1] * k + oy);
        c.closePath();
        c.fill();
        c.stroke();
      }
    }

    c.beginPath();
    for (let i = 0; i < pts.length; i += 2) c.lineTo(pts[i] * k + ox, pts[i + 1] * k + oy);
    c.strokeStyle = 'rgba(4, 8, 14, 0.6)';
    c.lineWidth = big ? 8 : 5;
    c.stroke();
    c.strokeStyle = 'rgba(238, 243, 248, 0.42)';
    c.lineWidth = big ? 4.5 : 2.4;
    c.stroke();

    const route = this.route;
    const p = this.p;
    for (const t of route.turns) {
      route.pointAt((t.s0 + t.s1) / 2, 0, p);
      c.beginPath();
      c.arc(p.x * k + ox, p.z * k + oy, big ? 5 : 2.6, 0, Math.PI * 2);
      c.fillStyle = WARN;
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = INK;
      c.stroke();
    }

    const fs = big ? 12 : 11;
    c.font = `600 ${fs}px ${FONT}`;
    c.textBaseline = 'middle';
    for (const l of this.labels) {
      const X = l.x * k + ox;
      const Y = l.z * k + oy;
      c.beginPath();
      c.moveTo(X, Y - 3);
      c.lineTo(X + 3, Y);
      c.lineTo(X, Y + 3);
      c.lineTo(X - 3, Y);
      c.closePath();
      c.fillStyle = '#ffffff';
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = INK;
      c.stroke();
      const gap = big ? 7 : 5;
      const side = big ? l.localSide : l.side;
      let tx = X;
      let ty = Y;
      if (side === 'above') ty = Y - (big ? 14 : 15);
      else if (side === 'below') ty = Y + gap + fs / 2;
      else if (side === 'left') tx = X - gap;
      else tx = X + gap;
      c.textAlign = side === 'left' ? 'right' : side === 'right' ? 'left' : 'center';
      c.lineWidth = 3;
      c.strokeStyle = INK;
      c.strokeText(l.text, tx, ty);
      c.fillStyle = 'rgba(238, 243, 248, 0.92)';
      c.fillText(l.text, tx, ty);
    }

    route.pointAt(CONFIG.race.startS, 0, p);
    this.flag(c, p.x * k + ox, p.z * k + oy, big, false);
    route.pointAt(route.data.finish.s, 0, p);
    this.flag(c, p.x * k + ox, p.z * k + oy, big, true);
  }

  private flag(c: CanvasRenderingContext2D, X: number, Y: number, big: boolean, checkered: boolean): void {
    const h = big ? 16 : 11;
    const fw = big ? 12 : 8;
    const fh = big ? 8 : 6;
    c.lineWidth = 3;
    c.strokeStyle = INK;
    c.beginPath();
    c.moveTo(X, Y);
    c.lineTo(X, Y - h);
    c.stroke();
    c.strokeRect(X, Y - h, fw, fh);
    c.lineWidth = 1.4;
    c.strokeStyle = '#ffffff';
    c.beginPath();
    c.moveTo(X, Y);
    c.lineTo(X, Y - h);
    c.stroke();
    if (!checkered) {
      c.fillStyle = '#5ee6a0';
      c.fillRect(X, Y - h, fw, fh);
      return;
    }
    const cols = 4;
    const rows = big ? 3 : 2;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        c.fillStyle = (r + q) % 2 ? '#111418' : '#ffffff';
        c.fillRect(X + (q * fw) / cols, Y - h + (r * fh) / rows, fw / cols, fh / rows);
      }
    }
  }

  private draw(x: number, z: number, yaw: number, s: number, passed: number, dt: number): void {
    const c = this.ctx;
    const dpr = this.dpr;
    const W = this.W;
    const H = this.H;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    let L: Layer;
    let ox: number;
    let oy: number;
    let pts: Float32Array;
    let ss: Float32Array;
    let cull = false;
    let x0 = 0;
    let x1 = 0;
    let z0 = 0;
    let z1 = 0;
    if (this.current === 'overview') {
      L = this.overview!;
      c.drawImage(L.canvas, 0, 0);
      ox = L.ox;
      oy = L.oy;
      pts = this.ov.pts;
      ss = this.ov.ss;
    } else {
      const a = 1 - Math.exp(-3 * dt);
      this.leadX += (-Math.sin(yaw) * MM.localLookAhead - this.leadX) * a;
      this.leadZ += (-Math.cos(yaw) * MM.localLookAhead - this.leadZ) * a;
      const camX = x + this.leadX;
      const camZ = z + this.leadZ;
      L = this.localLayer(camX, camZ);
      const k = L.k;
      // View origin inside the cache, snapped to device pixels so the blit stays sharp.
      const vx = Math.round(((camX * k + L.ox) - W / 2) * dpr);
      const vy = Math.round(((camZ * k + L.oy) - H / 2) * dpr);
      c.drawImage(L.canvas, vx, vy, W * dpr, H * dpr, 0, 0, W * dpr, H * dpr);
      ox = L.ox - vx / dpr;
      oy = L.oy - vy / dpr;
      pts = this.lo.pts;
      ss = this.lo.ss;
      cull = true;
      const m = 30;
      x0 = camX - W / 2 / k - m;
      x1 = camX + W / 2 / k + m;
      z0 = camZ - H / 2 / k - m;
      z1 = camZ + H / 2 / k + m;
    }
    const k = L.k;
    const big = this.current === 'local';
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // Travelled trail: route start up to the car's arc length.
    c.beginPath();
    let pen = false;
    let prevIn = false;
    let i = 0;
    for (; i < ss.length && ss[i] <= s; i++) {
      const px = pts[2 * i];
      const pz = pts[2 * i + 1];
      const inside = !cull || (px >= x0 && px <= x1 && pz >= z0 && pz <= z1);
      if (i > 0 && (inside || prevIn)) {
        if (!pen) c.moveTo(pts[2 * i - 2] * k + ox, pts[2 * i - 1] * k + oy);
        c.lineTo(px * k + ox, pz * k + oy);
        pen = true;
      } else {
        pen = false;
      }
      prevIn = inside;
    }
    if (i > 0) {
      const p = this.route.pointAt(this.route.clampS(s), 0, this.p);
      if (!pen) c.moveTo(pts[2 * i - 2] * k + ox, pts[2 * i - 1] * k + oy);
      c.lineTo(p.x * k + ox, p.z * k + oy);
      c.strokeStyle = 'rgba(46, 200, 222, 0.28)';
      c.lineWidth = big ? 9 : 5.5;
      c.stroke();
      c.strokeStyle = ACCENT;
      c.lineWidth = big ? 4.5 : 2.6;
      c.stroke();
    }

    // Checkpoints: passed (cyan), next (white, ringed), upcoming (hollow).
    const cps = this.cps;
    const r = big ? 4 : 2.4;
    for (let j = 0; j < cps.length; j += 2) {
      const X = cps[j] * k + ox;
      const Y = cps[j + 1] * k + oy;
      if (X < -10 || X > W + 10 || Y < -10 || Y > H + 10) continue;
      const n = j / 2;
      c.beginPath();
      c.arc(X, Y, n === passed ? r + 1 : r, 0, Math.PI * 2);
      c.fillStyle = n < passed ? ACCENT : n === passed ? '#ffffff' : 'rgba(9, 13, 22, 0.9)';
      c.fill();
      c.lineWidth = n === passed ? 1.6 : 1.2;
      c.strokeStyle = n < passed ? INK : n === passed ? ACCENT : 'rgba(238, 243, 248, 0.85)';
      c.stroke();
    }

    // Car: heading arrow at the true position (off-route too).
    const X = x * k + ox;
    const Y = z * k + oy;
    const cos = Math.cos(-yaw);
    const sin = Math.sin(-yaw);
    c.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * X, dpr * Y);
    const sc = big ? 1.25 : 1;
    c.beginPath();
    c.arc(0, 0, 8 * sc, 0, Math.PI * 2);
    c.fillStyle = 'rgba(46, 200, 222, 0.3)';
    c.fill();
    c.beginPath();
    c.moveTo(0, -7 * sc);
    c.lineTo(4.8 * sc, 5 * sc);
    c.lineTo(0, 2.6 * sc);
    c.lineTo(-4.8 * sc, 5 * sc);
    c.closePath();
    c.lineWidth = 1.6;
    c.strokeStyle = INK;
    c.stroke();
    c.fillStyle = '#ffffff';
    c.fill();
  }
}
