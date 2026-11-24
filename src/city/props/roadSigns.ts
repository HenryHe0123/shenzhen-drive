import * as THREE from 'three';
import type { RGB } from '../road/builder';
import { canvasTexture, makeCanvas } from '../road/textures';
import type { PropGeo, UVRect } from './geo';
import { fitText } from './signs';

/**
 * GB 5768 sign faces extracted from "Chinese Road Signs (32 road signs and more)" (notbadworks,
 * CC BY 4.0) by scripts/process_env_and_signs.mjs into public/textures/signs/<kind>.png.
 */
export const PACK_SIGNS = [
  'straight',
  'turn_left',
  'turn_right',
  'straight_left',
  'straight_right',
  'keep_right',
  'no_stopping',
  'no_parking',
  'no_u_turn',
  'no_left_turn',
  'crosswalk',
] as const;

/** Pack faces plus speed limits, which the pack lacks and are drawn here. */
export type RoadSignKind = (typeof PACK_SIGNS)[number] | 'limit60' | 'limit50';

const KINDS: readonly RoadSignKind[] = [...PACK_SIGNS, 'limit60', 'limit50'];
const SQUARE = new Set<RoadSignKind>(['crosswalk']);
const BLUE = new Set<RoadSignKind>(['straight', 'turn_left', 'turn_right', 'straight_left', 'straight_right', 'keep_right', 'crosswalk']);

const SIZE = 1024;
const CELL = 256;
/** The 248 px face sits in the cell with a rim-white border, so mip filtering never mixes faces. */
const PAD = 4;
const FACE = CELL - 2 * PAD;
const COLS = SIZE / CELL;

const RIM = '#fafafa';
const RED = '#c4121f';
const SIGN_BLUE = '#26389a';
const GALV: RGB = [0.5, 0.52, 0.55];
const WHITE: RGB = [1, 1, 1];

export const isSquareSign = (k: RoadSignKind) => SQUARE.has(k);

/** 4×4 atlas of sign faces: placeholders and speed limits drawn at once, pack images when loaded. */
export class RoadSignAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(aniso: number) {
    const [canvas, ctx] = makeCanvas(SIZE, SIZE);
    this.ctx = ctx;
    ctx.fillStyle = RIM;
    ctx.fillRect(0, 0, SIZE, SIZE);
    KINDS.forEach((k, i) => {
      const [x, y] = this.origin(i);
      if (k === 'limit60' || k === 'limit50') drawSpeedLimit(ctx, x, y, FACE, k === 'limit60' ? 60 : 50);
      else drawPlaceholder(ctx, x, y, FACE, k);
    });
    this.texture = canvasTexture(canvas, { repeat: false, aniso });
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  private origin(i: number): [number, number] {
    return [(i % COLS) * CELL + PAD, Math.floor(i / COLS) * CELL + PAD];
  }

  /** UV rectangle [u0, v0, u1, v1] of a face (v up). */
  uv(kind: RoadSignKind): UVRect {
    const [x, y] = this.origin(KINDS.indexOf(kind));
    return [x / SIZE, 1 - (y + FACE) / SIZE, (x + FACE) / SIZE, 1 - y / SIZE];
  }

  /** Replaces the placeholders with textures/signs/<kind>.png as they arrive. */
  load(base: string) {
    PACK_SIGNS.forEach((k) => {
      const img = new Image();
      img.onload = () => {
        const [x, y] = this.origin(KINDS.indexOf(k));
        this.ctx.drawImage(img, x, y, FACE, FACE);
        this.texture.needsUpdate = true;
      };
      img.onerror = () => console.warn(`[props] road sign textures/signs/${k}.png missing; keeping the placeholder`);
      img.src = `${base}textures/signs/${k}.png`;
    });
  }
}

/** Plain blue / red-ringed face shown until (or if) the pack image loads. */
function drawPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, k: RoadSignKind) {
  const c = s / 2;
  if (SQUARE.has(k)) {
    ctx.fillStyle = SIGN_BLUE;
    ctx.fillRect(x + s * 0.04, y + s * 0.04, s * 0.92, s * 0.92);
    return;
  }
  ctx.beginPath();
  ctx.arc(x + c, y + c, c * 0.96, 0, Math.PI * 2);
  ctx.fillStyle = BLUE.has(k) ? SIGN_BLUE : RED;
  ctx.fill();
  if (!BLUE.has(k)) {
    ctx.beginPath();
    ctx.arc(x + c, y + c, c * 0.76, 0, Math.PI * 2);
    ctx.fillStyle = k === 'no_stopping' || k === 'no_parking' ? SIGN_BLUE : RIM;
    ctx.fill();
  }
}

/** 限制速度: white disc, red ring (a tenth of the diameter), black numerals. */
function drawSpeedLimit(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, kmh: number) {
  const c = s / 2;
  ctx.beginPath();
  ctx.arc(x + c, y + c, c * 0.97, 0, Math.PI * 2);
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + c, y + c, c * 0.97 - s * 0.1, 0, Math.PI * 2);
  ctx.fillStyle = RIM;
  ctx.fill();
  ctx.fillStyle = '#111111';
  fitText(ctx, String(kmh), x + c, y + c * 1.04, s * 0.56, s * 0.5, 700, '"DIN Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif');
}

/**
 * Sign plate centred at local (x, y, z) facing +z (toward traffic): the textured face goes into
 * `faces`, the galvanised back and rolled rim into `back`.
 */
export function signPanel(faces: PropGeo, back: PropGeo, m: THREE.Matrix4, x: number, y: number, z: number, size: number, square: boolean, uv: UVRect) {
  const t = 0.025;
  const h = size / 2;
  if (square) {
    faces.quad(m, [x - h, y - h, z], [x + h, y - h, z], [x + h, y + h, z], [x - h, y + h, z], uv, WHITE);
    back.box(m, x, y, z - t / 2 - 0.004, size, size, t, GALV);
    return;
  }
  const seg = 24;
  const [u0, v0, u1, v1] = uv;
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  const front = faces.vertex(m, x, y, z, 0, 0, 1, uc, vc, WHITE);
  const rear = back.vertex(m, x, y, z - t, 0, 0, -1, 0, 0, GALV);
  const f0 = faces.vertexCount;
  const b0 = back.vertexCount;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    faces.vertex(m, x + h * cs, y + h * sn, z, 0, 0, 1, uc + ((u1 - u0) / 2) * cs, vc + ((v1 - v0) / 2) * sn, WHITE);
    back.vertex(m, x + h * cs, y + h * sn, z - t, 0, 0, -1, 0, 0, GALV);
  }
  for (let i = 0; i < seg; i++) {
    faces.idx.push(front, f0 + i, f0 + i + 1);
    back.idx.push(rear, b0 + i + 1, b0 + i);
  }
  back.cylinder(m, [x, y, z - t], [x, y, z], h, h, seg, GALV);
}
