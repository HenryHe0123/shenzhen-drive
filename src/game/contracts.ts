import type * as THREE from 'three';
import type { MetroData } from '../city/metro/load';
import type { Route } from '../route/Route';
import type { BuildingsData, CityModelsData } from '../route/types';

/** Everything scenery/render modules need at construction time. */
export interface WorldContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  route: Route;
  /** null when public/data/buildings.json is missing. */
  buildings: BuildingsData | null;
  /**
   * Real-building models placed by the pipeline (public/data/city_models.json), loaded by
   * createCity before the scenery modules are built; null when the file is missing.
   * Their footprints are keep-out zones for procedural buildings and props.
   */
  cityModels?: CityModelsData | null;
  /**
   * Whole-city terrain, water, buildings and roads (public/data/metro), loaded by createCity before the
   * scenery modules; null when missing or turned off (?noMetro). Corridor modules place far objects on
   * its terrain and drop the flat ground plane when it is present.
   */
  metro?: MetroData | null;
  debug: boolean;
}

/** Per-frame information handed to scenery modules. */
export interface FrameInfo {
  /** Render frame delta (s). */
  dt: number;
  /** Seconds since game start. */
  time: number;
  /** Car world position (y = 0 at road level). */
  focus: THREE.Vector3;
  /** Car arc length on the route. */
  s: number;
  /** Car speed (m/s, signed). */
  speed: number;
}

export interface SceneryModule {
  update(frame: FrameInfo): void;
  dispose?(): void;
}

export interface RenderPipeline {
  render(dt: number): void;
  setSize(width: number, height: number): void;
}

/** Inputs to the audio engine each frame. */
export interface AudioFrame {
  dt: number;
  /** m/s, signed (negative while reversing). */
  speed: number;
  /** 0..1 */
  throttle: number;
  braking: boolean;
  /** True while the race is running (countdown and menus are quieter). */
  driving: boolean;
}
