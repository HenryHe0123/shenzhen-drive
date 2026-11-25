import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { CONFIG } from '../config';
import { LIGHTING } from './presets';
import { getTimeOfDay, onTimeOfDayChange, type TimeOfDay } from './timeOfDay';

/**
 * Photographed HDRI reflections for a few chosen materials (car paint, glass, rims). Presets with
 * `hdri` set (golden) put the PMREM of CONFIG.render.hdriUrl into material.envMap, rotated so the
 * photo's sun sits at the preset's sun azimuth; other presets clear it so the material falls back
 * to scene.environment (the procedural sky). Never used as scene.background or scene.environment.
 */

interface Entry {
  readonly gain: number;
}

const registered = new Map<THREE.MeshStandardMaterial, Entry>();
let texture: THREE.Texture | null = null;
let started = false;

/** Equirect angle atan2(z, x) of the photo's sun (scripts/process_env_and_signs.mjs prints its u). */
const HDRI_SUN_ANGLE = (CONFIG.render.hdriSunU - 0.5) * Math.PI * 2;

function applyTo(m: THREE.MeshStandardMaterial, e: Entry, time: TimeOfDay): void {
  const h = LIGHTING[time].hdri;
  if (!h || !texture) {
    m.envMap = null;
    m.envMapIntensity = 1;
    return;
  }
  const az = THREE.MathUtils.degToRad(LIGHTING[time].sunAzimuthDeg);
  // envMapRotation R(θ) moves the map's equirect angle α to α − θ; the sun bearing az is world
  // direction (sin az, ·, −cos az).
  const target = Math.atan2(-Math.cos(az), Math.sin(az));
  m.envMap = texture;
  m.envMapRotation.set(0, HDRI_SUN_ANGLE - target, 0);
  m.envMapIntensity = h.intensity * e.gain;
}

function applyAll(time: TimeOfDay): void {
  for (const [m, e] of registered) applyTo(m, e, time);
}

/** Materials that take the HDRI in presets that have one; gain scales the preset intensity. */
export function registerReflective(materials: Iterable<THREE.MeshStandardMaterial>, gain = 1): void {
  for (const m of materials) {
    const e = { gain };
    registered.set(m, e);
    applyTo(m, e, getTimeOfDay());
  }
}

/**
 * Half-float RGBE texels → finite, non-negative, luminance-capped and tinted. A NaN or Inf here
 * survives PMREM and spreads through the bloom mip chain into a black frame.
 */
function sanitize(tex: THREE.DataTexture): void {
  const R = CONFIG.render;
  const tint = new THREE.Color(R.hdriTint);
  const { width: W, height: H } = tex.image;
  const data = tex.image.data as Uint16Array;
  const toF = THREE.DataUtils.fromHalfFloat;
  const toH = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < data.length; i += 4) {
    // Rows run top (zenith) to bottom; below the horizon the photo's pale concrete plaza becomes
    // the game's darker asphalt, faded in over the first few degrees.
    const elev = 90 - ((Math.floor(i / 4 / W) + 0.5) / H) * 180;
    const below = THREE.MathUtils.smoothstep(-elev, 0, 4);
    const k0 = 1 + (R.hdriGroundScale - 1) * below;
    let r = toF(data[i]);
    let g = toF(data[i + 1]);
    let b = toF(data[i + 2]);
    r = Number.isFinite(r) && r > 0 ? r * tint.r * k0 : 0;
    g = Number.isFinite(g) && g > 0 ? g * tint.g * k0 : 0;
    b = Number.isFinite(b) && b > 0 ? b * tint.b * k0 : 0;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const k = L > R.hdriMaxLuminance ? R.hdriMaxLuminance / L : 1;
    data[i] = toH(r * k);
    data[i + 1] = toH(g * k);
    data[i + 2] = toH(b * k);
    data[i + 3] = toH(1);
  }
  tex.needsUpdate = true;
}

/** Follows the time-of-day preset; the HDRI is fetched the first time a preset with `hdri` is active. */
export function startReflectionEnv(renderer: THREE.WebGLRenderer): () => void {
  const onTime = (time: TimeOfDay) => {
    if (LIGHTING[time].hdri) load(renderer);
    applyAll(time);
  };
  onTime(getTimeOfDay());
  return onTimeOfDayChange(onTime);
}

function load(renderer: THREE.WebGLRenderer): void {
  if (started) return;
  started = true;
  new HDRLoader()
    .setDataType(THREE.HalfFloatType)
    .loadAsync(import.meta.env.BASE_URL + CONFIG.render.hdriUrl)
    .then((equirect) => {
      sanitize(equirect);
      equirect.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const rt = pmrem.fromEquirectangular(equirect);
      pmrem.dispose();
      equirect.dispose();
      texture = rt.texture;
      applyAll(getTimeOfDay());
    })
    .catch((e) => console.warn('[env] HDRI reflections unavailable, keeping the procedural environment:', e));
}
