/**
 * Shared data contract between the Python city-data pipeline
 * (scripts/build_city_data.py → public/data/*.json) and the game.
 *
 * Coordinates: local meters, origin = route start (s = 0).
 * x points east, z points south, y is up (Three.js convention), so north = -z.
 * All geometry is already cut-and-spliced (see RouteMeta.cuts); the game never
 * needs real-world coordinates.
 */

/** [x, z] in local meters. */
export type Vec2 = [number, number];

export type SectionId = 'nanshan' | 'oct' | 'chegongmiao' | 'futian';

export interface RouteMeta {
  generatedAt: string;
  osmTimestamp: string | null;
  source: string;
  /** WGS-84 coordinates of the start point (local origin). */
  origin: { lon: number; lat: number };
  /** Arc length of the real (uncut) centerline in meters. */
  realLength: number;
  /** Arc length after cuts, equals the drivable route length. */
  length: number;
  /** Intervals removed from the ORIGINAL arc length. */
  cuts: { s0: number; s1: number; note?: string }[];
  /** Distance between consecutive centerline samples in meters. */
  sampleSpacing: number;
}

export interface RouteData {
  meta: RouteMeta;
  /**
   * Driving centerline, uniformly resampled: sample i is at s = i * sampleSpacing
   * (the final sample is exactly at meta.length). Follows the driving direction.
   */
  centerline: Vec2[];
  /** Drivable carriageway around the centerline (d < 0 is left of driving direction). */
  road: { lanes: number; laneWidth: number; halfWidthLeft: number; halfWidthRight: number };
  /**
   * Optional, one value per centerline sample: lateral offset d (negative, left side)
   * of the opposite-direction carriageway centerline. Used only for scenery.
   */
  oppositeOffset?: number[];
  sections: { id: SectionId; name: string; s0: number; s1: number }[];
  /** Ordered checkpoints (excluding start and finish). */
  checkpoints: { s: number; name: string }[];
  finish: { s: number; name: string };
  /** Deliberate turns at intersections, in route order. Read via Route.turns (normalized). */
  turns?: Turn[];
  /** @deprecated Last deliberate turn; still written for older consumers. */
  turn: Turn;
  /** Polygons kept free of buildings so landmarks stay visible from the road. */
  clearZones?: Vec2[][];
  /** Named cross streets, for crosswalks and street-name signs. */
  intersections?: { s: number; name: string }[];
  landmarks: Landmark[];
  signs: { s: number; side: 'left' | 'right'; text: string; sub?: string }[];
  /**
   * Optional, one value per centerline sample: lateral offset d of the side road (辅路) centre on the
   * right, and beyond the opposite carriageway on the left; null where there is none. Scenery only.
   */
  sideRoadRight?: (number | null)[];
  sideRoadLeft?: (number | null)[];
  /** Side road runs (s range per side) with their lane count. */
  sideRoadLanes?: { side: 'left' | 'right'; s0: number; s1: number; lanes: number }[];
  /** Pedestrian bridges crossing the route at s, spanning d0..d1; skew = angle (rad) from the route normal. */
  footbridges?: { s: number; d0: number; d1: number; skew: number; osmId?: number }[];
  busStops?: RoadsideItem[];
  subwayEntrances?: RoadsideItem[];
}

export interface RoadsideItem {
  s: number;
  /** Lateral offset of the OSM node (m). */
  d: number;
  side: 'left' | 'right';
  name?: string;
}

export interface Turn {
  /** Arc-length span of the fillet arc. */
  s0: number;
  s1: number;
  direction: 'left' | 'right';
  /** Road being turned onto. */
  name: string;
  /** Fillet radius (m). */
  radius?: number;
}

export interface Landmark {
  /** 'tencent' | 'eiffel' | 'pingan' | 'civic_center' | 'lianhuashan' | ... */
  id: string;
  name: string;
  osmId?: number;
  /** Centroid in local coordinates (after cut transform). */
  x: number;
  z: number;
  /** Projection of the centroid onto the route. */
  s: number;
  d: number;
  footprint?: Vec2[];
  height?: number;
}

export interface BuildingRecord {
  /** OSM way/relation id. */
  id: number;
  /** Projection of the footprint centroid onto the route. */
  s: number;
  d: number;
  /** Height in meters. */
  h: number;
  zone: SectionId;
  /** Skyline-only building outside the near corridor. */
  far?: boolean;
  /** Outer ring, no repeated closing point, any winding. */
  fp: Vec2[];
  /** Footprint from Overture Maps (machine-learned rooftop) instead of OSM; absent for OSM and procedural records. */
  src?: 'overture';
  /** Function from the OSM building tag, else CMAB's prediction. */
  use?: BuildingUse;
  /** Construction decade, e.g. '1990s' (OSM start_date, else CMAB). */
  age?: string;
}

export type BuildingUse = 'office' | 'residential' | 'commercial' | 'public' | 'industrial';

/** A processed real-building model (public/models/city/) placed by the data pipeline. */
export interface CityModelRecord {
  id: string;
  /** Path relative to the public root, e.g. 'models/city/tencent_1c412809.glb'. */
  file: string;
  role: 'landmark' | 'frontage' | 'skyline';
  /** World position of the processed model's origin (ground level) after the cut transform. */
  x: number;
  z: number;
  /** rotation.y (radians) to apply to the processed model. */
  yaw: number;
  s: number;
  d: number;
  height: number;
  /** Ground footprint in world coordinates; keep-out for procedural buildings and props. */
  footprint: Vec2[];
  /** OSM building ids removed from buildings.json because this model replaces them. */
  replacesOsm: number[];
  /** Hand-built landmark id (src/city/landmarks) this model replaces, if chosen. */
  replacesLandmark?: string;
  /** Set when the footprint reaches into a route clearZones wedge: lowest landmark sight line over it (m). */
  viewCap?: number;
  /** Old photo-textured model (needs the photo facade material) vs clean geometry. */
  photoTextured: boolean;
  tris: number;
  drawCalls: number;
  bytes: number;
  credit: { title: string; author: string; url: string; license: string };
}

export interface CityModelsData {
  meta: { generatedAt: string; count: number; totalBytes: number };
  models: CityModelRecord[];
}

export interface BuildingsData {
  meta: {
    generatedAt: string;
    osmTimestamp: string | null;
    count: number;
    /** Where each height comes from: OSM height / levels, CMAB, Overture, zone estimate (procedural blocks included). */
    heightSources: { tag: number; levels: number; cmab?: number; overture?: number; estimated: number };
    footprintSources?: { osm: number; overture: number; procedural: number };
  };
  buildings: BuildingRecord[];
}
