/**
 * All tunable parameters. Each subsystem owns its own section; add keys inside
 * your section only.
 */
export const CONFIG = {
  data: {
    routeUrl: 'data/route.json',
    buildingsUrl: 'data/buildings.json',
    carModelUrl: 'models/xiaomi_su7.glb',
  },

  physics: {
    /** Fixed physics rate (Hz). */
    hz: 60,
    /** Sub-steps per fixed step (collision robustness at high speed). */
    substeps: 2,
    /** Longest frame delta we try to simulate (s); avoids spiral of death after tab switch. */
    maxFrameDt: 0.25,
  },

  vehicle: {
    /** Bounding box used for collision (m). */
    length: 5.0,
    width: 2.0,
    height: 1.45,
    wheelbase: 3.0,
    maxSpeedKmh: 180,
    maxReverseKmh: 25,
    /** Peak forward acceleration at standstill (m/s^2); tapers off toward max speed. */
    accel: 9.0,
    /** Throttle taper: a = accel * (1 - (v / vmax)^accelExponent). */
    accelExponent: 2,
    brakeDecel: 13.0,
    reverseAccel: 4.0,
    /** Seconds S must stay held at standstill before the car starts reversing. */
    reverseDelay: 0.2,
    /** Constant rolling resistance (m/s^2) when coasting. */
    rollingDrag: 0.4,
    /** Quadratic aero drag coefficient (1/m): a = k * v^2. */
    airDrag: 0.0006,
    /** Max front wheel angle at low speed / at max speed (rad). */
    steerMaxLow: 0.6,
    steerMaxHigh: 0.012,
    /** Cornering limit (m/s^2) that shapes the steer angle between the two extremes. */
    latAccelMax: 10.5,
    /** Normalized steering slew rates (full lock = 1, units per second). */
    steerRate: 3.5,
    steerReturnRate: 6.0,
  },

  collision: {
    /** Fraction of along-wall speed kept per impact. */
    wallFriction: 0.8,
    /** Extra speed scaling applied on impact, scaled by sin(impact angle). */
    impactSlowdown: 0.5,
    /** Minimum impact speed (m/s) that triggers the thud sound. */
    thudMinSpeed: 4,
    /** Normal speed (m/s) above which a contact counts as a fresh impact (friction applied). */
    impactMinSpeed: 1.5,
    /** Seconds without contact before the next contact counts as a fresh impact. */
    impactCooldown: 0.3,
    /** Deceleration (m/s^2) while scraping along a wall. */
    scrapeDecel: 5,
    /** Max yaw rate (rad/s) turning the car parallel to the wall it slides along. */
    alignRate: 2.5,
    /** Route ends act as walls: s < startMargin or s > length - endMargin. */
    startMargin: 1,
    endMargin: 3,
  },

  car: {
    modelScale: 0.2533,
    paintMaterial: 'Paint1Mtl',
    paintColor: '#1BA3BC',
    paintMetalness: 0.6,
    paintRoughness: 0.35,
    paintClearcoat: 1.0,
    paintClearcoatRoughness: 0.05,
    /** Visual body pitch/roll response (rad per m/s^2). */
    bodyPitchPerAccel: 0.003,
    bodyRollPerLatAccel: 0.004,
    /** Smoothing rate (1/s) of the body pitch/roll. */
    bodyLerp: 6,
  },

  camera: {
    distance: 7.2,
    height: 2.3,
    lookAhead: 8,
    lookHeight: 1.1,
    fovBase: 58,
    fovMax: 72,
    /** Exponential smoothing rates (1/s). */
    yawLerp: 5,
    fovLerp: 3,
    /** Extra distance / height at max speed (m). */
    speedDistance: 1.6,
    speedHeight: -0.2,
    /** Camera pull-back per m/s^2 of longitudinal acceleration (m). */
    accelPull: 0.06,
    near: 0.5,
    /** Large enough to see Ping An Finance Center from the start (skyline guide). */
    far: 15000,
  },

  race: {
    countdownSeconds: 3,
    bestTimeKey: 'shenzhen-drive.best.v1',
    /** Checkpoint is passed when s crosses it while moving forward along the route. */
    minForwardDot: 0.0,
    /** Car center at the start (route coordinates). */
    startS: 6,
    /** Lateral position used for the start and for resets (lane center). */
    laneD: 1.75,
    /** Distance before turn.s0 at which the turn hint appears (m). */
    turnHintDistance: 700,
    /** Seconds of throttle without moving (or pinned to a wall) before the reset hint shows. */
    stuckSeconds: 2,
    toastSeconds: 2.6,
  },

  render: {
    maxPixelRatio: 2,
    exposure: 1.0,
    shadowMapSize: 2048,
    /** Half-size of the shadow camera frustum around the car (m). */
    shadowRange: 80,
    shadowRadius: 3,
    /** Haze color at the eastern (anti-sun) horizon; the fog takes its color from the sky. */
    fogColor: '#3a3550',
    /** Extinction per meter at ground level (height fog, see fogHeightFalloff). */
    fogDensity: 0.00045,
    /** 1/m: fog density falls off as exp(-y * falloff), keeps the skyline readable. */
    fogHeightFalloff: 0.0055,
    bloomIntensity: 0.6,
    bloomThreshold: 0.85,
    bloomSmoothing: 0.3,
    bloomRadius: 0.7,
    /** Compass bearing (0 = north, 270 = west) of the set sun. */
    sunAzimuthDeg: 262,
    /** Elevation of the sun glow in the sky (just below the horizon). */
    skySunElevationDeg: -4,
    /** Elevation of the key light (a fake low sun for shading and shadows). */
    sunLightElevationDeg: 11,
    sunColor: '#ffb07a',
    sunIntensity: 1.1,
    hemiSkyColor: '#6f86c8',
    hemiGroundColor: '#3d3029',
    hemiIntensity: 0.35,
    envIntensity: 1.0,
    skyZenith: '#0b1636',
    skyMid: '#253f7a',
    skyGlow: '#ff7a3c',
    skyGlowHigh: '#ffc890',
    skyBelt: '#7a5a85',
    skyGround: '#14141c',
    vignette: 0.4,
  },

  city: {
    /** Building chunk length along s (m). */
    chunkLength: 250,
    floorHeight: 3.5,
    bayWidth: 1.5,
    litWindowRatio: 0.32,
    /** Near building chunks farther than this from the car are hidden (m). */
    buildingDrawDistance: 5000,
    /** Chunks within this distance (m, along s) cast shadows. */
    buildingShadowDistance: 150,
    /** Gap filler: s step (m) and lateral probe width (m) for missing street wall. */
    buildingFillerStep: 100,
    buildingFillerProbe: 150,
    /** Fog multiplier for skyline landmarks (Ping An, KK100, Lianhuashan). */
    landmarkFogScale: 0.3,
    treeSpacing: 12,
    lampSpacing: 36,
    /** Road surface chunk length along s (m); one draw call per material per chunk. */
    roadChunkLength: 500,
    /** Road chunks farther than this ahead of the car (along s) are hidden (m). */
    roadViewAhead: 2400,
    roadViewBehind: 400,
    /** Instanced trees/shrubs are only uploaded within this window around the car (m). */
    treeViewAhead: 1400,
    lampViewAhead: 2600,
    propViewBehind: 250,
    /** Half width of visual cross streets at intersections (m). */
    crossHalfWidth: 15,
    lampColor: '#ffb469',
    /** HDR multiplier of lamp heads; well above the bloom threshold. */
    lampIntensity: 9,
    lampPoolIntensity: 0.55,
    signEmissive: 0.55,
    billboardCount: 6,
    billboardBrightness: 1.0,
  },

  audio: {
    masterVolume: 0.6,
    /** Motor whine fundamental at a crawl and at refSpeed (Hz). */
    motorHzMin: 150,
    motorHzMax: 1800,
    /** Speed (m/s) mapped to motorHzMax and to full wind/tyre level; 50 m/s = 180 km/h. */
    refSpeed: 50,
    motorGain: 0.1,
    inverterGain: 0.006,
    windGain: 0.2,
    tyreGain: 0.12,
    thudGain: 0.8,
    beepGain: 0.22,
    chimeGain: 0.2,
    /** Minimum seconds between collision thuds (a clearly harder hit still plays). */
    thudMinInterval: 0.18,
    /** Driving-sound level outside the race (menu, countdown, result screen). */
    idleLevel: 0.45,
  },

  debug: {
    /** Enabled with ?debug in the URL. Key 0 teleports this far before the turn (m). */
    turnTeleportOffset: 150,
  },
} as const;

export type Config = typeof CONFIG;

export const KMH = 1 / 3.6;
