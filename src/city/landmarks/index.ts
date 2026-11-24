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

function glowTexture(): THREE.CanvasTexture {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

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

  const glow = glowTexture();
  disposables.push(glow);
  const beaconMat = new THREE.SpriteMaterial({
    map: glow,
    color: new THREE.Color(6, 0.35, 0.25),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    fog: false,
    sizeAttenuation: false,
  });
  disposables.push(beaconMat);
  const beacons: THREE.Sprite[] = [];

  const pa = sites.get('pingan');
  if (pa && keep('pingan')) {
    const scale = pa.height > 400 && pa.height < 700 ? pa.height / 599 : 1;
    const { object, beacon } = buildPingAn(mats, scale);
    place(object, 'pingan');
    const sp = new THREE.Sprite(beaconMat);
    sp.position.copy(beacon);
    sp.scale.setScalar(0.012);
    object.add(sp);
    beacons.push(sp);
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
  if (kk && keep('kk100')) {
    const obj = buildKK100(mats, kk.height > 300 && kk.height < 500 ? kk.height : 442);
    place(obj, 'kk100');
    const sp = new THREE.Sprite(beaconMat);
    sp.position.set(0, (kk.height || 442) + 2, 0);
    sp.scale.setScalar(0.009);
    obj.add(sp);
    beacons.push(sp);
  }

  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.receiveShadow = true;
      if (o.material === mats.gold || o.material === mats.glassNear) o.castShadow = true;
    }
  });
  scene.add(root);
  if (ctx.debug) (window as unknown as { __LANDMARKS__?: THREE.Group }).__LANDMARKS__ = root;

  // Aviation beacons and floodlights are a night feature; daylight hides them.
  let beaconLevel = 0;
  const applyNight = (night: number) => {
    mats.setNight(night);
    cc?.setNight(night);
    beaconLevel = night;
    for (const b of beacons) b.visible = night > 0.05;
  };
  applyNight(nightLevel());
  const unsubscribe = onTimeOfDayChange((t) => applyNight(nightLevel(t)));

  return {
    update(frame: FrameInfo) {
      const on = frame.time % 1.6 < 0.55;
      beaconMat.opacity = (on ? 1 : 0.12) * beaconLevel;
    },
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
