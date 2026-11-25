import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { SceneryModule, WorldContext } from '../../game/contracts';
import { getTimeOfDay, onTimeOfDayChange, type TimeOfDay } from '../../render/timeOfDay';
import { PropGeo, placeMatrix } from '../props/geo';
import type { RGB } from '../road/builder';
import { canvasTexture, makeCanvas } from '../road/textures';
import { drawApecFace } from './art';
import { placePylons, type PylonPlacement } from './pylons';

const S = CONFIG.screens;
const FACE_UV = [0, 0, 1, 1] as const;

/**
 * Faces (one unlit mesh) and their supports (one lit mesh): a dark cabinet a little larger than
 * the face, two columns behind it on concrete plinths with a cross beam and a back truss, a
 * service catwalk under the cabinet and a light top cap.
 */
function buildMeshes(list: PylonPlacement[]): { faces: THREE.BufferGeometry; frames: THREE.BufferGeometry } {
  const faces = new PropGeo();
  const frames = new PropGeo();
  const cabinet: RGB = [S.cabinetShade, S.cabinetShade, S.cabinetShade * 1.1];
  const steel: RGB = [S.columnShade, S.columnShade * 1.02, S.columnShade * 1.06];
  const concrete: RGB = [0.55, 0.54, 0.52];
  const m = new THREE.Matrix4();
  for (const p of list) {
    placeMatrix(p.x, 0, p.z, Math.atan2(p.nx, p.nz), 1, m);
    const w = p.width / 2;
    const y0 = p.bottom;
    const y1 = p.bottom + p.height;
    faces.quad(m, [-w, y0, 0.12], [w, y0, 0.12], [w, y1, 0.12], [-w, y1, 0.12], FACE_UV, [1, 1, 1]);
    frames.box(m, 0, (y0 + y1) / 2, -0.55, p.width + 0.9, p.height + 0.9, 1.1, cabinet);
    frames.box(m, 0, y1 + 0.55, -0.5, p.width + 1.3, 0.22, 1.5, steel);
    const cx = p.width * 0.27;
    for (const x of [-cx, cx]) {
      frames.cylinder(m, [x, 0, -2], [x, y0 + p.height * 0.8, -2], 0.85, 0.7, 14, steel);
      frames.box(m, x, 0.4, -2, 2.4, 0.8, 2.4, concrete);
    }
    frames.box(m, 0, y0 - 0.9, -1.9, 2 * cx + 1.6, 1.1, 1.1, steel);
    frames.box(m, 0, y0 + p.height * 0.55, -1.5, 2 * cx, 0.6, 0.6, steel);
    // Catwalk under the cabinet with rails, hung from brackets.
    const yc = y0 - 1.6;
    frames.box(m, 0, yc, 0.15, p.width + 0.9, 0.12, 1.2, steel);
    for (const y of [yc + 0.55, yc + 1.05]) frames.box(m, 0, y, 0.72, p.width + 0.9, 0.07, 0.07, steel);
    for (let k = 0; k <= 8; k++) {
      const x = -w - 0.45 + ((p.width + 0.9) * k) / 8;
      frames.box(m, x, yc + 0.55, 0.72, 0.07, 1.1, 0.07, steel);
      frames.box(m, x, (yc + y0 - 0.45) / 2, -0.3, 0.12, y0 - 0.45 - yc, 0.12, steel);
    }
  }
  return { faces: faces.geometry(), frames: frames.geometry() };
}

/** LED pixel grid up close: darkens the gaps between LEDs, faded out once a cell is under ~1.5 px. */
function addLedGrid(mat: THREE.MeshBasicMaterial, columns: number, rows: number) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLedCells = { value: new THREE.Vector2(columns, rows) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uLedCells;')
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
#ifdef USE_MAP
  {
    vec2 led = vMapUv * uLedCells;
    vec2 fw = fwidth(led);
    vec2 cell = abs(fract(led) - 0.5);
    float lit = 1.0 - smoothstep(0.28, 0.48, max(cell.x, cell.y));
    float near = 1.0 - clamp(max(fw.x, fw.y) * 1.5 - 0.5, 0.0, 1.0);
    diffuseColor.rgb *= 1.0 - ${S.ledGrid.toFixed(3)} * near * (1.0 - lit);
  }
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'apec-led-screen';
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * APEC China 2026 roadside LED screens: free-standing, yawed toward approaching traffic and raised
 * above the tree canopy, one per configured s-window (placement in pylons.ts). Two draw calls: the
 * unlit faces (brighter than the facades in every preset) and their lit steel supports.
 */
export async function createScreens(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene, renderer } = ctx;
  const { placed, skipped } = placePylons(route, ctx.buildings, ctx.cityModels ?? null, S.windows, S);
  if (ctx.debug) {
    for (const p of placed) {
      console.info(
        `[screens] ${p.window}: s ${p.s.toFixed(0)} d ${p.d.toFixed(1)} ${p.side}, ${p.width}×${p.height} m from ${p.bottom} m, ` +
          `yaw ${p.yawDeg}° toward traffic, seen from ${p.visible.join('/')} m`,
      );
    }
    for (const k of skipped) console.info(`[screens] ${k.window} skipped: ${k.reason}`);
  }
  if (!placed.length) return { update() {} };

  const img = await loadImage(import.meta.env.BASE_URL + S.textureUrl);
  if (!img && ctx.debug) console.info(`[screens] ${S.textureUrl} missing, gradient art panel`);
  const [canvas] = makeCanvas(2048, 1024);
  drawApecFace(canvas, img, img?.naturalWidth ?? 0, img?.naturalHeight ?? 0);
  const texture = canvasTexture(canvas, { repeat: false, aniso: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;

  const { faces, frames } = buildMeshes(placed);
  const faceMat = new THREE.MeshBasicMaterial({ map: texture });
  addLedGrid(faceMat, Math.round(S.width / S.ledPitch), Math.round(S.height / S.ledPitch));
  const frameMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.55 });
  const faceMesh = new THREE.Mesh(faces, faceMat);
  faceMesh.name = 'apec-screens';
  const frameMesh = new THREE.Mesh(frames, frameMat);
  frameMesh.name = 'apec-screen-frames';
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  const root = new THREE.Group();
  root.name = 'apec-screens';
  for (const m of [faceMesh, frameMesh]) {
    m.matrixAutoUpdate = false;
    root.add(m);
  }
  scene.add(root);
  if (ctx.debug) ((window as unknown as { __SCENERY__?: Record<string, THREE.Object3D> }).__SCENERY__ ??= {}).screens = root;

  const apply = (time: TimeOfDay) => faceMat.color.setScalar(S.brightness[time]);
  apply(getTimeOfDay());
  const unsubscribe = onTimeOfDayChange(apply);

  return {
    update() {},
    dispose() {
      unsubscribe();
      scene.remove(root);
      faces.dispose();
      frames.dispose();
      faceMat.dispose();
      frameMat.dispose();
      texture.dispose();
    },
  };
}
