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
    brakeDecel: 16.0,
    reverseAccel: 4.0,
    /** Constant rolling resistance (m/s^2) when coasting. */
    rollingDrag: 0.8,
    /** Quadratic aero drag coefficient (1/m): a = k * v^2. */
    airDrag: 0.0012,
    /** Max front wheel angle at low speed / at max speed (rad). */
    steerMaxLow: 0.55,
    steerMaxHigh: 0.06,
    /** Steering wheel slew rates (rad/s). */
    steerRate: 2.2,
    steerReturnRate: 3.0,
  },

  collision: {
    /** Fraction of along-wall speed kept per contact. */
    wallFriction: 0.75,
    /** Extra speed scaling applied on contact, scaled by impact angle. */
    impactSlowdown: 0.5,
    /** Minimum impact speed (m/s) that triggers the thud sound. */
    thudMinSpeed: 4,
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
    bodyPitchPerAccel: 0.004,
    bodyRollPerLatAccel: 0.006,
  },

  camera: {
    distance: 7.2,
    height: 2.3,
    lookAhead: 8,
    lookHeight: 1.1,
    fovBase: 58,
    fovMax: 72,
    /** Exponential smoothing rates (1/s). */
    posLerp: 6,
    yawLerp: 5,
    near: 0.5,
    /** Large enough to see Ping An Finance Center from the start (skyline guide). */
    far: 15000,
  },

  race: {
    countdownSeconds: 3,
    bestTimeKey: 'shenzhen-drive.best.v1',
    /** Checkpoint is passed when s crosses it while moving forward along the route. */
    minForwardDot: 0.0,
  },

  render: {
    maxPixelRatio: 2,
    exposure: 1.0,
    shadowMapSize: 2048,
    /** Half-size of the shadow camera frustum around the car (m). */
    shadowRange: 80,
    fogColor: '#3a3550',
    fogDensity: 0.00055,
    bloomIntensity: 0.6,
    bloomThreshold: 0.85,
  },

  city: {
    /** Building chunk length along s (m). */
    chunkLength: 250,
    floorHeight: 3.5,
    bayWidth: 1.5,
    litWindowRatio: 0.45,
    treeSpacing: 12,
    lampSpacing: 36,
  },

  audio: {
    masterVolume: 0.6,
  },

  debug: {
    /** Enabled with ?debug in the URL. */
    freeCamSpeed: 60,
  },
} as const;

export type Config = typeof CONFIG;

export const KMH = 1 / 3.6;
