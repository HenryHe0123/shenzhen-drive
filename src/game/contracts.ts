import type * as THREE from 'three';
import type { Route } from '../route/Route';
import type { BuildingsData } from '../route/types';

/** Everything scenery/render modules need at construction time. */
export interface WorldContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  route: Route;
  /** null when public/data/buildings.json is missing. */
  buildings: BuildingsData | null;
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
