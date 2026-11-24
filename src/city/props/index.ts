import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import type { RGB } from '../road/builder';
import { getRoadLayout, type Interval, inJunction, SIDE } from '../road/layout';
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

/** Sign texture density (pixels per metre of sign face). */
const PX = 80;

const inAny = (gaps: Interval[], s: number, margin = 0) => gaps.some(([a, b]) => s > a - margin && s < b + margin);

export async function createProps(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene, renderer } = ctx;
  const l = getRoadLayout(route);
  const { turn, W } = l;
  const len = route.length;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const rand = mulberry32(2026);
  const root = new THREE.Group();
  root.name = 'props';

  const P = { x: 0, z: 0 };
  const yawAt = (s: number) => route.headingAt(Math.min(len, Math.max(0, s)));
  const place = (s: number, d: number, y = 0, yawOff = 0, scale = 1) => {
    const p = route.pointAt(s, d, P);
    return placeMatrix(p.x, y, p.z, yawAt(s) + yawOff, scale);
  };
  const reserved: Record<'right' | 'left', Interval[]> = { right: [], left: [] };
  const lawnReserved: Interval[] = [];
  const reserve = (side: 'right' | 'left' | 'both', s: number, half: number) => {
    if (side !== 'left') reserved.right.push([s - half, s + half]);
    if (side !== 'right') reserved.left.push([s - half, s + half]);
  };

  // ---------------- Signs, gates and other static structures ----------------
  const atlas = new SignAtlas();
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

  /** Full-width overhead gantry. */
  const gantry = (s: number, panels: { d0: number; d1: number; slot: Slot }[]) => {
    const m = place(s, 0);
    const dL = l.edgeL - 0.9;
    const dR = l.edgeR + 0.9;
    for (const d of [dL, dR]) {
      struct.cylinder(m, [d, 0, 0], [d, 8.3, 0], 0.26, 0.2, 10, METAL);
      struct.box(m, d, 0.25, 0, 0.8, 0.5, 0.8, DARK);
    }
    for (const y of [6.3, 7.7]) struct.box(m, (dL + dR) / 2, y, -0.3, dR - dL + 0.4, 0.22, 0.22, METAL);
    for (let k = 0; k <= 8; k++) {
      const x = dL + ((dR - dL) * k) / 8;
      struct.box(m, x, 7.0, -0.3, 0.1, 1.4, 0.1, METAL);
    }
    for (const p of panels) board(m, (p.d0 + p.d1) / 2, 6.65, 0, p.d1 - p.d0, 2.9, p.slot);
    reserve('both', s, 6);
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

  // Guide signs from the route data (e.g. the APEC venue sign at 香蜜湖路, the turn guide).
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

  // Junction advance signs and corner street-name plates.
  const signsS = (route.data.signs ?? []).map((x) => x.s);
  for (const c of l.cross) {
    const sAdv = c.s - W - 150;
    if (c.name && sAdv > 60 && !signsS.some((x) => Math.abs(x - sAdv) < 60) && !inJunction(l, sAdv, 10)) {
      cantilever(sAdv, 'right', drawJunction(atlas, 5.6 * PX, 3.2 * PX, c.name, '深南大道'), 5.6, 3.2);
    }
    if (c.name) {
      const plate = drawPlate(atlas, c.name);
      for (const [s, d, yawOff] of [
        [c.s - W - 2.5, l.edgeR + SIDE.walk[0] + 1.2, 0],
        [c.s + W + 2.5, l.opp(c.s) - 7.3 - SIDE.walk[0] - 1.2, Math.PI],
      ] as [number, number, number][]) {
        const m = place(s, d, 0, yawOff);
        struct.cylinder(m, [0, 0, 0], [0, 3.9, 0], 0.06, 0.05, 8, METAL);
        board(m, 0, 3.45, 0.08, 2.4, 0.65, plate, plate, 0.06);
      }
    }
  }

  // Turn guidance: two overhead gantries, a street-name plate, chevrons and barriers on the outer edge.
  const turnName = turn?.name || route.data.turn?.name || '';
  if (turn) {
    for (const back of [300, 120]) {
      const s = turn.sA - back;
      if (s < 50) continue;
      const left = drawGuide(atlas, 7 * PX, 2.9 * PX, '市民中心', turnName ? `左转 ${turnName}` : '左转', { arrow: turn.left ? 'left' : 'right' });
      const right = drawGuide(atlas, 6 * PX, 2.9 * PX, '福田中心区', `前方 ${back} 米${turn.left ? '左转' : '右转'}`, { arrow: turn.left ? 'left' : 'right' });
      gantry(s, [
        { d0: route.dMin + 0.2, d1: route.dMin + 7.2, slot: left },
        { d0: route.dMax - 6.2, d1: route.dMax - 0.2, slot: right },
      ]);
    }
    if (turnName) {
      const plate = drawPlate(atlas, turnName);
      const m = place(turn.sA - 3, l.edgeR + SIDE.walk[0] + 1.2);
      struct.cylinder(m, [0, 0, 0], [0, 3.9, 0], 0.06, 0.05, 8, METAL);
      board(m, 0, 3.45, 0.08, 2.4, 0.65, plate, plate, 0.06);
    }
    const chev = drawChevron(atlas, turn.left ? 'left' : 'right');
    const dChev = turn.left ? l.edgeR + 1.3 : l.edgeL - 1.3;
    for (let s = turn.s0 - 8; s <= turn.s1 + 4; s += 4.5) {
      const m = place(s, dChev);
      struct.cylinder(m, [0, 0, 0], [0, 2.2, 0], 0.05, 0.05, 6, METAL);
      board(m, 0, 1.65, 0.06, 0.8, 1.0, chev, undefined, 0.05);
    }
    let k = 0;
    for (let s = turn.s0 - 6; s <= turn.s1 + 6; s += 1.6, k++) {
      for (const d of [l.edgeR + 0.35, l.edgeL - 0.35]) struct.box(place(s, d), 0, 0.4, 0, 0.5, 0.8, 1.4, k % 2 ? WHITE : RED);
    }
  }

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
    while (inJunction(l, sb, 2) && sb < len - 30) sb += 10;
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

  // Lit billboards on the right-hand lawn (AI images replace the placeholders when present).
  const bb = new BillboardAtlas(aniso);
  bb.loadAi(import.meta.env.BASE_URL);
  const faces = new PropGeo();
  const nBB = CONFIG.city.billboardCount;
  const bbEnd = (turn ? turn.sA - 350 : len - 300) - 400;
  for (let i = 0; i < nBB; i++) {
    let s = 400 + ((i + 0.5) * bbEnd) / nBB;
    while (inJunction(l, s, 30) && s < len - 100) s += 25;
    const m = place(s, l.edgeR + SIDE.lawn[0] + 8, 0, -0.35);
    struct.cylinder(m, [0, 0, 0], [0, 12.6, 0], 0.45, 0.38, 12, METAL);
    struct.box(m, 0, 14.6, -0.38, 12.6, 4.6, 0.5, DARK);
    faces.quad(m, [-6, 12.6, -0.1], [6, 12.6, -0.1], [6, 16.6, -0.1], [-6, 16.6, -0.1], bb.uv(i), WHITE);
    for (const x of [-4, 0, 4]) {
      struct.box(m, x, 16.95, 0.25, 0.08, 0.08, 0.7, DARK);
      glow.box(m, x, 16.9, 0.6, 1.2, 0.1, 0.12, WARM);
    }
    lawnReserved.push([s - 12, s + 12]);
  }

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
    const m = place(s, d, 0, yawOff);
    list.push({ s, m });
    for (const h of heads) {
      const lm = new THREE.Matrix4().makeTranslation(h[0], h[1], h[2]).premultiply(m);
      lenses.push({ s, m: lm });
      hv.set(h[0], 0, h[2]).applyMatrix4(m);
      pools.push({ s, m: new THREE.Matrix4().makeScale(17, 1, 17).setPosition(hv.x, 0.025, hv.z) });
    }
  };
  for (let s = lampSp / 2; s < len - 5; s += lampSp) {
    if (inJunction(l, s, 3)) continue;
    if (!inAny(reserved.right, s, 3) && !inAny(l.gaps.right, s, 3)) {
      addLamp(singles, SINGLE_HEADS, s, l.edgeR + 0.8, 0);
      lampAt.right.push(s);
    }
    if (!inAny(l.gaps.far, s, 3) && !inAny(l.gaps.opp, s, 3)) addLamp(singles, SINGLE_HEADS, s, l.opp(s) - 7.3 - 0.8, Math.PI);
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
  const tree = (list: InstanceItem[], s: number, d: number, sc: number, c: THREE.Color) =>
    list.push({ s, m: place(s, d, 0, rand() * Math.PI * 2, sc), c });
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
    if (!inAny(l.gaps.far, s, 4) && !inAny(l.gaps.opp, s, 4)) tree(banyans, s, oppFar - 2.0, 0.9 + rand() * 0.25, tint(0.75, 1.1));
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
    if (rand() < 0.6 && !inAny(l.gaps.farLawn, s, 6) && !inAny(l.gaps.opp, s, 6)) {
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
    if (rand() < 0.35 && !inAny(l.gaps.right, s, 3) && !inAny(reserved.right, s, 2)) {
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
  const statics: THREE.Mesh[] = [
    new THREE.Mesh(struct.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5 })),
    new THREE.Mesh(
      boards.geometry(),
      new THREE.MeshStandardMaterial({
        map: signTex,
        emissiveMap: signTex,
        emissive: new THREE.Color(1, 1, 1),
        emissiveIntensity: CONFIG.city.signEmissive,
        roughness: 0.45,
        metalness: 0.1,
      }),
    ),
    new THREE.Mesh(glow.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    new THREE.Mesh(faces.geometry(), new THREE.MeshBasicMaterial({ map: bb.texture, color: new THREE.Color(1, 1, 1).multiplyScalar(CONFIG.city.billboardBrightness) })),
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

  for (const w of windows) w.update(0);
  return {
    update(frame: FrameInfo) {
      for (const w of windows) w.update(frame.s);
    },
    dispose() {
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
