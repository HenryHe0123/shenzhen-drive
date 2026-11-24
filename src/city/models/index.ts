import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import type { CityModelRecord } from '../../route/types';
import { nightUniform } from '../../render/timeOfDay';
import { STYLE } from '../buildings/facadeMaterial';
import { Accents } from './accents';
import { createTintedFacadeMaterial, type FaceStyler } from './cleanFacade';
import { prepareModel } from './prepare';

const M = CONFIG.cityModels;
const C = CONFIG.city;

/** Per-face facade style of clean-geometry landmarks (the hand-built ones' styles), by record id prefix. */
const CLEAN_STYLE: [RegExp, (height: number) => FaceStyler][] = [
  [/^ping_an_finance_cent/, () => () => STYLE.pingan],
  // Civic Center: warm glass halls; the thin bands of the wave roof read as metal louvers.
  [/^(civic_center_|citizen_centre_)/, (h) => (y0, y1) => (y0 > 0.25 * h && y1 - y0 < 14 ? STYLE.mech : STYLE.civic)],
  [/^tencent/, () => () => STYLE.tencent],
];

type SlotState = 'queued' | 'loading' | 'loaded' | 'failed';

interface Slot {
  rec: CityModelRecord;
  state: SlotState;
  object: THREE.Group | null;
  meshes: THREE.Mesh[];
  disposables: { dispose(): void }[];
  /** World bounding circle (x, z, radius). */
  cx: number;
  cz: number;
  r: number;
  skyline: boolean;
  cast: boolean;
  drawCalls: number;
  tris: number;
  atlas: [number, number] | null;
}

export interface CityModelsDebug {
  total: number;
  loaded: number;
  failed: number;
  /** All models settled (loaded or failed). */
  ready: boolean;
  list(): { id: string; state: SlotState; visible: boolean; drawCalls: number; tris: number; atlas: string | null }[];
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Real Shenzhen building models (3D Warehouse, processed offline into
 * public/models/city/) placed from ctx.cityModels at (x, 0, z), rotation.y = yaw.
 * Loading never blocks: the module returns at once and GLBs stream in nearest
 * first (skyline towers early), each turned into <= 2 draw calls (landmarks
 * <= 8) by prepareModel. Photo-textured models get the photo facade material,
 * clean geometry the procedural facade; night accents follow nightUniform.
 * Visibility per model by distance (skyline models always), shadows only near
 * the car, thinned fog for skyline models.
 */
export async function createCityModels(ctx: WorldContext): Promise<SceneryModule> {
  const records = ctx.cityModels?.models ?? [];
  const debugState: CityModelsDebug = {
    total: records.length,
    loaded: 0,
    failed: 0,
    ready: records.length === 0,
    list: () =>
      slots.map((s) => ({
        id: s.rec.id,
        state: s.state,
        visible: !!s.object?.visible && !!s.object.parent,
        drawCalls: s.drawCalls,
        tris: s.tris,
        atlas: s.atlas ? s.atlas.join('x') : null,
      })),
  };
  if (ctx.debug) (window as unknown as { __CITY_MODELS__?: CityModelsDebug }).__CITY_MODELS__ = debugState;
  const slots: Slot[] = [];
  if (!records.length) return { update() {} };

  const { scene, renderer, camera } = ctx;
  const root = new THREE.Group();
  root.name = 'city-models';
  scene.add(root);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const accents = new Accents();
  let facadeNear: THREE.Material | null = null;
  let facadeFar: THREE.Material | null = null;
  const facade = (far: boolean) => {
    if (far) return (facadeFar ??= createTintedFacadeMaterial({ fogScale: C.landmarkFogScale }));
    return (facadeNear ??= createTintedFacadeMaterial());
  };

  for (const rec of records) {
    slots.push({
      rec,
      state: 'queued',
      object: null,
      meshes: [],
      disposables: [],
      cx: rec.x,
      cz: rec.z,
      r: 50,
      skyline: rec.role === 'skyline' || rec.height >= M.skylineHeight,
      cast: false,
      drawCalls: 0,
      tris: 0,
      atlas: null,
    });
  }
  const queue = slots.slice();
  const loaded: { slot: Slot; gltf: GLTF }[] = [];
  let inFlight = 0;
  let focusS: number = CONFIG.race.startS;
  let disposed = false;

  const settle = (slot: Slot, state: SlotState) => {
    slot.state = state;
    if (state === 'loaded') debugState.loaded++;
    else debugState.failed++;
    debugState.ready = debugState.loaded + debugState.failed === slots.length;
  };

  /** Next model to fetch: closest along the route, ahead preferred, skyline towers early. */
  const pickNext = (): Slot | null => {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i].rec;
      const ds = r.s - focusS;
      let score = ds >= 0 ? ds : -ds * 3;
      if (queue[i].skyline) score -= 4000;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return null;
    const slot = queue[best];
    queue[best] = queue[queue.length - 1];
    queue.pop();
    return slot;
  };

  const pump = () => {
    while (!disposed && inFlight < M.maxConcurrentLoads) {
      const slot = pickNext();
      if (!slot) return;
      slot.state = 'loading';
      inFlight++;
      loader
        .loadAsync(import.meta.env.BASE_URL + slot.rec.file)
        .then((gltf) => {
          if (disposed) disposeGltf(gltf);
          else loaded.push({ slot, gltf });
        })
        .catch((e: unknown) => {
          console.warn(`[city-models] ${slot.rec.file}: ${e instanceof Error ? e.message : String(e)}`);
          settle(slot, 'failed');
        })
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  };

  const install = (slot: Slot, gltf: GLTF) => {
    const rec = slot.rec;
    const landmark = rec.role !== 'frontage' || !!rec.replacesLandmark;
    const far = rec.role === 'skyline' || rec.height >= M.fogScaleHeight;
    const styler = CLEAN_STYLE.find(([re]) => re.test(rec.id))?.[1](rec.height);
    const prep = prepareModel(gltf.scene, {
      photo: rec.photoTextured,
      maxDrawCalls: landmark ? M.drawCallsLandmark : M.drawCallsBuilding,
      atlasMax: landmark ? M.atlasMaxLandmark : M.atlasMaxBuilding,
      atlasTile: landmark ? M.atlasTileLandmark : M.atlasTileBuilding,
      seed: seedOf(rec.id),
      fogScale: far ? C.landmarkFogScale : undefined,
      anisotropy,
      facadeMaterial: () => facade(far),
      styler,
      podium: rec.role === 'frontage' ? 5.5 : 0,
    });
    const obj = new THREE.Group();
    obj.name = `city-model:${rec.id}`;
    obj.position.set(rec.x, 0, rec.z);
    obj.rotation.y = rec.yaw;
    obj.add(prep.object);
    const acc = accents.build(rec, prep.geometry, prep.bounds);
    if (acc) obj.add(acc);
    obj.updateMatrixWorld(true);
    obj.matrixAutoUpdate = false;
    for (const o of [prep.object, ...(acc ? [acc] : [])]) o.matrixAutoUpdate = false;

    const center = prep.bounds.getCenter(new THREE.Vector3()).applyMatrix4(obj.matrixWorld);
    const size = prep.bounds.getSize(new THREE.Vector3());
    slot.cx = center.x;
    slot.cz = center.z;
    slot.r = Math.hypot(size.x, size.z) / 2;
    slot.object = obj;
    slot.meshes = prep.meshes;
    slot.disposables = prep.disposables;
    slot.drawCalls = prep.drawCalls;
    slot.tris = prep.tris;
    slot.atlas = prep.atlas;
    for (const m of prep.meshes) {
      const tex = (m.material as THREE.MeshStandardMaterial).map;
      if (tex) renderer.initTexture(tex);
    }
    renderer
      .compileAsync(obj, camera, scene)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        root.add(obj);
        settle(slot, 'loaded');
        if (ctx.debug) {
          console.info(
            `[city-models] ${rec.id}: ${prep.drawCalls} draw call(s), ${prep.tris} tris` +
              (prep.atlas ? `, atlas ${prep.atlas.join('x')}` : '') +
              `, ${rec.photoTextured ? 'photo' : 'clean'}`,
          );
        }
      });
  };

  pump();
  let lastNight = -1;

  return {
    update(frame: FrameInfo) {
      focusS = frame.s;
      // At most one model per frame is merged / atlased, to keep frame times flat while driving.
      const next = loaded.shift();
      if (next) {
        try {
          install(next.slot, next.gltf);
        } catch (e) {
          console.warn(`[city-models] ${next.slot.rec.file}: ${e instanceof Error ? e.message : String(e)}`);
          disposeGltf(next.gltf);
          settle(next.slot, 'failed');
        }
      }
      if (nightUniform.value !== lastNight) {
        lastNight = nightUniform.value;
        accents.setNight(lastNight);
      }

      const fx = frame.focus.x;
      const fz = frame.focus.z;
      const drawDist = C.buildingDrawDistance;
      const shadowDist = C.buildingShadowDistance;
      for (const s of slots) {
        const obj = s.object;
        if (!obj) continue;
        const dx = s.cx - fx;
        const dz = s.cz - fz;
        const dist = Math.sqrt(dx * dx + dz * dz) - s.r;
        obj.visible = s.skyline || dist < drawDist;
        const cast = dist < shadowDist;
        if (cast !== s.cast) {
          s.cast = cast;
          for (const m of s.meshes) m.castShadow = cast;
        }
      }
    },
    dispose() {
      disposed = true;
      scene.remove(root);
      for (const s of slots) for (const d of s.disposables) d.dispose();
      for (const l of loaded) disposeGltf(l.gltf);
      loaded.length = 0;
      accents.dispose();
      facadeNear?.dispose();
      facadeFar?.dispose();
    },
  };
}

function disposeGltf(gltf: GLTF): void {
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}
