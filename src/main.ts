import * as THREE from 'three';
import { CONFIG } from './config';
import { createCity } from './city';
import type { WorldContext } from './game/contracts';
import { loadWorldData } from './game/loadWorld';
import { createEnvironment } from './render/environment';
import { createRenderPipeline } from './render/pipeline';
import { createRenderer } from './render/renderer';

/** Scaffold boot: renders the scenery from a fixed chase-like viewpoint. Replaced by the game loop. */
async function boot() {
  const container = document.getElementById('app')!;
  const world = await loadWorldData();
  const renderer = createRenderer(container);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fovBase,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far,
  );
  const ctx: WorldContext = {
    renderer,
    scene,
    camera,
    route: world.route,
    buildings: world.buildings,
    debug: new URLSearchParams(location.search).has('debug'),
  };
  const env = createEnvironment(ctx);
  const city = await createCity(ctx);
  const pipeline = createRenderPipeline(ctx);

  const focus = new THREE.Vector3();
  let s = 0;
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    s = (s + dt * 30) % world.route.length;
    const p = world.route.pointAt(s);
    const back = world.route.pointAt(s - 8);
    focus.set(p.x, 0, p.z);
    camera.position.set(back.x, 2.4, back.z);
    camera.lookAt(p.x, 1.0, p.z);
    const frame = { dt, time: clock.elapsedTime, focus, s, speed: 30 };
    env.update(frame);
    city.update(frame);
    pipeline.render(dt);
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    pipeline.setSize(window.innerWidth, window.innerHeight);
  });
}

boot();
