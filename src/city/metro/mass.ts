import * as THREE from 'three';
import { CONFIG } from '../../config';
import { nightUniform } from '../../render/timeOfDay';
import { STYLE } from '../buildings/facadeMaterial';
import { parseMassArrays, type MassArrays } from './massData';

export type { MassArrays };

export interface MassTile {
  /** Mesh origin (tile centre); instance positions are relative to it. */
  ox: number;
  oz: number;
  count: number;
  geometry: THREE.InstancedBufferGeometry;
}

let unitBox: THREE.BufferGeometry | null = null;

/** Box x, z in [-1, 1], y in [0, 1] without its bottom face. */
function box(): THREE.BufferGeometry {
  if (unitBox) return unitBox;
  const g = new THREE.BoxGeometry(2, 1, 2).translate(0, 0.5, 0);
  const idx = Array.from(g.getIndex()!.array);
  g.setIndex([...idx.slice(0, 18), ...idx.slice(24)]);
  g.deleteAttribute('uv');
  unitBox = g;
  return g;
}

/** Builds an InstancedBufferGeometry from worker-parsed mass-tile typed arrays (zero copy). */
export function massGeometryFromArrays(data: MassArrays): MassTile {
  const geo = new THREE.InstancedBufferGeometry();
  const b = box();
  geo.index = b.index;
  geo.setAttribute('position', b.getAttribute('position'));
  geo.setAttribute('normal', b.getAttribute('normal'));
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(data.pos, 3));
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(data.size, 3));
  geo.setAttribute('iRS', new THREE.InstancedBufferAttribute(data.rs, 3));
  geo.instanceCount = data.count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(...data.bsCenter), data.bsRadius);
  return { ox: data.ox, oz: data.oz, count: data.count, geometry: geo };
}

/** Parses an SZM1 mass / skyline buffer into an InstancedBufferGeometry. */
export function parseMassTile(buf: ArrayBuffer): MassTile {
  return massGeometryFromArrays(parseMassArrays(buf));
}

/** Detail-tile readiness lookup shared with the mass shader (one texel per 2 km tile). */
export interface ReadyGrid {
  texture: THREE.DataTexture;
  /** tile size, first tile index i, j, tiles across, tiles down */
  tile: number;
  i0: number;
  j0: number;
  ni: number;
  nj: number;
}

/**
 * Boxes for distant buildings: facade palette per style (matching the detail facades from afar), floor and
 * window grid fading to its average with distance, lit windows at night. Instances whose detail tile is on
 * screen, or too small for their distance, collapse to nothing in the vertex shader.
 */
export function createMassMaterial(ready: ReadyGrid): THREE.MeshStandardMaterial {
  const M = CONFIG.metro;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  mat.name = 'MetroMass';
  const uniforms = {
    uReady: { value: ready.texture },
    uReadyGrid: { value: new THREE.Vector4(ready.tile, ready.i0, ready.j0, 0) },
    uReadyDim: { value: new THREE.Vector2(ready.ni, ready.nj) },
    uCull: { value: M.massCull },
    uNight: nightUniform,
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 iPos;
attribute vec3 iSize;
attribute vec3 iRS;
uniform sampler2D uReady;
uniform vec4 uReadyGrid;
uniform vec2 uReadyDim;
uniform float uCull;
varying vec3 vMass;
varying vec3 vMassS;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `float mC = cos(iRS.x);
float mS = sin(iRS.x);
vec3 objectNormal = vec3(normal.x * mC - normal.z * mS, normal.y, normal.x * mS + normal.z * mC);`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
vec3 mL = vec3(position.x * iSize.x, position.y * (iSize.y + 1.0) - 1.0, position.z * iSize.z);
vec3 transformed = vec3(mL.x * mC - mL.z * mS, mL.y, mL.x * mS + mL.z * mC) + iPos;
vec3 mW = (modelMatrix * vec4(iPos, 1.0)).xyz;
vec2 mT = floor(mW.xz / uReadyGrid.x) - uReadyGrid.yz;
float mReady = 0.0;
if (mT.x >= 0.0 && mT.y >= 0.0 && mT.x < uReadyDim.x && mT.y < uReadyDim.y) mReady = texture(uReady, (mT + 0.5) / uReadyDim).r;
float mSize = max(iSize.y, 2.0 * max(iSize.x, iSize.z));
if (mReady > 0.5 || mSize < distance(mW + vec3(0.0, iSize.y * 0.5, 0.0), cameraPosition) * uCull) transformed = vec3(0.0);
float mU = abs(normal.x) > 0.5 ? (position.z + 1.0) * iSize.z : (position.x + 1.0) * iSize.x;
vMass = vec3(mU, mL.y, normal.y);
vMassS = vec3(iRS.y, iRS.z, iSize.y);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uNight;
varying vec3 vMass;
varying vec3 vMassS;
float mHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
int mStyle = int(vMassS.x + 0.5);
float mSeed = vMassS.y;
bool mGlass = mStyle == ${STYLE.tealGlass} || mStyle == ${STYLE.blueGlass} || mStyle == ${STYLE.silverGlass} || mStyle == ${STYLE.bronzeGlass};
vec3 mWall;
if (mStyle == ${STYLE.tealGlass}) mWall = vec3(0.07, 0.13, 0.12);
else if (mStyle == ${STYLE.blueGlass}) mWall = vec3(0.07, 0.1, 0.16);
else if (mStyle == ${STYLE.silverGlass}) mWall = vec3(0.22, 0.23, 0.24);
else if (mStyle == ${STYLE.bronzeGlass}) mWall = vec3(0.15, 0.11, 0.08);
else if (mStyle == ${STYLE.residential}) mWall = mSeed < 0.4 ? vec3(0.66, 0.64, 0.6) : mSeed < 0.7 ? vec3(0.6, 0.53, 0.43) : vec3(0.55, 0.57, 0.59);
else if (mStyle == ${STYLE.mech}) mWall = vec3(0.34, 0.35, 0.36);
else if (mStyle == ${STYLE.stone}) mWall = mSeed < 0.3 ? vec3(0.55, 0.49, 0.4) : mSeed < 0.6 ? vec3(0.5, 0.49, 0.46) : vec3(0.63, 0.61, 0.57);
else mWall = vec3(0.42, 0.43, 0.43);
mWall *= 0.85 + 0.3 * fract(mSeed * 7.31);
float mRoof = step(0.5, vMass.z);
// Floors and window bays; the grid averages out once a cell is under a few pixels.
float mFh = 3.2;
float mBw = mGlass ? 1.5 : 2.4;
vec2 mCell = vec2(vMass.x / mBw, vMass.y / mFh);
vec2 mF = fract(mCell);
vec2 mW = fwidth(mCell);
float mFade = smoothstep(0.25, 0.7, max(mW.x, mW.y));
float mWin = mGlass ? step(0.18, mF.y) : step(0.25, mF.x) * step(mF.x, 0.75) * step(0.3, mF.y) * step(mF.y, 0.8);
float mWinAvg = mGlass ? 0.82 : 0.25;
mWin = mix(mWin, mWinAvg, mFade) * (1.0 - mRoof);
vec3 mWinCol = mGlass ? mWall * 0.55 : vec3(0.06, 0.07, 0.08);
vec3 mCol = mix(mWall, mWinCol, mWin);
if (mRoof > 0.5) mCol = vec3(0.22, 0.22, 0.21) * (0.8 + 0.4 * mSeed);
diffuseColor.rgb *= mCol;
float mLit = step(mHash(vec3(floor(mCell), mSeed * 97.0)), 0.3) * smoothstep(0.08, 1.0, uNight);
vec3 mEmis = vec3(1.0, 0.75, 0.45) * mix(mLit, 0.3, mFade) * mWin * smoothstep(0.08, 1.0, uNight) * 0.6;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mGlass ? mix(0.6, 0.18, mWin) : 0.85;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += mEmis;');
  };
  mat.customProgramCacheKey = () => 'sd-metro-mass-v1';
  return mat;
}
