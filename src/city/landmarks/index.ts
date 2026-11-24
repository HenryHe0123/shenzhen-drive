import * as THREE from 'three';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import type { Route } from '../../route/Route';
import { nightLevel, onTimeOfDayChange } from '../../render/timeOfDay';
import { buildCivicCenter, civicOutline } from './civic';
import { buildEiffel } from './eiffel';
import { createLandmarkMaterials } from './materials';
import { buildPingAn } from './pingan';
import { resolveLandmarkSites, type LandmarkSite } from './placement';
import { buildHill, buildKK100, buildTencent } from './towers';

/** Nothing of the Civic Center may come closer than this to the centerline of the final leg (m). */
const CIVIC_CLEARANCE = 14;

/**
 * Smallest signed offset d (right of the route) of the Civic Center outline on
 * the leg after the last turn, for a site moved `back` meters along local -z.
 */
function civicMinD(route: Route, site: LandmarkSite, back: number): number {
  const legS0 = route.turns.length ? route.turns[route.turns.length - 1].s1 : 0;
  const hint = route.data.finish?.s ?? route.length;
  const c = Math.cos(site.yaw);
  const s = Math.sin(site.yaw);
  let min = Infinity;
  for (const [lx, lz0] of civicOutline()) {
    const lz = lz0 - back;
    const x = site.x + lx * c + lz * s;
    const z = site.z - lx * s + lz * c;
    const pr = route.project(x, z, hint, Math.max(400, hint - legS0 + 200));
    if (pr.s < legS0 - 20 || Math.abs(pr.d) > 400) continue;
    min = Math.min(min, pr.d);
  }
  return min;
}

/**
 * Hand-built landmarks: Civic Center (finish), Ping An Finance Center (skyline
 * guide), Tencent Building, Window of the World Eiffel replica, Lianhuashan,
 * KK100 when listed in route.json. Lighting follows the time-of-day preset.
 */
export async function createLandmarks(ctx: WorldContext): Promise<SceneryModule> {
  const { scene, route } = ctx;
  const sites = resolveLandmarkSites(route);
  // Landmarks replaced by real-building models (src/city/models) are not built here.
  const replaced = new Set<string>();
  for (const m of ctx.cityModels?.models ?? []) {
    if (m.replacesLandmark) replaced.add(m.replacesLandmark === 'kingkey100' ? 'kk100' : m.replacesLandmark);
  }
  const keep = (id: string) => !replaced.has(id);
  const mats = createLandmarkMaterials();
  const root = new THREE.Group();
  root.name = 'landmarks';
  const disposables: { dispose(): void }[] = [];

  const place = (obj: THREE.Object3D, id: string) => {
    const site = sites.get(id);
    if (!site) return null;
    obj.position.set(site.x, 0, site.z);
    obj.rotation.y = site.yaw;
    root.add(obj);
    return site;
  };

  const pa = sites.get('pingan');
  if (pa && keep('pingan')) {
    const scale = pa.height > 400 && pa.height < 700 ? pa.height / 599 : 1;
    place(buildPingAn(mats, scale), 'pingan');
  }

  const cc = keep('civic_center') ? buildCivicCenter(mats) : null;
  if (cc) disposables.push(...cc.disposables);
  const ccSite = cc ? place(cc.object, 'civic_center') : null;
  if (cc && ccSite) {
    // The final leg runs along the south facade: keep the canopy edge back from the curb.
    const d0 = civicMinD(route, ccSite, 0);
    let back = 0;
    if (d0 < CIVIC_CLEARANCE) {
      back = CIVIC_CLEARANCE - d0 + 1;
      cc.object.position.x -= Math.sin(ccSite.yaw) * back;
      cc.object.position.z -= Math.cos(ccSite.yaw) * back;
    }
    if (ctx.debug) {
      const d1 = civicMinD(route, ccSite, back);
      console.info(`[landmarks] civic center: closest point d=${d0.toFixed(1)} m, moved back ${back.toFixed(1)} m → d=${d1.toFixed(1)} m`);
    }
  }

  const tc = sites.get('tencent');
  if (tc && keep('tencent')) place(buildTencent(mats, tc.height > 120 && tc.height < 260 ? tc.height : 193), 'tencent');

  if (keep('eiffel')) place(buildEiffel(mats), 'eiffel');

  const hill = sites.get('lianhuashan');
  if (hill) {
    const h = hill.height > 40 && hill.height < 200 ? hill.height : 106;
    place(buildHill(mats, Math.min(520, Math.max(260, hill.hx)), h), 'lianhuashan');
  }

  const kk = sites.get('kk100');
  if (kk && keep('kk100')) place(buildKK100(mats, kk.height > 300 && kk.height < 500 ? kk.height : 442), 'kk100');

  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.receiveShadow = true;
      if (o.material === mats.gold || o.material === mats.glassNear) o.castShadow = true;
    }
  });
  scene.add(root);
  if (ctx.debug) (window as unknown as { __LANDMARKS__?: THREE.Group }).__LANDMARKS__ = root;

  const applyNight = (night: number) => {
    mats.setNight(night);
    cc?.setNight(night);
  };
  applyNight(nightLevel());
  const unsubscribe = onTimeOfDayChange((t) => applyNight(nightLevel(t)));

  return {
    update(_frame: FrameInfo) {},
    dispose() {
      unsubscribe();
      scene.remove(root);
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const m of mats.all) m.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
