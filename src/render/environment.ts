import * as THREE from 'three';
import { CONFIG } from '../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../game/contracts';
import { bearingDir, createSkyMaterial, installSkyFog } from './sky';

const R = CONFIG.render;

/**
 * Blue-hour sky dome, PMREM environment map from the same sky, low warm key
 * light from the west with a texel-snapped shadow box following the car,
 * hemisphere fill and sky-colored height fog.
 */
export function createEnvironment(ctx: WorldContext): SceneryModule {
  const { scene, renderer, camera } = ctx;
  installSkyFog();

  const skyMat = createSkyMaterial();
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

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeo, skyMat);
  envSky.scale.setScalar(50);
  envScene.add(envSky);
  const envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = R.envIntensity;
  scene.background = null;

  scene.fog = new THREE.FogExp2(R.fogColor, R.fogDensity);

  const hemi = new THREE.HemisphereLight(R.hemiSkyColor, R.hemiGroundColor, R.hemiIntensity);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(R.sunColor, R.sunIntensity);
  sun.name = 'sun';
  const toSun = bearingDir(R.sunAzimuthDeg, R.sunLightElevationDeg);
  const range = R.shadowRange;
  const lightDist = 600;
  sun.castShadow = true;
  sun.shadow.mapSize.set(R.shadowMapSize, R.shadowMapSize);
  sun.shadow.radius = R.shadowRadius;
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
  const axisZ = toSun.clone();
  const axisX = new THREE.Vector3(0, 1, 0).cross(axisZ).normalize();
  const axisY = axisZ.clone().cross(axisX).normalize();
  const texel = (2 * range) / R.shadowMapSize;
  const snapped = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function follow(focus: THREE.Vector3) {
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
  follow(new THREE.Vector3());

  return {
    update(frame: FrameInfo) {
      follow(frame.focus);
    },
    dispose() {
      scene.remove(sky, hemi, sun, sun.target);
      skyGeo.dispose();
      skyMat.dispose();
      envRT.dispose();
    },
  };
}
