import * as THREE from 'three';
import { CONFIG } from '../config';

/**
 * Tone mapping and anti-aliasing happen in the post-processing pipeline
 * (src/render/pipeline.ts), so the renderer itself outputs linear HDR.
 * toneMappingExposure still drives the ToneMappingEffect (it reads three's uniform).
 * Reversed-Z depth (EXT_clip_control) with the pipeline's float depth target keeps 0.5 m - 60 km
 * precise enough that terrain, roads and water far away do not z-fight.
 */
export function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = CONFIG.render.exposure;
  renderer.shadowMap.enabled = true;
  // r187 removed PCFSoftShadowMap; PCF with light.shadow.radius gives the soft edge.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}
