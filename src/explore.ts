import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { createCity } from './city';
import type { MetroDebug } from './city/metro';
import { loadMetro, type MetroData } from './city/metro/load';
import { CONFIG } from './config';
import type { FrameInfo, WorldContext } from './game/contracts';
import { loadWorldData } from './game/loadWorld';
import { BUILD } from './hud/version';
import { createEnvironment } from './render/environment';
import { createRenderPipeline } from './render/pipeline';
import { LIGHTING } from './render/presets';
import { onQualityChange, qualitySettings } from './render/quality';
import { createRenderer } from './render/renderer';
import { setAerialHaze } from './render/sky';
import { getTimeOfDay, setTimeOfDay, TIME_LABELS, TIME_PRESETS } from './render/timeOfDay';

/** A named camera: target on the ground (WGS-84), distance from it, compass heading the camera looks along, pitch below horizontal. */
interface Viewpoint {
  id: string;
  name: string;
  lon: number;
  lat: number;
  dist: number;
  heading: number;
  pitch: number;
}

const VIEWS: Viewpoint[] = [
  { id: 'city', name: '全市俯瞰', lon: 114.12, lat: 22.62, dist: 30000, heading: 0, pitch: 68 },
  { id: 'futian', name: '福田 CBD', lon: 114.055, lat: 22.538, dist: 3200, heading: 10, pitch: 28 },
  { id: 'futian-n', name: '莲花山望 CBD', lon: 114.054, lat: 22.545, dist: 1800, heading: 180, pitch: 14 },
  { id: 'luohu', name: '罗湖 · 京基100', lon: 114.106, lat: 22.544, dist: 2600, heading: 20, pitch: 26 },
  { id: 'houhai', name: '后海 · 深圳湾', lon: 113.947, lat: 22.516, dist: 3400, heading: 330, pitch: 26 },
  { id: 'qianhai', name: '前海', lon: 113.898, lat: 22.53, dist: 3200, heading: 60, pitch: 28 },
  { id: 'keji', name: '南山科技园', lon: 113.947, lat: 22.545, dist: 2600, heading: 90, pitch: 26 },
  { id: 'bay', name: '深圳湾大桥', lon: 113.97, lat: 22.49, dist: 4200, heading: 330, pitch: 20 },
  { id: 'baoan', name: '宝安中心 · 机场', lon: 113.84, lat: 22.6, dist: 7000, heading: 340, pitch: 30 },
  { id: 'longhua', name: '龙华 · 深圳北站', lon: 114.03, lat: 22.61, dist: 4200, heading: 0, pitch: 28 },
  { id: 'longgang', name: '龙岗中心城', lon: 114.25, lat: 22.72, dist: 4500, heading: 20, pitch: 28 },
  { id: 'pingshan', name: '坪山', lon: 114.35, lat: 22.7, dist: 5000, heading: 0, pitch: 30 },
  { id: 'guangming', name: '光明', lon: 113.93, lat: 22.77, dist: 5000, heading: 0, pitch: 30 },
  { id: 'yantian', name: '盐田港 · 大梅沙', lon: 114.28, lat: 22.585, dist: 6000, heading: 20, pitch: 22 },
  { id: 'wutong', name: '梧桐山', lon: 114.205, lat: 22.58, dist: 7500, heading: 60, pitch: 16 },
  { id: 'dapeng', name: '大鹏半岛', lon: 114.52, lat: 22.55, dist: 14000, heading: 110, pitch: 24 },
  { id: 'street', name: '深南东路（地面）', lon: 114.1, lat: 22.5432, dist: 70, heading: 95, pitch: 3 },
  { id: 'huaqiang', name: '华强北（地面）', lon: 114.0855, lat: 22.5445, dist: 60, heading: 0, pitch: 4 },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

/**
 * explore.html — free flight over the whole city (no race): map controls (left drag pan, right drag rotate,
 * wheel zoom; WASD / arrows pan, Q / E rotate, R / F zoom), viewpoint presets, time of day.
 * ?view=<id> or ?lon=&lat=&dist=&heading=&pitch= set the start; ?time=day|golden.
 * window.__EXPLORE__ = { ready, drawCalls, triangles, setView(id | params) } for screenshots.
 */
async function boot() {
  const params = new URLSearchParams(location.search);
  const container = document.getElementById('app')!;
  const ui = document.getElementById('ui')!;
  const world = await loadWorldData();
  const renderer = createRenderer(container);
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 160000);
  const metro: MetroData | null = await loadMetro().catch(() => null);
  const ctx: WorldContext = { renderer, scene, camera, route: world.route, buildings: world.buildings, metro, debug: true };
  const env = createEnvironment(ctx);
  const city = await createCity(ctx);
  const pipeline = createRenderPipeline(ctx);
  const route = world.route;
  // Same local equirectangular frame as the pipeline (scripts/build_city_data.py Proj).
  const origin = route.data.meta.origin;
  const phi = (origin.lat * Math.PI) / 180;
  const e2 = 6.69437999014e-3;
  const w = Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const kx = (((Math.PI / 180) * 6378137) / w) * Math.cos(phi);
  const ky = ((Math.PI / 180) * 6378137 * (1 - e2)) / w ** 3;
  const toXZ = (lon: number, lat: number) => ({ x: (lon - origin.lon) * kx, z: -(lat - origin.lat) * ky });
  const toLL = (x: number, z: number) => ({ lon: origin.lon + x / kx, lat: origin.lat - z / ky });
  const groundAt = (x: number, z: number) => metro?.terrain.heightAt(x, z) ?? 0;

  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 20;
  controls.maxDistance = 90000;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.zoomSpeed = 1.2;
  controls.screenSpacePanning = false;

  function setView(v: Viewpoint | Partial<Viewpoint> | string) {
    const vp = typeof v === 'string' ? VIEWS.find((x) => x.id === v) : v;
    if (!vp) return false;
    const base = { ...VIEWS[1], ...vp } as Viewpoint;
    const t = toXZ(base.lon, base.lat);
    const ty = groundAt(t.x, t.z);
    const hd = THREE.MathUtils.degToRad(base.heading);
    const pt = THREE.MathUtils.degToRad(base.pitch);
    const fx = Math.sin(hd);
    const fz = -Math.cos(hd);
    controls.target.set(t.x, ty, t.z);
    camera.position.set(t.x - fx * Math.cos(pt) * base.dist, ty + Math.sin(pt) * base.dist + 1.6, t.z - fz * Math.cos(pt) * base.dist);
    controls.update();
    return true;
  }

  const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
  const start = params.get('view');
  if (!(start && setView(start))) {
    const custom: Partial<Viewpoint> = {};
    for (const k of ['lon', 'lat', 'dist', 'heading', 'pitch'] as const) if (num(k) !== undefined) custom[k] = num(k);
    setView(Object.keys(custom).length ? custom : 'futian');
  }

  // Double-click: what is under the cursor (for feedback: coordinates, ground elevation, building height).
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let picked = '';
  const pickables = () => {
    const out: THREE.Object3D[] = [];
    for (const name of ['metro-buildings', 'buildings', 'city-models']) {
      const g = scene.getObjectByName(name);
      if (g) out.push(...g.children.filter((c) => !c.name.startsWith('metro-mass') && !c.name.startsWith('metro-road')));
    }
    return out;
  };
  renderer.domElement.addEventListener('dblclick', (e) => {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables(), true)[0];
    // Terrain: march along the ray until it goes below the ground.
    let tHit = Infinity;
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    for (let t = 1, step = 2; t < 60000; t += step, step = Math.min(step * 1.02, 40)) {
      if (o.y + d.y * t < groundAt(o.x + d.x * t, o.z + d.z * t)) {
        tHit = t;
        break;
      }
    }
    const t = hit && hit.distance < tHit ? hit.distance : tHit;
    if (!Number.isFinite(t)) return;
    const p = ray.ray.at(t, new THREE.Vector3());
    const ll = toLL(p.x, p.z);
    const asl = groundAt(p.x, p.z) - (metro?.meta.terrain.seaLevel ?? 0);
    let what = `地面海拔 ${asl.toFixed(0)} m`;
    if (hit && hit.distance < tHit && hit.face && hit.object instanceof THREE.Mesh) {
      const fac = hit.object.geometry.getAttribute('aFac');
      const h = fac ? fac.getW(hit.face.a) : NaN;
      if (Number.isFinite(h) && h > 0) what += ` · 建筑高约 ${h.toFixed(0)} m（${hit.object.name.startsWith('metro') ? '全城' : '沿线'}）`;
      else what += ` · ${hit.object.name || '模型'}`;
    }
    picked = `拾取 ${ll.lon.toFixed(5)}°E ${ll.lat.toFixed(5)}°N\n${what}`;
    console.info(`[pick] ${JSON.stringify({ lon: +ll.lon.toFixed(6), lat: +ll.lat.toFixed(6), height: 0, note: what })}`);
  });

  // Keyboard flight: pan along the ground, rotate around the target, zoom.
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    keys.add(e.code);
    const n = Number(e.key);
    if (!e.metaKey && !e.ctrlKey && n >= 1 && n <= 9 && VIEWS[n - 1]) setView(VIEWS[n - 1]);
    if (e.code === 'KeyT') setTimeOfDay(TIME_PRESETS[(TIME_PRESETS.indexOf(getTimeOfDay()) + 1) % TIME_PRESETS.length]);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const off = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  function keyFlight(dt: number) {
    const dist = camera.position.distanceTo(controls.target);
    const sp = dist * 0.9 * dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1);
    camera.getWorldDirection(fwd).setY(0).normalize();
    right.crossVectors(fwd, camera.up).normalize();
    off.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) off.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) off.sub(fwd);
    if (keys.has('KeyD') || keys.has('ArrowRight')) off.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) off.sub(right);
    if (off.lengthSq() > 0) {
      off.normalize().multiplyScalar(sp);
      camera.position.add(off);
      controls.target.add(off);
    }
    const rot = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    if (rot) {
      const a = rot * dt * 0.9;
      const v = camera.position.clone().sub(controls.target).applyAxisAngle(camera.up, a);
      camera.position.copy(controls.target).add(v);
    }
    const zoom = (keys.has('KeyF') ? 1 : 0) - (keys.has('KeyR') ? 1 : 0);
    if (zoom) {
      const v = camera.position.clone().sub(controls.target).multiplyScalar(Math.exp(zoom * dt * 1.2));
      if (v.length() > controls.minDistance && v.length() < controls.maxDistance) camera.position.copy(controls.target).add(v);
    }
    // Keep the target on the ground and the camera above it.
    const gy = groundAt(controls.target.x, controls.target.z);
    camera.position.y += gy - controls.target.y;
    controls.target.y = gy;
    const cy = groundAt(camera.position.x, camera.position.z) + 1.6;
    if (camera.position.y < cy) camera.position.y = cy;
  }

  // Panel: presets, time of day, readout.
  const panel = el(
    'div',
    'position:fixed;left:12px;top:12px;width:236px;padding:12px 12px 10px;background:rgba(10,14,22,.78);color:#e8edf5;' +
      'border-radius:10px;font-size:12px;line-height:1.5;backdrop-filter:blur(6px);user-select:none;z-index:5',
  );
  panel.append(el('div', 'font-size:15px;font-weight:600;letter-spacing:.5px', '深圳全城巡览'));
  panel.append(el('div', 'opacity:.6;margin-bottom:8px', `v${BUILD.version} · ${BUILD.commit} · 无比赛，自由飞行`));
  const grid = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px');
  VIEWS.forEach((v, i) => {
    const b = el(
      'button',
      'font:inherit;font-size:11.5px;padding:4px 5px;border:0;border-radius:5px;background:#26324a;color:#e8edf5;cursor:pointer;text-align:left',
      (i < 9 ? `${i + 1} ` : '') + v.name,
    );
    b.onclick = () => setView(v);
    grid.append(b);
  });
  panel.append(grid);
  const timeRow = el('div', 'display:flex;gap:4px;margin-bottom:8px');
  for (const t of TIME_PRESETS) {
    const b = el('button', 'flex:1;font:inherit;padding:3px;border:0;border-radius:5px;background:#26324a;color:#e8edf5;cursor:pointer', TIME_LABELS[t]);
    b.onclick = () => setTimeOfDay(t);
    timeRow.append(b);
  }
  panel.append(timeRow);
  const readout = el('div', 'font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:pre;opacity:.9');
  panel.append(readout);
  panel.append(
    el(
      'div',
      'opacity:.55;margin-top:6px;font-size:11px',
      '左键拖动平移 · 右键拖动旋转 · 滚轮缩放\nWASD 平移 · Q/E 旋转 · R/F 拉近/拉远 · Shift 加速 · T 时段 · 1-9 视点\n双击：显示该处经纬度、海拔和楼高（反馈时用）',
    ),
  );
  ui.append(panel);
  // ?hud=0 hides the panel (clean screenshots).
  if (params.get('hud') === '0') panel.style.display = 'none';
  if (!metro) panel.append(el('div', 'color:#ffb469;margin-top:6px', '未找到 public/data/metro：先运行 scripts/build_metro_data.py'));

  const metroDbg = (window as unknown as { __METRO__?: MetroDebug }).__METRO__;
  metroDbg?.buildings.setRadii(CONFIG.metro.exploreDetailRadius, CONFIG.metro.exploreMassRadius, CONFIG.metro.exploreRoadScale);
  const state = {
    ready: false,
    drawCalls: 0,
    triangles: 0,
    metro: !!metro,
    setView: (v: Viewpoint | Partial<Viewpoint> | string) => setView(v),
    views: VIEWS.map((v) => v.id),
    /** True once the building tiles around the camera have loaded. */
    settled: () => metroDbg?.buildings.settled() ?? true,
  };
  (window as unknown as { __EXPLORE__: typeof state; __SCENE__: THREE.Scene }).__EXPLORE__ = state;
  (window as unknown as { __SCENE__: THREE.Scene }).__SCENE__ = scene;

  const focus = new THREE.Vector3();
  const frame: FrameInfo = { dt: 0, time: 0, focus, s: 0, speed: 0 };
  const clock = new THREE.Clock();
  let frames = 0;
  let fpsT = 0;
  let fpsN = 0;
  let fps = 0;
  let readT = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    keyFlight(dt);
    controls.update();
    const alt = camera.position.y - groundAt(camera.position.x, camera.position.z);
    // Distance haze only when high above the city, so the far edges of the data fade out.
    setAerialHaze(THREE.MathUtils.smoothstep(alt, 300, 4000) * CONFIG.metro.exploreAerialHaze);
    focus.set(controls.target.x, 0, controls.target.z);
    frame.dt = dt;
    frame.time = clock.elapsedTime;
    frame.s = route.clampS(route.project(focus.x, focus.z).s);
    renderer.info.reset();
    env.update(frame);
    if (scene.fog instanceof THREE.FogExp2) scene.fog.density = LIGHTING[getTimeOfDay()].fogDensity * CONFIG.metro.exploreFog;
    city.update(frame);
    pipeline.render(dt);
    state.drawCalls = renderer.info.render.calls;
    state.triangles = renderer.info.render.triangles;
    fpsT += dt;
    fpsN++;
    if (fpsT > 0.5) {
      fps = fpsN / fpsT;
      fpsT = 0;
      fpsN = 0;
    }
    readT += dt;
    if (readT > 0.25) {
      readT = 0;
      const ll = toLL(controls.target.x, controls.target.z);
      const bs = metroDbg?.buildings.stats();
      readout.textContent =
        `${ll.lon.toFixed(4)}°E ${ll.lat.toFixed(4)}°N\n` +
        `高度 ${alt.toFixed(0)} m · 距目标 ${camera.position.distanceTo(controls.target).toFixed(0)} m\n` +
        `FPS ${fps.toFixed(0)} · draw ${state.drawCalls} · tris ${(state.triangles / 1e6).toFixed(2)} M` +
        (bs ? `\n建筑块 ${bs.detailLoaded}${bs.detailLoading ? `+${bs.detailLoading}` : ''} · 远景 ${bs.massLoaded} 块 ${(bs.instances / 1000).toFixed(0)}k 栋` : '') +
        (picked ? `\n${picked}` : '');
    }
    if (++frames > 8) state.ready = true;
  });
  const applySize = () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, qualitySettings().maxPixelRatio));
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    pipeline.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', applySize);
  onQualityChange(applySize);
}

boot();
