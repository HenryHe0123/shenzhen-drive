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
import { LIGHTING } from './presets';
import { getTimeOfDay, onTimeOfDayChange, type TimeOfDay } from './timeOfDay';

const R = CONFIG.render;

/**
 * HDR scene → bloom (only emissive highlights pass the threshold) → ACES tone
 * mapping + vignette → SMAA on the tone-mapped image. No motion blur.
 * Exposure lives on renderer.toneMappingExposure (set by the environment);
 * bloom and vignette follow the time-of-day preset.
 */
export function createRenderPipeline(ctx: WorldContext): RenderPipeline {
  const { renderer, scene, camera } = ctx;
  renderer.toneMapping = THREE.NoToneMapping;

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
    stencilBuffer: false,
  });
  // The scene renders into inputBuffer: a 32-bit float depth attachment pairs with reversed-Z.
  const depth = new THREE.DepthTexture(composer.inputBuffer.width, composer.inputBuffer.height, THREE.FloatType);
  depth.name = 'SceneDepth';
  composer.inputBuffer.depthTexture = depth;
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

  const apply = (time: TimeOfDay) => {
    const p = LIGHTING[time];
    bloom.intensity = p.bloomIntensity;
    bloom.luminanceMaterial.threshold = p.bloomThreshold;
    bloom.luminanceMaterial.smoothing = p.bloomSmoothing;
    vignette.darkness = p.vignette;
  };
  apply(getTimeOfDay());
  onTimeOfDayChange(apply);

  return {
    render(dt: number) {
      composer.render(dt);
    },
    setSize(width: number, height: number) {
      composer.setSize(width, height);
    },
  };
}
