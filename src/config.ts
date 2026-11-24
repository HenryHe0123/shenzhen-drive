/**
 * All tunable parameters. Each subsystem owns its own section; add keys inside
 * your section only.
 */
export const CONFIG = {
  data: {
    routeUrl: 'data/route.json',
    buildingsUrl: 'data/buildings.json',
    cityModelsUrl: 'data/city_models.json',
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
    /** Electronically limited top speed (SU7 Ultra). */
    maxSpeedKmh: 350,
    maxReverseKmh: 25,
    /**
     * Drive acceleration (m/s^2) = min(accel, power / v) minus drag: traction-limited
     * launch, then constant power. 0-100 ≈ 2.3 s, 0-200 ≈ 5.7 s, 0-300 ≈ 13.3 s, 350 ≈ 22 s.
     */
    accel: 12.5,
    /** Drive power per unit mass (W/kg = m^2/s^3). */
    power: 380,
    brakeDecel: 15.0,
    reverseAccel: 4.0,
    /** Seconds S must stay held at standstill before the car starts reversing. */
    reverseDelay: 0.2,
    /** Rolling resistance (m/s^2), acts in every state. */
    rollingDrag: 0.3,
    /** Quadratic aero drag coefficient (1/m): a = k * v^2; coasting ≈ 0.5 m/s^2 at 100 km/h, 3 m/s^2 at 350. */
    airDrag: 0.00028,
    /** Max front wheel angle at low speed (rad). */
    steerMaxLow: 0.6,
    /** Cornering limit (m/s^2) at low speed (≈ 1.07 g); full steering reaches exactly this. */
    latAccelMax: 10.5,
    /** Grip lost toward top speed: limit = latAccelMax - loss * (v / vmax)^2 (≈ 0.87 g at 350 km/h). */
    latAccelHighSpeedLoss: 2.0,
    /** Normalized steering slew rates (full lock = 1, units per second); steerRate fades to steerRateHigh at top speed. */
    steerRate: 3.5,
    steerRateHigh: 1.8,
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
    /** Visual body pitch/roll response (rad per m/s^2); the wheels move with the body (tight arches). */
    bodyPitchPerAccel: 0.0018,
    bodyRollPerLatAccel: 0.0035,
    /** Smoothing rate (1/s) of the body pitch/roll. */
    bodyLerp: 6,
    /** GLB wheel materials, each merging that part of all four wheels; split per wheel at load. */
    tireTreadMaterial: 'Mesh1Mtl',
    tireSidewallMaterial: 'Mesh4Mtl',
    rimMaterial: 'Mesh3Mtl',
    brakeDiscMaterial: 'Mesh2Mtl',
    /** Rolling radius (m): wheel spin angle = distance / radius. */
    tireRadius: 0.36,
    /**
     * Wheels moved outward (m per side), an Ultra-like wider stance: straight from behind the
     * GLB body hides the tyres almost completely; this lets their shoulders show.
     */
    wheelTrackOffset: 0,
    /** The GLB tyre textures are near black (albedo ≈ 0.01); scaled to dark grey rubber. */
    tireAlbedoScale: 3.2,
    tireRoughness: 0.85,
    rimMetalness: 1.0,
    rimRoughness: 0.3,
    /** Visual front wheel angle = steer * clamp(physical steer limit, min, max) (rad). */
    wheelSteerMin: 0.12,
    wheelSteerMax: 0.45,
    /** Tail light material (shared with some red interior trim) and its emissive gain while braking. */
    tailLightMaterial: 'Mesh19Mtl',
    brakeLightGain: 3,
  },

  camera: {
    /** A little lower than v0.1 so the tyres show beside and under the rear bumper. */
    distance: 6.8,
    height: 1.8,
    lookAhead: 9,
    lookHeight: 0.9,
    /** Vertical FOV (deg) at rest and at max speed; grows with (v / vmax)^1.5. */
    fovBase: 58,
    fovMax: 80,
    /** Exponential smoothing rates (1/s); the yaw lag shows the car's flank (and wheels) in turns. */
    yawLerp: 4,
    fovLerp: 3,
    /** Extra distance / height at max speed (m); slightly closer to offset the wide FOV. */
    speedDistance: -0.3,
    speedHeight: -0.1,
    /** Camera pull-back per m/s^2 of longitudinal acceleration (m). */
    accelPull: 0.06,
    /** Tiny vertical vibration (m) reached at max speed, starting at vibrationFromKmh. */
    vibration: 0.012,
    vibrationFromKmh: 250,
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
    /** Initial exposure; each time-of-day preset sets its own (src/render/presets.ts). */
    exposure: 1.0,
    shadowMapSize: 2048,
    /** Half-size of the shadow camera frustum around the car (m). */
    shadowRange: 80,
    /** Sky, sun, fog, exposure, bloom and shadow softness per preset live in src/render/presets.ts. */
    bloomIntensity: 0.6,
    bloomThreshold: 0.85,
    bloomSmoothing: 0.3,
    bloomRadius: 0.7,
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
    landmarkFogScale: 0.2,
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
    /** Billboard face width (m); height is width / 3 to match the atlas slots. */
    billboardWidth: 16,
    /** Height of the billboard's bottom edge, above the street-tree canopy (m). */
    billboardBottom: 11,
    /** Yaw of the billboard face toward oncoming traffic (degrees). */
    billboardAngleDeg: 26,
  },

  audio: {
    masterVolume: 0.6,
    /** Motor whine fundamental at a crawl and at refSpeed (Hz), linear in speed (single-ratio drive). */
    motorHzMin: 150,
    motorHzMax: 1750,
    /** Speed (m/s) mapped to motorHzMax and to full wind/tyre level; 97.2 m/s = 350 km/h. */
    refSpeed: 97.2,
    motorGain: 0.1,
    inverterGain: 0.006,
    /** Wind level = windGain * (v / refSpeed)^windExponent: quiet in town, a full rush at 350 km/h. */
    windGain: 0.22,
    windExponent: 1.6,
    /** Tyre level = tyreGain * (v / refSpeed)^tyreExponent. */
    tyreGain: 0.12,
    tyreExponent: 0.7,
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
