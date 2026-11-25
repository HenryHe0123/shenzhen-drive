import * as THREE from 'three';
import { nightUniform } from '../../render/timeOfDay';

/** Frame layout and size written by scripts/bake_banyan_impostor.mjs (public/textures/trees/banyan.json). */
export interface ImpostorData {
  color: string;
  normal: string;
  frames: number;
  cols: number;
  rows: number;
  /** Tree height, canopy radius and height of the canopy's underside (m) at instance scale 1. */
  height: number;
  canopyRadius: number;
  canopyBottom: number;
  /** Frame rectangle (m) around the trunk axis: x in [-size / 2, size / 2], y in [bottom, bottom + size]. */
  quad: { size: number; bottom: number };
}

export interface Impostor {
  /** Disposing the geometry also disposes the materials and textures. */
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  /** World direction toward the shadow-casting light; shadow lookups use it to skip self-shadowing. */
  readonly sunDir: THREE.Vector3;
}

export interface ImpostorOptions {
  /** Instance height (m) at scale 1; the baked frame is scaled from data.height. */
  height: number;
  alphaTest: number;
  /** Alpha gain per mip level, keeps distant canopies from thinning out (Golus' coverage trick). */
  mipAlphaGain: number;
  /** How much the baked sky visibility darkens ambient / direct light (0 = off, 1 = full). */
  aoIndirect: number;
  aoDirect: number;
  /** Diffuse wrap past the terminator and back-light transmission of the canopy (0 = plain Lambert). */
  wrap: number;
  translucency: number;
  roughness: number;
  /** Height (m) of the tallest tree that may shadow a canopy; nearer occluders are skipped (no tree-on-tree shadows). */
  shadowReach: number;
  /** Street-lamp light on the lower canopy at night: colour and gain (scaled by nightUniform²). */
  lampColor: THREE.ColorRepresentation;
  lampGlow: number;
}

const PARS_VERTEX = /* glsl */ `
uniform vec4 uBbFrames;
uniform vec2 uBbQuad;
flat varying vec2 vBbFrames;
varying float vBbBlend;
varying vec2 vBbUv;
varying float vBbNear;
`;

/**
 * Screen-space dither shared by the impostor and the near mesh (treeNear.ts): at nearness t the near
 * mesh keeps the pixels with dither < t and the impostor the rest, so the two cross-fade without overlap.
 */
export const LOD_DITHER = /* glsl */ `
float lodDither() {
  return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
`;

/**
 * Cylindrical billboard around the trunk axis of each instance, facing the camera (or, for the
 * orthographic shadow camera, the light). Picks the two baked frames bracketing the view azimuth in
 * tree-local space; frame k was rendered from azimuth k * 2pi / frames (0 = local +z, pi/2 = local +x).
 * instanceMatrix[0].w (unused by the billboard) carries the near-LOD weight of the instance.
 */
const BILLBOARD = /* glsl */ `
  vBbNear = instanceMatrix[0].w;
  vec3 bbBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float bbScale = length(instanceMatrix[1].xyz);
  vec3 bbLx = normalize(mat3(modelMatrix) * instanceMatrix[0].xyz);
  vec3 bbLz = normalize(mat3(modelMatrix) * instanceMatrix[2].xyz);
  vec3 bbView = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : cameraPosition - bbBase;
  bbView.y = 0.0;
  bbView = dot(bbView, bbView) > 1e-8 ? normalize(bbView) : vec3(0.0, 0.0, 1.0);
  vec3 bbRight = vec3(bbView.z, 0.0, -bbView.x);
  float bbF = mod(atan(dot(bbView, bbLx), dot(bbView, bbLz)) / (2.0 * PI) * uBbFrames.x + uBbFrames.x, uBbFrames.x);
  float bbF0 = min(floor(bbF), uBbFrames.x - 1.0);
  vBbBlend = bbF - bbF0;
  vBbFrames = vec2(bbF0, mod(bbF0 + 1.0, uBbFrames.x));
  vBbUv = vec2(position.x + 0.5, position.y);
  vec3 bbPos = bbBase + bbRight * (position.x * uBbQuad.x * bbScale) + vec3(0.0, (uBbQuad.y + position.y * uBbQuad.x) * bbScale, 0.0);
`;

const PROJECT = /* glsl */ `
  vec4 mvPosition = viewMatrix * vec4(bbPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
`;

const PARS_FRAGMENT = /* glsl */ `
uniform vec4 uBbFrames;
flat varying vec2 vBbFrames;
varying float vBbBlend;
varying vec2 vBbUv;
varying float vBbNear;
${LOD_DITHER}
vec2 bbCellUv(float k) {
  vec2 cell = vec2(mod(k, uBbFrames.y), uBbFrames.z - 1.0 - floor(k / uBbFrames.y));
  return (cell + vBbUv) / uBbFrames.yz;
}
`;

/** Cross-faded colour + coverage of the two frames; alpha grows with the mip level to keep coverage. */
const MAP = /* glsl */ `
  vec2 bbUvA = bbCellUv(vBbFrames.x);
  vec2 bbUvB = bbCellUv(vBbFrames.y);
  vec4 bbTex = mix(texture2D(map, bbUvA), texture2D(map, bbUvB), vBbBlend);
  vec2 bbTx = bbUvA * vec2(textureSize(map, 0));
  vec2 bbDx = dFdx(bbTx);
  vec2 bbDy = dFdy(bbTx);
  bbTex.a *= 1.0 + max(0.0, 0.5 * log2(max(dot(bbDx, bbDx), dot(bbDy, bbDy)))) * uBbFrames.w;
  diffuseColor *= bbTex;
`;

/** World-space frame bases (camera direction and right vector of each baked frame) for normal decoding. */
const FRAME_BASES = /* glsl */ `
  float bbThA = vBbFrames.x / uBbFrames.x * (2.0 * PI);
  float bbThB = vBbFrames.y / uBbFrames.x * (2.0 * PI);
  vBbFA = (viewMatrix * vec4(sin(bbThA) * bbLx + cos(bbThA) * bbLz, 0.0)).xyz;
  vBbRA = (viewMatrix * vec4(cos(bbThA) * bbLx - sin(bbThA) * bbLz, 0.0)).xyz;
  vBbFB = (viewMatrix * vec4(sin(bbThB) * bbLx + cos(bbThB) * bbLz, 0.0)).xyz;
  vBbRB = (viewMatrix * vec4(cos(bbThB) * bbLx - sin(bbThB) * bbLz, 0.0)).xyz;
`;

/**
 * Shadow lookups slide along the light (same shadow-map texel, only the depth changes) onto the
 * light-facing card the tree casts with, then past the reach of any tree: a tree uBbShadowReach tall
 * shadows points at most reach / sin(elevation) away along the light. Buildings beyond that still
 * shadow the canopy; neither the tree itself nor its row neighbours do (rows of banyans would go
 * black under a low sun; the baked normals and AO shade the canopy instead).
 */
const SHADOW_RECEIVE = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  {
    vec3 bbL = normalize(uBbSun);
    float bbC = max(length(bbL.xz), 0.05);
    vec3 bbLh = vec3(bbL.x, 0.0, bbL.z) / bbC;
    worldPosition.xyz = bbPos - bbL * (dot(bbPos - bbBase, bbLh) / bbC - uBbShadowReach / max(bbL.y, 0.1));
  }
#endif
#include <shadowmap_vertex>
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  vBbShadowView = directionalShadowMatrix[ 0 ] * vec4(bbView * (bbScale * uBbCanopyR), 0.0);
#endif
`;

/**
 * The card is flat, so a building's shadow edge would cross it as a straight line. Each fragment's
 * shadow lookup moves toward the viewer by its depth on the canopy (sphere: radius * normal.z), so
 * edges follow the canopy's volume.
 */
const SHADOW_DEPTH = THREE.ShaderChunk.lights_fragment_begin.replaceAll(
  'vDirectionalShadowCoord[ i ] )',
  '( vDirectionalShadowCoord[ i ] + ( UNROLLED_LOOP_INDEX == 0 ? vBbShadowView * bbDepth : vec4( 0.0 ) ) ) )',
);

const NORMAL = /* glsl */ `
  vec4 bbNa = texture2D(uBbNormal, bbUvA);
  vec4 bbNb = texture2D(uBbNormal, bbUvB);
  vec3 bbUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  vec3 bbA3 = bbNa.xyz * 2.0 - 1.0;
  vec3 bbB3 = bbNb.xyz * 2.0 - 1.0;
  normal = normalize(mix(bbA3.x * vBbRA + bbA3.y * bbUp + bbA3.z * vBbFA, bbB3.x * vBbRB + bbB3.y * bbUp + bbB3.z * vBbFB, vBbBlend));
  float bbAo = mix(bbNa.a, bbNb.a, vBbBlend);
  float bbDepth = clamp(mix(bbA3.z, bbB3.z, vBbBlend), -1.0, 1.0);
`;

/**
 * Foliage lighting on top of the standard BRDF (directLight.color is already shadowed): wrapped
 * diffuse past the terminator of the bent normals, and light transmitted through back-lit leaves.
 */
export const FOLIAGE_DIRECT = /* glsl */ `
#include <lights_physical_pars_fragment>
uniform vec2 uBbFoliage;
void RE_Direct_Banyan( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float nl = dot( geometryNormal, directLight.direction );
  float wrapExtra = saturate( ( nl + uBbFoliage.x ) / ( 1.0 + uBbFoliage.x ) ) - saturate( nl );
  float trans = uBbFoliage.y * saturate( -nl );
  reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( material.diffuseColor ) * ( wrapExtra + trans );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Banyan
`;

/** Baked sky visibility on ambient / direct light, plus street lamps lighting the lower canopy at night. */
const AO = /* glsl */ `
  float bbOccI = mix(1.0, bbAo, uBbAo.x);
  float bbOccD = mix(1.0, bbAo, uBbAo.y);
  reflectedLight.indirectDiffuse *= bbOccI;
  reflectedLight.indirectSpecular *= bbOccI;
  reflectedLight.directDiffuse *= bbOccD;
  reflectedLight.directSpecular *= bbOccD;
  totalEmissiveRadiance += diffuseColor.rgb * uBbLamp * (uNight * uNight) * (1.0 - smoothstep(0.5, 1.0, vBbUv.y)) * bbOccI;
`;

export function replace(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error(`tree impostor: shader chunk ${from} not found`);
  return src.replace(from, to);
}

/** Unit quad x in [-0.5, 0.5], y in [0, 1]; the vertex shader turns it into the billboard. */
function quadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1);
  return g;
}

/**
 * Instanced impostor: one draw call for every instance (plus one in the shadow pass), per-instance
 * position / yaw / uniform scale from instanceMatrix and tint from instanceColor. Lit by the scene
 * lights through the baked normals, fogged by the global height fog.
 */
export function createImpostor(data: ImpostorData, color: THREE.Texture, normal: THREE.Texture, opt: ImpostorOptions): Impostor {
  const k = opt.height / data.height;
  const sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  const shared = {
    uBbFrames: { value: new THREE.Vector4(data.frames, data.cols, data.rows, opt.mipAlphaGain) },
    uBbQuad: { value: new THREE.Vector2(data.quad.size * k, data.quad.bottom * k) },
  };
  const material = new THREE.MeshStandardMaterial({
    map: color,
    alphaTest: opt.alphaTest,
    roughness: opt.roughness,
    metalness: 0,
    side: THREE.FrontSide,
    shadowSide: THREE.DoubleSide,
  });
  material.name = 'banyan-impostor';
  const own = {
    uBbNormal: { value: normal },
    uBbSun: { value: sunDir },
    uBbShadowReach: { value: opt.shadowReach },
    uBbCanopyR: { value: data.canopyRadius * k },
    uBbAo: { value: new THREE.Vector2(opt.aoIndirect, opt.aoDirect) },
    uBbFoliage: { value: new THREE.Vector2(opt.wrap, opt.translucency) },
    uBbLamp: { value: new THREE.Color(opt.lampColor).multiplyScalar(opt.lampGlow) },
    uNight: nightUniform,
  };
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, own);
    let v = `${PARS_VERTEX}uniform vec3 uBbSun;\nuniform float uBbShadowReach;\nuniform float uBbCanopyR;\nvarying vec4 vBbShadowView;\nvarying vec3 vBbFA;\nvarying vec3 vBbRA;\nvarying vec3 vBbFB;\nvarying vec3 vBbRB;\n${sh.vertexShader}`;
    v = replace(v, 'void main() {', `void main() {\n${BILLBOARD}\n${FRAME_BASES}`);
    v = replace(v, '#include <defaultnormal_vertex>', 'vec3 transformedNormal = (viewMatrix * vec4(bbView, 0.0)).xyz;');
    v = replace(v, '#include <project_vertex>', PROJECT);
    v = replace(v, '#include <worldpos_vertex>', 'vec4 worldPosition = vec4(bbPos, 1.0);');
    v = replace(v, '#include <shadowmap_vertex>', SHADOW_RECEIVE);
    sh.vertexShader = v;
    let f = `${PARS_FRAGMENT}uniform sampler2D uBbNormal;\nuniform vec2 uBbAo;\nuniform vec3 uBbLamp;\nuniform float uNight;\nvarying vec4 vBbShadowView;\nvarying vec3 vBbFA;\nvarying vec3 vBbRA;\nvarying vec3 vBbFB;\nvarying vec3 vBbRB;\n${sh.fragmentShader}`;
    f = replace(f, 'void main() {', 'void main() {\n  if (lodDither() < vBbNear) discard;');
    f = replace(f, '#include <map_fragment>', MAP);
    f = replace(f, '#include <normal_fragment_maps>', NORMAL);
    f = replace(f, '#include <aomap_fragment>', AO);
    f = replace(f, '#include <lights_physical_pars_fragment>', FOLIAGE_DIRECT);
    f = replace(f, '#include <lights_fragment_begin>', SHADOW_DEPTH);
    sh.fragmentShader = f;
  };
  material.customProgramCacheKey = () => 'banyan-impostor';

  // three copies map, alphaTest and shadowSide from `material` onto this before each shadow draw.
  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.name = 'banyan-impostor-depth';
  depthMaterial.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    let v = `${PARS_VERTEX}${sh.vertexShader}`;
    v = replace(v, 'void main() {', `void main() {\n${BILLBOARD}`);
    v = replace(v, '#include <project_vertex>', PROJECT);
    sh.vertexShader = v;
    // The near mesh casts the shadow once it is the larger half of the cross-fade.
    const f = replace(`${PARS_FRAGMENT}${sh.fragmentShader}`, 'void main() {', 'void main() {\n  if (vBbNear >= 0.5) discard;');
    sh.fragmentShader = replace(f, '#include <map_fragment>', MAP);
  };
  depthMaterial.customProgramCacheKey = () => 'banyan-impostor-depth';

  const geometry = quadGeometry();
  geometry.addEventListener('dispose', () => {
    material.dispose();
    depthMaterial.dispose();
    color.dispose();
    normal.dispose();
  });
  return { geometry, material, depthMaterial, sunDir };
}

/** Loads banyan.json and its two atlases (colour in sRGB, normal + AO linear). */
export async function loadImpostor(url: string, aniso: number): Promise<{ data: ImpostorData; color: THREE.Texture; normal: THREE.Texture }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = (await res.json()) as ImpostorData;
  const dir = url.slice(0, url.lastIndexOf('/') + 1);
  const loader = new THREE.TextureLoader();
  const [color, normal] = await Promise.all([loader.loadAsync(dir + data.color), loader.loadAsync(dir + data.normal)]);
  color.colorSpace = THREE.SRGBColorSpace;
  normal.colorSpace = THREE.NoColorSpace;
  for (const t of [color, normal]) {
    t.anisotropy = aniso;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
  }
  return { data, color, normal };
}
