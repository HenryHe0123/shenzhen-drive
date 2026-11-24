import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { RGB } from '../road/builder';
import { canvasTexture, makeCanvas } from '../road/textures';
import { PropGeo, type V3 } from './geo';

const POLE: RGB = [0.36, 0.38, 0.41];

/** Local head positions; local +x points to the route's right when yaw = route heading. */
export const DOUBLE_HEADS: V3[] = [
  [-3.25, 9.9, 0],
  [3.25, 9.9, 0],
];
export const SINGLE_HEADS: V3[] = [[-2.95, 9.45, 0]];

export function doubleLampGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  g.box(null, 0, 0.35, 0, 0.5, 0.7, 0.5, POLE);
  g.cylinder(null, [0, 0.7, 0], [0, 10.3, 0], 0.15, 0.08, 8, POLE);
  for (const sgn of [-1, 1]) {
    g.cylinder(null, [0, 9.55, 0], [sgn * 1.6, 9.95, 0], 0.07, 0.06, 6, POLE);
    g.cylinder(null, [sgn * 1.6, 9.95, 0], [sgn * 2.9, 10.05, 0], 0.06, 0.05, 6, POLE);
    g.box(null, sgn * 3.25, 10.02, 0, 0.95, 0.16, 0.38, POLE);
  }
  return g.geometry();
}

export function singleLampGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  g.box(null, 0, 0.3, 0, 0.45, 0.6, 0.45, POLE);
  g.cylinder(null, [0, 0.6, 0], [0, 9.6, 0], 0.14, 0.08, 8, POLE);
  g.cylinder(null, [0, 9.1, 0], [-1.4, 9.5, 0], 0.07, 0.06, 6, POLE);
  g.cylinder(null, [-1.4, 9.5, 0], [-2.6, 9.58, 0], 0.06, 0.05, 6, POLE);
  g.box(null, -2.95, 9.57, 0, 0.95, 0.16, 0.38, POLE);
  return g.geometry();
}

/** Emissive lens under each lamp housing (instanced at head positions). */
export function lensGeometry(): THREE.BufferGeometry {
  const g = new PropGeo();
  const w: RGB = [1, 1, 1];
  g.box(null, 0, 0, 0, 0.8, 0.07, 0.3, w);
  return g.geometry();
}

export function lampMaterials() {
  const pole = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.45 });
  const lens = new THREE.MeshBasicMaterial({
    color: new THREE.Color(CONFIG.city.lampColor).multiplyScalar(CONFIG.city.lampIntensity),
  });
  return { pole, lens };
}

/**
 * Additive warm pool on the ground under a lamp; fog fades it to nothing instead of fog colour.
 * The fog chunk is evaluated on white and black to recover its transmittance, so this keeps
 * working with any linear-mix fog chunk (the render module installs its own).
 */
export function poolMaterial(): THREE.MeshBasicMaterial {
  const [c, ctx] = makeCanvas(128, 128);
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(150,150,150,1)');
  grd.addColorStop(0.7, 'rgba(40,40,40,1)');
  grd.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  const tex = canvasTexture(c, { repeat: false });
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(CONFIG.city.lampColor).multiplyScalar(CONFIG.city.lampPoolIntensity),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
  vec3 poolSrc = gl_FragColor.rgb;
  gl_FragColor.rgb = vec3(1.0);
  {
#include <fog_fragment>
  }
  vec3 poolOnWhite = gl_FragColor.rgb;
  gl_FragColor.rgb = vec3(0.0);
  {
#include <fog_fragment>
  }
  gl_FragColor.rgb = poolSrc * clamp(poolOnWhite - gl_FragColor.rgb, 0.0, 1.0);
#endif`,
    );
  };
  return mat;
}

export function poolGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
}
