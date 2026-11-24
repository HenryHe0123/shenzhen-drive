import * as THREE from 'three';
import { CONFIG } from '../config';

/**
 * Tone mapping and anti-aliasing happen in the post-processing pipeline
 * (src/render/pipeline.ts), so the renderer itself outputs linear HDR.
 * toneMappingExposure still drives the ToneMappingEffect (it reads three's uniform).
 */
export function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
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
