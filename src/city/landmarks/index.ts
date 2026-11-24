import * as THREE from 'three';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { buildCivicCenter } from './civic';
import { buildEiffel } from './eiffel';
import { createLandmarkMaterials } from './materials';
import { buildPingAn } from './pingan';
import { resolveLandmarkSites } from './placement';
import { buildHill, buildKK100, buildTencent } from './towers';

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
 * Hand-built landmarks: Civic Center (finish), Ping An Finance Center (skyline
 * guide), Tencent Building, Window of the World Eiffel replica, Lianhuashan,
 * KK100 when listed in route.json.
 */
export async function createLandmarks(ctx: WorldContext): Promise<SceneryModule> {
  const { scene, route } = ctx;
  const sites = resolveLandmarkSites(route);
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
  if (pa) {
    const scale = pa.height > 400 && pa.height < 700 ? pa.height / 599 : 1;
    const { object, beacon } = buildPingAn(mats, scale);
    place(object, 'pingan');
    const sp = new THREE.Sprite(beaconMat);
    sp.position.copy(beacon);
    sp.scale.setScalar(0.012);
    object.add(sp);
    beacons.push(sp);
  }

  const cc = buildCivicCenter(mats);
  disposables.push(...cc.disposables);
  place(cc.object, 'civic_center');

  const tc = sites.get('tencent');
  if (tc) place(buildTencent(mats, tc.height > 120 && tc.height < 260 ? tc.height : 193), 'tencent');

  place(buildEiffel(mats), 'eiffel');

  const hill = sites.get('lianhuashan');
  if (hill) {
    const h = hill.height > 40 && hill.height < 200 ? hill.height : 106;
    place(buildHill(mats, Math.min(520, Math.max(260, hill.hx)), h), 'lianhuashan');
  }

  const kk = sites.get('kk100');
  if (kk) {
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

  return {
    update(frame: FrameInfo) {
      const on = frame.time % 1.6 < 0.55;
      beaconMat.opacity = on ? 1 : 0.12;
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const m of mats.all) m.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
