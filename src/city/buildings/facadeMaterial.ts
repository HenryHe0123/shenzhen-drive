import * as THREE from 'three';
import { CONFIG } from '../../config';

/**
 * Facade style ids, stored per vertex in aFac.y.
 * 0 teal glass curtain wall, 1 blue/silver glass, 2 stone/tile with punched
 * windows, 3 mixed office, 4 flat roof, 5 mechanical louvers,
 * 6 Ping An glass, 7 Tencent glass, 8 Civic Center glass (warm, mostly lit).
 */
export const STYLE = {
  tealGlass: 0,
  blueGlass: 1,
  stone: 2,
  mixed: 3,
  roof: 4,
  mech: 5,
  pingan: 6,
  tencent: 7,
  civic: 8,
} as const;

const C = CONFIG.city;

/**
 * Procedural facade shader on top of MeshStandardMaterial (keeps PBR lighting,
 * shadows, env reflections and fog). Expects attributes
 *   aEdge = (meters along the current facade face, face length)
 *   aFac  = (building seed 0..1, style id, podium height m, building top y)
 * and draws window grids, mullions, spandrels, shop fronts, lit offices and
 * roof-edge LED strips. Grid detail fades to its average when it gets
 * sub-pixel, which keeps distant towers from shimmering.
 */
export function createFacadeMaterial(opts: { fogScale?: number; litRatio?: number } = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 });
  mat.name = opts.fogScale !== undefined ? 'FacadeLandmark' : 'Facade';
  if (opts.fogScale !== undefined) mat.defines = { FOG_SCALE: opts.fogScale.toFixed(3) };
  const uniforms = {
    uFloorH: { value: C.floorHeight },
    uBayW: { value: C.bayWidth },
    uLit: { value: opts.litRatio ?? C.litWindowRatio },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aEdge;
attribute vec4 aFac;
varying vec2 vEdge;
varying vec4 vFac;
varying float vLY;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vEdge = aEdge;
vFac = aFac;
vLY = position.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 fDiff; vec3 fSpec; float fRough; vec3 fEmis;
sdFacade(fDiff, fSpec, fRough, fEmis);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = fRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = 0.0;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = fEmis;')
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
material.diffuseColor = fDiff;
material.diffuseContribution = fDiff;
material.specularColor = fSpec;
material.specularColorBlended = fSpec;`,
      );
  };
  mat.customProgramCacheKey = () => 'sd-facade-v1';
  return mat;
}

const FACADE_GLSL = /* glsl */ `
uniform float uFloorH;
uniform float uBayW;
uniform float uLit;
varying vec2 vEdge;
varying vec4 vFac;
varying float vLY;

float fh11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float fh12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fh13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// 1 inside [a, b] of a cell coordinate x in [0,1); fades to the duty cycle once a cell is sub-pixel.
float fPulse(float x, float a, float b, float fw) {
  float w = clamp(fw, 1e-4, 0.5);
  float p = smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
  return mix(p, b - a, smoothstep(0.2, 0.6, fw));
}

// Thin line kept at >= 1 px wide with intensity scaled by true coverage.
float fLine(float coord, float center, float halfW) {
  float fw = max(fwidth(coord), 1e-4);
  float hw = max(halfW, fw);
  return (1.0 - smoothstep(hw - fw * 0.5, hw + fw * 0.5, abs(coord - center))) * (halfW / hw);
}

void sdFacade(out vec3 diff, out vec3 spec, out float rough, out vec3 emis) {
  float seed = vFac.x;
  int style = int(vFac.y + 0.5);
  float podH = vFac.z;
  float top = vFac.w;
  float y = vLY;
  emis = vec3(0.0);
  if (style == 4) {
    diff = vec3(0.05, 0.051, 0.056) * (0.75 + 0.5 * seed);
    spec = vec3(0.03);
    rough = 0.85;
    return;
  }
  if (style == 5) {
    float l = fPulse(fract(y / 0.45), 0.0, 0.55, fwidth(y / 0.45));
    diff = vec3(0.06, 0.062, 0.066) * (0.75 + 0.5 * l);
    spec = vec3(0.05);
    rough = 0.55;
    return;
  }

  float r1 = fh11(seed * 91.7 + 3.1);
  float r2 = fh11(seed * 37.3 + 7.7);
  float r3 = fh11(seed * 13.1 + 1.9);
  float r4 = fh11(seed * 57.9 + 5.3);

  bool glassStyle = style == 0 || style == 1 || style == 6 || style == 7 || (style == 3 && r3 > 0.72);
  float fh = uFloorH * (style == 2 ? 0.86 : (0.95 + 0.22 * r1));
  float bw = uBayW * (style == 2 ? 2.0 : (1.0 + floor(r2 * 2.0)));
  if (style == 6) { fh = 4.4; bw = 1.5; }
  if (style == 7) { fh = 4.0; bw = 1.5; }
  if (style == 8) { fh = 4.5; bw = 3.0; }

  float faceLen = max(vEdge.y, 0.5);
  float nb = max(1.0, floor(faceLen / bw + 0.5));
  float bx = vEdge.x / (faceLen / nb);
  float bay = floor(bx);
  float fx = fract(bx);
  float fwx = fwidth(bx);
  float fy0 = y / fh;
  float fl = floor(fy0);
  float fy = fract(fy0);
  float fwy = fwidth(fy0);

  // Window aperture per style.
  float wx0 = 0.06, wx1 = 0.94, wy0 = 0.2, wy1 = 0.95;
  vec3 wallD = vec3(0.025, 0.03, 0.035);
  vec3 wallS = vec3(0.07);
  float wallR = 0.3;
  vec3 glassS = vec3(0.1, 0.15, 0.17);
  float litMul = 1.0;
  if (style == 1) {
    glassS = vec3(0.13, 0.16, 0.21);
    wallD = vec3(0.03, 0.035, 0.045);
    if (r4 > 0.5 && mod(bay, 4.0) == 0.0) { wx0 = 0.18; }
  } else if (style == 2) {
    wx0 = 0.22; wx1 = 0.78; wy0 = 0.28; wy1 = 0.8;
    vec3 pal = r4 < 0.25 ? vec3(0.42, 0.35, 0.27) : r4 < 0.45 ? vec3(0.36, 0.2, 0.14) : r4 < 0.7 ? vec3(0.5, 0.49, 0.46) : r4 < 0.85 ? vec3(0.58, 0.56, 0.52) : vec3(0.48, 0.36, 0.33);
    wallD = pal * (0.8 + 0.25 * r1);
    wallS = vec3(0.04);
    wallR = 0.85;
    glassS = vec3(0.05);
    litMul = 1.1;
  } else if (style == 3 && !glassStyle) {
    if (r3 < 0.4) {
      wx0 = 0.015; wx1 = 0.985; wy0 = 0.36; wy1 = 0.9;
      wallD = r4 < 0.5 ? vec3(0.5, 0.5, 0.49) : vec3(0.12, 0.125, 0.13);
    } else {
      wx0 = 0.14; wx1 = 0.86; wy0 = 0.22; wy1 = 0.88;
      wallD = r4 < 0.5 ? vec3(0.42, 0.41, 0.38) : vec3(0.3, 0.31, 0.33);
    }
    wallS = vec3(0.045);
    wallR = 0.7;
    glassS = vec3(0.07, 0.08, 0.085);
  } else if (style == 3) {
    glassS = vec3(0.11, 0.14, 0.13);
  } else if (style == 6) {
    wx0 = 0.09; wx1 = 0.91; wy0 = 0.14; wy1 = 0.96;
    glassS = vec3(0.16, 0.18, 0.21);
    wallD = vec3(0.12, 0.125, 0.13);
    wallS = vec3(0.35);
    litMul = 1.4;
  } else if (style == 7) {
    glassS = vec3(0.08, 0.15, 0.26);
    wallD = vec3(0.02, 0.04, 0.08);
  } else if (style == 8) {
    wx0 = 0.04; wx1 = 0.96; wy0 = 0.08; wy1 = 0.97;
    glassS = vec3(0.08);
    wallD = vec3(0.16, 0.16, 0.17);
    litMul = 1.5;
  }

  float win = fPulse(fx, wx0, wx1, fwx) * fPulse(fy, wy0, wy1, fwy);

  // Lit offices: grouped bays per floor, per-floor occupancy, warm/cool mix.
  float gsize = 2.0 + floor(r1 * 5.0);
  float g = floor(bay / gsize);
  float floorOcc = fh12(vec2(fl, seed * 113.0));
  float litP = clamp(uLit * litMul * (0.3 + 1.4 * floorOcc), 0.0, 1.0);
  float cell = step(fh13(vec3(fl, g, seed * 71.0)), litP);
  float kCell = smoothstep(0.25, 0.7, max(fwx / gsize, fwy));
  float kFloor = smoothstep(0.25, 0.7, fwy);
  float lit = mix(mix(cell, litP, kCell), clamp(uLit * litMul, 0.0, 1.0), kFloor);
  float tone = fh13(vec3(g, fl, seed * 17.0));
  vec3 litCol = tone < 0.55 ? vec3(1.0, 0.7, 0.4) : tone < 0.85 ? vec3(0.95, 0.9, 0.8) : vec3(0.72, 0.86, 1.0);
  if (style == 8) litCol = vec3(1.0, 0.78, 0.5);
  litCol = mix(litCol, vec3(0.95, 0.8, 0.6), kCell);
  float bh = fh13(vec3(bay, fl, seed * 29.0));
  float bright = mix(0.3 + 1.1 * bh * bh, 0.65, kCell);
  float grad = mix(0.65 + 0.5 * fy, 0.9, kFloor);
  vec3 winEmis = litCol * lit * bright * grad * 0.95;

  float cellVar = fh13(vec3(bay, fl, seed * 5.0));
  vec3 glassD = vec3(0.01, 0.013, 0.017) + litCol * lit * 0.02;
  diff = mix(wallD, glassD, win);
  spec = mix(wallS, glassS * (0.85 + 0.3 * cellVar), win);
  rough = mix(wallR, 0.05 + 0.08 * r3 + 0.06 * cellVar * (1.0 - kCell), win);
  emis = winEmis * win;

  // Podium: shop fronts with glowing interiors and light-box signs, mall cladding above.
  if (y < podH) {
    float shopW = 6.0 + 3.0 * r2;
    float sx = vEdge.x / shopW;
    float shop = floor(sx);
    float sfx = fract(sx);
    float sfw = fwidth(sx);
    float groundH = min(5.5, podH);
    if (y < groundH) {
      float g0 = fPulse(sfx, 0.04, 0.96, sfw) * (1.0 - smoothstep(4.0, 4.1, y));
      float on = step(fh12(vec2(shop, seed * 41.0)), 0.65);
      float shopB = 0.35 + 0.65 * fh12(vec2(shop, seed * 3.0));
      vec3 shopCol = mix(vec3(1.0, 0.66, 0.36), vec3(0.85, 0.9, 1.0), step(0.75, fh12(vec2(shop, seed * 7.0))));
      diff = mix(vec3(0.05, 0.05, 0.055), vec3(0.02), g0);
      spec = mix(vec3(0.05), vec3(0.08), g0);
      rough = mix(0.6, 0.08, g0);
      float shelf = 0.75 + 0.25 * step(0.5, fract(sx * 3.0 + y * 0.35));
      emis = shopCol * g0 * on * shopB * shelf * (0.12 + 0.45 * smoothstep(0.0, 3.8, y));
      float band = step(4.3, y) * step(y, 5.1) * fPulse(sfx, 0.12, 0.88, sfw);
      float hue = fh12(vec2(shop, seed * 13.0));
      vec3 signCol = hue < 0.3 ? vec3(1.0, 0.1, 0.06) : hue < 0.45 ? vec3(1.0, 0.92, 0.8) : hue < 0.65 ? vec3(0.08, 0.4, 1.0) : hue < 0.82 ? vec3(1.0, 0.65, 0.08) : vec3(0.08, 0.85, 0.45);
      float signOn = step(fh12(vec2(shop, seed * 23.0)), 0.6);
      emis += signCol * band * signOn * 1.6;
    } else {
      float lv = fract((y - groundH) / 5.0);
      float bandG = fPulse(lv, 0.3, 0.8, fwidth((y - groundH) / 5.0));
      float joint = 1.0 - 0.35 * fLine(fract(vEdge.x / 3.0), 0.5, 0.02);
      vec3 clad = (r4 < 0.5 ? vec3(0.17, 0.16, 0.15) : vec3(0.09, 0.095, 0.1)) * joint;
      diff = mix(clad, vec3(0.015), bandG);
      spec = mix(vec3(0.06), vec3(0.09), bandG);
      rough = mix(0.5, 0.07, bandG);
      float on2 = step(fh12(vec2(shop, floor((y - groundH) / 5.0) + seed * 3.0)), 0.45);
      emis = vec3(1.0, 0.72, 0.45) * bandG * on2 * 0.45;
    }
  }

  if (style == 6) {
    // Ping An: faint cool facade glow and an LED-lit crown "lantern" above the main shaft.
    emis += vec3(0.03, 0.045, 0.075);
    if (y > top) {
      float fin = fPulse(fx, 0.35, 0.65, fwx);
      float band = 0.6 + 0.4 * fPulse(fy, 0.0, 0.25, fwy);
      emis = vec3(0.65, 0.8, 1.0) * mix(0.55, 1.6, fin) * band;
      diff = vec3(0.05);
      spec = vec3(0.2);
      rough = 0.2;
    }
    return;
  }

  // Parapet, plus LED strips at the roof edge and on face corners of some towers.
  float hgt = top;
  if (y > top - 1.1) {
    diff = wallD * 1.3 + 0.05;
    spec = vec3(0.06);
    rough = 0.5;
    emis = vec3(0.0);
  }
  if (hgt > 45.0 && r2 > 0.5) {
    vec3 led = r4 < 0.45 ? vec3(0.35, 0.85, 1.0) : r4 < 0.8 ? vec3(1.0, 0.97, 0.92) : vec3(1.0, 0.55, 0.25);
    emis += led * fLine(y, top - 0.7, 0.18) * 4.0;
    if (r1 > 0.55 && hgt > 70.0) {
      float edgeD = min(vEdge.x, faceLen - vEdge.x);
      emis += led * fLine(edgeD, 0.0, 0.25) * 3.0 * smoothstep(podH, podH + 4.0, y);
    }
  }
}
`;
