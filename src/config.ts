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
    /**
     * Impact tiers by the normal speed into the wall (km/h), not the car speed: a 300 km/h graze
     * at 3° is ~16 km/h. Below lightKmh a scrape (no sound, not counted); light: counted, no
     * after-effect; heavy: damage; severe: the car stops dead, then damage.
     */
    lightKmh: 15,
    heavyKmh: 50,
    severeKmh: 100,
    /**
     * Damage: power and top speed drop by damageLoss and recover linearly over damageSeconds, both
     * interpolated from the heavy to the severe threshold. A weaker hit does not shorten a
     * recovery in progress.
     */
    damageLoss: [0.3, 0.5],
    damageSeconds: [4, 8],
    /** Severe impact: seconds the car cannot be driven before the recovery starts. */
    stallSeconds: 2,
    /** Normal speed (m/s) above which a contact counts as a fresh impact (friction applied). */
    impactMinSpeed: 1.5,
    /** Seconds without contact before the next contact counts as a fresh impact. */
    impactCooldown: 0.3,
    /**
     * Deceleration while pressing into a wall: scrapeDecel + scrapeDrag * speed (m/s^2). The speed
     * term outgrows the drive at speed, so riding a wall settles near 100 km/h instead of gaining.
     */
    scrapeDecel: 5,
    scrapeDrag: 0.25,
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
    /**
     * Steering wheel, cut out of the GLB dashboard meshes at load so it can turn: triangles of
     * these materials whose centroid lies within the cylinder (body space, m; axis points forward
     * down the column, fitted to the rim vertices).
     */
    steeringWheel: {
      materials: ['Mesh13Mtl', 'Mesh16Mtl'],
      center: [-0.415, 0.875, -0.423],
      axis: [0.002, -0.342, -0.94],
      radius: 0.2,
      axialMin: -0.06,
      axialMax: 0.07,
      /** Steering wheel angle / visual front wheel angle: about 55° at full input at speed, 200° parked. */
      ratio: 8,
    },
    /** Tail light material (shared with some red interior trim) and its emissive gain while braking. */
    tailLightMaterial: 'Mesh19Mtl',
    brakeLightGain: 3,
    /** Tinted window glass and the glossy black glass roof / windscreen backing. */
    glassMaterials: ['Mesh26Mtl', 'Mesh72Mtl'],
    /** Window glass (blended, mirror-like): GLB opacity 0.5 and green tint lightened for the cockpit view. */
    windowGlassMaterial: 'Mesh26Mtl',
    windowGlassOpacity: 0.25,
    /** Share of the GLB green tint kept (0 = neutral, 1 = original). */
    windowGlassTint: 0.5,
    /** HDRI reflection strength (× the preset's hdri.intensity) of paint, glass and rims. */
    hdriPaintGain: 1.0,
    hdriGlassGain: 0.7,
    hdriRimGain: 1.0,
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
    /** Shake (m) after a heavy impact at full strength (severe), decaying at joltDecay (1/s). */
    jolt: 0.35,
    joltDecay: 4,
    near: 0.5,
    /** The horizon mountains (梧桐山 ~28 km from the start, 大帽山 ~30 km); depth stays precise with reversed-Z float depth. */
    far: 60000,
  },

  /** First-person view from the driver's seat (left-hand drive). */
  cockpit: {
    /**
     * Eye point in car body space (m): +X right, +Y up from the road, -Z forward, origin at the
     * car center. Centered on the steering wheel, just in front of the GLB driver's headrest
     * (front face z ≈ 0.11).
     */
    eyeX: -0.39,
    eyeY: 1.18,
    eyeZ: -0.03,
    /** Downward tilt of the gaze (rad): wheel, cluster and center screen in the lower third. */
    pitch: -0.1,
    fovBase: 66,
    fovMax: 76,
    /** Head turn into the steering direction at full lock (rad), faded in with speed up to lookIntoFullKmh. */
    lookInto: 0.1,
    lookIntoFullKmh: 60,
    lookLerp: 4,
    /** Head lag against longitudinal / lateral acceleration (m per m/s^2), clamped to maxLean. */
    leanPerAccel: 0.004,
    maxLean: 0.04,
    vibration: 0.004,
    /** Head shake (m) after a heavy impact at full strength; decays at camera.joltDecay. */
    jolt: 0.05,
    /** Below the headliner / A-pillar distance (~0.2 m) but no closer, to keep distant depth precision. */
    near: 0.1,
  },

  race: {
    countdownSeconds: 3,
    /** Best score (time + penalties). v1: times on the 12.3 km cut route (until v0.3.2); v2: raw times without penalties (v0.4.0–v0.4.1). */
    bestTimeKey: 'shenzhen-drive.best.v3',
    /** Penalty (s) per heavy / severe wall impact, added to the time for the final score. */
    penaltyHeavy: 5,
    penaltySevere: 10,
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
    /** Pixel ratio cap for the default 'standard' quality preset (cuts Retina fragment load ~2.5x). */
    standardPixelRatio: 1.25,
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
    /**
     * Car reflections in presets with `hdri` (golden): Poly Haven shanghai_riverside, 1k, made by
     * scripts/process_env_and_signs.mjs (which prints the sun's equirect u). The photo's sky is a
     * cool blue; the tint warms it toward the generated sunset sky. Luminance is capped again at load.
     */
    hdriUrl: 'textures/env/shanghai_riverside_1k.hdr',
    hdriSunU: 0.6003,
    hdriTint: '#ffe2c4',
    hdriMaxLuminance: 24,
    /** Below-horizon multiplier: the photo's pale plaza → the game's darker asphalt. */
    hdriGroundScale: 0.3,
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
    /**
     * Procedural blocks filling street-wall gaps. Off when buildings.json is loaded (real open land stays
     * open); always used for the procedural fallback city without data.
     */
    buildingFiller: false,
    /** Gap filler: s step (m) and lateral probe width (m) for missing street wall. */
    buildingFillerStep: 100,
    buildingFillerProbe: 150,
    /** Fog multiplier for skyline landmarks (Ping An, KK100, Lianhuashan); 1 = same fog as every other building. */
    landmarkFogScale: 1,
    treeSpacing: 12,
    /** Street banyans: impostor atlas baked by scripts/bake_banyan_impostor.mjs (relative to BASE_URL). */
    treeImpostorUrl: 'textures/trees/banyan.json',
    /** Near-LOD banyan mesh (scripts/bake_banyan_near.mjs) drawn for the trees nearest the camera. */
    treeNearUrl: 'models/trees/banyan_near.glb',
    /** At most this many near meshes; all mesh within treeNearFull (m), dithered into impostors by treeNearFar. */
    treeNearCount: 24,
    treeNearFull: 28,
    treeNearFar: 38,
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
    /** Side-street closures (props/closures.ts): barrier pitch along the mouth (m), upload window ahead (m). */
    closureBarrierPitch: 1.55,
    closureViewAhead: 1400,
    /** No-entry sign planter: distance behind the barrier line (m) and turn toward approaching traffic (deg). */
    closureSignSetback: 1.0,
    closureSignAngleDeg: 35,
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

  /** Whole-city scenery beyond the corridor (src/city/metro, public/data/metro from scripts/build_metro_data.py). */
  metro: {
    /** Terrain quadtree: levels above the 3.84 km leaves; a node splits while the camera is nearer than terrainSplit x its size. */
    terrainLevels: 5,
    terrainSplit: 1.7,
    /** Strength of the sub-texel albedo variation near the camera (the imagery is 24 m per pixel). */
    terrainDetail: 0.18,
    waterRoughness: 0.12,
    /** Sky reflection strength of the water (environment map intensity). */
    waterEnv: 0.7,
    /** Albedo of the turbid Pearl River estuary / Shenzhen Bay and of reservoirs (sRGB). */
    seaColor: '#2c4448',
    lakeColor: '#2a3d35',
    /** Beyond the data window: a plane of this size (m) at sea level, sea to the south, distant land (sRGB) to the north. */
    farPlane: 400000,
    farLandColor: '#5b6553',
    /** Camera distance (m) within which 2 km detail tiles (footprints) and 8 km mass tiles (boxes) are loaded; unloaded unloadSlack m further out. */
    detailRadius: 2400,
    massRadius: 14000,
    /** Tighter racing-mode radii for the default 'standard' quality preset (skyline >= 60 m remains city-wide). */
    standardDetailRadius: 1600,
    standardMassRadius: 9000,
    standardRoadRadiusScale: 1.2,
    standardMassCull: 0.006,
    /** explore.html: wider radii for aerial views, and thinner haze than the game's presets (share of their fog density). */
    exploreDetailRadius: 3600,
    exploreMassRadius: 22000,
    exploreRoadScale: 2.2,
    exploreFog: 0.6,
    /** Distance-only haze per metre at full altitude (explore view above ~4 km). */
    exploreAerialHaze: 1 / 200000,
    unloadSlack: 600,
    /** Road / rail tiles load within detailRadius x roadRadiusScale. */
    roadRadiusScale: 1.4,
    maxDetailLoads: 3,
    maxMassLoads: 2,
    buildWorkers: 2,
    /** Mass boxes whose size (max of height and footprint) is below this share of their distance are dropped. */
    massCull: 0.004,
  },

  /** Real-building models (src/city/models); shadows use city.buildingShadowDistance, far fog city.landmarkFogScale. */
  cityModels: {
    /** GLB downloads in flight at once; nearest to the car first. */
    maxConcurrentLoads: 3,
    /** Models at least this tall stay visible at any distance (skyline guides, m); others use city.buildingDrawDistance. */
    skylineHeight: 300,
    /** Role 'skyline' and models at least this tall get the thinned fog farFogScale and the far tone (m). */
    fogScaleHeight: 350,
    /** Fog multiplier of those clean-geometry skyline towers (Ping An); photo models use city.landmarkFogScale. 1 = normal fog. */
    farFogScale: 1,
    /** Distance (m) over which their facade darkens, and the specular / diffuse reduction reached. */
    farTone: { near: 1200, far: 5000, spec: 0.6, diffuse: 0.45 },
    /**
     * Civic Center glass halls below `height` (m): mullion spacing, transom heights (m), daylit
     * lobby glow (linear emission, off at night) and minimum glass reflectance.
     */
    civicLobby: { height: 14, bay: 1.5, transom: 3.6, transom2: 7.4, interior: [0.075, 0.068, 0.056], reflectance: 0.16 },
    /**
     * Civic Center roof underside (downward faces): coffer grid (m), light metal tone, and the
     * sunlit plaza's bounce per preset as [sRGB, multiplier] (added as emission on the soffit).
     */
    soffit: {
      grid: 3.0,
      tone: '#b8b4ac',
      bounce: { day: ['#efe4d2', 0.32], golden: ['#ffc58e', 0.26], dusk: ['#000000', 0] },
    },
    /** Draw-call budget per model: ordinary buildings / landmarks; more materials are atlased at load. */
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

  /**
   * APEC China 2026 roadside LED screens (src/city/screens): free-standing, facing approaching
   * traffic above the tree canopy, one per s-window, placed from the data (pylons.ts).
   */
  screens: {
    /** Art composited on the left of the face (the slogan is drawn at runtime). */
    textureUrl: 'textures/ai/facade_apec_01.jpg',
    /**
     * Sides tried in order; the median is too narrow for a face that spans ~26 m across the road.
     * The APEC-sign window (竹子林) ends at s 7500 because further on the right side lies in the
     * Ping An sight-line zone and the far side is behind the median trees.
     */
    windows: [
      { name: 'apec-sign', s0: 7250, s1: 7500, sides: ['right', 'median', 'left'] },
      { name: 'shennan-futian', s0: 11400, s1: 12600, sides: ['right', 'median', 'left'] },
      { name: 'cbd-loop', s0: 13760, s1: 15480, sides: ['right', 'left'] },
    ],
    /** 2:1 landscape face (m); the bottom edge clears the street canopy from a few hundred meters and keeps the face in the chase view at 80 m. */
    width: 28,
    height: 14,
    bottom: 26,
    /** Face yaw from square-on to the road, toward the carriageway (deg). */
    yawDeg: 20,
    /** Ground footprint around the face center: half width beyond the face, depth behind / in front (m). */
    footprintPad: 1,
    footprintBack: 3,
    footprintFront: 1.2,
    /** Gap to the sidewalk / median curb (m), further lateral offsets tried, s step (m). */
    clearance: 1.5,
    extraOffsets: [4, 8, 14],
    sStep: 10,
    /** Chase-camera distances before the screen that are scored; at least minVisible must see it unobstructed. */
    viewBack: [400, 320, 250, 200, 150, 110, 80],
    minVisible: 3,
    /** Street-tree canopy bands for those sight lines: radius around each trunk row, top height (m). */
    canopyRadius: 4,
    canopyTop: 11,
    /**
     * Chase-camera distances (every step from min to max, m) whose sight lines to the landmarks the
     * face may not cut; inside min the car is passing under the screen and it leaves the view.
     */
    landmarkBackMin: 50,
    landmarkBackMax: 700,
    landmarkBackStep: 25,
    /** Cabinet / steel shade of the supports (lit material). */
    cabinetShade: 0.06,
    columnShade: 0.5,
    /** Face color multiplier per time-of-day preset (dusk blooms: threshold 0.85). */
    brightness: { day: 1.05, golden: 1.2, dusk: 1.6 },
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
