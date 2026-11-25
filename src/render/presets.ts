import type { TimeOfDay } from './timeOfDay';

/** Linear HDR color as [sRGB hex, multiplier]. */
export type HdrColor = readonly [string, number];

export interface SkyPreset {
  zenith: HdrColor;
  mid: HdrColor;
  /** Haze at the horizon; distant geometry fades into it. */
  horizon: HdrColor;
  /** Low glow toward the sun azimuth, hugging the horizon. */
  glow: HdrColor;
  glowHigh: HdrColor;
  /** Anti-sun band (belt of Venus). */
  belt: HdrColor;
  /** Below-horizon color (environment reflections of the ground). */
  ground: HdrColor;
  /** Sun halo / Mie lobe / disc color (3D, around the sun direction). */
  halo: HdrColor;
  /** Elevation (sin) where horizon→mid ends, mid→zenith starts and ends. */
  midEnd: number;
  zenStart: number;
  zenEnd: number;
  glowFall: number;
  glowHighFall: number;
  glowNarrowGain: number;
  glowNarrowExp: number;
  beltElev: number;
  beltWidth: number;
  haloExp: number;
  mieGain: number;
  mieExp: number;
  discGain: number;
}

export interface LightingPreset {
  sky: SkyPreset;
  /** Compass bearing of the sun (0 = north, 90 = east, 270 = west). */
  sunAzimuthDeg: number;
  /** Sun elevation used for the sky glow / disc. */
  skySunElevationDeg: number;
  /** Key light elevation (shading and shadows). */
  lightElevationDeg: number;
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  envIntensity: number;
  /** Ground-level extinction per meter of the height fog. */
  fogDensity: number;
  /** 1/m: fog density falls off as exp(-y * falloff). */
  fogHeightFalloff: number;
  exposure: number;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomSmoothing: number;
  /** PCF shadow blur radius (texels). */
  shadowRadius: number;
  vignette: number;
  /** Skyline ring in the environment map (reflected by glass and paint); multiplier 0 hides it. */
  envCity: HdrColor;
  /** Photographed HDRI (CONFIG.render.hdriUrl) on the car's paint, glass and rims (src/render/reflectionEnv.ts); absent = procedural environment. */
  hdri?: { intensity: number };
  /**
   * 0..1: how far the asphalt's sky light (reflection, and 75 % of it for the ambient) is pulled to
   * neutral grey, so a blue sky does not tint the road (src/city/road).
   */
  roadSkyNeutral: number;
}

/**
 * day: hazy subtropical afternoon, sun high in the south-west (behind / beside
 * the car on the eastbound leg). golden: low sun in the west behind the player.
 * dusk: the v0.1 blue-hour look, unchanged.
 */
export const LIGHTING: Record<TimeOfDay, LightingPreset> = {
  day: {
    sky: {
      zenith: ['#2a68c0', 1.0],
      mid: ['#89b3df', 1.0],
      horizon: ['#d8e0e5', 1.06],
      glow: ['#fff1dc', 0.28],
      glowHigh: ['#fff4e6', 0.14],
      belt: ['#000000', 0],
      ground: ['#8a8478', 0.75],
      halo: ['#fff0da', 0.32],
      midEnd: 0.42,
      zenStart: 0.1,
      zenEnd: 1.0,
      glowFall: 6,
      glowHighFall: 2,
      glowNarrowGain: 0.6,
      glowNarrowExp: 16,
      beltElev: 0.12,
      beltWidth: 0.08,
      haloExp: 5,
      mieGain: 5,
      mieExp: 260,
      discGain: 70,
    },
    sunAzimuthDeg: 235,
    skySunElevationDeg: 47,
    lightElevationDeg: 47,
    sunColor: '#ffecd2',
    sunIntensity: 4.2,
    hemiSky: '#cfdcea',
    hemiGround: '#857664',
    hemiIntensity: 0.3,
    envIntensity: 0.85,
    fogDensity: 0.0004,
    fogHeightFalloff: 0.0045,
    exposure: 0.9,
    bloomIntensity: 0.22,
    bloomThreshold: 2.2,
    bloomSmoothing: 0.4,
    shadowRadius: 2,
    vignette: 0.24,
    envCity: ['#5f6a76', 0.34],
    roadSkyNeutral: 0.8,
  },
  golden: {
    sky: {
      zenith: ['#3d5f9c', 0.6],
      mid: ['#a9b5c9', 0.72],
      horizon: ['#e3bf98', 0.88],
      glow: ['#ff9447', 0.95],
      glowHigh: ['#ffc58a', 0.36],
      belt: ['#c8a2b0', 0.12],
      ground: ['#6e5c4c', 0.5],
      halo: ['#ffd5a0', 0.5],
      midEnd: 0.3,
      zenStart: 0.15,
      zenEnd: 0.95,
      glowFall: 7,
      glowHighFall: 2.5,
      glowNarrowGain: 1.2,
      glowNarrowExp: 24,
      beltElev: 0.12,
      beltWidth: 0.09,
      haloExp: 5,
      mieGain: 5,
      mieExp: 220,
      discGain: 30,
    },
    sunAzimuthDeg: 262,
    skySunElevationDeg: 10,
    lightElevationDeg: 10,
    sunColor: '#ffb46e',
    sunIntensity: 2.5,
    hemiSky: '#9cb0d4',
    hemiGround: '#6b5040',
    hemiIntensity: 0.42,
    envIntensity: 1.0,
    fogDensity: 0.0005,
    fogHeightFalloff: 0.0045,
    exposure: 1.0,
    bloomIntensity: 0.45,
    bloomThreshold: 1.3,
    bloomSmoothing: 0.35,
    shadowRadius: 3,
    vignette: 0.32,
    envCity: ['#5c4c44', 0.24],
    hdri: { intensity: 0.6 },
    roadSkyNeutral: 0.15,
  },
  dusk: {
    sky: {
      zenith: ['#0b1636', 0.9],
      mid: ['#253f7a', 0.75],
      horizon: ['#3a3550', 0.9],
      glow: ['#ff7a3c', 0.55],
      glowHigh: ['#ffc890', 0.22],
      belt: ['#7a5a85', 0.16],
      ground: ['#14141c', 1.0],
      halo: ['#000000', 0],
      midEnd: 0.32,
      zenStart: 0.18,
      zenEnd: 0.9,
      glowFall: 11,
      glowHighFall: 3.2,
      glowNarrowGain: 1.6,
      glowNarrowExp: 28,
      beltElev: 0.12,
      beltWidth: 0.08,
      haloExp: 8,
      mieGain: 0,
      mieExp: 1,
      discGain: 0,
    },
    sunAzimuthDeg: 262,
    skySunElevationDeg: -4,
    lightElevationDeg: 11,
    sunColor: '#ffb07a',
    sunIntensity: 1.1,
    hemiSky: '#6f86c8',
    hemiGround: '#3d3029',
    hemiIntensity: 0.35,
    envIntensity: 1.0,
    fogDensity: 0.00045,
    fogHeightFalloff: 0.0055,
    exposure: 1.0,
    bloomIntensity: 0.6,
    bloomThreshold: 0.85,
    bloomSmoothing: 0.3,
    shadowRadius: 3,
    vignette: 0.4,
    envCity: ['#000000', 0],
    roadSkyNeutral: 0,
  },
};
