import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { facadeGeometry, type FacadeArrays } from '../buildings/builder';
import { createFacadeMaterial } from '../buildings/facadeMaterial';
import type { DetailTileRequest, DetailTileResult, RoadArrays } from './buildingWorker';
import { fetchBinary, type MetroData } from './load';
import { createMassMaterial, parseMassTile, type ReadyGrid } from './mass';

const M = CONFIG.metro;

type State = 'idle' | 'loading' | 'ready' | 'failed';

interface Tile {
  key: string;
  i: number;
  j: number;
  size: number;
  count: number;
  state: State;
  mesh: THREE.Mesh | null;
  /** Bumped on unload so a late load result is dropped. */
  gen: number;
}

export interface MetroBuildingsStats {
  detailLoaded: number;
  detailLoading: number;
  massLoaded: number;
  instances: number;
  detailVertices: number;
}

export interface MetroBuildings extends SceneryModule {
  stats(): MetroBuildingsStats;
  /** Detail / mass load radius (m); the explore view widens them. */
  setRadii(detail: number, mass: number, roadScale?: number): void;
  /** True once nothing within the radii is still loading. */
  settled(): boolean;
}

/**
 * Every building of 深圳市 beyond the route corridor, streamed by camera distance: 2 km detail tiles
 * (footprints extruded in a worker, the corridor's procedural facade) near the camera, 8 km mass tiles
 * (one instanced box per building) further out, and the skyline set (>= 60 m) at any distance.
 */
export async function createMetroBuildings(ctx: WorldContext, metro: MetroData): Promise<MetroBuildings> {
  const { scene, camera } = ctx;
  const bm = metro.meta.buildings;
  const empty: MetroBuildings = {
    update() {},
    stats: () => ({ detailLoaded: 0, detailLoading: 0, massLoaded: 0, instances: 0, detailVertices: 0 }),
    setRadii() {},
    settled: () => true,
  };
  if (!bm) return empty;
  const root = new THREE.Group();
  root.name = 'metro-buildings';
  scene.add(root);

  // Detail-tile readiness texture for the mass shader.
  let i0 = Infinity;
  let j0 = Infinity;
  let i1 = -Infinity;
  let j1 = -Infinity;
  for (const [i, j] of bm.detail) {
    i0 = Math.min(i0, i);
    j0 = Math.min(j0, j);
    i1 = Math.max(i1, i);
    j1 = Math.max(j1, j);
  }
  const ni = i1 - i0 + 1;
  const nj = j1 - j0 + 1;
  const readyData = new Uint8Array(ni * nj);
  const readyTex = new THREE.DataTexture(readyData, ni, nj, THREE.RedFormat, THREE.UnsignedByteType);
  readyTex.magFilter = readyTex.minFilter = THREE.NearestFilter;
  readyTex.unpackAlignment = 1;
  readyTex.needsUpdate = true;
  const ready: ReadyGrid = { texture: readyTex, tile: bm.detailTile, i0, j0, ni, nj };
  const setReady = (t: Tile, on: boolean) => {
    readyData[(t.j - j0) * ni + (t.i - i0)] = on ? 255 : 0;
    readyTex.needsUpdate = true;
  };

  const facade = createFacadeMaterial();
  facade.name = 'MetroFacade';
  const massMat = createMassMaterial(ready);

  const detail = new Map<string, Tile>();
  for (const [i, j, count] of bm.detail) detail.set(`${i}_${j}`, { key: `${i}_${j}`, i, j, size: bm.detailTile, count, state: 'idle', mesh: null, gen: 0 });
  const mass = new Map<string, Tile>();
  for (const [i, j, count] of bm.mass) mass.set(`${i}_${j}`, { key: `${i}_${j}`, i, j, size: bm.massTile, count, state: 'idle', mesh: null, gen: 0 });

  // Workers build the detail geometry off the main thread.
  const workers: Worker[] = [];
  const pending = new Map<string, (r: DetailTileResult) => void>();
  for (let k = 0; k < M.buildWorkers; k++) {
    const w = new Worker(new URL('./buildingWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DetailTileResult>) => {
      const cb = pending.get(e.data.key);
      pending.delete(e.data.key);
      cb?.(e.data);
    };
    workers.push(w);
  }
  let nextWorker = 0;
  const build = (key: string, buf: ArrayBuffer, kind: 'bld' | 'road' = 'bld') =>
    new Promise<DetailTileResult>((resolve) => {
      pending.set(key, resolve);
      const w = workers[nextWorker++ % workers.length];
      w.postMessage({ key, buf, kind } satisfies DetailTileRequest, [buf]);
    });

  // Roads and rail: ribbons on the terrain, loaded a little further out than the detail buildings.
  const roadMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    // A dull sky reflection: grazing views otherwise tint the asphalt blue-violet.
    envMapIntensity: 0.35,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  roadMat.name = 'MetroRoad';
  const roads = new Map<string, Tile>();
  for (const [i, j, count] of metro.meta.roads?.tiles ?? []) roads.set(`${i}_${j}`, { key: `${i}_${j}`, i, j, size: metro.meta.roads!.tile, count, state: 'idle', mesh: null, gen: 0 });
  const loadRoad = async (t: Tile) => {
    t.state = 'loading';
    const gen = t.gen;
    try {
      const res = await build(`road:${t.key}`, await fetchBinary(`${metro.base}roads/${t.key}.bin.gz`), 'road');
      if (res.error) throw new Error(res.error);
      if (gen !== t.gen) return;
      const a = res.arrays as RoadArrays | null;
      if (a) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(a.color, 3));
        geo.setIndex(new THREE.BufferAttribute(a.index, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, roadMat);
        mesh.position.set(res.ox, 0, res.oz);
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.receiveShadow = true;
        mesh.name = `metro-road-${t.key}`;
        root.add(mesh);
        t.mesh = mesh;
      }
      t.state = 'ready';
    } catch (e) {
      t.state = 'failed';
      console.warn(`[metro] road tile ${t.key}:`, e instanceof Error ? e.message : e);
    }
  };

  let detailVertices = 0;
  let instances = 0;
  const loadDetail = async (t: Tile) => {
    t.state = 'loading';
    const gen = t.gen;
    try {
      const buf = await fetchBinary(`${metro.base}bld/${t.key}.bin.gz`);
      const res = await build(t.key, buf);
      if (res.error) throw new Error(res.error);
      if (gen !== t.gen) return;
      if (res.arrays) {
        const mesh = new THREE.Mesh(facadeGeometry(res.arrays as FacadeArrays), facade);
        mesh.position.set(res.ox, 0, res.oz);
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.receiveShadow = true;
        mesh.name = `metro-detail-${t.key}`;
        root.add(mesh);
        t.mesh = mesh;
        detailVertices += res.arrays.position.length / 3;
      }
      t.state = 'ready';
      setReady(t, true);
    } catch (e) {
      t.state = 'failed';
      console.warn(`[metro] detail tile ${t.key}:`, e instanceof Error ? e.message : e);
    }
  };
  const loadMass = async (t: Tile, file: string) => {
    t.state = 'loading';
    const gen = t.gen;
    try {
      const mt = parseMassTile(await fetchBinary(metro.base + file));
      if (gen !== t.gen) return;
      const mesh = new THREE.Mesh(mt.geometry, massMat);
      mesh.position.set(mt.ox, 0, mt.oz);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.name = `metro-mass-${t.key}`;
      root.add(mesh);
      t.mesh = mesh;
      instances += mt.count;
      t.state = 'ready';
    } catch (e) {
      t.state = 'failed';
      console.warn(`[metro] mass tile ${t.key}:`, e instanceof Error ? e.message : e);
    }
  };
  const unload = (t: Tile, kind: 'detail' | 'mass' | 'road') => {
    t.gen++;
    if (t.mesh) {
      root.remove(t.mesh);
      if (kind === 'detail') detailVertices -= t.mesh.geometry.getAttribute('position').count;
      else if (kind === 'mass') instances -= (t.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
      t.mesh.geometry.dispose();
      t.mesh = null;
    }
    if (kind === 'detail') setReady(t, false);
    t.state = 'idle';
  };

  const sky: Tile = { key: 'skyline', i: 0, j: 0, size: 0, count: bm.skyline.count, state: 'idle', mesh: null, gen: 0 };
  await loadMass(sky, bm.skyline.file);

  let rDetail: number = M.detailRadius;
  let rMass: number = M.massRadius;
  let roadScale: number = M.roadRadiusScale;
  const cam = new THREE.Vector3();
  const dist = (t: Tile) => {
    const x0 = t.i * t.size;
    const z0 = t.j * t.size;
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + t.size));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + t.size));
    const dy = Math.max(0, cam.y - 150);
    return Math.sqrt(dx * dx + dz * dz + dy * dy);
  };
  let acc = 1;
  const schedule = () => {
    camera.getWorldPosition(cam);
    const want: [number, Tile][] = [];
    for (const t of detail.values()) {
      const d = dist(t);
      if (d > rDetail + M.unloadSlack) {
        if (t.state !== 'idle') unload(t, 'detail');
      } else if (d <= rDetail && t.state === 'idle') want.push([d, t]);
    }
    const rRoad = rDetail * roadScale;
    for (const t of roads.values()) {
      const d = dist(t);
      if (d > rRoad + M.unloadSlack) {
        if (t.state !== 'idle') unload(t, 'road');
      } else if (d <= rRoad && t.state === 'idle') want.push([d, t]);
    }
    let loading = 0;
    for (const t of detail.values()) if (t.state === 'loading') loading++;
    for (const t of roads.values()) if (t.state === 'loading') loading++;
    want.sort((a, b) => a[0] - b[0]);
    for (const [, t] of want) {
      if (loading >= M.maxDetailLoads) break;
      loading++;
      void (roads.get(t.key) === t ? loadRoad(t) : loadDetail(t));
    }
    for (const t of mass.values()) {
      const d = dist(t);
      if (d > rMass + M.unloadSlack) {
        if (t.state !== 'idle') unload(t, 'mass');
      } else if (d <= rMass && t.state === 'idle') void loadMass(t, `mass/${t.key}.bin.gz`);
    }
  };
  schedule();

  return {
    update(frame: FrameInfo) {
      acc += frame.dt;
      if (acc < 0.2) return;
      acc = 0;
      schedule();
    },
    stats() {
      let dl = 0;
      let dg = 0;
      let ml = 0;
      for (const t of detail.values()) {
        if (t.state === 'ready') dl++;
        if (t.state === 'loading') dg++;
      }
      for (const t of mass.values()) if (t.state === 'ready') ml++;
      return { detailLoaded: dl, detailLoading: dg, massLoaded: ml, instances, detailVertices };
    },
    setRadii(d: number, m: number, rs = M.roadRadiusScale) {
      rDetail = d;
      rMass = m;
      roadScale = rs;
      schedule();
    },
    settled() {
      camera.getWorldPosition(cam);
      for (const t of detail.values()) if (t.state === 'loading' || (t.state === 'idle' && dist(t) <= rDetail)) return false;
      for (const t of roads.values()) if (t.state === 'loading' || (t.state === 'idle' && dist(t) <= rDetail * roadScale)) return false;
      for (const t of mass.values()) if (t.state === 'loading' || (t.state === 'idle' && dist(t) <= rMass)) return false;
      return true;
    },
    dispose() {
      for (const w of workers) w.terminate();
      scene.remove(root);
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      facade.dispose();
      massMat.dispose();
      roadMat.dispose();
      readyTex.dispose();
    },
  };
}
