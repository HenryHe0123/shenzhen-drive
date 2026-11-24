import * as THREE from 'three';
import type { FrameInfo, SceneryModule, WorldContext } from '../game/contracts';

/** Sky, lights, fog and environment map. Placeholder until the dusk setup lands. */
export function createEnvironment(ctx: WorldContext): SceneryModule {
  const { scene } = ctx;
  scene.background = new THREE.Color('#4a4a6a');
  scene.fog = new THREE.Fog('#4a4a6a', 200, 2500);
  scene.add(new THREE.HemisphereLight('#b8c4ff', '#3a3030', 1.2));
  const sun = new THREE.DirectionalLight('#ffd2a0', 2.0);
  sun.position.set(-100, 120, 60);
  scene.add(sun, sun.target);
  return {
    update(frame: FrameInfo) {
      sun.target.position.copy(frame.focus);
      sun.position.copy(frame.focus).add(new THREE.Vector3(-100, 120, 60));
    },
  };
}
