import * as THREE from 'three';
import { CONFIG } from '../config';

const R = CONFIG.render;

/** Unit vector toward a compass bearing (0 = north = -z, 90 = east = +x) and elevation. */
export function bearingDir(azimuthDeg: number, elevationDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

function glslColor(hex: string, k = 1): string {
  const c = new THREE.Color(hex);
  return `vec3(${(c.r * k).toFixed(5)}, ${(c.g * k).toFixed(5)}, ${(c.b * k).toFixed(5)})`;
}

function glslNum(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/**
 * Analytic blue-hour sky shared by the sky dome, the environment map and the
 * fog (so distant geometry fades into exactly the sky behind it).
 * Values are linear HDR before exposure.
 */
function skyGLSL(): string {
  const sun = bearingDir(R.sunAzimuthDeg, 0);
  return /* glsl */ `
const vec3 SD_ZENITH = ${glslColor(R.skyZenith, 0.9)};
const vec3 SD_MID = ${glslColor(R.skyMid, 0.75)};
const vec3 SD_HOR = ${glslColor(R.fogColor, 0.9)};
const vec3 SD_GLOW = ${glslColor(R.skyGlow, 0.55)};
const vec3 SD_GLOW_HI = ${glslColor(R.skyGlowHigh, 0.22)};
const vec3 SD_BELT = ${glslColor(R.skyBelt, 0.16)};
const vec3 SD_GROUND = ${glslColor(R.skyGround, 1.0)};
const vec2 SD_SUN_H = vec2(${glslNum(sun.x)}, ${glslNum(sun.z)});
const float SD_FOG_FALLOFF = ${glslNum(R.fogHeightFalloff)};

vec3 sdSky(vec3 dir) {
  float e = dir.y;
  float eh = max(e, 0.0);
  vec2 hd = dir.xz / max(length(dir.xz), 1e-4);
  float toSun = dot(hd, SD_SUN_H) * 0.5 + 0.5;
  vec3 col = mix(SD_HOR, SD_MID, smoothstep(0.0, 0.32, eh));
  col = mix(col, SD_ZENITH, smoothstep(0.18, 0.9, eh));
  float glowA = toSun * toSun * toSun * toSun;
  float glowN = pow(toSun, 28.0);
  col += SD_GLOW * glowA * exp(-eh * 11.0);
  col += SD_GLOW_HI * glowA * exp(-eh * 3.2);
  col += SD_GLOW * glowN * exp(-eh * 26.0) * 1.6;
  float anti = 1.0 - toSun;
  float belt = exp(-pow((eh - 0.12) / 0.08, 2.0)) * anti * anti;
  col += SD_BELT * belt;
  col = mix(col, SD_GROUND, smoothstep(0.0, -0.12, e));
  return col;
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
    float sdY0 = max(cameraPosition.y, 0.0);
    float sdDy = sdRay.y * SD_FOG_FALLOFF;
    float sdA = exp(-sdY0 * SD_FOG_FALLOFF);
    float sdH = abs(sdDy) > 1e-4 ? sdA * (1.0 - exp(-sdDy)) / sdDy : sdA;
    float fogFactor = 1.0 - exp(-fogDensity * sdDist * sdH);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, sdDist);
  #endif
  #ifdef FOG_SCALE
    fogFactor *= FOG_SCALE;
  #endif
  vec3 sdDir = sdRay / max(sdDist, 1e-4);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, sdSky(vec3(sdDir.x, max(sdDir.y, 0.0), sdDir.z)), fogFactor);
}
#endif
`;
}

export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'BlueHourSky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
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
      ${skyGLSL()}
      void main() {
        gl_FragColor = vec4(sdSky(normalize(vDir)), 1.0);
      }
    `,
  });
}
