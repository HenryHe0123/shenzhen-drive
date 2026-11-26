import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { GROUND_COLOR_GLSL, groundTextures } from '../road/ground';
import type { GridSampler, MetroData } from './load';

const M = CONFIG.metro;
/** Quads per node side; every node is the same shared grid, displaced in the vertex shader. */
const N = 128;

/** Unit grid (x, z in [0, 1]) with downward skirts around the edge, which hide cracks between LOD levels. */
function nodeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const skirt: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      pos.push(i / N, 0, j / N);
      skirt.push(0);
    }
  }
  const at = (i: number, j: number) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  // Perimeter clockwise seen from above (north edge eastward first): outward-facing skirt quads.
  const ring: number[] = [];
  for (let i = 0; i < N; i++) ring.push(at(i, 0));
  for (let j = 0; j < N; j++) ring.push(at(N, j));
  for (let i = N; i > 0; i--) ring.push(at(i, N));
  for (let j = N; j > 0; j--) ring.push(at(0, j));
  const base = pos.length / 3;
  for (const v of ring) {
    pos.push(pos[v * 3], 0, pos[v * 3 + 2]);
    skirt.push(1);
  }
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    const p2 = base + k;
    const q2 = base + ((k + 1) % ring.length);
    idx.push(p, q, p2, q, q2, p2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
  geo.setIndex(idx);
  // Heights are added on the GPU: a sphere of 0.75 x the node size (scale x/z) covers any terrain under 1.4 km.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0, 0.5), 0.75);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(1, 0.3, 1));
  return geo;
}

function heightTexture(renderer: THREE.WebGLRenderer, s: GridSampler): THREE.DataTexture {
  const { nx, nz } = s.g;
  const floatLinear = renderer.extensions.has('OES_texture_float_linear');
  const tex = floatLinear
    ? new THREE.DataTexture(s.values, nx, nz, THREE.RedFormat, THREE.FloatType)
    : new THREE.DataTexture(Uint16Array.from(s.values, (v) => THREE.DataUtils.toHalfFloat(v)), nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function corridorTexture(s: GridSampler<Uint8Array> | null): THREE.DataTexture {
  const tex = s
    ? new THREE.DataTexture(s.values, s.g.nx, s.g.nz, THREE.RedFormat, THREE.UnsignedByteType)
    : new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const rect = (g: { x0: number; z0: number; cell: number; nx: number; nz: number }) =>
  new THREE.Vector4(g.x0, g.z0, g.nx * g.cell, g.nz * g.cell);

/** Shared GLSL (vertex and fragment): blended terrain height at world xz. */
const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHInner;
uniform sampler2D uHOuter;
uniform vec4 uInner;
uniform vec4 uOuter;
uniform float uInnerBlend;
uniform float uSeaY;
float sdInnerW(vec2 xz) {
  vec2 a = xz - uInner.xy;
  vec2 b = uInner.xy + uInner.zw - xz;
  float d = min(min(a.x, b.x), min(a.y, b.y));
  return smoothstep(0.0, 1.0, clamp(d / uInnerBlend, 0.0, 1.0));
}
float sdTerrainH(vec2 xz) {
  vec2 ro = (xz - uOuter.xy) / uOuter.zw;
  // Outside the data window the terrain drops under the far sea / land plane (src/city/metro/water.ts).
  if (ro.x < 0.0 || ro.y < 0.0 || ro.x > 1.0 || ro.y > 1.0) return uSeaY - 30.0;
  float w = sdInnerW(xz);
  float o = texture(uHOuter, ro).r;
  if (w <= 0.0) return o;
  float i = texture(uHInner, (xz - uInner.xy) / uInner.zw).r;
  return mix(o, i, w);
}
`;

export interface TerrainHandle extends SceneryModule {
  material: THREE.MeshStandardMaterial;
  /** Nodes drawn last frame (debug). */
  nodeCount(): number;
}

/**
 * Whole-city terrain (scripts/build_metro_data.py): chunked LOD quadtree of one shared grid, displaced on
 * the GPU from the 30 m inner / 120 m outer height grids. Sentinel-2 albedo, normals from the height
 * field; inside the flattened route corridor it shows the procedural ground of the v0.5 ground plane.
 */
export async function createTerrain(ctx: WorldContext, metro: MetroData): Promise<TerrainHandle> {
  const { scene, renderer, camera } = ctx;
  const t = metro.terrain;
  const tm = metro.meta.terrain;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const loader = new THREE.TextureLoader();
  const albedo = async (file: string) => {
    const tex = await loader.loadAsync(metro.base + file);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = aniso;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  const [aInner, aOuter] = await Promise.all([albedo(tm.inner.albedo.file), albedo(tm.outer.albedo.file)]);
  const hInner = heightTexture(renderer, t.inner);
  const hOuter = heightTexture(renderer, t.outer);
  const corr = corridorTexture(t.corridor);
  const ground = groundTextures(aniso);

  const uniforms = {
    uHInner: { value: hInner },
    uHOuter: { value: hOuter },
    uAInner: { value: aInner },
    uAOuter: { value: aOuter },
    uCorridor: { value: corr },
    uGroundDetail: { value: ground.detail },
    uGroundMacro: { value: ground.macro },
    uInner: { value: rect(tm.inner) },
    uOuter: { value: rect(tm.outer) },
    uCorr: { value: tm.corridor ? rect(tm.corridor) : new THREE.Vector4(0, 0, 1, 1) },
    uInnerBlend: { value: tm.innerBlend },
    uSeaY: { value: tm.seaLevel },
    uDetail: { value: M.terrainDetail },
  };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
  material.name = 'MetroTerrain';
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}\nattribute float aSkirt;\nvarying vec2 vTerrainXZ;`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
vec2 sdWxz = (modelMatrix * vec4(position, 1.0)).xz;
vec3 transformed = vec3(position);
transformed.y = sdTerrainH(sdWxz) - aSkirt * (modelMatrix[0][0] / ${N.toFixed(1)} * 1.5 + 6.0);
vTerrainXZ = sdWxz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${HEIGHT_GLSL}
${GROUND_COLOR_GLSL}
uniform sampler2D uAInner;
uniform sampler2D uAOuter;
uniform sampler2D uCorridor;
uniform vec4 uCorr;
uniform float uDetail;
varying vec2 vTerrainXZ;
float sdHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sdVNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sdHash(i), sdHash(i + vec2(1.0, 0.0)), f.x), mix(sdHash(i + vec2(0.0, 1.0)), sdHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
{
  vec2 xz = vTerrainXZ;
  float w = sdInnerW(xz);
  vec3 alb = texture2D(uAOuter, (xz - uOuter.xy) / uOuter.zw).rgb;
  if (w > 0.0) alb = mix(alb, texture2D(uAInner, (xz - uInner.xy) / uInner.zw).rgb, w);
  // Sub-texel variation so the 24 m imagery does not read as a smooth blur up close.
  float dist = length(vViewPosition);
  float n = sdVNoise(xz / 7.0) * 0.6 + sdVNoise(xz / 23.0) * 0.4;
  alb *= 1.0 + uDetail * (n - 0.5) * (1.0 - smoothstep(300.0, 2500.0, dist));
  // The corridor's paving / lawn patchwork is street-level detail; from the air it gives way to the imagery.
  float corr = texture2D(uCorridor, (xz - uCorr.xy) / uCorr.zw).r * (1.0 - smoothstep(40.0, 220.0, cameraPosition.y)) * (1.0 - smoothstep(800.0, 2500.0, dist));
  if (corr > 0.0) alb = mix(alb, sdGroundColor(xz), corr);
  diffuseColor.rgb *= alb;
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
{
  float e = clamp(length(vViewPosition) * 0.004, 15.0, 120.0);
  vec2 xz = vTerrainXZ;
  float hx = sdTerrainH(xz - vec2(e, 0.0)) - sdTerrainH(xz + vec2(e, 0.0));
  float hz = sdTerrainH(xz - vec2(0.0, e)) - sdTerrainH(xz + vec2(0.0, e));
  normal = normalize((viewMatrix * vec4(normalize(vec3(hx, 2.0 * e, hz)), 0.0)).xyz);
}`,
      );
  };
  material.customProgramCacheKey = () => 'sd-metro-terrain-v1';

  const geo = nodeGeometry();
  const root = new THREE.Group();
  root.name = 'metro-terrain';
  scene.add(root);

  // Quadtree roots: leaves are N cells of the inner grid, aligned with its cell centres.
  const leaf = N * tm.inner.cell;
  const levels = M.terrainLevels;
  const rootSize = leaf * 2 ** levels;
  const ox = tm.inner.x0 + tm.inner.cell / 2 - Math.ceil((tm.inner.x0 + tm.inner.cell / 2 - tm.outer.x0) / leaf) * leaf;
  const oz = tm.inner.z0 + tm.inner.cell / 2 - Math.ceil((tm.inner.z0 + tm.inner.cell / 2 - tm.outer.z0) / leaf) * leaf;
  const ex1 = tm.outer.x0 + tm.outer.nx * tm.outer.cell;
  const ez1 = tm.outer.z0 + tm.outer.nz * tm.outer.cell;
  const roots: [number, number][] = [];
  for (let x = ox; x < ex1; x += rootSize) for (let z = oz; z < ez1; z += rootSize) roots.push([x, z]);

  const pool: THREE.Mesh[] = [];
  const active = new Map<string, THREE.Mesh>();
  const want = new Map<string, [number, number, number]>();
  const camPos = new THREE.Vector3();
  const k = M.terrainSplit;
  const minY = tm.min;
  const maxY = tm.max;
  const ex0 = tm.outer.x0;
  const ez0 = tm.outer.z0;

  const visit = (x: number, z: number, size: number, level: number) => {
    if (x >= ex1 || z >= ez1 || x + size <= ex0 || z + size <= ez0) return;
    const dx = Math.max(x - camPos.x, 0, camPos.x - (x + size));
    const dz = Math.max(z - camPos.z, 0, camPos.z - (z + size));
    const dy = Math.max(minY - camPos.y, 0, camPos.y - maxY);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (level > 0 && d < k * size) {
      const h = size / 2;
      visit(x, z, h, level - 1);
      visit(x + h, z, h, level - 1);
      visit(x, z + h, h, level - 1);
      visit(x + h, z + h, h, level - 1);
      return;
    }
    want.set(`${level}:${Math.round(x)}:${Math.round(z)}`, [x, z, size]);
  };

  let lastX = Infinity;
  let lastY = Infinity;
  let lastZ = Infinity;
  const select = () => {
    camera.getWorldPosition(camPos);
    if (Math.abs(camPos.x - lastX) + Math.abs(camPos.y - lastY) + Math.abs(camPos.z - lastZ) < 8) return;
    lastX = camPos.x;
    lastY = camPos.y;
    lastZ = camPos.z;
    want.clear();
    for (const [x, z] of roots) visit(x, z, rootSize, levels);
    for (const [key, mesh] of active) {
      if (!want.has(key)) {
        root.remove(mesh);
        pool.push(mesh);
        active.delete(key);
      }
    }
    for (const [key, [x, z, size]] of want) {
      if (active.has(key)) continue;
      const mesh = pool.pop() ?? new THREE.Mesh(geo, material);
      mesh.position.set(x, 0, z);
      mesh.scale.set(size, 1, size);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = 'terrain-node';
      root.add(mesh);
      active.set(key, mesh);
    }
  };
  // The first selection happens before the first render so nothing pops in on the first frames.
  select();

  return {
    material,
    nodeCount: () => active.size,
    update(_frame: FrameInfo) {
      select();
    },
    dispose() {
      scene.remove(root);
      geo.dispose();
      material.dispose();
      for (const tex of [hInner, hOuter, aInner, aOuter, corr, ground.detail, ground.macro]) tex.dispose();
    },
  };
}
