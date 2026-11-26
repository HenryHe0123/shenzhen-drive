import * as THREE from 'three';
import { LIGHTING, type HdrColor, type LightingPreset } from './presets';
import { getTimeOfDay } from './timeOfDay';

/** Unit vector toward a compass bearing (0 = north = -z, 90 = east = +x) and elevation. */
export function bearingDir(azimuthDeg: number, elevationDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const SKY_VEC4 = 12;

/**
 * Sky parameters as vec4[SKY_VEC4], shared by reference with every fogged
 * material (three copies non-three uniform values by reference), so a preset
 * switch is a buffer write instead of a shader recompile.
 */
export const skyParams = new Float32Array(SKY_VEC4 * 4);

/** Extinction per metre of distance-only haze on top of the height fog (0 in the game; the aerial explore view raises it). */
let aerialHaze = 0;

export function setAerialHaze(perMeter: number): void {
  aerialHaze = perMeter;
  skyParams[44] = perMeter;
}

const tmpColor = new THREE.Color();
const tmpDir = new THREE.Vector3();

function packSky(p: LightingPreset, out: Float32Array): Float32Array {
  const s = p.sky;
  const put = (i: number, c: HdrColor, w: number) => {
    tmpColor.set(c[0]);
    out[i * 4] = tmpColor.r * c[1];
    out[i * 4 + 1] = tmpColor.g * c[1];
    out[i * 4 + 2] = tmpColor.b * c[1];
    out[i * 4 + 3] = w;
  };
  put(0, s.zenith, 1);
  put(1, s.mid, s.midEnd);
  put(2, s.horizon, s.zenStart);
  put(3, s.glow, s.glowFall);
  put(4, s.glowHigh, s.glowHighFall);
  put(5, s.belt, s.glowNarrowGain);
  put(6, s.ground, p.fogHeightFalloff);
  bearingDir(p.sunAzimuthDeg, p.skySunElevationDeg, tmpDir);
  out.set([tmpDir.x, tmpDir.y, tmpDir.z, s.discGain], 28);
  put(8, s.halo, s.haloExp);
  bearingDir(p.sunAzimuthDeg, 0, tmpDir);
  out.set([tmpDir.x, tmpDir.z, s.mieGain, s.mieExp], 36);
  out.set([s.zenEnd, s.glowNarrowExp, s.beltElev, s.beltWidth], 40);
  out.set([aerialHaze, 0, 0, 0], 44);
  return out;
}

export function setSkyParams(p: LightingPreset): void {
  packSky(p, skyParams);
}

function glslNum(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/**
 * Analytic sky shared by the sky dome, the environment map and the fog (so
 * distant geometry fades into exactly the sky behind it). Linear HDR before
 * exposure. Materials missing the uniform (sdSkyP[0].w == 0) fall back to the
 * preset that was active when the shaders were generated.
 */
function skyGLSL(): string {
  const def = packSky(LIGHTING[getTimeOfDay()], new Float32Array(SKY_VEC4 * 4));
  const vecs: string[] = [];
  for (let i = 0; i < SKY_VEC4; i++) {
    vecs.push(`vec4(${Array.from(def.subarray(i * 4, i * 4 + 4), glslNum).join(', ')})`);
  }
  return /* glsl */ `
uniform vec4 sdSkyP[${SKY_VEC4}];
const vec4 SD_DEF[${SKY_VEC4}] = vec4[${SKY_VEC4}](${vecs.join(', ')});
vec4 sdP(int i) { return sdSkyP[0].w > 0.5 ? sdSkyP[i] : SD_DEF[i]; }

vec3 sdSky(vec3 dir, float discK) {
  vec4 p0 = sdP(0), p1 = sdP(1), p2 = sdP(2), p3 = sdP(3), p4 = sdP(4), p5 = sdP(5);
  vec4 p6 = sdP(6), p7 = sdP(7), p8 = sdP(8), p9 = sdP(9), p10 = sdP(10);
  float e = dir.y;
  float eh = max(e, 0.0);
  vec2 hd = dir.xz / max(length(dir.xz), 1e-4);
  float toSun = clamp(dot(hd, p9.xy) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(p2.rgb, p1.rgb, smoothstep(0.0, p1.w, eh));
  col = mix(col, p0.rgb, smoothstep(p2.w, p10.x, eh));
  float t2 = toSun * toSun;
  float glowA = t2 * t2;
  float glowN = pow(toSun, p10.y);
  col += p3.rgb * glowA * exp(-eh * p3.w);
  col += p4.rgb * glowA * exp(-eh * p4.w);
  col += p3.rgb * glowN * exp(-eh * 26.0) * p5.w;
  float anti = 1.0 - toSun;
  float bz = (eh - p10.z) / p10.w;
  float belt = exp(-bz * bz) * anti * anti;
  col += p5.rgb * belt;
  float mu = clamp(dot(dir, p7.xyz), 0.0, 1.0);
  col += p8.rgb * (pow(mu, p8.w) + p9.z * pow(mu, p9.w));
  col += p8.rgb * (p7.w * discK) * smoothstep(0.99990, 0.99996, mu);
  col = mix(col, p6.rgb, 1.0 - smoothstep(-0.12, 0.0, e));
  return max(col, vec3(0.0));
}
`;
}

let fogInstalled = false;

/**
 * Replaces three's fog chunks globally: exponential height fog whose color is
 * the sky color in the view direction. Materials can thin it with
 * `defines.FOG_SCALE` (e.g. skyline landmarks). Must run before the first
 * render so every program compiles with it.
 */
export function installSkyFog(): void {
  if (fogInstalled) return;
  fogInstalled = true;
  setSkyParams(LIGHTING[getTimeOfDay()]);
  // Every built-in shader with fog uniforms, plus ShaderMaterials that merge UniformsLib.fog.
  const libs = THREE.ShaderLib as unknown as Record<string, { uniforms?: Record<string, THREE.IUniform> }>;
  for (const lib of Object.values(libs)) {
    if (lib.uniforms && 'fogDensity' in lib.uniforms) lib.uniforms.sdSkyP = { value: skyParams };
  }
  (THREE.UniformsLib.fog as Record<string, THREE.IUniform>).sdSkyP = { value: skyParams };

  const chunk = THREE.ShaderChunk as unknown as Record<string, string>;
  chunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogView;
#endif
`;
  chunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogView = mvPosition.xyz;
#endif
`;
  chunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${skyGLSL()}
#endif
`;
  chunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
{
  vec3 sdRay = (vec4(vFogView, 0.0) * viewMatrix).xyz;
  float sdDist = length(sdRay);
  #ifdef FOG_EXP2
    float sdFall = sdP(6).w;
    float sdY0 = max(cameraPosition.y, 0.0);
    float sdDy = sdRay.y * sdFall;
    float sdA = exp(-sdY0 * sdFall);
    float sdH = abs(sdDy) > 1e-4 ? sdA * (1.0 - exp(-sdDy)) / sdDy : sdA;
    float fogFactor = 1.0 - exp(-fogDensity * sdDist * sdH);
    fogFactor = max(fogFactor, 1.0 - exp(-sdDist * sdP(11).x));
  #else
    float fogFactor = smoothstep(fogNear, fogFar, sdDist);
  #endif
  #ifdef FOG_SCALE
    fogFactor *= FOG_SCALE;
  #endif
  vec3 sdDir = sdRay / max(sdDist, 1e-4);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, sdSky(vec3(sdDir.x, max(sdDir.y, 0.0), sdDir.z), 0.0), fogFactor);
}
#endif
`;
}

/** Sky dome / environment material; discGain scales the sun disc (0 keeps it out of the env map). */
export function createSkyMaterial(discGain = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'Sky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sdSkyP: { value: skyParams }, uDisc: { value: discGain } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uDisc;
      ${skyGLSL()}
      void main() {
        gl_FragColor = vec4(sdSky(normalize(vDir), uDisc), 1.0);
      }
    `,
  });
}
