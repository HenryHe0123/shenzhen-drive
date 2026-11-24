import * as THREE from 'three';
import { CONFIG } from './config';
import { createCity } from './city';
import type { WorldContext } from './game/contracts';
import { loadWorldData } from './game/loadWorld';
import { createEnvironment } from './render/environment';
import { createRenderPipeline } from './render/pipeline';
import { createRenderer } from './render/renderer';

/**
 * Scenery preview without gameplay: preview.html?s=1200&d=2&h=2.4&look=40&yaw=0
 * s/d place the camera in route coordinates, h is camera height, look is how far
 * ahead along the route it looks, yaw rotates the view (degrees). Without s the
 * camera flies along the route; speed=<m/s> controls the flight.
 * window.__PREVIEW__ = { ready, drawCalls, triangles, setView(s, d, h, look) }.
 */
async function boot() {
  const params = new URLSearchParams(location.search);
  const num = (k: string, def: number) => (params.has(k) ? Number(params.get(k)) : def);
  const container = document.getElementById('app')!;
  const world = await loadWorldData();
  const renderer = createRenderer(container);
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    num('fov', CONFIG.camera.fovBase),
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
    debug: true,
  };
  const env = createEnvironment(ctx);
  const city = await createCity(ctx);
  const pipeline = createRenderPipeline(ctx);

  const route = world.route;
  const view = { s: num('s', 0), d: num('d', 1.75), h: num('h', 2.4), look: num('look', 40), yaw: num('yaw', 0) };
  const fly = !params.has('s');
  const speed = num('speed', 30);
  const focus = new THREE.Vector3();
  const state = { ready: false, drawCalls: 0, triangles: 0, synthetic: world.synthetic, length: route.length, setView };
  (window as unknown as { __PREVIEW__: typeof state }).__PREVIEW__ = state;

  function setView(s: number, d = view.d, h = view.h, look = view.look) {
    Object.assign(view, { s, d, h, look });
  }

  const clock = new THREE.Clock();
  let frames = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (fly) view.s = (view.s + dt * speed) % route.length;
    const p = route.pointAt(view.s, view.d);
    const ahead = route.pointAt(view.s + view.look, view.d);
    const yaw = THREE.MathUtils.degToRad(view.yaw);
    const dx = ahead.x - p.x;
    const dz = ahead.z - p.z;
    camera.position.set(p.x, view.h, p.z);
    camera.lookAt(
      p.x + dx * Math.cos(yaw) + dz * Math.sin(yaw),
      view.h * 0.6,
      p.z - dx * Math.sin(yaw) + dz * Math.cos(yaw),
    );
    focus.set(p.x, 0, p.z);
    const frame = { dt, time: clock.elapsedTime, focus, s: view.s, speed: fly ? speed : 0 };
    renderer.info.reset();
    env.update(frame);
    city.update(frame);
    pipeline.render(dt);
    state.drawCalls = renderer.info.render.calls;
    state.triangles = renderer.info.render.triangles;
    if (++frames > 5) state.ready = true;
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    pipeline.setSize(window.innerWidth, window.innerHeight);
  });
}

boot();
