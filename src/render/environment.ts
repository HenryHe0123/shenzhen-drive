import * as THREE from 'three';
import { CONFIG } from '../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../game/contracts';
import { LIGHTING, type LightingPreset } from './presets';
import { bearingDir, createSkyMaterial, installSkyFog, setSkyParams } from './sky';
import { getTimeOfDay, onTimeOfDayChange, type TimeOfDay } from './timeOfDay';

const R = CONFIG.render;

/**
 * Ring of box silhouettes around the horizon of the environment scene, so
 * glass and car paint reflect a skyline instead of bare horizon haze.
 * Vertex colors hold per-box brightness; material.color sets the preset tone.
 */
function createEnvSkyline(): THREE.Mesh {
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return seed / 4294967296;
  };
  const geos: THREE.BufferGeometry[] = [];
  const pos: number[] = [];
  const col: number[] = [];
  for (const [radius, count, elevMin, elevMax, tone] of [
    [34, 70, 0.04, 0.2, 0.75],
    [24, 46, 0.08, 0.42, 1.0],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const a = ((i + rnd() * 0.6) / count) * Math.PI * 2;
      const w = radius * (0.06 + rnd() * 0.07);
      const h = radius * Math.tan(elevMin + (elevMax - elevMin) * Math.pow(rnd(), 1.5));
      const box = new THREE.BoxGeometry(w, h + 3, w * 0.8).toNonIndexed();
      box.translate(0, (h + 3) / 2 - 3, 0);
      box.rotateY(-a + Math.PI / 2);
      box.translate(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      const v = tone * (0.45 + 0.75 * rnd());
      const p = box.getAttribute('position');
      const n = box.getAttribute('normal');
      for (let k = 0; k < p.count; k++) {
        pos.push(p.getX(k), p.getY(k), p.getZ(k));
        // Faces toward the sun side read lighter; tops lighter still.
        const lit = 0.75 + 0.25 * n.getY(k) + 0.2 * Math.max(0, -n.getX(k) * 0.6 + n.getZ(k) * 0.8);
        col.push(v * lit, v * lit, v * lit);
      }
      geos.push(box);
    }
  }
  for (const g of geos) g.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'env-skyline';
  return mesh;
}

/**
 * Time-of-day environment: analytic sky dome, PMREM environment map from the
 * same sky (plus a skyline ring), sun key light with a texel-snapped shadow box
 * following the car, hemisphere fill and sky-colored height fog. Presets come
 * from src/render/presets.ts and switch live through onTimeOfDayChange.
 */
export function createEnvironment(ctx: WorldContext): SceneryModule {
  const { scene, renderer, camera } = ctx;
  installSkyFog();

  const skyMat = createSkyMaterial(1);
  const skyGeo = new THREE.SphereGeometry(1, 64, 32);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'sky';
  sky.scale.setScalar(Math.min(12000, camera.far * 0.85));
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.onBeforeRender = (_r, _s, cam) => {
    sky.position.copy(cam.position);
    sky.updateMatrixWorld();
  };
  scene.add(sky);

  const envSkyMat = createSkyMaterial(0.15);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeo, envSkyMat);
  envSky.scale.setScalar(50);
  const envCity = createEnvSkyline();
  envScene.add(envSky, envCity);
  const envCityMat = envCity.material as THREE.MeshBasicMaterial;
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;
  scene.background = null;

  const fog = new THREE.FogExp2(0xffffff, 0.0005);
  scene.fog = fog;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.4);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.name = 'sun';
  const range = R.shadowRange;
  const lightDist = 600;
  sun.castShadow = true;
  sun.shadow.mapSize.set(R.shadowMapSize, R.shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  const sc = sun.shadow.camera;
  sc.left = -range;
  sc.right = range;
  sc.top = range;
  sc.bottom = -range;
  sc.near = 1;
  sc.far = lightDist * 2;
  sc.updateProjectionMatrix();
  scene.add(sun, sun.target);

  // Light-space basis matching the shadow camera's lookAt (up = +y).
  const axisZ = new THREE.Vector3();
  const axisX = new THREE.Vector3();
  const axisY = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const texel = (2 * range) / R.shadowMapSize;
  const snapped = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const lastFocus = new THREE.Vector3();

  function follow(focus: THREE.Vector3) {
    lastFocus.copy(focus);
    const u = Math.round(focus.dot(axisX) / texel) * texel;
    const v = Math.round(focus.dot(axisY) / texel) * texel;
    const w = focus.dot(axisZ);
    snapped.copy(axisX).multiplyScalar(u);
    snapped.addScaledVector(axisY, v).addScaledVector(axisZ, w);
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).add(tmp.copy(axisZ).multiplyScalar(lightDist));
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  function apply(time: TimeOfDay) {
    const p: LightingPreset = LIGHTING[time];
    setSkyParams(p);
    fog.density = p.fogDensity;
    fog.color.set(p.sky.horizon[0]);
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiIntensity;
    sun.color.set(p.sunColor);
    sun.intensity = p.sunIntensity;
    sun.shadow.radius = p.shadowRadius;
    bearingDir(p.sunAzimuthDeg, p.lightElevationDeg, axisZ);
    axisX.crossVectors(up, axisZ).normalize();
    axisY.crossVectors(axisZ, axisX).normalize();
    follow(lastFocus);
    renderer.toneMappingExposure = p.exposure;
    scene.environmentIntensity = p.envIntensity;

    envCity.visible = p.envCity[1] > 0;
    envCityMat.color.set(p.envCity[0]).multiplyScalar(p.envCity[1]);
    const rt = pmrem.fromScene(envScene, 0, 0.1, 100);
    envRT?.dispose();
    envRT = rt;
    scene.environment = rt.texture;
  }

  apply(getTimeOfDay());
  const unsubscribe = onTimeOfDayChange(apply);

  return {
    update(frame: FrameInfo) {
      follow(frame.focus);
    },
    dispose() {
      unsubscribe();
      scene.remove(sky, hemi, sun, sun.target);
      skyGeo.dispose();
      skyMat.dispose();
      envSkyMat.dispose();
      envCity.geometry.dispose();
      envCityMat.dispose();
      envRT?.dispose();
      pmrem.dispose();
    },
  };
}
