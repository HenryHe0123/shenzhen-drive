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
    /**
     * Wheel angle ∝ |steer|^steerExpo (1 = linear): > 1 softens short taps, full lock unchanged. Kept linear:
     * in scripted keyboard runs 1.15–1.5 made small corrections at 300 km/h too weak (the slew ramp already softens taps there).
     */
    steerExpo: 1.0,
    /**
     * Straight-line stability: after a short key press the car counter-steers by itself to give back
     * this share of the heading the press added, so a tap moves the car sideways instead of leaving it
     * pointed off-line. Uses only the car's own heading history, never the road (0 = off). Higher values
     * also give back part of small heading corrections (at 300 km/h, 0.6+ made lane holding harder).
     */
    recenter: 0.5,
    /** Presses up to recenterTapTime (s) get the full share, fading to none at recenterHoldTime (a deliberate turn keeps its heading). */
    recenterTapTime: 0.2,
    recenterHoldTime: 0.5,
    /**
     * Presses less than this many seconds apart (either direction) form one manoeuvre: press time adds up
     * (rhythmic tapping through a curve keeps its heading) and a counter-steer cancels heading rather than being given back.
     */
    recenterChainTime: 0.4,
    /** Speed band (km/h) over which the give-back fades in; off when crawling and reversing. */
    recenterFromKmh: 40,
    recenterFullKmh: 90,
    /** Time constant of the give-back (s), the smoothing of its counter-steer (s, at most a quarter of the former: no overshoot). */
    recenterTime: 0.4,
    recenterSmoothing: 0.1,
    /** Largest heading (rad) the give-back may still owe, and its largest counter-steer as a fraction of full lock. */
    recenterMaxAngle: 0.1,
    recenterMaxSteer: 0.4,
    /** Visual only: the body turns this far into the turn per m/s^2 of lateral acceleration (rad), a hint of tyre slip. */
    visualSlipPerLatAccel: 0.0035,
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
    /** Yaw smoothing at top speed, blended in with (v / vmax)^2: small heading corrections don't swing the view. */
    yawLerpHigh: 2.5,
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

  hud: {
    /** Top-left minimap (src/hud/Minimap.ts), north-up in both modes. */
    minimap: {
      /** Canvas size (CSS px); the panel header with section / checkpoints sits above it. */
      width: 300,
      height: 104,
      maxRedrawHz: 30,
      /** Local mode: meters across the panel width, and how far the view leads the car (m). */
      localSpan: 1200,
      localLookAhead: 130,
      /** Without a manual choice (N), local mode turns on this far before the first turn (m). */
      autoLocalBeforeTurn: 400,
      /** Landmark ids from route.json with their short map labels and label side (overview / local). */
      landmarks: [
        { id: 'eiffel', label: '世界之窗', side: 'below', localSide: 'below' },
        { id: 'pingan', label: '平安金融中心', side: 'below', localSide: 'left' },
        { id: 'civic_center', label: '市民中心', side: 'above', localSide: 'above' },
      ],
    },
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
    /** Street banyans: impostor atlas baked by scripts/bake_banyan_impostor.mjs (relative to BASE_URL). */
    treeImpostorUrl: 'textures/trees/banyan.json',
    /** Banyan height (m) at instance scale 1; placed banyans end up ≈ 10–14.5 m (深南大道: ~10–16 m). */
    treeBanyanHeight: 10.5,
    /** Top fraction of a view-corridor landmark (route clearZones) that banyans on its sight lines leave visible. */
    treeSightKeep: 0.2,
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
    /** Emission of the GB 5768 road sign plates at full night (retro-reflective, none by day). */
    roadSignNightGlow: 0.3,
    billboardCount: 6,
    billboardBrightness: 1.0,
    /** Billboard face width (m); height is width / 3 to match the atlas slots. */
    billboardWidth: 16,
    /** Height of the billboard's bottom edge, above the street-tree canopy (m). */
    billboardBottom: 11,
    /** Yaw of the billboard face toward oncoming traffic (degrees). */
    billboardAngleDeg: 26,
  },

  /** Real-building models (src/city/models); shadows use city.buildingShadowDistance, far fog city.landmarkFogScale. */
  cityModels: {
    /** GLB downloads in flight at once; nearest to the car first. */
    maxConcurrentLoads: 3,
    /** Models at least this tall stay visible at any distance (skyline guides, m); others use city.buildingDrawDistance. */
    skylineHeight: 300,
    /** Role 'skyline' and models at least this tall get the thinned landmark fog (m). */
    fogScaleHeight: 350,
    /** Draw calls per model (spec 7.4): ordinary buildings / landmarks; more materials are atlased at load. */
    drawCallsBuilding: 2,
    drawCallsLandmark: 8,
    /** Runtime atlas size and per-texture cap (px), ordinary buildings / landmarks (pipeline caps: 512 / 1024). */
    atlasMaxBuilding: 512,
    atlasMaxLandmark: 1024,
    atlasTileBuilding: 512,
    atlasTileLandmark: 1024,
    /** Photo facades by day: saturation and contrast (1 = photo as is). */
    photoSaturation: 0.8,
    photoContrast: 0.85,
    /** Photo albedo at full night (multiplier and cool tint). */
    photoNightDim: 0.35,
    photoNightTint: '#cfdcff',
    /** Lit window ratio of photo facades (procedural facades use city.litWindowRatio). */
    photoLitRatio: 0.32,
    /** Strength of the mullion lines drawn over blurry photos up close (0 = off). */
    photoDetail: 0.25,
    /** Unsharp-mask amount on magnified photos (0 = off). */
    photoSharpen: 0.35,
    /** Night accents as HDR multipliers: LED strips (SZSE podium, Civic Center roof edge) and the crown floodlight wash. */
    accentStripIntensity: 3.2,
    accentWashIntensity: 0.6,
  },

  /** APEC facade LED screens on real buildings (src/city/screens); one per s-window, picked from the data. */
  screens: {
    textureUrl: 'textures/ai/facade_apec_01.jpg',
    windows: [
      { name: 'apec-sign', s0: 5800, s1: 6400, side: 'left' },
      { name: 'shennan-futian', s0: 7600, s1: 8800 },
      { name: 'cbd-loop', s0: 9960, s1: 11680 },
    ],
    /** Preferred / smallest width (m); 9:16 portrait, so 20 m wide is 35.6 m tall. */
    width: 20,
    minWidth: 16,
    /** Preferred / lowest bottom edge (m), above the street and median trees. */
    bottom: 22,
    minBottom: 15,
    roofGap: 3,
    /** Wall run kept free beside the screen (m). */
    edgeMargin: 1.5,
    minHeight: 55,
    /** Wall distance from the centerline of the carriageway on its side (the opposite one on the left, m). */
    minDist: 25,
    maxDist: 90,
    /** Wall normal within this angle of the direction to the road; preferred tilt toward oncoming traffic (deg). */
    maxFacingDeg: 30,
    preferFacingDeg: 12,
    /** Sight lines from these distances before the screen (m) must mostly reach it. */
    viewBack: [260, 170, 90],
    /** Screen face / frame front distance from the wall, frame border (m). */
    offset: 0.42,
    frameFront: 0.3,
    border: 0.6,
    /** Color multiplier per time-of-day preset (dusk blooms: threshold 0.85). */
    brightness: { day: 1.1, golden: 1.3, dusk: 1.7 },
    /** LED pitch (m) and depth of the pixel-grid shading, faded out once a cell is under ~1.5 px. */
    ledPitch: 0.125,
    ledGrid: 0.22,
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
