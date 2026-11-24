import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import type { SectionId, Vec2 } from '../../route/types';
import { insideLandmarkSite, resolveLandmarkSites } from '../landmarks/placement';
import { FacadeBuilder, rectRing, ringArea, ringCentroid } from './builder';
import { STYLE, createFacadeMaterial } from './facadeMaterial';

const C = CONFIG.city;
const FAR_CHUNK = 1000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromId(id: number): number {
  const lo = id % 2147483647;
  const hi = Math.floor(id / 2147483647);
  let h = Math.imul(lo ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(hi + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function styleFor(zone: SectionId, h: number, r: number): number {
  if (h < 18) return r < 0.6 ? STYLE.stone : STYLE.mixed;
  switch (zone) {
    case 'nanshan':
      return r < 0.6 ? STYLE.tealGlass : r < 0.85 ? STYLE.mixed : STYLE.blueGlass;
    case 'oct':
      return r < 0.55 ? STYLE.stone : r < 0.85 ? STYLE.mixed : STYLE.tealGlass;
    case 'chegongmiao':
      return r < 0.45 ? STYLE.mixed : r < 0.85 ? STYLE.blueGlass : STYLE.stone;
    case 'futian':
    default:
      return r < 0.65 ? STYLE.blueGlass : r < 0.82 ? STYLE.tealGlass : STYLE.mixed;
  }
}

const HEIGHT_RANGE: Record<SectionId, [number, number]> = {
  nanshan: [60, 200],
  oct: [20, 80],
  chegongmiao: [80, 250],
  futian: [100, 300],
};

function pointInRing(ring: Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Uniform-grid set of occupied circles (building footprints) for overlap tests. */
class Occupancy {
  private cells = new Map<string, number[]>();
  private readonly cell = 60;
  private key(i: number, j: number) {
    return i + ',' + j;
  }
  add(x: number, z: number, r: number) {
    const i0 = Math.floor((x - r) / this.cell);
    const i1 = Math.floor((x + r) / this.cell);
    const j0 = Math.floor((z - r) / this.cell);
    const j1 = Math.floor((z + r) / this.cell);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(x, z, r);
      }
  }
  hits(x: number, z: number, r: number): boolean {
    const i0 = Math.floor((x - r) / this.cell);
    const i1 = Math.floor((x + r) / this.cell);
    const j0 = Math.floor((z - r) / this.cell);
    const j1 = Math.floor((z + r) / this.cell);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const arr = this.cells.get(this.key(i, j));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 3) {
          const dx = arr[k] - x;
          const dz = arr[k + 1] - z;
          const rr = arr[k + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    return false;
  }
}

interface Chunk {
  mesh: THREE.Mesh;
  sMid: number;
  cx: number;
  cz: number;
  r: number;
}

/** Street-wall record used by the gap filler (real or procedural building). */
interface Placed {
  s: number;
  d: number;
}

/**
 * OSM building footprints extruded and merged per chunk of s with a shared
 * procedural facade shader; procedural blocks when buildings.json is missing,
 * plus gap fillers so the street wall stays continuous.
 */
export async function createBuildings(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene } = ctx;
  const material = createFacadeMaterial();
  const sites = resolveLandmarkSites(route);
  const hill = sites.get('lianhuashan');
  const occ = new Occupancy();
  const near = new Map<number, FacadeBuilder>();
  const far = new Map<number, FacadeBuilder>();
  const placed: Placed[] = [];
  const L = route.length;
  const intersections = (route.data.intersections ?? []).map((i) => i.s);
  const clampS = (s: number) => route.clampS(s);

  const builderFor = (s: number, isFar: boolean) => {
    const map = isFar ? far : near;
    const key = Math.floor(s / (isFar ? FAR_CHUNK : C.chunkLength));
    let b = map.get(key);
    if (!b) map.set(key, (b = new FacadeBuilder()));
    return b;
  };

  /** True when every point is outside the road corridor (right of +minR, left of opposite - minL). */
  const clearOfRoad = (ring: Vec2[], sHint: number, minR: number, minL: number) => {
    for (const p of ring) {
      const pr = route.project(p[0], p[1], sHint, 600);
      const opp = route.oppositeOffsetAt(clampS(pr.s));
      if (pr.d < minR && pr.d > opp - minL) return false;
    }
    return true;
  };

  const nearIntersection = (s: number, half: number) => {
    for (const x of intersections) if (Math.abs(x - s) < half) return true;
    return false;
  };

  const onHill = (x: number, z: number) => !!hill && Math.hypot(x - hill.x, z - hill.z) < hill.hx;

  /** Extrudes one building with roof equipment / crown details. */
  const addBuilding = (b: FacadeBuilder, ring: Vec2[], h: number, seed: number, style: number, podium: number, y0 = 0) => {
    b.addPrism(ring, y0, h, [seed, style, podium, h]);
    const rng = mulberry32(Math.floor(seed * 1e9) ^ 0x5bd1e995);
    const area = Math.abs(ringArea(ring));
    if (h < 25 || area < 150) return;
    const [cx, cz] = ringCentroid(ring);
    if (!pointInRing(ring, cx, cz)) return;
    // Long-edge axis for aligning roof boxes.
    let ax = 1;
    let az = 0;
    let best = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > best) {
        best = l;
        ax = (q[0] - p[0]) / l;
        az = (q[1] - p[1]) / l;
      }
    }
    const size = Math.sqrt(area);
    if (h > 90 && ring.length <= 10 && rng() < 0.75) {
      const k = 0.62 + rng() * 0.15;
      const crown = ring.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k] as Vec2);
      const ch = 5 + rng() * 9;
      b.addPrism(crown, h, h + ch, [seed, rng() < 0.5 ? style : STYLE.mech, 0, h + ch]);
      h += ch;
    }
    const boxes = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < boxes; i++) {
      const w = Math.min(14, Math.max(3, size * (0.12 + rng() * 0.15)));
      const d = Math.min(10, Math.max(2.5, size * (0.08 + rng() * 0.12)));
      const ox = (rng() - 0.5) * size * 0.35;
      const oz = (rng() - 0.5) * size * 0.35;
      const bx = cx + ax * ox - az * oz;
      const bz = cz + az * ox + ax * oz;
      const box = rectRing(bx, bz, ax, az, w / 2, d / 2);
      if (!box.every(([x, z]) => pointInRing(ring, x, z))) continue;
      const bh = 2.5 + rng() * 4;
      b.addPrism(box, h, h + bh, [seed, STYLE.mech, 0, h + bh]);
    }
  };

  /** Procedural block at route coords (s, d) with long side along the route. */
  const addBlock = (rng: () => number, s: number, d: number, len: number, dep: number, h: number, isFar: boolean): boolean => {
    const sc = clampS(s);
    const p = route.pointAt(s, d);
    const t = route.tangentAt(sc);
    const r = Math.hypot(len, dep) / 2;
    if (occ.hits(p.x, p.z, r * 0.9)) return false;
    if (insideLandmarkSite(sites, p.x, p.z, r + 10) || onHill(p.x, p.z)) return false;
    const zone = route.sectionAt(sc).id;
    const chamfer = rng() < 0.3 ? Math.min(len, dep) * 0.15 : 0;
    const ring = rectRing(p.x, p.z, t.x, t.z, len / 2, dep / 2, chamfer);
    if (!clearOfRoad(ring, sc, 24, 20)) return false;
    occ.add(p.x, p.z, r * 0.9);
    const seed = rng();
    const b = builderFor(s, isFar);
    if (!isFar && h > 50 && rng() < 0.65) {
      const podH = 10 + rng() * 12;
      b.addPrism(ring, 0, podH, [seed, rng() < 0.5 ? STYLE.mixed : STYLE.stone, podH, podH]);
      const back = d > 0 ? dep * 0.12 : -dep * 0.12;
      const tp = route.pointAt(s, d + back);
      const tower = rectRing(tp.x, tp.z, t.x, t.z, len * (0.3 + rng() * 0.12), dep * (0.3 + rng() * 0.1), rng() < 0.5 ? 3 : 0);
      addBuilding(b, tower, h, seed, styleFor(zone, h, rng()), 0, podH);
    } else {
      addBuilding(b, ring, h, seed, styleFor(zone, h, rng()), isFar ? 0 : h > 24 ? 5.5 + rng() * 6 : 5);
    }
    if (!isFar) placed.push({ s, d });
    return true;
  };

  const heightFor = (rng: () => number, s: number, k: number) => {
    const [lo, hi] = HEIGHT_RANGE[route.sectionAt(clampS(s)).id];
    return lo + (hi - lo) * Math.pow(rng(), 1.6) * k;
  };

  // --- Real OSM buildings -------------------------------------------------
  let farCount = 0;
  if (ctx.buildings) {
    for (const rec of ctx.buildings.buildings) {
      if (!rec.fp || rec.fp.length < 3 || !(rec.h > 2)) continue;
      const [cx, cz] = ringCentroid(rec.fp);
      if (insideLandmarkSite(sites, cx, cz, 5)) continue;
      if (!rec.far) {
        let ok = true;
        let minSide = 0;
        let maxSide = 0;
        for (const p of rec.fp) {
          const pr = route.project(p[0], p[1], rec.s, 300);
          const opp = route.oppositeOffsetAt(clampS(pr.s));
          if (pr.d < 12 && pr.d > opp - 8) {
            ok = false;
            break;
          }
          if (pr.d > 0) maxSide = 1;
          else minSide = 1;
        }
        if (!ok || (minSide && maxSide && Math.abs(rec.d) < 60)) continue;
      }
      const seed = seedFromId(rec.id);
      const style = styleFor(rec.zone, rec.h, seed);
      const podium = rec.far ? 0 : rec.h > 24 ? 5.5 + seed * 6 : rec.h > 8 ? 5 : 0;
      addBuilding(builderFor(rec.s, !!rec.far), rec.fp, rec.h, seed, style, podium);
      let r = 0;
      for (const p of rec.fp) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cz));
      occ.add(cx, cz, r);
      if (rec.far) farCount++;
      else placed.push({ s: rec.s, d: rec.d });
    }
  } else {
    // --- Procedural fallback: rows of blocks along both sides ---------------
    for (const side of [1, -1] as const) {
      const rng = mulberry32(side > 0 ? 1234 : 4321);
      let s = -300;
      while (s < L + 250) {
        const len = 30 + rng() * 45;
        const sc = s + len / 2;
        if (!nearIntersection(sc, len / 2 + 14)) {
          const opp = route.oppositeOffsetAt(clampS(sc));
          const d0 = side > 0 ? 26 + rng() * 8 : opp - 26 - rng() * 8;
          const dep = 18 + rng() * 26;
          addBlock(rng, sc, d0 + (side * dep) / 2, len, dep, heightFor(rng, sc, 0.75), false);
          const d1 = d0 + side * (dep + 14 + rng() * 16);
          const dep1 = 24 + rng() * 34;
          addBlock(rng, sc + (rng() - 0.5) * 20, d1 + (side * dep1) / 2, len * (0.75 + rng() * 0.4), dep1, heightFor(rng, sc, 1), false);
          if (rng() < 0.7) {
            const d2 = d1 + side * (dep1 + 20 + rng() * 70);
            const dep2 = 30 + rng() * 30;
            addBlock(rng, sc + (rng() - 0.5) * 30, d2 + (side * dep2) / 2, 30 + rng() * 25, dep2, heightFor(rng, sc, 1.1), false);
          }
        }
        s += len + 10 + rng() * 18;
      }
    }
  }

  // --- Gap filler: keep the street wall continuous ------------------------
  {
    const step = C.buildingFillerStep;
    const probe = C.buildingFillerProbe;
    const nSeg = Math.ceil(L / step);
    const hasR = new Uint8Array(nSeg);
    const hasL = new Uint8Array(nSeg);
    for (const p of placed) {
      const i = Math.floor(p.s / step);
      if (i < 0 || i >= nSeg) continue;
      const opp = route.oppositeOffsetAt(clampS(p.s));
      if (p.d > 0 && p.d < 24 + probe) hasR[i] = 1;
      else if (p.d < 0 && p.d > opp - 20 - probe) hasL[i] = 1;
    }
    const rng = mulberry32(777);
    for (let i = 0; i < nSeg; i++) {
      for (const side of [1, -1] as const) {
        if ((side > 0 ? hasR : hasL)[i]) continue;
        let s = i * step + rng() * 8;
        while (s < (i + 1) * step - 20) {
          const len = 28 + rng() * 22;
          const sc = s + len / 2;
          if (!nearIntersection(sc, len / 2 + 14)) {
            const opp = route.oppositeOffsetAt(clampS(sc));
            const d0 = side > 0 ? 26 + rng() * 10 : opp - 22 - rng() * 10;
            const dep = 18 + rng() * 22;
            addBlock(rng, sc, d0 + (side * dep) / 2, len, dep, heightFor(rng, sc, 0.6), false);
            const d1 = d0 + side * (dep + 15 + rng() * 20);
            addBlock(rng, sc, d1 + side * 20, len * 0.9, 34, heightFor(rng, sc, 1), false);
          }
          s += len + 8 + rng() * 14;
        }
      }
    }
  }

  // --- Far skyline when the data has little of it -------------------------
  if (farCount < 40) {
    const rng = mulberry32(9001);
    for (const side of [1, -1] as const) {
      let s = 0;
      while (s < L + 300) {
        const d = side * (320 + rng() * 650);
        const w = 30 + rng() * 25;
        addBlock(rng, s, d, w, w * (0.7 + rng() * 0.4), heightFor(rng, s, 1.25), true);
        s += 90 + rng() * 160;
      }
    }
  }

  // --- Meshes --------------------------------------------------------------
  const nearChunks: Chunk[] = [];
  const group = new THREE.Group();
  group.name = 'buildings';
  const makeMesh = (b: FacadeBuilder, sMid: number, isFar: boolean) => {
    const geo = b.build();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = isFar ? 'buildings-far' : 'buildings-near';
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    group.add(mesh);
    const bs = geo.boundingSphere!;
    return { mesh, sMid, cx: bs.center.x, cz: bs.center.z, r: bs.radius };
  };
  for (const [k, b] of near) if (!b.empty) nearChunks.push(makeMesh(b, (k + 0.5) * C.chunkLength, false));
  for (const [k, b] of far) if (!b.empty) makeMesh(b, (k + 0.5) * FAR_CHUNK, true);
  scene.add(group);

  const drawDist = C.buildingDrawDistance;
  const shadowDist = C.buildingShadowDistance + C.chunkLength * 0.5;
  return {
    update(frame: FrameInfo) {
      const fx = frame.focus.x;
      const fz = frame.focus.z;
      for (const c of nearChunks) {
        const dx = c.cx - fx;
        const dz = c.cz - fz;
        c.mesh.visible = Math.sqrt(dx * dx + dz * dz) - c.r < drawDist;
        c.mesh.castShadow = Math.abs(c.sMid - frame.s) < shadowDist;
      }
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      material.dispose();
    },
  };
}
