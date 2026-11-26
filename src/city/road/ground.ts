import * as THREE from 'three';
import { canvasTexture, fbm, makeCanvas, mulberry32 } from './textures';

/** Meters covered by one tile of the detail texture. */
const DETAIL_M = 96;

/**
 * Urban ground detail, one 96 m tile: 8 × 8 plots of paving slabs, plaza tiles,
 * lawn, gravel and parking asphalt with curb lines between them.
 */
function detailTexture(aniso: number): THREE.CanvasTexture {
  const S = 1024;
  const N = 8;
  const C = S / N;
  const px = S / DETAIL_M;
  const rand = mulberry32(808);
  const low = fbm(S, S, 4, 4, rand);
  const [c, ctx] = makeCanvas(S, S);
  const kinds = ['paving', 'paving', 'plaza', 'plaza', 'grass', 'grass', 'grass', 'gravel', 'lot'] as const;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const x0 = gx * C;
      const y0 = gy * C;
      const tone = 0.9 + rand() * 0.2;
      const rgb = (r: number, g: number, b: number, k = 1) =>
        `rgb(${Math.round(r * tone * k)},${Math.round(g * tone * k)},${Math.round(b * tone * k)})`;
      if (kind === 'paving') {
        ctx.fillStyle = rgb(158, 152, 142);
        ctx.fillRect(x0, y0, C, C);
        ctx.fillStyle = 'rgba(70,66,60,0.35)';
        const step = 0.8 * px;
        for (let y = y0; y < y0 + C; y += step) ctx.fillRect(x0, y, C, 1);
        for (let x = x0; x < x0 + C; x += step * 1.5) ctx.fillRect(x, y0, 1, C);
      } else if (kind === 'plaza') {
        const t = 2 * px;
        for (let y = 0; y < C; y += t) {
          for (let x = 0; x < C; x += t) {
            const odd = (Math.round(x / t) + Math.round(y / t)) % 2 === 1;
            ctx.fillStyle = odd ? rgb(182, 172, 160) : rgb(132, 126, 120);
            ctx.fillRect(x0 + x, y0 + y, t, t);
          }
        }
        ctx.fillStyle = 'rgba(60,56,52,0.4)';
        for (let y = 0; y <= C; y += t) ctx.fillRect(x0, y0 + y, C, 1);
        for (let x = 0; x <= C; x += t) ctx.fillRect(x0 + x, y0, 1, C);
      } else if (kind === 'grass') {
        ctx.fillStyle = rgb(78, 108, 54);
        ctx.fillRect(x0, y0, C, C);
      } else if (kind === 'gravel') {
        ctx.fillStyle = rgb(140, 126, 104);
        ctx.fillRect(x0, y0, C, C);
      } else {
        ctx.fillStyle = rgb(74, 74, 76);
        ctx.fillRect(x0, y0, C, C);
        ctx.fillStyle = 'rgba(225,225,215,0.55)';
        for (let x = x0 + 4; x < x0 + C; x += 2.6 * px) ctx.fillRect(x, y0 + C * 0.1, 2, C * 0.32);
      }
      // Curb / border around each plot.
      ctx.fillStyle = 'rgba(205,200,190,0.55)';
      ctx.fillRect(x0, y0, C, 3);
      ctx.fillRect(x0, y0, 3, C);
    }
  }
  // Grain and soft blotches so plots never look flat.
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    const k = 0.86 + (low[i] - 0.5) * 0.35 + (rand() - 0.5) * 0.12;
    d[i * 4] = Math.min(255, d[i * 4] * k);
    d[i * 4 + 1] = Math.min(255, d[i * 4 + 1] * k);
    d[i * 4 + 2] = Math.min(255, d[i * 4 + 2] * k);
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c, { aniso });
}

/** Low-frequency masks: r = large lawns, g = tint, b = blend between the two detail scales. */
function macroTexture(): THREE.CanvasTexture {
  const S = 256;
  const rand = mulberry32(909);
  const r = fbm(S, S, 3, 4, rand);
  const g = fbm(S, S, 5, 3, rand);
  const b = fbm(S, S, 2, 3, rand);
  const [c, ctx] = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    img.data[i * 4] = r[i] * 255;
    img.data[i * 4 + 1] = g[i] * 255;
    img.data[i * 4 + 2] = b[i] * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c, { srgb: false, aniso: 1 });
}

/** Detail and macro textures of the procedural ground (also used by the metro terrain inside the route corridor). */
export function groundTextures(aniso: number): { detail: THREE.CanvasTexture; macro: THREE.CanvasTexture } {
  return { detail: detailTexture(aniso), macro: macroTexture() };
}

/** GLSL: `vec3 sdGroundColor(vec2 xz)`, the procedural ground albedo at world xz (needs uGroundDetail, uGroundMacro). */
export const GROUND_COLOR_GLSL = /* glsl */ `
uniform sampler2D uGroundDetail;
uniform sampler2D uGroundMacro;
vec3 sdGroundColor(vec2 xz) {
  vec3 gA = texture2D(uGroundDetail, xz / ${DETAIL_M.toFixed(1)}).rgb;
  vec3 gB = texture2D(uGroundDetail, xz.yx / 151.0 + vec2(0.37, 0.61)).rgb;
  vec4 gM = texture2D(uGroundMacro, xz / 1700.0);
  vec3 gCol = mix(gA, gB, smoothstep(0.38, 0.62, gM.b));
  float gLawn = smoothstep(0.56, 0.68, gM.r);
  gCol = mix(gCol, vec3(0.075, 0.13, 0.045) * (0.75 + 0.5 * gA.g), gLawn * 0.8);
  return gCol * (0.85 + 0.3 * gM.g);
}
`;

/** World-space procedural ground (paving, plazas, lawns) that reads in daylight and darkens with the light at dusk. */
export function groundMaterial(aniso: number) {
  const { detail, macro } = groundTextures(aniso);
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGroundDetail = { value: detail };
    sh.uniforms.uGroundMacro = { value: macro };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundXZ = (modelMatrix * vec4(position, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vGroundXZ;\n${GROUND_COLOR_GLSL}`)
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= sdGroundColor(vGroundXZ);');
  };
  return { material: mat, textures: [detail, macro] };
}
