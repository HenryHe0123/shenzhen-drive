import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { nightUniform } from '../../render/timeOfDay';
import { lowerBound } from '../road/builder';
import { type InstanceItem, WindowedInstances } from './instances';
import { FOLIAGE_DIRECT, LOD_DITHER, replace } from './treeImpostor';

/**
 * Near-LOD banyan baked by scripts/bake_banyan_near.mjs: ~9k triangles in the impostor's tree frame
 * (trunk axis at the origin, height = ImpostorData.height), group 0 bark (tiling map), group 1
 * foliage (alpha-tested atlas, normals bent toward the canopy), per-vertex sky visibility in `_ao`.
 */
export interface NearModel {
  geometry: THREE.BufferGeometry;
  bark: THREE.Texture;
  foliage: THREE.Texture;
  /** Model height (m), equal to the impostor's ImpostorData.height. */
  height: number;
}

export async function loadNearModel(url: string, aniso: number): Promise<NearModel> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const extras = gltf.asset.extras as { foliage: string; bark: string; height: number };
  const byMaterial = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) byMaterial.set((m.material as THREE.Material).name, m.geometry);
  });
  const parts = ['bark', 'foliage'].map((n) => byMaterial.get(n));
  if (!parts[0] || !parts[1]) throw new Error(`${url}: bark / foliage primitives missing`);
  const geometry = mergeGeometries(parts as THREE.BufferGeometry[], true);
  if (!geometry) throw new Error(`${url}: bark / foliage primitives don't merge`);
  for (const g of byMaterial.values()) g.dispose();
  const dir = url.slice(0, url.lastIndexOf('/') + 1);
  const loader = new THREE.TextureLoader();
  const [bark, foliage] = await Promise.all([loader.loadAsync(dir + extras.bark), loader.loadAsync(dir + extras.foliage)]);
  for (const t of [bark, foliage]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    t.flipY = false;
    t.needsUpdate = true;
  }
  bark.wrapS = bark.wrapT = THREE.RepeatWrapping;
  foliage.wrapS = foliage.wrapT = THREE.ClampToEdgeWrapping;
  return { geometry, bark, foliage, height: extras.height };
}

export function disposeNearModel(m: NearModel) {
  m.geometry.dispose();
  m.bark.dispose();
  m.foliage.dispose();
}

export interface NearShading {
  /** Shared with the impostor so both read the same sun direction and skip the same tree shadows. */
  sunDir: THREE.Vector3;
  shadowReach: number;
  alphaTest: number;
  mipAlphaGain: number;
  aoIndirect: number;
  aoDirect: number;
  wrap: number;
  translucency: number;
  roughness: number;
  lampColor: THREE.ColorRepresentation;
  lampGlow: number;
  /** Foliage albedo gain: sharp leaves read lighter than the impostor's supersampled canopy. */
  foliageGain: number;
}

const NEAR_VERTEX = /* glsl */ `
attribute float _ao;
attribute float aNear;
uniform vec3 uBbSun;
uniform float uBbShadowReach;
uniform float uNearHeight;
varying float vNearAo;
varying float vNearFade;
varying float vNearH;
`;

/** Shadow lookups slide toward the light past every tree, as the impostor's (only buildings shadow a canopy). */
const NEAR_SHADOW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  {
    vec3 nBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 nL = normalize(uBbSun);
    float nC = max(length(nL.xz), 0.05);
    vec3 nLh = vec3(nL.x, 0.0, nL.z) / nC;
    worldPosition.xyz -= nL * (dot(worldPosition.xyz - nBase, nLh) / nC - uBbShadowReach / max(nL.y, 0.1));
  }
#endif
#include <shadowmap_vertex>
`;

const NEAR_FRAGMENT = /* glsl */ `
uniform vec2 uBbAo;
uniform vec3 uBbLamp;
uniform float uNight;
uniform float uNearMipGain;
varying float vNearAo;
varying float vNearFade;
varying float vNearH;
${LOD_DITHER}
`;

/** Alpha grows with the mip level like the impostor's, so small distant leaves keep their coverage. */
const NEAR_MAP = /* glsl */ `
  vec4 nearTex = texture2D(map, vMapUv);
  vec2 nearTx = vMapUv * vec2(textureSize(map, 0));
  vec2 nearDx = dFdx(nearTx);
  vec2 nearDy = dFdy(nearTx);
  nearTex.a *= 1.0 + max(0.0, 0.5 * log2(max(dot(nearDx, nearDx), dot(nearDy, nearDy)))) * uNearMipGain;
  diffuseColor *= nearTex;
`;

const NEAR_AO = /* glsl */ `
  float bbOccI = mix(1.0, vNearAo, uBbAo.x);
  float bbOccD = mix(1.0, vNearAo, uBbAo.y);
  reflectedLight.indirectDiffuse *= bbOccI;
  reflectedLight.indirectSpecular *= bbOccI;
  reflectedLight.directDiffuse *= bbOccD;
  reflectedLight.directSpecular *= bbOccD;
  totalEmissiveRadiance += diffuseColor.rgb * uBbLamp * (uNight * uNight) * (1.0 - smoothstep(0.5, 1.0, vNearH)) * bbOccI;
`;

/** Bark (opaque, tiling) and foliage (alpha-tested atlas, bent normals, wrap + transmission) materials and the shared shadow-depth material. */
export function createNearMaterials(model: NearModel, height: number, opt: NearShading): { materials: THREE.MeshStandardMaterial[]; depthMaterial: THREE.MeshDepthMaterial } {
  const uniforms = {
    uBbSun: { value: opt.sunDir },
    uBbShadowReach: { value: opt.shadowReach },
    uNearHeight: { value: height },
    uNearMipGain: { value: opt.mipAlphaGain },
    uBbAo: { value: new THREE.Vector2(opt.aoIndirect, opt.aoDirect) },
    uBbFoliage: { value: new THREE.Vector2(opt.wrap, opt.translucency) },
    uBbLamp: { value: new THREE.Color(opt.lampColor).multiplyScalar(opt.lampGlow) },
    uNight: nightUniform,
  };
  const make = (foliage: boolean) => {
    const m = new THREE.MeshStandardMaterial({
      map: foliage ? model.foliage : model.bark,
      color: new THREE.Color().setScalar(foliage ? opt.foliageGain : 1),
      alphaTest: foliage ? opt.alphaTest : 0,
      roughness: opt.roughness,
      metalness: 0,
      side: foliage ? THREE.DoubleSide : THREE.FrontSide,
    });
    m.name = foliage ? 'banyan-near-foliage' : 'banyan-near-bark';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      let v = `${NEAR_VERTEX}${sh.vertexShader}`;
      v = replace(v, '#include <begin_vertex>', '#include <begin_vertex>\n  vNearAo = _ao;\n  vNearFade = aNear;\n  vNearH = position.y / uNearHeight;');
      v = replace(v, '#include <shadowmap_vertex>', NEAR_SHADOW);
      sh.vertexShader = v;
      let f = `${NEAR_FRAGMENT}${sh.fragmentShader}`;
      f = replace(f, 'void main() {', 'void main() {\n  if (lodDither() >= vNearFade) discard;');
      f = replace(f, '#include <aomap_fragment>', NEAR_AO);
      if (foliage) {
        f = replace(f, '#include <map_fragment>', NEAR_MAP);
        f = replace(f, '#include <normal_fragment_begin>', replace(THREE.ShaderChunk.normal_fragment_begin, 'normal *= faceDirection;', ''));
        f = replace(f, '#include <lights_physical_pars_fragment>', FOLIAGE_DIRECT);
      }
      sh.fragmentShader = f;
    };
    m.customProgramCacheKey = () => m.name;
    return m;
  };
  // three copies map, alphaTest and side of each group's material onto this before its shadow draw.
  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.name = 'banyan-near-depth';
  depthMaterial.onBeforeCompile = (sh) => {
    sh.vertexShader = replace(`attribute float aNear;\nvarying float vNearFade;\n${sh.vertexShader}`, '#include <begin_vertex>', '#include <begin_vertex>\n  vNearFade = aNear;');
    sh.fragmentShader = replace(`varying float vNearFade;\n${sh.fragmentShader}`, 'void main() {', 'void main() {\n  if (vNearFade < 0.5) discard;');
  };
  depthMaterial.customProgramCacheKey = () => 'banyan-near-depth';
  return { materials: [make(false), make(true)], depthMaterial };
}

export interface NearLodOptions {
  /** Most near meshes drawn at once. */
  count: number;
  /** Trees nearer than `full` (m, from the camera) are all mesh, farther than `far` all impostor. */
  full: number;
  far: number;
}

/**
 * Banyan impostors windowed along the route (WindowedInstances) plus the nearest banyans to the camera
 * as real meshes. Each frame the trees within `far` of the camera are ranked by distance; up to
 * `count` of them get a near weight t = (far' - d) / (far - full), far' shrinking to the first tree
 * that didn't fit so no tree pops out of the set. The weight dithers the near mesh in and the impostor
 * (instanceMatrix[0].w of its slot) out. Buffers are preallocated; nothing is allocated per frame.
 */
export class BanyanLod extends WindowedInstances {
  readonly near: THREE.InstancedMesh;
  private readonly sv: Float64Array;
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly nearMats: Float32Array;
  private readonly tints: Float32Array | null;
  private readonly fade: THREE.InstancedBufferAttribute;
  private readonly cand: Int32Array;
  private readonly candD: Float32Array;
  private readonly prev: Int32Array;
  private prevN = 0;
  private readonly cam = new THREE.Vector3(Number.NaN, 0, 0);
  private readonly lastCam = new THREE.Vector3(Number.NaN, 0, 0);
  private lastLo = -1;
  private lastCount = -1;
  private readonly inv = new THREE.Matrix4();

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    items: InstanceItem[],
    ahead: number,
    private readonly behindM: number,
    model: { geometry: THREE.BufferGeometry; materials: THREE.Material[]; depthMaterial: THREE.Material; scale: number },
    private readonly opt: NearLodOptions,
  ) {
    super(geo, mat, items, ahead, behindM);
    // super() sorted `items` by s.
    const n = items.length;
    this.sv = Float64Array.from(items, (it) => it.s);
    this.px = Float32Array.from(items, (it) => it.m.elements[12]);
    this.pz = Float32Array.from(items, (it) => it.m.elements[14]);
    this.nearMats = new Float32Array(n * 16);
    const k = new THREE.Vector3().setScalar(model.scale);
    const m = new THREE.Matrix4();
    items.forEach((it, i) => m.copy(it.m).scale(k).toArray(this.nearMats, i * 16));
    this.tints = items.some((it) => it.c) ? new Float32Array(n * 3) : null;
    if (this.tints) items.forEach((it, i) => (it.c ? it.c.toArray(this.tints!, i * 3) : this.tints!.fill(1, i * 3, i * 3 + 3)));

    const cap = opt.count;
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.fade.setUsage(THREE.DynamicDrawUsage);
    model.geometry.setAttribute('aNear', this.fade);
    this.near = new THREE.InstancedMesh(model.geometry, model.materials, cap);
    this.near.name = 'banyans-near';
    this.near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.tints) {
      this.near.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.near.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.near.customDepthMaterial = model.depthMaterial;
    this.near.castShadow = true;
    this.near.receiveShadow = true;
    this.near.frustumCulled = false;
    this.near.count = 0;
    this.mesh.add(this.near);
    this.mesh.userData.lod = this;
    this.cand = new Int32Array(256);
    this.candD = new Float32Array(256);
    this.prev = new Int32Array(cap);
  }

  /** Camera of the last rendered frame; picks the near trees on the next update. */
  setCamera(camera: THREE.Camera) {
    if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    this.cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inv.copy(this.mesh.matrixWorld).invert());
  }

  override update(s: number) {
    super.update(s);
    if (Number.isNaN(this.cam.x)) return;
    const q = Math.round(s / 20) * 20;
    const lo = lowerBound(this.sv, q - this.behindM);
    const cnt = this.mesh.count;
    if (lo === this.lastLo && cnt === this.lastCount && this.cam.distanceToSquared(this.lastCam) < 1e-4) return;
    this.lastLo = lo;
    this.lastCount = cnt;
    this.lastCam.copy(this.cam);

    const { full, far, count: cap } = this.opt;
    const cx = this.cam.x;
    const cz = this.cam.z;
    // Route s and camera distance differ by the camera offset and curvature; search a generous s range.
    const a = lowerBound(this.sv, s - far - 60);
    const b = lowerBound(this.sv, s + far + 60);
    let n = 0;
    for (let i = a; i < b && n < this.cand.length; i++) {
      const d = Math.hypot(this.px[i] - cx, this.pz[i] - cz);
      if (d >= far) continue;
      let j = n++;
      while (j > 0 && this.candD[j - 1] > d) {
        this.candD[j] = this.candD[j - 1];
        this.cand[j] = this.cand[j - 1];
        j--;
      }
      this.candD[j] = d;
      this.cand[j] = i;
    }
    const farEff = n > cap ? this.candD[cap] : far;
    const band = far - full;

    const imp = this.mesh.instanceMatrix.array as Float32Array;
    let wMin = Infinity;
    let wMax = -1;
    for (let j = 0; j < this.prevN; j++) {
      const w = this.prev[j] - lo;
      if (w < 0 || w >= cnt) continue;
      imp[w * 16 + 3] = 0;
      wMin = Math.min(wMin, w);
      wMax = Math.max(wMax, w);
    }
    const nm = this.near.instanceMatrix.array as Float32Array;
    const nc = this.near.instanceColor?.array as Float32Array | undefined;
    const fa = this.fade.array as Float32Array;
    let k = 0;
    for (let j = 0; j < Math.min(n, cap); j++) {
      const t = Math.min(1, (farEff - this.candD[j]) / band);
      if (t <= 0) break;
      const g = this.cand[j];
      for (let e = 0; e < 16; e++) nm[k * 16 + e] = this.nearMats[g * 16 + e];
      if (nc && this.tints) for (let e = 0; e < 3; e++) nc[k * 3 + e] = this.tints[g * 3 + e];
      fa[k] = t;
      this.prev[k++] = g;
      const w = g - lo;
      if (w < 0 || w >= cnt) continue;
      imp[w * 16 + 3] = t;
      wMin = Math.min(wMin, w);
      wMax = Math.max(wMax, w);
    }
    this.prevN = k;
    if (wMax >= 0) {
      this.mesh.instanceMatrix.addUpdateRange(wMin * 16, (wMax - wMin + 1) * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this.near.count = k;
    if (k === 0) return;
    upload(this.near.instanceMatrix, k);
    upload(this.fade, k);
    if (this.near.instanceColor) upload(this.near.instanceColor, k);
  }
}

function upload(attr: THREE.InstancedBufferAttribute, count: number) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}
