import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { getTimeOfDay, nightLevel, onTimeOfDayChange, type TimeOfDay } from '../../render/timeOfDay';
import { yawFromDir } from '../../route/Route';
import type { RGB } from '../road/builder';
import { getRoadLayout, inClearZone, type Interval, inJunction, inLandmark, SIDE, type TurnLayout } from '../road/layout';
import { mulberry32 } from '../road/textures';
import { placeMatrix, PropGeo, type V3 } from './geo';
import { type InstanceItem, WindowedInstances } from './instances';
import { DOUBLE_HEADS, doubleLampGeometry, lampMaterials, lensGeometry, poolGeometry, poolMaterial, SINGLE_HEADS, singleLampGeometry } from './lamps';
import { BillboardAtlas, drawBanner, drawChevron, drawGuide, drawJunction, drawPlate, SignAtlas, type Slot } from './signs';
import { banyanGeometry, foliageAtlas, foliageMaterial, palmGeometry, shrubGeometry } from './trees';

const METAL: RGB = [0.42, 0.44, 0.47];
const DARK: RGB = [0.16, 0.17, 0.19];
const PILLAR: RGB = [0.82, 0.84, 0.88];
const RED: RGB = [0.75, 0.06, 0.05];
const WHITE: RGB = [0.95, 0.95, 0.95];
const CYAN: RGB = [0.35, 2.6, 3.4];
const WARM: RGB = [4.0, 2.9, 1.8];
const ACCENT_START: RGB = [0.4, 2.4, 3.6];
const ACCENT_FINISH: RGB = [3.6, 0.5, 0.6];
const SIGNAL_GREEN: RGB = [0.15, 3.2, 1.3];
const LENS_DARK: RGB = [0.07, 0.07, 0.08];

/** Sign texture density (pixels per metre of sign face). */
const PX = 80;

/** Destination shown under the road name on turn gantries. */
const TURN_DEST: Record<string, string> = { 益田路: '平安金融中心', 福华三路: '会展中心', 金田路: '市民中心', 福中三路: '市民中心 · 终点' };

const inAny = (gaps: Interval[], s: number, margin = 0) => gaps.some(([a, b]) => s > a - margin && s < b + margin);

/** Emission level of street lamps per preset: off in daylight, dim at sunset, full at dusk. */
const lampLevel = (night: number) => (night <= 0.01 ? 0 : Math.min(1, night * night * 2.4));

export async function createProps(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene, renderer } = ctx;
  const l = getRoadLayout(route);
  const { turns } = l;
  const len = route.length;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const rand = mulberry32(2026);
  const root = new THREE.Group();
  root.name = 'props';

  const P = { x: 0, z: 0 };
  const Q = { x: 0, z: 0 };
  const yawAt = (s: number) => route.headingAt(Math.min(len, Math.max(0, s)));
  const place = (s: number, d: number, y = 0, yawOff = 0, scale = 1) => {
    const p = route.pointAt(s, d, P);
    return placeMatrix(p.x, y, p.z, yawAt(s) + yawOff, scale);
  };
  /** False when (s, d) lies inside a landmark footprint grown by `margin`. */
  const clear = (s: number, d: number, margin = 3) => {
    const p = route.pointAt(s, d, Q);
    return !inLandmark(l, p.x, p.z, margin);
  };
  const reserved: Record<'right' | 'left', Interval[]> = { right: [], left: [] };
  const lawnReserved: Interval[] = [];
  const farLawnReserved: Interval[] = [];
  const reserve = (side: 'right' | 'left' | 'both', s: number, half: number) => {
    if (side !== 'left') reserved.right.push([s - half, s + half]);
    if (side !== 'right') reserved.left.push([s - half, s + half]);
  };

  // ---------------- Signs, gates and other static structures ----------------
  const atlas = new SignAtlas(4096, 2048);
  const struct = new PropGeo();
  const boards = new PropGeo();
  const glow = new PropGeo();
  const grey = atlas.grey;

  const board = (m: THREE.Matrix4, x: number, y: number, z: number, w: number, h: number, slot: Slot, back?: Slot, depth = 0.12) =>
    boards.box(m, x, y, z, w, h, depth, WHITE, slot.uv, grey, back?.uv ?? grey);

  /** F-type cantilever sign over the outer two lanes of one side. */
  const cantilever = (s: number, side: 'right' | 'left', slot: Slot, w: number, h: number) => {
    const right = side === 'right';
    const dPole = right ? l.edgeR + 0.9 : l.edgeL - 0.9;
    const dBoard = right ? route.dMax - w / 2 - 0.2 : route.dMin + w / 2 + 0.2;
    const m = place(s, dPole);
    const yC = 5.4 + h / 2;
    struct.cylinder(m, [0, 0, 0], [0, yC + h / 2 + 0.5, 0], 0.2, 0.15, 10, METAL);
    const bx = dBoard - dPole;
    const xFar = right ? bx - w / 2 + 0.3 : bx + w / 2 - 0.3;
    for (const yy of [yC + h * 0.3, yC - h * 0.3]) struct.box(m, xFar / 2, yy, -0.2, Math.abs(xFar), 0.16, 0.16, METAL);
    board(m, bx, yC, 0, w, h, slot);
    reserve(side, s, 6);
  };

  /** Full-width overhead gantry; panels hang with their bottom edge 5.4 m above the road. */
  const gantry = (s: number, panels: { d0: number; d1: number; slot: Slot }[], h: number) => {
    const m = place(s, 0);
    const dL = l.edgeL - 0.9;
    const dR = l.edgeR + 0.9;
    const yC = 5.4 + h / 2;
    const yTop = yC + h / 2 + 0.6;
    for (const d of [dL, dR]) {
      struct.cylinder(m, [d, 0, 0], [d, yTop + 0.3, 0], 0.28, 0.22, 10, METAL);
      struct.box(m, d, 0.25, 0, 0.9, 0.5, 0.9, DARK);
    }
    for (const y of [yC - h * 0.32, yC + h * 0.32]) struct.box(m, (dL + dR) / 2, y, -0.3, dR - dL + 0.4, 0.22, 0.22, METAL);
    for (let k = 0; k <= 8; k++) struct.box(m, dL + ((dR - dL) * k) / 8, yC, -0.3, 0.1, h * 0.64, 0.1, METAL);
    for (const p of panels) board(m, (p.d0 + p.d1) / 2, yC, 0, p.d1 - p.d0, h, p.slot);
    reserve('both', s, 8);
  };

  /** Start / finish arch spanning the carriageway, text on both faces and glowing trims. */
  const arch = (s: number, slot: Slot, accent: RGB) => {
    const m = place(s, 0);
    const dL = l.edgeL - 0.8;
    const dR = l.edgeR + 0.8;
    const mid = (dL + dR) / 2;
    for (const d of [dL, dR]) {
      struct.box(m, d, 4.0, 0, 0.9, 8.0, 0.9, PILLAR);
      glow.box(m, d, 3.8, 0.46, 0.14, 6.6, 0.03, accent);
      glow.box(m, d, 3.8, -0.46, 0.14, 6.6, 0.03, accent);
    }
    struct.box(m, mid, 7.2, 0, dR - dL + 0.9, 1.7, 0.8, PILLAR);
    board(m, mid, 7.2, 0, dR - dL - 1.4, 1.35, slot, slot, 0.86);
    glow.box(m, mid, 6.3, 0.42, dR - dL - 0.6, 0.09, 0.05, accent);
    glow.box(m, mid, 6.3, -0.42, dR - dL - 0.6, 0.09, 0.05, accent);
    reserve('both', s, 6);
  };

  /** Chinese cantilever traffic signal on the near-right corner, one head per lane, green for us. */
  const signal = (s: number) => {
    const dPole = l.edgeR + 1.0;
    if (!clear(s, dPole)) return;
    const m = place(s, dPole);
    const armEnd = route.dMin + 1.2 - dPole;
    struct.cylinder(m, [0, 0, 0], [0, 7.4, 0], 0.17, 0.13, 10, METAL);
    struct.box(m, 0, 0.2, 0, 0.6, 0.4, 0.6, DARK);
    struct.cylinder(m, [0, 6.9, 0], [armEnd, 6.9, 0], 0.11, 0.08, 8, METAL);
    struct.cylinder(m, [0, 5.4, 0], [armEnd * 0.45, 6.85, 0], 0.05, 0.05, 6, METAL);
    for (let k = 0; k < l.lanes; k++) {
      const x = route.dMin + (k + 0.5) * l.laneW - dPole;
      struct.box(m, x, 6.35, 0, 0.42, 1.25, 0.32, DARK);
      struct.box(m, x, 6.35, -0.18, 0.5, 1.4, 0.04, DARK);
      for (const [y, col] of [
        [6.75, [0.22, 0.03, 0.03]],
        [6.35, [0.22, 0.14, 0.02]],
      ] as [number, RGB][]) struct.box(m, x, y, 0.17, 0.26, 0.26, 0.02, col);
      glow.box(m, x, 5.95, 0.17, 0.26, 0.26, 0.02, SIGNAL_GREEN);
      struct.box(m, x, 6.75, 0.24, 0.32, 0.04, 0.16, LENS_DARK);
    }
    reserve('right', s, 3);
  };

  // Guide signs from the route data (e.g. the APEC venue sign at 香蜜湖路).
  for (const sg of route.data.signs ?? []) {
    if (!sg || !Number.isFinite(sg.s) || sg.s < 20 || sg.s > len - 20) continue;
    let s = sg.s;
    while (inJunction(l, s, 6) && s > 40) s -= 20;
    const text = sg.text ?? '';
    const sub = sg.sub;
    const apec = /APEC|国际交流中心/.test(text + (sub ?? ''));
    const left = /←/.test(text + (sub ?? ''));
    const w = apec ? 8 : 7;
    const h = apec ? 3.4 : 3.0;
    const slot = drawGuide(atlas, w * PX, h * PX, text, sub, apec ? { icon: 'globe' } : left ? { arrow: 'left' } : {});
    cantilever(s, sg.side === 'left' ? 'left' : 'right', slot, w, h);
  }

  // Turn guidance: blue overhead gantries ~500 m and ~200 m before each turn (turn panel over the
  // two turn-side lanes, straight-on panel over the others), a street-name plate at the corner,
  // chevron boards and barriers along the arc.
  const gantryS: number[] = [];
  const chevrons: Partial<Record<'left' | 'right', Slot>> = {};
  turns.forEach((t: TurnLayout, i) => {
    const prev = turns[i - 1];
    const dir = t.left ? '左转' : '右转';
    for (const back of [500, 200]) {
      let s = t.sA - back;
      while ((inJunction(l, s, 10) || inAny(reserved.right, s, 8)) && s > 60) s -= 10;
      if (s < 60 || (prev && s < prev.sB + 50)) continue;
      const dist = Math.max(50, Math.round((t.s0 - s) / 50) * 50);
      const hP = 3.6;
      const dest = TURN_DEST[t.name];
      const turnSlot = drawGuide(atlas, 7.4 * PX, hP * PX, t.name, `${dist} 米 ${dir}${dest ? ` · ${dest}` : ''}`, { arrow: t.left ? 'left' : 'right' });
      const straightSlot = drawGuide(atlas, 6.6 * PX, hP * PX, t.fromName, '直行', { arrow: 'up' });
      const turnPanel = t.left ? { d0: route.dMin + 0.1, d1: route.dMin + 7.5 } : { d0: route.dMax - 7.5, d1: route.dMax - 0.1 };
      const straightPanel = t.left ? { d0: route.dMax - 6.7, d1: route.dMax - 0.1 } : { d0: route.dMin + 0.1, d1: route.dMin + 6.7 };
      gantry(s, [{ ...turnPanel, slot: turnSlot }, { ...straightPanel, slot: straightSlot }], hP);
      gantryS.push(s);
    }
    const plateD = l.edgeR + SIDE.walk[0] + 1.2;
    if (t.name && clear(t.sA - 3, plateD)) {
      const plate = drawPlate(atlas, t.name);
      const m = place(t.sA - 3, plateD);
      struct.cylinder(m, [0, 0, 0], [0, 3.9, 0], 0.06, 0.05, 8, METAL);
      board(m, 0, 3.45, 0.08, 2.4, 0.65, plate, plate, 0.06);
    }
    const chevDir = t.left ? 'left' : 'right';
    const chev = (chevrons[chevDir] ??= drawChevron(atlas, chevDir));
    const dChev = t.left ? l.edgeR + 1.4 : l.edgeL - 1.4;
    for (let s = t.s0 - 6; s <= t.s1 + 6; s += 4) {
      const p = route.pointAt(s, dChev, P);
      const v = route.pointAt(Math.max(t.s0 - 60, s - 50), 1.75, Q);
      const m = placeMatrix(p.x, 0, p.z, yawFromDir(p.x - v.x, p.z - v.z));
      struct.cylinder(m, [0, 0, 0], [0, 2.75, 0], 0.06, 0.06, 6, METAL);
      board(m, 0, 1.95, 0.07, 1.15, 1.45, chev, undefined, 0.05);
    }
    let k = 0;
    for (let s = t.s0 - 6; s <= t.s1 + 6; s += 1.6, k++) {
      for (const d of [l.edgeR + 0.35, l.edgeL - 0.35]) struct.box(place(s, d), 0, 0.45, 0, 0.5, 0.9, 1.4, k % 2 ? WHITE : RED);
    }
  });

  // Junction advance signs, corner street-name plates and traffic signals.
  const signsS = (route.data.signs ?? []).map((x) => x.s);
  for (const c of l.cross) {
    const sAdv = c.s - c.hw - 150;
    const nearTurn = turns.some((t) => sAdv > t.sA - 560 && sAdv < t.sB + 30);
    if (c.name && sAdv > 60 && !nearTurn && !signsS.some((x) => Math.abs(x - sAdv) < 60) && !gantryS.some((x) => Math.abs(x - sAdv) < 80) && !inJunction(l, sAdv, 10)) {
      const prevRoad = [...turns].reverse().find((t) => t.s1 < c.s)?.name ?? '深南大道';
      cantilever(sAdv, 'right', drawJunction(atlas, 5.6 * PX, 3.2 * PX, c.name, prevRoad), 5.6, 3.2);
    }
    if (c.name) {
      const plate = drawPlate(atlas, c.name);
      for (const [s, d, yawOff] of [
        [c.s - c.hw - 2.5, l.edgeR + SIDE.walk[0] + 1.2, 0],
        [c.s + c.hw + 2.5, l.opp(c.s) - 7.3 - SIDE.walk[0] - 1.2, Math.PI],
      ] as [number, number, number][]) {
        if (!clear(s, d)) continue;
        const m = place(s, d, 0, yawOff);
        struct.cylinder(m, [0, 0, 0], [0, 3.9, 0], 0.06, 0.05, 8, METAL);
        board(m, 0, 3.45, 0.08, 2.4, 0.65, plate, plate, 0.06);
      }
    }
    signal(c.s - c.hw - 1.2);
  }
  for (const t of turns) signal(t.sA - 1.2);

  // Road-closed barriers at both ends.
  for (const s of [l.s0 + 1.2, l.s1 - 1.2]) {
    let k = 0;
    for (let d = l.edgeL; d < l.edgeR - 0.5; d += 1.55, k++) struct.box(place(s, d + 0.75), 0, 0.4, 0, 1.45, 0.8, 0.5, k % 2 ? WHITE : RED);
  }

  // Start / finish arches, checkered banners; checkpoint light lines and small banners.
  arch(0, drawBanner(atlas, 1120, 120, 'START · 南山科技园', 'start'), ACCENT_START);
  const fin = route.data.finish;
  if (fin && fin.s > 0 && fin.s <= len) arch(fin.s, drawBanner(atlas, 1120, 120, 'FINISH · 深圳市民中心', 'finish'), ACCENT_FINISH);
  const cps = route.data.checkpoints ?? [];
  cps.forEach((cp, i) => {
    if (!Number.isFinite(cp.s) || cp.s <= 0 || cp.s >= len) return;
    const m = place(cp.s, 0);
    glow.quad(m, [route.dMin, 0.03, 0.2], [route.dMax, 0.03, 0.2], [route.dMax, 0.03, -0.2], [route.dMin, 0.03, -0.2], grey, CYAN);
    let sb = cp.s;
    while ((inJunction(l, sb, 2) || gantryS.some((x) => Math.abs(x - sb) < 12)) && sb < len - 30) sb += 10;
    const mb = place(sb, 0);
    const dL = l.edgeL - 0.7;
    const dR = l.edgeR + 0.7;
    for (const d of [dL, dR]) struct.cylinder(mb, [d, 0, 0], [d, 6.8, 0], 0.1, 0.08, 8, METAL);
    struct.box(mb, (dL + dR) / 2, 6.7, -0.12, dR - dL, 0.16, 0.16, METAL);
    const slot = drawBanner(atlas, 6.2 * PX, 0.9 * PX, `CHECKPOINT ${i + 1}/${cps.length} · ${cp.name}`, 'checkpoint');
    board(mb, 0, 6.05, 0, 6.2, 0.9, slot, slot, 0.08);
    glow.box(mb, 0, 5.55, 0.05, 6.0, 0.05, 0.05, CYAN);
    reserve('both', sb, 3);
  });

  // Billboards on the right-hand lawn just behind the sidewalk, angled toward traffic, bottom edge
  // above the tree canopy; kept out of junctions, clear zones and landmark footprints.
  const bb = new BillboardAtlas(aniso);
  bb.loadAi(import.meta.env.BASE_URL);
  const faces = new PropGeo();
  const nBB = CONFIG.city.billboardCount;
  const BW = CONFIG.city.billboardWidth;
  const BH = BW / 3;
  const B0 = CONFIG.city.billboardBottom;
  const bbYaw = -CONFIG.city.billboardAngleDeg * (Math.PI / 180);
  // Two-leg frame spanning the sidewalk: inner leg in the planting strip, outer leg just behind the
  // sidewalk, so the face sits ~16 m from the centerline, clear of the street-tree canopy line.
  // Right side first; the far side (mirrored) where the right is a landmark sight line.
  const legX = BW / 2 - 0.8;
  const bbOff = SIDE.green[0] + 1.6 + legX * Math.cos(bbYaw);
  const bbSide = (side: 'right' | 'left', s: number) =>
    side === 'right' ? { d: l.edgeR + bbOff, yaw: bbYaw } : { d: l.opp(s) - 7.3 - bbOff, yaw: -bbYaw };
  const bbStart = 450;
  const bbEnd = (turns[0]?.sA ?? len) - 700;
  const bbOk = (side: 'right' | 'left', s: number) => {
    if (inJunction(l, s, 45) || inAny(reserved[side], s, 30) || gantryS.some((x) => Math.abs(x - s) < 60)) return false;
    if (side === 'left' && (inAny(l.gaps.farLawn, s, 20) || inAny(l.gaps.opp, s, 20))) return false;
    if (Math.abs(((yawAt(s) - yawAt(s - 250) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) > 0.14) return false;
    const { d, yaw } = bbSide(side, s);
    const m = place(s, d, 0, yaw);
    for (const x of [-BW / 2, 0, BW / 2]) {
      const v = new THREE.Vector3(x, 0, 0).applyMatrix4(m);
      if (inClearZone(route, v.x, v.z) || inLandmark(l, v.x, v.z, 4)) return false;
    }
    return true;
  };
  const bbPlaced: string[] = [];
  for (let i = 0; i < nBB; i++) {
    const s0 = bbStart + ((i + 0.5) * (bbEnd - bbStart)) / nBB;
    let s = NaN;
    let side: 'right' | 'left' = 'right';
    for (const sd of ['right', 'left'] as const) {
      for (let k = 0; k <= 16 && Number.isNaN(s); k++) {
        for (const c of [s0 + k * 25, s0 - k * 25]) {
          if (Number.isNaN(s) && c > 200 && c < len - 300 && bbOk(sd, c)) {
            s = c;
            side = sd;
          }
        }
      }
      if (!Number.isNaN(s)) break;
    }
    if (Number.isNaN(s)) continue;
    const { d: bbD, yaw: yawB } = bbSide(side, s);
    const m = place(s, bbD, 0, yawB);
    const yTop = B0 + BH;
    for (const x of [-legX, legX]) {
      struct.cylinder(m, [x, 0, -0.9], [x, B0 + 0.4, -0.9], 0.42, 0.34, 12, METAL);
      struct.box(m, x, 0.25, -0.9, 1.2, 0.5, 1.2, DARK);
    }
    struct.box(m, 0, B0 - 1.6, -0.9, 2 * legX, 0.3, 0.3, METAL);
    struct.box(m, 0, (B0 + yTop) / 2, -0.55, BW + 0.6, BH + 0.6, 0.5, DARK);
    struct.box(m, 0, B0 - 0.45, 0.2, BW + 0.6, 0.12, 1.1, METAL);
    faces.quad(m, [-BW / 2, B0, -0.28], [BW / 2, B0, -0.28], [BW / 2, yTop, -0.28], [-BW / 2, yTop, -0.28], bb.uv(i), WHITE);
    for (const x of [-BW * 0.36, -BW * 0.12, BW * 0.12, BW * 0.36]) {
      struct.box(m, x, yTop + 0.35, 0.3, 0.08, 0.08, 0.9, DARK);
      glow.box(m, x, yTop + 0.3, 0.75, 1.2, 0.1, 0.14, WARM);
    }
    if (side === 'right') {
      lawnReserved.push([s - BW, s + BW]);
      reserved.right.push([s - 26, s + 4]);
    } else farLawnReserved.push([s - BW, s + BW]);
    bbPlaced.push(`${Math.round(s)}${side === 'left' ? 'L' : 'R'}`);
  }
  if (ctx.debug) console.info(`[props] billboards at s = ${bbPlaced.join(', ')}`);

  // ---------------- Lamps ----------------
  const lampSp = CONFIG.city.lampSpacing;
  const medianW = (s: number) => l.edgeL - 0.3 - (l.opp(s) + 7.6);
  const doubles: InstanceItem[] = [];
  const singles: InstanceItem[] = [];
  const lenses: InstanceItem[] = [];
  const pools: InstanceItem[] = [];
  const lampAt: Record<'right' | 'left', number[]> = { right: [], left: [] };
  const hv = new THREE.Vector3();
  const addLamp = (list: InstanceItem[], heads: V3[], s: number, d: number, yawOff: number) => {
    if (!clear(s, d)) return false;
    const m = place(s, d, 0, yawOff);
    list.push({ s, m });
    for (const h of heads) {
      const lm = new THREE.Matrix4().makeTranslation(h[0], h[1], h[2]).premultiply(m);
      lenses.push({ s, m: lm });
      hv.set(h[0], 0, h[2]).applyMatrix4(m);
      pools.push({ s, m: new THREE.Matrix4().makeScale(17, 1, 17).setPosition(hv.x, 0.025, hv.z) });
    }
    return true;
  };
  for (let s = lampSp / 2; s < len - 5; s += lampSp) {
    if (inJunction(l, s, 3)) continue;
    if (!inAny(reserved.right, s, 3) && !inAny(l.gaps.right, s, 3)) {
      if (addLamp(singles, SINGLE_HEADS, s, l.edgeR + 0.8, 0)) lampAt.right.push(s);
    }
    if (!inAny(l.gaps.far, s, 3) && !inAny(l.gaps.opp, s, 3) && !inAny(farLawnReserved, s, 3)) addLamp(singles, SINGLE_HEADS, s, l.opp(s) - 7.3 - 0.8, Math.PI);
  }
  for (let s = 0; s < len - 5; s += lampSp) {
    if (inJunction(l, s, 3) || inAny(l.gaps.median, s, 3) || inAny(reserved.left, s, 3)) continue;
    const w = medianW(s);
    if (w < 0.6) continue;
    if (w < 7) addLamp(doubles, DOUBLE_HEADS, s, l.edgeL - 0.3 - w / 2, 0);
    else {
      addLamp(singles, SINGLE_HEADS, s, l.edgeL - 1.0, Math.PI);
      addLamp(singles, SINGLE_HEADS, s, l.opp(s) + 7.6 + 0.7, 0);
    }
    lampAt.left.push(s);
  }
  const nearLamp = (side: 'right' | 'left', s: number, r: number) => lampAt[side].some((x) => Math.abs(x - s) < r);

  // ---------------- Trees and shrubs ----------------
  const banyans: InstanceItem[] = [];
  const palms: InstanceItem[] = [];
  const shrubs: InstanceItem[] = [];
  const tint = (lo: number, hi: number, g = 1) => {
    const v = lo + rand() * (hi - lo);
    return new THREE.Color(v * (0.92 + rand() * 0.1), v * g, v * (0.85 + rand() * 0.1));
  };
  const tree = (list: InstanceItem[], s: number, d: number, sc: number, c: THREE.Color) => {
    if (clear(s, d)) list.push({ s, m: place(s, d, 0, rand() * Math.PI * 2, sc), c });
  };
  const sp = CONFIG.city.treeSpacing;
  for (let s0 = 6; s0 < len + 2; s0 += sp) {
    const s = s0 + (rand() - 0.5) * 2;
    // Right planting strip.
    if (!inAny(l.gaps.right, s, 4) && !inAny(reserved.right, s, 4) && !nearLamp('right', s, 3.5)) {
      if (rand() < 0.85) tree(banyans, s, l.edgeR + 2.0, 0.9 + rand() * 0.2, tint(0.75, 1.1));
      else tree(palms, s, l.edgeR + 1.9, 0.85 + rand() * 0.2, tint(0.85, 1.1));
    }
    // Far planting strip.
    const oppFar = l.opp(s) - 7.3;
    if (!inAny(l.gaps.far, s, 4) && !inAny(l.gaps.opp, s, 4) && !inAny(farLawnReserved, s, 4)) tree(banyans, s, oppFar - 2.0, 0.9 + rand() * 0.25, tint(0.75, 1.1));
    // Median.
    const w = medianW(s);
    if (!inAny(l.gaps.median, s, 3) && w >= 1.4) {
      const mid = l.edgeL - 0.3 - w / 2;
      if (!(w < 7 && nearLamp('left', s, 4))) tree(palms, s, mid + (rand() - 0.5) * Math.min(1, w * 0.2), 0.9 + rand() * 0.25, tint(0.85, 1.1));
      if (w >= 7) {
        tree(banyans, s + sp / 2, l.edgeL - 0.3 - 2.4, 0.95 + rand() * 0.3, tint(0.75, 1.1));
        tree(banyans, s + sp / 2, l.opp(s) + 7.6 + 2.4, 0.95 + rand() * 0.3, tint(0.75, 1.1));
      }
      if (w >= 16) {
        for (let k = 0; k < 2; k++) {
          const dd = l.edgeL - 0.3 - 5 - rand() * (w - 10);
          if (Math.abs(dd - mid) > 2.5) tree(rand() < 0.7 ? banyans : palms, s + rand() * sp, dd, 1.1 + rand() * 0.5, tint(0.7, 1.05));
        }
      }
    }
    // Lawn rows behind the sidewalks.
    if (rand() < 0.7 && !inAny(l.gaps.lawn, s, 6) && !inAny(lawnReserved, s)) {
      const d = l.edgeR + SIDE.lawn[0] + 4 + rand() * 9;
      if (rand() < 0.6) tree(banyans, s, d, 1.2 + rand() * 0.5, tint(0.7, 1.05));
      else for (let k = 0; k < 2; k++) tree(palms, s + k * 2.5, d + (rand() - 0.5) * 3, 0.95 + rand() * 0.3, tint(0.85, 1.1));
    }
    if (rand() < 0.6 && !inAny(l.gaps.farLawn, s, 6) && !inAny(l.gaps.opp, s, 6) && !inAny(farLawnReserved, s)) {
      tree(rand() < 0.6 ? banyans : palms, s, oppFar - SIDE.lawn[0] - 4 - rand() * 9, 1.1 + rand() * 0.5, tint(0.7, 1.05));
    }
  }
  for (let s = 3; s < len; s += 2.6) {
    const w = medianW(s);
    if (w >= 2.6 && !inAny(l.gaps.median, s, 2)) {
      const mid = l.edgeL - 0.3 - w / 2;
      const off = Math.min(0.75, w * 0.18) + 0.75;
      for (const sgn of [-1, 1]) {
        if (rand() < 0.85) shrubs.push({ s, m: place(s + rand(), mid + sgn * off, 0.18, rand() * 6.28, 0.8 + rand() * 0.45), c: tint(0.85, 1.15) });
      }
    }
    if (rand() < 0.35 && !inAny(l.gaps.right, s, 3) && !inAny(reserved.right, s, 2) && clear(s, l.edgeR + 0.95)) {
      shrubs.push({ s, m: place(s, l.edgeR + 0.95, 0.12, rand() * 6.28, 0.7 + rand() * 0.3), c: tint(0.85, 1.15) });
    }
  }

  // ---------------- Meshes ----------------
  const fol = foliageAtlas(aniso);
  const folMat = foliageMaterial(fol);
  const lampMats = lampMaterials();
  const poolMat = poolMaterial();
  const ahead = CONFIG.city.treeViewAhead;
  const behind = CONFIG.city.propViewBehind;
  const lampAhead = CONFIG.city.lampViewAhead;
  const windows = [
    new WindowedInstances(banyanGeometry(), folMat, banyans, ahead, behind),
    new WindowedInstances(palmGeometry(), folMat, palms, ahead, behind),
    new WindowedInstances(shrubGeometry(), folMat, shrubs, ahead * 0.6, behind),
    new WindowedInstances(doubleLampGeometry(), lampMats.pole, doubles, lampAhead, behind),
    new WindowedInstances(singleLampGeometry(), lampMats.pole, singles, lampAhead, behind),
    new WindowedInstances(lensGeometry(), lampMats.lens, lenses, lampAhead, behind),
    new WindowedInstances(poolGeometry(), poolMat, pools, ahead, behind),
  ];
  windows.forEach((w, i) => {
    // Windowed instances skip frustum culling, so shadow casting is limited to the cheap, close-reading types.
    w.mesh.castShadow = i === 0 || i === 3 || i === 4;
    w.mesh.name = ['banyans', 'palms', 'shrubs', 'lamps-double', 'lamps-single', 'lamp-lenses', 'lamp-pools'][i];
    if (i === 6) w.mesh.renderOrder = 1;
    root.add(w.mesh);
  });

  const signTex = atlas.texture(aniso);
  const boardMat = new THREE.MeshStandardMaterial({
    map: signTex,
    emissiveMap: signTex,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: CONFIG.city.signEmissive,
    roughness: 0.45,
    metalness: 0.1,
  });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const bbMat = new THREE.MeshStandardMaterial({
    map: bb.texture,
    emissiveMap: bb.texture,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: CONFIG.city.billboardBrightness,
    roughness: 0.55,
    metalness: 0,
  });
  const statics: THREE.Mesh[] = [
    new THREE.Mesh(struct.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5 })),
    new THREE.Mesh(boards.geometry(), boardMat),
    new THREE.Mesh(glow.geometry(), glowMat),
    new THREE.Mesh(faces.geometry(), bbMat),
  ];
  ['structures', 'sign-boards', 'glow', 'billboards'].forEach((n, i) => {
    const m = statics[i];
    m.name = n;
    m.castShadow = i < 2;
    m.receiveShadow = i < 2;
    m.matrixAutoUpdate = false;
    root.add(m);
  });
  scene.add(root);
  if (ctx.debug) ((window as unknown as { __SCENERY__?: Record<string, THREE.Object3D> }).__SCENERY__ ??= {}).props = root;

  // Time of day: lamps off by day, dim at sunset, full at dusk; glow trims, sign and billboard
  // emission scale with darkness (printed boards by day, lit boards at dusk).
  const lensOn = lampMats.lens.color.clone();
  const lensOff = new THREE.Color(0.32, 0.33, 0.35);
  const poolOn = poolMat.color.clone();
  const applyTime = (time: TimeOfDay) => {
    const n = nightLevel(time);
    const lamp = lampLevel(n);
    lampMats.lens.color.copy(lensOff).lerp(lensOn, lamp);
    poolMat.color.copy(poolOn).multiplyScalar(lamp);
    windows[6].mesh.visible = lamp > 0.01;
    glowMat.color.setScalar(0.3 + 0.7 * n);
    boardMat.emissiveIntensity = CONFIG.city.signEmissive * (0.3 + 0.7 * n);
    bbMat.emissiveIntensity = CONFIG.city.billboardBrightness * (0.22 + 0.78 * n);
  };
  applyTime(getTimeOfDay());
  const unsubscribe = onTimeOfDayChange(applyTime);

  for (const w of windows) w.update(0);
  return {
    update(frame: FrameInfo) {
      for (const w of windows) w.update(frame.s);
    },
    dispose() {
      unsubscribe();
      scene.remove(root);
      for (const w of windows) w.mesh.geometry.dispose();
      for (const m of statics) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      for (const m of [folMat, lampMats.pole, lampMats.lens, poolMat]) m.dispose();
      for (const t of [fol, signTex, bb.texture]) t.dispose();
    },
  };
}
