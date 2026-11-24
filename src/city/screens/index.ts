import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { SceneryModule, WorldContext } from '../../game/contracts';
import { getTimeOfDay, onTimeOfDayChange, type TimeOfDay } from '../../render/timeOfDay';
import { placeScreens, type ScreenPlacement } from './placement';

const S = CONFIG.screens;
const FRAME_SHADE = 0.035;

/**
 * Screens (textured faces) and their dark frames in one world-space geometry; the frame samples
 * the texture too but its vertex color keeps it near black, so everything is one draw call.
 */
function screenGeometry(list: ScreenPlacement[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], uvs: number[], shade: number) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(...uvs);
    for (let k = 0; k < 4; k++) col.push(shade, shade, shade);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const FRAME_UV = [0.5, 0.98, 0.5, 0.98, 0.5, 0.98, 0.5, 0.98];
  for (const p of list) {
    // Viewer's right when looking at the wall.
    const rx = p.nz;
    const rz = -p.nx;
    const at = (u: number, y: number, out: number) => [p.x + rx * u + p.nx * out, y, p.z + rz * u + p.nz * out];
    const w = p.width / 2;
    const y0 = p.bottom;
    const y1 = p.bottom + p.height;
    quad(at(-w, y0, S.offset), at(w, y0, S.offset), at(w, y1, S.offset), at(-w, y1, S.offset), [0, 0, 1, 0, 1, 1, 0, 1], 1);
    // Frame box from the wall to just behind the face, `border` larger on every side.
    const fw = w + S.border;
    const f0 = y0 - S.border;
    const f1 = y1 + S.border;
    const back = 0.04;
    const front = S.frameFront;
    quad(at(-fw, f0, front), at(fw, f0, front), at(fw, f1, front), at(-fw, f1, front), FRAME_UV, FRAME_SHADE);
    quad(at(fw, f0, front), at(fw, f0, back), at(fw, f1, back), at(fw, f1, front), FRAME_UV, FRAME_SHADE);
    quad(at(-fw, f0, back), at(-fw, f0, front), at(-fw, f1, front), at(-fw, f1, back), FRAME_UV, FRAME_SHADE);
    quad(at(-fw, f1, front), at(fw, f1, front), at(fw, f1, back), at(-fw, f1, back), FRAME_UV, FRAME_SHADE);
    quad(at(-fw, f0, back), at(fw, f0, back), at(fw, f0, front), at(-fw, f0, front), FRAME_UV, FRAME_SHADE);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
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

/**
 * APEC CHINA 2026 portrait LED screens on real buildings along the route (one per configured
 * s-window, see placement.ts). Unlit and brighter than the facades in every preset; at dusk the
 * bright parts pass the bloom threshold.
 */
export async function createScreens(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene, renderer } = ctx;
  const { placed, skipped } = placeScreens(route, ctx.buildings, ctx.cityModels ?? null, S.windows, S);
  if (ctx.debug) {
    for (const p of placed) {
      console.info(
        `[screens] ${p.window}: OSM ${p.buildingId} (h ${p.buildingHeight.toFixed(0)} m) s ${p.s.toFixed(0)} d ${p.d.toFixed(1)} ${p.side}, ` +
          `${p.width.toFixed(1)}×${p.height.toFixed(1)} m from ${p.bottom.toFixed(1)} m, facing ${p.facingDeg.toFixed(1)}° toward traffic`,
      );
    }
    for (const k of skipped) console.info(`[screens] ${k.window} skipped: ${k.reason}`);
  }
  if (!placed.length) return { update() {} };

  const texture = await new THREE.TextureLoader().loadAsync(import.meta.env.BASE_URL + S.textureUrl).catch(() => null);
  if (!texture) {
    if (ctx.debug) console.info(`[screens] ${S.textureUrl} missing, screens off`);
    return { update() {} };
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true });
  addLedGrid(material, Math.round(S.width / S.ledPitch), Math.round((S.width * 16) / 9 / S.ledPitch));
  const mesh = new THREE.Mesh(screenGeometry(placed), material);
  mesh.name = 'apec-screens';
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  if (ctx.debug) ((window as unknown as { __SCENERY__?: Record<string, THREE.Object3D> }).__SCENERY__ ??= {}).screens = mesh;

  const apply = (time: TimeOfDay) => material.color.setScalar(S.brightness[time]);
  apply(getTimeOfDay());
  const unsubscribe = onTimeOfDayChange(apply);

  return {
    update() {},
    dispose() {
      unsubscribe();
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
