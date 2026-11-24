import * as THREE from 'three';
import { AudioEngine } from './audio/AudioEngine';
import { createCity } from './city';
import { CONFIG } from './config';
import type { WorldContext } from './game/contracts';
import { Game, type GameState } from './game/Game';
import { loadWorldData } from './game/loadWorld';
import { Hud } from './hud/Hud';
import { Input } from './input/Input';
import { createEnvironment } from './render/environment';
import { createRenderPipeline } from './render/pipeline';
import { createRenderer } from './render/renderer';
import { CarVisual } from './vehicle/CarVisual';

interface TestHooks {
  ready: boolean;
  getState(): GameState | { phase: 'loading' };
  teleport(s: number): void;
}

declare global {
  interface Window {
    __SZD__: TestHooks;
  }
}

async function boot() {
  const ui = document.getElementById('ui')!;
  const debug = new URLSearchParams(location.search).has('debug');
  const hooks: TestHooks = { ready: false, getState: () => ({ phase: 'loading' }), teleport: () => {} };
  window.__SZD__ = hooks;

  const world = await loadWorldData();
  const route = world.route;
  const data = route.data;
  let game: Game | null = null;
  const hud = new Hud(ui, {
    startName: '南山科技园',
    finishName: data.finish.name,
    checkpointFractions: data.checkpoints.map((c) => c.s / data.finish.s),
    onStart: () => game?.startRace(),
    onRetry: () => game?.startRace(),
  });

  try {
    const container = document.getElementById('app')!;
    const renderer = createRenderer(container);
    renderer.info.autoReset = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fovBase,
      window.innerWidth / window.innerHeight,
      CONFIG.camera.near,
      CONFIG.camera.far,
    );
    const ctx: WorldContext = { renderer, scene, camera, route, buildings: world.buildings, debug };
    const env = createEnvironment(ctx);
    const [city, car] = await Promise.all([createCity(ctx), CarVisual.load()]);
    scene.add(car.root);
    const pipeline = createRenderPipeline(ctx);
    if (debug) {
      const size = car.size();
      console.info(
        `[car] model ${car.loadedModel ? 'loaded' : 'FALLBACK'}, size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m;`,
        `route ${route.length.toFixed(0)} m${world.synthetic ? ' (synthetic)' : ''}, buildings ${world.buildings?.buildings.length ?? 0}`,
      );
    }

    const g = new Game({
      renderer,
      camera,
      route,
      env,
      city,
      pipeline,
      audio: new AudioEngine(),
      car,
      hud,
      input: new Input(),
      debugRoot: debug ? ui : null,
    });
    game = g;
    hooks.getState = () => g.getState();
    hooks.teleport = (s) => g.teleport(s);
    hud.setLoading(false);
    g.start(() => {
      hooks.ready = true;
    });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      pipeline.setSize(window.innerWidth, window.innerHeight);
    });
  } catch (e) {
    console.error('[boot] failed:', e);
    hud.setLoading(false, e instanceof Error ? e.message : String(e));
  }
}

boot();
