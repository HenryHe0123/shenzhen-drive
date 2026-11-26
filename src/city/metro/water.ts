import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { fetchBinary, type MetroData } from './load';

const M = CONFIG.metro;

/**
 * Sea, reservoirs, lakes and rivers (water.bin.gz, 'SZW2': per 8 km tile i, j, vertex and index counts, world
 * x, y, z float32, uint32 indices): flat triangle meshes, glossy PBR water
 * reflecting the sky environment, with small animated ripples in the normal. Sea and inland water differ
 * only in tint (told apart by height: the sea sits at metro.terrain.seaLevel).
 */
export async function createWater(ctx: WorldContext, metro: MetroData): Promise<SceneryModule> {
  const { scene } = ctx;
  const buf = await fetchBinary(metro.base + metro.meta.water.file);
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'SZW2') throw new Error('water.bin: bad magic');
  const tiles = dv.getUint32(4, true);
  let off = 12;
  const uTime = { value: 0 };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: M.waterRoughness, metalness: 0, envMapIntensity: M.waterEnv });
  material.name = 'MetroWater';
  const tm = metro.meta.terrain;
  // Beyond the data window: open sea, except north of it (Dongguan / Huizhou), which reads as distant land.
  const northEdge = tm.outer.z0;
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uSea = { value: tm.seaLevel };
    sh.uniforms.uSeaColor = { value: new THREE.Color(M.seaColor) };
    sh.uniforms.uLakeColor = { value: new THREE.Color(M.lakeColor) };
    sh.uniforms.uLandColor = { value: new THREE.Color(M.farLandColor) };
    sh.uniforms.uLandNorth = { value: northEdge };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterW = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec3 vWaterW;
uniform float uTime;
uniform float uSea;
uniform vec3 uSeaColor;
uniform vec3 uLakeColor;
uniform vec3 uLandColor;
uniform float uLandNorth;
float wHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float wHeight(vec2 p) {
  return wNoise(p / 9.0 + vec2(uTime * 0.05, uTime * 0.03)) * 0.6 + wNoise(p / 3.1 - vec2(uTime * 0.11, -uTime * 0.07)) * 0.4;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
bool wLand = vWaterW.z < uLandNorth;
diffuseColor.rgb *= wLand ? uLandColor : abs(vWaterW.y - uSea) < 0.3 ? uSeaColor : uLakeColor;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (wLand) roughnessFactor = 1.0;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
if (!wLand) {
  float dist = length(vViewPosition);
  float amp = 0.35 * (1.0 - smoothstep(200.0, 4000.0, dist));
  vec2 p = vWaterW.xz;
  float e = 0.6;
  float hx = wHeight(p + vec2(e, 0.0)) - wHeight(p - vec2(e, 0.0));
  float hz = wHeight(p + vec2(0.0, e)) - wHeight(p - vec2(0.0, e));
  vec3 nW = normalize(vec3(-hx * amp, 2.0 * e, -hz * amp));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`,
      );
  };
  material.customProgramCacheKey = () => 'sd-metro-water-v1';

  const root = new THREE.Group();
  root.name = 'metro-water';
  let verts = 0;
  for (let k = 0; k < tiles; k++) {
    const nv = dv.getUint32(off + 8, true);
    const ni = dv.getUint32(off + 12, true);
    off += 16;
    const pos = new Float32Array(buf.slice(off, off + nv * 12));
    off += nv * 12;
    const idx = new Uint32Array(buf.slice(off, off + ni * 4));
    off += ni * 4;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const nrm = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) nrm[v * 3 + 1] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.matrixAutoUpdate = false;
    mesh.name = 'water-tile';
    root.add(mesh);
    verts += nv;
  }
  // Sea level out to the horizon around the data window (a frame with the window cut out, so it never meets the terrain).
  const x0 = tm.outer.x0;
  const z0 = tm.outer.z0;
  const x1 = x0 + tm.outer.nx * tm.outer.cell;
  const z1 = z0 + tm.outer.nz * tm.outer.cell;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const h = M.farPlane / 2;
  const outer = [cx - h, cz - h, cx + h, cz - h, cx + h, cz + h, cx - h, cz + h];
  const inner = [x0, z0, x1, z0, x1, z1, x0, z1];
  const fp = new Float32Array(24);
  for (let k = 0; k < 4; k++) {
    fp.set([outer[k * 2], tm.seaLevel, outer[k * 2 + 1]], k * 3);
    fp.set([inner[k * 2], tm.seaLevel, inner[k * 2 + 1]], 12 + k * 3);
  }
  const fi: number[] = [];
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    fi.push(k, 4 + n, n, k, 4 + k, 4 + n);
  }
  const farGeo = new THREE.BufferGeometry();
  farGeo.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  farGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(24).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  farGeo.setIndex(fi);
  farGeo.computeBoundingSphere();
  const far = new THREE.Mesh(farGeo, material);
  far.matrixAutoUpdate = false;
  far.name = 'water-far';
  root.add(far);
  scene.add(root);
  if (ctx.debug) console.info(`[metro] water: ${tiles} tiles, ${verts} vertices`);
  return {
    update(frame: FrameInfo) {
      uTime.value = frame.time;
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      material.dispose();
    },
  };
}
