import * as THREE from 'three';
import type { RenderPipeline, WorldContext } from '../game/contracts';

/** Post-processing pipeline. Placeholder: plain render with ACES tone mapping. */
export function createRenderPipeline(ctx: WorldContext): RenderPipeline {
  const { renderer, scene, camera } = ctx;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return {
    render() {
      renderer.render(scene, camera);
    },
    setSize(w, h) {
      renderer.setSize(w, h);
    },
  };
}
