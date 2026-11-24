import * as THREE from 'three';
import {
  BloomEffect,
  EdgeDetectionMode,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { CONFIG } from '../config';
import type { RenderPipeline, WorldContext } from '../game/contracts';

const R = CONFIG.render;

/**
 * HDR scene → bloom (only emissive highlights pass the threshold) → ACES tone
 * mapping + vignette → SMAA on the tone-mapped image. No motion blur.
 */
export function createRenderPipeline(ctx: WorldContext): RenderPipeline {
  const { renderer, scene, camera } = ctx;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = R.exposure;

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
    stencilBuffer: false,
  });
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new BloomEffect({
    mipmapBlur: true,
    intensity: R.bloomIntensity,
    luminanceThreshold: R.bloomThreshold,
    luminanceSmoothing: R.bloomSmoothing,
    radius: R.bloomRadius,
    levels: 7,
  });
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const vignette = new VignetteEffect({ offset: 0.3, darkness: R.vignette });
  composer.addPass(new EffectPass(camera, bloom, toneMapping, vignette));

  const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR });
  const aaPass = new EffectPass(camera, smaa);
  aaPass.dithering = true;
  composer.addPass(aaPass);

  return {
    render(dt: number) {
      composer.render(dt);
    },
    setSize(width: number, height: number) {
      composer.setSize(width, height);
    },
  };
}
