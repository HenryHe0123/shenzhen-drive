import * as THREE from 'three';
import { CONFIG } from '../../config';
import { nightUniform } from '../../render/timeOfDay';
import { WINDOW_GLSL } from './windowPattern';

const M = CONFIG.cityModels;

export interface PhotoMaterialOptions {
  map: THREE.Texture | null;
  /** map is a runtime atlas: per-vertex aAtlas = (u0, v0, du, dv), UVs repeat inside the rect. */
  atlas: boolean;
  vertexColors: boolean;
  doubleSided: boolean;
  /** FOG_SCALE define (skyline models); undefined = normal fog. */
  fogScale?: number;
  /** Per-building random seed 0..1 (window layout, lit pattern). */
  seed: number;
}

const nightTint = new THREE.Color(M.photoNightTint);

/**
 * Facade material for old photo-textured models (Google Earth snapshots baked
 * into 3D Warehouse SketchUp models). MeshStandardMaterial keeps PBR lighting,
 * shadows, env reflections and the sky fog; onBeforeCompile adds:
 * - daylight grading: the photo slightly desaturated and flattened so it sits
 *   with the procedural city;
 * - a glass mask from photo luminance (darker than its blurred surroundings, or
 *   dark / bluish): glossier there, and the only place offices light up;
 * - subtle mullion / slab lines from the shared window grid where the photo is
 *   too blurry to show them (few texels per meter) and the camera is close;
 * - night: the photo base dimmed and cooled with nightUniform, plus the shared
 *   lit-window grid (floor / bay scale of the procedural facade) on vertical faces.
 * Facade coordinates come from the object-space position and the flat face
 * normal (screen derivatives), so the GLB needs no extra attributes.
 */
export function createPhotoFacadeMaterial(o: PhotoMaterialOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'CityModelPhoto',
    color: 0xffffff,
    map: o.map,
    vertexColors: o.vertexColors,
    roughness: 0.88,
    metalness: 0,
    side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  const defines: Record<string, string> = {};
  if (o.atlas) defines.SD_ATLAS = '';
  if (o.fogScale !== undefined) defines.FOG_SCALE = o.fogScale.toFixed(3);
  mat.defines = defines;
  const uniforms = {
    uNight: nightUniform,
    uFloorH: { value: CONFIG.city.floorHeight },
    uBayW: { value: CONFIG.city.bayWidth },
    uLit: { value: M.photoLitRatio },
    uSeed: { value: o.seed },
    uSat: { value: M.photoSaturation },
    uContrast: { value: M.photoContrast },
    uNightDim: { value: M.photoNightDim },
    uNightTint: { value: nightTint },
    uDetail: { value: M.photoDetail },
    uSharpen: { value: M.photoSharpen },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSdObj;
#ifdef SD_ATLAS
attribute vec4 aAtlas;
varying vec4 vSdAtlas;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vSdObj = position;
#ifdef SD_ATLAS
vSdAtlas = aAtlas;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PHOTO_PARS}\n${WINDOW_GLSL}`)
      .replace('#include <map_fragment>', PHOTO_MAP)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${PHOTO_GRADE}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.3, sdGlass * sdVert);`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${PHOTO_NIGHT}`);
  };
  mat.customProgramCacheKey = () => 'sd-city-photo-v1';
  return mat;
}

const PHOTO_PARS = /* glsl */ `
uniform float uNight;
uniform float uFloorH;
uniform float uBayW;
uniform float uLit;
uniform float uSeed;
uniform float uSat;
uniform float uContrast;
uniform float uNightDim;
uniform vec3 uNightTint;
uniform float uDetail;
uniform float uSharpen;
varying vec3 vSdObj;
#ifdef SD_ATLAS
varying vec4 vSdAtlas;
#endif
`;

const PHOTO_MAP = /* glsl */ `
// Flat face normal in object space: vertical faces get facade coordinates (NaN-safe: bloom spreads NaN).
vec3 sdFN = cross(dFdx(vSdObj), dFdy(vSdObj));
sdFN = dot(sdFN, sdFN) > 1e-20 ? normalize(sdFN) : vec3(0.0, 1.0, 0.0);
float sdVert = 1.0 - smoothstep(0.35, 0.6, abs(sdFN.y));
vec2 sdTan = normalize(vec2(-sdFN.z, sdFN.x) + 1e-6);
SwCell sdCell = swCell(dot(vSdObj.xz, sdTan), vSdObj.y, uSeed, uFloorH, uBayW);
float sdGlass = 0.0;
float sdTexelsPerM = 0.0;
#ifdef USE_MAP
{
  vec2 sdTs = vec2(textureSize(map, 0));
  #ifdef SD_ATLAS
    vec2 sdDx = dFdx(vMapUv) * vSdAtlas.zw;
    vec2 sdDy = dFdy(vMapUv) * vSdAtlas.zw;
    vec2 sdUv = vSdAtlas.xy + fract(vMapUv) * vSdAtlas.zw;
    vec4 sdTex = textureGrad(map, sdUv, sdDx, sdDy);
  #else
    vec2 sdDx = dFdx(vMapUv);
    vec2 sdDy = dFdy(vMapUv);
    vec2 sdUv = vMapUv;
    vec4 sdTex = texture2D(map, vMapUv);
  #endif
  // Neighbourhood mean ~4 texels wide, also when magnified (a bias alone clamps at level 0).
  float sdLod = max(0.5 * log2(max(dot(sdDx * sdTs, sdDx * sdTs), dot(sdDy * sdTs, sdDy * sdTs))), 0.0);
  vec4 sdBlur = textureLod(map, sdUv, sdLod + 2.0);
  // Mild unsharp mask on magnified photos: crisper floor and window edges.
  sdTex.rgb = max(sdTex.rgb + (sdTex.rgb - sdBlur.rgb) * uSharpen * (1.0 - smoothstep(0.5, 2.0, sdLod)), vec3(0.0));
  diffuseColor *= sdTex;
  float sdL = dot(sdTex.rgb, vec3(0.2126, 0.7152, 0.0722));
  float sdLB = dot(sdBlur.rgb, vec3(0.2126, 0.7152, 0.0722));
  // Glass in a daylight photo: darker than its surroundings, or dark / bluish overall.
  float sdDarker = clamp((sdLB - sdL) / max(sdLB, 0.03) * 3.0, 0.0, 1.0);
  float sdDark = 1.0 - smoothstep(0.05, 0.28, sdL);
  float sdBlue = clamp((sdTex.b - sdTex.r) * 6.0, 0.0, 1.0);
  sdGlass = clamp(max(sdDarker, sdDark * 0.85) + 0.25 * sdBlue, 0.0, 1.0);
  sdTexelsPerM = length(sdDx * sdTs) / max(length(dFdx(vSdObj)), 1e-5);
}
#endif
`;

const PHOTO_GRADE = /* glsl */ `
{
  float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 c = mix(vec3(l), diffuseColor.rgb, uSat);
  c = max(mix(vec3(0.16), c, uContrast), vec3(0.0));
  // Blurry photo up close: a hint of mullions from the shared grid (the photo keeps its own floors).
  float blurry = 1.0 - smoothstep(1.5, 4.0, sdTexelsPerM);
  c *= 1.0 - uDetail * swMullions(sdCell) * blurry * sdVert * smoothstep(3.0, 4.5, vSdObj.y);
  float n2 = uNight * uNight;
  diffuseColor.rgb = c * mix(vec3(1.0), uNightTint * uNightDim, n2);
}
`;

const PHOTO_NIGHT = /* glsl */ `
{
  float litK = smoothstep(0.08, 1.0, uNight);
  if (litK > 0.0) {
    float mask = mix(0.2, 1.0, sdGlass) * sdVert * smoothstep(3.0, 4.5, vSdObj.y);
    totalEmissiveRadiance += swWindowLight(sdCell, uSeed, uLit, litK) * mask;
  }
}
`;
