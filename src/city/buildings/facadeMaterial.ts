import * as THREE from 'three';
import { CONFIG } from '../../config';
import { nightUniform } from '../../render/timeOfDay';

/**
 * Facade style ids, stored per vertex in aFac.y.
 * 0 teal/green glass curtain wall, 1 blue glass, 2 stone/tile with punched
 * windows, 3 mixed office, 4 flat roof, 5 mechanical louvers,
 * 6 Ping An glass, 7 Tencent glass, 8 Civic Center glass (warm, mostly lit),
 * 9 silver reflective glass, 10 bronze/smoky glass, 11 tiled residential.
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
  silverGlass: 9,
  bronzeGlass: 10,
  residential: 11,
} as const;

const C = CONFIG.city;

/**
 * Procedural facade shader on top of MeshStandardMaterial (keeps PBR lighting,
 * shadows, env reflections and fog). Expects attributes
 *   aEdge = (meters along the current facade face, face length)
 *   aFac  = (building seed 0..1, style id, podium height m, building top y)
 *   aBase = ground y of the building; heights in aFac and the floor grid count from it
 * and draws curtain walls (tinted reflective panes with per-pane tilt,
 * mullions, spandrels, a parallax interior behind the glass), punched
 * windows in weathered stone/tile, shop fronts with sign bands, parapets and
 * night lighting scaled by nightUniform. Grid detail fades to its average
 * when it gets sub-pixel, which keeps distant towers from shimmering.
 */
export function createFacadeMaterial(opts: { fogScale?: number; litRatio?: number } = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 });
  mat.name = opts.fogScale !== undefined ? 'FacadeLandmark' : 'Facade';
  if (opts.fogScale !== undefined) mat.defines = { FOG_SCALE: opts.fogScale.toFixed(3) };
  const uniforms = {
    uFloorH: { value: C.floorHeight },
    uBayW: { value: C.bayWidth },
    uLit: { value: opts.litRatio ?? C.litWindowRatio },
    uNight: nightUniform,
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
attribute float aBase;
varying vec2 vEdge;
varying vec4 vFac;
varying float vLY;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vEdge = aEdge;
vFac = aFac;
vLY = position.y - aBase;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_GLSL}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
vec3 fDiff; vec3 fSpec; float fRough; vec3 fEmis;
sdFacade(normal, fDiff, fSpec, fRough, fEmis);
roughnessFactor = fRough;
metalnessFactor = 0.0;`,
      )
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
  mat.customProgramCacheKey = () => 'sd-facade-v2';
  return mat;
}

const FACADE_GLSL = /* glsl */ `
uniform float uFloorH;
uniform float uBayW;
uniform float uLit;
uniform float uNight;
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

float fNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fh12(i), fh12(i + vec2(1.0, 0.0)), f.x), mix(fh12(i + vec2(0.0, 1.0)), fh12(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Reflectance (F0) of coated curtain-wall glass.
vec3 fGlassTint(int style, float r, float r2) {
  if (style == 0) return r < 0.5 ? vec3(0.035, 0.15, 0.14) : vec3(0.06, 0.16, 0.1);
  if (style == 1) return r < 0.6 ? vec3(0.045, 0.1, 0.22) : vec3(0.08, 0.125, 0.2);
  if (style == 9) return vec3(0.2, 0.21, 0.22) * (0.85 + 0.3 * r2);
  if (style == 10) return r < 0.5 ? vec3(0.2, 0.125, 0.065) : vec3(0.14, 0.115, 0.095);
  if (style == 6) return vec3(0.115, 0.13, 0.15);
  if (style == 7) return vec3(0.06, 0.13, 0.24);
  if (style == 8) return vec3(0.09, 0.1, 0.11);
  return vec3(0.09, 0.11, 0.12);
}

// Room behind a pane, ray-cast in facade space: ceiling, floor, side and back walls.
vec3 fInterior(vec3 rayW, vec3 nW, vec3 tW, float px, float py, float roomW, float roomH, float rnd) {
  float rz = max(dot(rayW, -nW), 0.08);
  float rx = dot(rayW, tW);
  float ry = rayW.y;
  float tz = roomH * (1.3 + rnd) / rz;
  float tx = rx > 0.0 ? (roomW - px) / max(rx, 1e-3) : px / max(-rx, 1e-3);
  float ty = ry > 0.0 ? (roomH - py) / max(ry, 1e-3) : py / max(-ry, 1e-3);
  float t = min(tz, min(tx, ty));
  vec3 col;
  if (t == tz) col = mix(vec3(0.17, 0.165, 0.16), vec3(0.3, 0.28, 0.25), rnd);
  else if (t == tx) col = vec3(0.24, 0.23, 0.22);
  else if (ry > 0.0) col = vec3(0.55, 0.55, 0.53);
  else col = vec3(0.08, 0.075, 0.07);
  return col * exp(-t * rz * 0.22);
}

void sdFacade(inout vec3 n, out vec3 diff, out vec3 spec, out float rough, out vec3 emis) {
  float seed = vFac.x;
  int style = int(vFac.y + 0.5);
  float podH = vFac.z;
  float top = vFac.w;
  float y = vLY;
  float night = uNight;
  float litK = smoothstep(0.08, 1.0, night);
  emis = vec3(0.0);

  float r1 = fh11(seed * 91.7 + 3.1);
  float r2 = fh11(seed * 37.3 + 7.7);
  float r3 = fh11(seed * 13.1 + 1.9);
  float r4 = fh11(seed * 57.9 + 5.3);
  float r5 = fh11(seed * 23.3 + 9.1);

  if (style == 4) {
    diff = vec3(0.2, 0.2, 0.19) * (0.7 + 0.5 * r1);
    spec = vec3(0.03);
    rough = 0.9;
    return;
  }
  if (style == 5) {
    float l = fPulse(fract(y / 0.45), 0.0, 0.55, fwidth(y / 0.45));
    diff = vec3(0.24, 0.245, 0.25) * (0.7 + 0.45 * l) * (0.8 + 0.35 * r1);
    if (top - y < 0.25) diff *= 1.25;
    spec = vec3(0.06);
    rough = 0.5;
    return;
  }

  vec3 nW = (vec4(n, 0.0) * viewMatrix).xyz;
  vec3 rayW = normalize((vec4(-vViewPosition, 0.0) * viewMatrix).xyz);
  float ao = mix(0.72, 1.0, smoothstep(0.0, 2.8, y));

  bool ribbon = style == 3 && r3 < 0.4;
  bool punched = style == 2 || style == 11 || (style == 3 && r3 >= 0.4 && r3 <= 0.72);
  bool glassy = !ribbon && !punched;
  float fh = uFloorH * (punched ? 0.86 : (0.95 + 0.22 * r1));
  float bw = uBayW * (punched ? 2.0 : (1.0 + floor(r2 * 2.0)));
  if (style == 6) { fh = 4.4; bw = 1.5; }
  if (style == 7) { fh = 4.0; bw = 1.5; }
  if (style == 8) { fh = 4.5; bw = 3.0; }

  float faceLen = max(vEdge.y, 0.5);
  float nb = max(1.0, floor(faceLen / bw + 0.5));
  float bwe = faceLen / nb;
  float bx = vEdge.x / bwe;
  float bay = floor(bx);
  float fx = fract(bx);
  float fwx = fwidth(bx);
  float fy0 = y / fh;
  float fl = floor(fy0);
  float fy = fract(fy0);
  float fwy = fwidth(fy0);
  // Detail fades: kCell when a cell is a few px, kFine (blinds, streaks) earlier.
  float kCell = smoothstep(0.12, 0.45, max(fwx, fwy));
  float kFine = smoothstep(0.03, 0.12, max(fwx, fwy));

  vec3 tint = fGlassTint(style, r4, r5);
  vec3 wallD;
  vec3 wallS = vec3(0.04);
  float wallR = 0.85;
  float wx0, wx1, wy0, wy1;
  float litMul = 1.0;
  if (glassy) {
    float mw = (style == 8 ? 0.22 : 0.065) / bwe;
    wx0 = mw;
    wx1 = 1.0 - mw;
    float spand = style == 6 ? 0.55 : style == 8 ? 0.5 : (r3 < 0.45 ? 0.85 + 0.5 * r2 : 0.16);
    wy0 = spand / fh;
    wy1 = 1.0 - 0.05 / fh;
    wallD = r5 < 0.55 ? vec3(0.34, 0.35, 0.36) : vec3(0.045, 0.047, 0.05);
    if (style == 6) wallD = vec3(0.4, 0.41, 0.42);
    if (style == 7) wallD = vec3(0.3, 0.32, 0.34);
    if (style == 8) wallD = vec3(0.4, 0.4, 0.39);
    wallS = vec3(0.22);
    wallR = 0.35;
    if (style == 6) litMul = 1.4;
    if (style == 8) litMul = 1.5;
  } else if (ribbon) {
    wx0 = 0.015; wx1 = 0.985; wy0 = 0.36; wy1 = 0.9;
    wallD = r4 < 0.5 ? vec3(0.5, 0.5, 0.48) : r4 < 0.75 ? vec3(0.36, 0.37, 0.38) : vec3(0.15, 0.155, 0.16);
    wallS = vec3(0.045);
    wallR = 0.7;
    tint = vec3(0.08, 0.09, 0.095);
  } else {
    wx0 = 0.22; wx1 = 0.78; wy0 = 0.28; wy1 = 0.8;
    if (style == 3) { wx0 = 0.14; wx1 = 0.86; wy0 = 0.22; wy1 = 0.88; }
    vec3 pal = r4 < 0.2 ? vec3(0.55, 0.48, 0.38) : r4 < 0.35 ? vec3(0.4, 0.23, 0.16) : r4 < 0.6 ? vec3(0.52, 0.51, 0.48) : r4 < 0.8 ? vec3(0.66, 0.64, 0.6) : vec3(0.52, 0.4, 0.35);
    if (style == 11) pal = r4 < 0.4 ? vec3(0.72, 0.7, 0.65) : r4 < 0.7 ? vec3(0.64, 0.56, 0.45) : vec3(0.56, 0.58, 0.6);
    wallD = pal * (0.82 + 0.25 * r1);
    litMul = 1.1;
    tint = vec3(0.055, 0.06, 0.065);
  }

  float colMask = fPulse(fx, wx0, wx1, fwx);
  float visMask = fPulse(fy, wy0, wy1, fwy);
  float win = colMask * visMask;

  // Weathering of opaque walls: large blotches, rain streaks under windows and parapets.
  if (!glassy) {
    float big = fNoise(vec2(vEdge.x * 0.07 + seed * 13.0, y * 0.05));
    float streak = fNoise(vec2(vEdge.x * 1.7 + seed * 5.0, y * 0.035));
    float under = colMask * (1.0 - smoothstep(0.0, wy0, fy));
    float runoff = smoothstep(0.5, 0.95, streak) * (0.45 + 0.55 * under) * (1.0 - kFine);
    wallD *= (0.86 + 0.26 * big) * (1.0 - 0.22 * runoff);
    wallD *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 4.0, top - y)) * streak;
    // Sill line under each window.
    wallD = mix(wallD, wallD * 1.2 + 0.03, fLine(fy, wy0 - 0.012, 0.012) * colMask * (1.0 - kCell));
  }

  // Lit offices: grouped bays per floor, per-floor occupancy, warm/cool mix; none in daylight.
  float gsize = 2.0 + floor(r1 * 5.0);
  float g = floor(bay / gsize);
  float floorOcc = fh12(vec2(fl, seed * 113.0));
  float litBase = uLit * litMul * litK;
  float litP = clamp(litBase * (0.3 + 1.4 * floorOcc), 0.0, 1.0);
  float cell = step(fh13(vec3(fl, g, seed * 71.0)), litP);
  float kC = smoothstep(0.25, 0.7, max(fwx / gsize, fwy));
  float kFloor = smoothstep(0.25, 0.7, fwy);
  float lit = mix(mix(cell, litP, kC), clamp(litBase, 0.0, 1.0), kFloor);
  float tone = fh13(vec3(g, fl, seed * 17.0));
  vec3 litCol = tone < 0.55 ? vec3(1.0, 0.7, 0.4) : tone < 0.85 ? vec3(0.95, 0.9, 0.8) : vec3(0.72, 0.86, 1.0);
  if (style == 8) litCol = vec3(1.0, 0.78, 0.5);
  litCol = mix(litCol, vec3(0.95, 0.8, 0.6), kC);
  float bh = fh13(vec3(bay, fl, seed * 29.0));
  float bright = mix(0.3 + 1.1 * bh * bh, 0.65, kC);
  float grad = mix(0.65 + 0.5 * fy, 0.9, kFloor);
  vec3 winEmis = litCol * lit * bright * grad * 0.95;

  // Daylit interior seen through the glass (parallax room), blinds/curtains near the pane.
  float cellR = fh13(vec3(bay, fl, seed * 5.0));
  vec3 tW = normalize(cross(nW, vec3(0.0, 1.0, 0.0)) + 1e-5);
  float roomBays = punched ? 1.0 : 3.0;
  vec3 interior = fInterior(rayW, nW, tW, (mod(bay, roomBays) + fx) * bwe, fy * fh, roomBays * bwe, fh,
                            fh13(vec3(floor(bay / roomBays), fl, seed * 3.0)));
  float hasBlind = step(fh13(vec3(bay, fl, seed * 11.0)), punched ? 0.5 : 0.3);
  float blindLen = 0.15 + 0.75 * fh13(vec3(bay, fl, seed * 19.0));
  float wv = (fy - wy0) / max(wy1 - wy0, 1e-3);
  vec3 blindCol = punched ? mix(vec3(0.62, 0.55, 0.44), vec3(0.6, 0.6, 0.58), fh13(vec3(bay, fl, seed * 23.0))) : vec3(0.46, 0.46, 0.44);
  float slat = punched ? 1.0 : mix(0.82 + 0.18 * step(0.5, fract(fy * fh * 10.0)), 0.91, kFine);
  interior = mix(interior, blindCol * slat, hasBlind * step(1.0 - blindLen, wv));
  interior = mix(interior, vec3(0.17), kCell);
  float cosV = clamp(dot(nW, -rayW), 0.0, 1.0);
  float f0 = dot(tint, vec3(0.3333));
  float fres = f0 + (1.0 - f0) * pow(1.0 - cosV, 5.0);
  vec3 trans = mix(vec3(0.75), 0.75 * tint / max(max(tint.r, tint.g), max(tint.b, 1e-3)), 0.55);
  // Window reveal: punched windows sit in a recess, the lintel shades the top of the pane.
  float reveal = punched ? (1.0 - 0.55 * smoothstep(wy1 - 0.16 / fh - fwy - 1e-3, wy1 - 0.16 / fh, fy)) * (1.0 - 0.35 * (1.0 - smoothstep(wx0, wx0 + 0.1 / bwe + fwx, fx))) : 1.0;
  reveal = mix(reveal, 0.85, kCell);
  vec3 interiorEmis = interior * mix(0.085, 0.006, night) * trans * (1.0 - fres) * reveal;

  vec3 glassD = vec3(0.004) + litCol * lit * 0.02;
  vec3 glassS = tint * (0.88 + 0.24 * cellR) * reveal;
  float glassR = 0.04 + 0.04 * r3;
  diff = mix(wallD * ao, glassD, win);
  spec = mix(wallS, glassS, win);
  rough = mix(wallR, glassR, win);
  emis = (winEmis + interiorEmis) * win;

  if (glassy) {
    // Spandrel below the vision glass: shadow-box glass or a metal panel.
    float spd = colMask * fPulse(fy, 0.05 / fh, wy0, fwy) * step(0.1, wy0);
    vec3 panel = r2 < 0.55 ? vec3(0.012) : r2 < 0.8 ? vec3(0.4, 0.4, 0.39) : vec3(0.42, 0.37, 0.29);
    vec3 panelS = r2 < 0.55 ? tint : vec3(0.1);
    diff = mix(diff, panel, spd);
    spec = mix(spec, panelS, spd);
    rough = mix(rough, r2 < 0.55 ? glassR : 0.4, spd);
    // Each pane is slightly out of plane, so reflections break up pane by pane.
    vec2 jit = (vec2(fh13(vec3(bay, fl, seed * 37.0)), fh13(vec3(fl, bay, seed * 43.0))) - 0.5) * 0.05 * (1.0 - kCell);
    vec3 upV = viewMatrix[1].xyz;
    vec3 tV = normalize(cross(upV, n) + 1e-5);
    n = normalize(n + (tV * jit.x + upV * jit.y) * colMask);
  } else if (style == 11 || (style == 2 && top < 70.0)) {
    // Air-conditioner units under some windows (residential).
    float ac = step(fh13(vec3(bay, fl, seed * 53.0)), 0.45) * fPulse(fx, 0.6, 0.9, fwx) * fPulse(fy, 0.05, 0.21, fwy);
    ac *= 1.0 - kCell;
    diff = mix(diff, vec3(0.58, 0.58, 0.56) * mix(0.75, 1.0, step(0.5, fract(fy * fh * 6.0))), ac);
    spec = mix(spec, vec3(0.05), ac);
    rough = mix(rough, 0.6, ac);
  }

  // Podium: shop fronts (sign bands, lit interiors) and mall cladding above.
  if (y < podH) {
    float shopW = 6.0 + 3.0 * r2;
    float sx = vEdge.x / shopW;
    float shop = floor(sx);
    float sfx = fract(sx);
    float sfw = fwidth(sx);
    float kShop = smoothstep(0.08, 0.3, sfw);
    float groundH = min(5.5, podH);
    vec3 podStone = r4 < 0.35 ? vec3(0.5, 0.47, 0.42) : r4 < 0.7 ? vec3(0.4, 0.4, 0.39) : vec3(0.24, 0.23, 0.22);
    if (y < groundH) {
      float g0 = fPulse(sfx, 0.06, 0.94, sfw) * (1.0 - smoothstep(3.85, 3.95, y));
      float bars = (1.0 - fPulse(fract(sfx * 4.0), 0.04, 0.96, sfw * 4.0)) * g0 * (1.0 - kShop);
      float on = step(fh12(vec2(shop, seed * 41.0)), 0.65);
      float shopB = 0.35 + 0.65 * fh12(vec2(shop, seed * 3.0));
      vec3 shopCol = mix(vec3(1.0, 0.66, 0.36), vec3(0.85, 0.9, 1.0), step(0.75, fh12(vec2(shop, seed * 7.0))));
      float shelf = 0.75 + 0.25 * step(0.5, fract(sx * 3.0 + y * 0.35));
      diff = mix(podStone * ao, vec3(0.008), g0);
      diff = mix(diff, vec3(0.05), bars);
      spec = mix(vec3(0.04), vec3(0.07), g0);
      rough = mix(0.6, 0.06, g0);
      emis = shopCol * g0 * (1.0 - bars) * on * shopB * shelf * (0.12 + 0.45 * smoothstep(0.0, 3.8, y)) * mix(0.3, 1.0, night);
      float soffit = step(3.95, y) * step(y, 4.25);
      diff = mix(diff, vec3(0.045), soffit);
      float band = step(4.3, y) * step(y, 5.1) * fPulse(sfx, 0.12, 0.88, sfw);
      float hue = fh12(vec2(shop, seed * 13.0));
      vec3 signCol = hue < 0.3 ? vec3(1.0, 0.1, 0.06) : hue < 0.45 ? vec3(1.0, 0.92, 0.8) : hue < 0.65 ? vec3(0.08, 0.4, 1.0) : hue < 0.82 ? vec3(1.0, 0.65, 0.08) : vec3(0.08, 0.85, 0.45);
      float signOn = step(fh12(vec2(shop, seed * 23.0)), 0.6) * band;
      // Blocky characters on the sign face (light on dark colors, dark on the white boxes).
      float cu = (sfx - 0.12) / 0.76 * 5.0;
      float glyph = step(0.3, fh12(vec2(floor(cu * 2.0), shop * 7.0 + floor((y - 4.3) / 0.4)))) * fPulse(fract(cu), 0.12, 0.88, sfw * 6.6)
                  * fPulse((y - 4.3) / 0.8, 0.2, 0.8, fwidth(y) / 0.8) * (1.0 - kShop);
      bool whiteBox = hue >= 0.3 && hue < 0.45;
      vec3 face = mix(signCol * 0.5, whiteBox ? vec3(0.06) : vec3(0.75, 0.74, 0.7), glyph * 0.9);
      diff = mix(diff, face, signOn);
      spec = mix(spec, vec3(0.05), signOn);
      rough = mix(rough, 0.3, signOn);
      emis += signCol * signOn * 1.6 * night;
    } else {
      float lv = fract((y - groundH) / 5.0);
      float bandG = fPulse(lv, 0.3, 0.8, fwidth((y - groundH) / 5.0));
      float joint = 1.0 - 0.3 * fLine(fract(vEdge.x / 3.0), 0.5, 0.02) * (1.0 - kShop);
      vec3 clad = (r4 < 0.5 ? vec3(0.46, 0.44, 0.4) : vec3(0.3, 0.31, 0.32)) * joint;
      diff = mix(clad, vec3(0.008), bandG);
      spec = mix(vec3(0.05), tint, bandG);
      rough = mix(0.5, 0.06, bandG);
      float on2 = step(fh12(vec2(shop, floor((y - groundH) / 5.0) + seed * 3.0)), 0.45);
      emis = vec3(1.0, 0.72, 0.45) * bandG * on2 * 0.45 * litK;
      emis += bandG * vec3(0.16) * mix(0.085, 0.006, night) * (1.0 - fres);
    }
  }

  if (style == 6) {
    // Ping An: faint cool facade glow and the LED crown "lantern", both at night only.
    emis += vec3(0.03, 0.045, 0.075) * litK;
    if (y > top) {
      float fin = fPulse(fx, 0.35, 0.65, fwx);
      float band = 0.6 + 0.4 * fPulse(fy, 0.0, 0.25, fwy);
      emis = vec3(0.65, 0.8, 1.0) * mix(0.55, 1.6, fin) * band * litK;
      diff = mix(vec3(0.02), vec3(0.32), fin);
      spec = mix(tint, vec3(0.55), fin);
      rough = mix(0.06, 0.25, fin);
    }
    return;
  }

  // Parapet with a lighter coping, plus night LED strips at the roof edge and corners.
  if (y > top - 1.1) {
    diff = glassy ? wallD : wallD * 1.08 + 0.02;
    if (top - y < 0.15) diff = diff * 1.2 + 0.04;
    spec = wallS;
    rough = wallR;
    emis = vec3(0.0);
  }
  if (top > 45.0 && r2 > 0.5) {
    vec3 led = r4 < 0.45 ? vec3(0.35, 0.85, 1.0) : r4 < 0.8 ? vec3(1.0, 0.97, 0.92) : vec3(1.0, 0.55, 0.25);
    emis += led * fLine(y, top - 0.7, 0.18) * 4.0 * litK;
    if (r1 > 0.55 && top > 70.0) {
      float edgeD = min(vEdge.x, faceLen - vEdge.x);
      emis += led * fLine(edgeD, 0.0, 0.25) * 3.0 * smoothstep(podH, podH + 4.0, y) * litK;
    }
  }
}
`;
