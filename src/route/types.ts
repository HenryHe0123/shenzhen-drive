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
  /** The single deliberate turn before the finish. */
  turn: { s0: number; s1: number; direction: 'left' | 'right'; name: string };
  /** Named cross streets, for crosswalks and street-name signs. */
  intersections?: { s: number; name: string }[];
  landmarks: Landmark[];
  signs: { s: number; side: 'left' | 'right'; text: string; sub?: string }[];
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
}

export interface BuildingsData {
  meta: {
    generatedAt: string;
    osmTimestamp: string | null;
    count: number;
    heightSources: { tag: number; levels: number; estimated: number };
  };
  buildings: BuildingRecord[];
}
