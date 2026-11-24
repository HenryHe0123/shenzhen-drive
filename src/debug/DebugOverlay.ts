import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface DebugInfo {
  fps: number;
  phase: string;
  s: number;
  d: number;
  speed: number;
  time: number;
  passed: number;
  count: number;
  contact: boolean;
  assisted: boolean;
}

/** ?debug overlay: FPS, draw calls, triangles, route coordinates; optional orbit free camera around the car. */
export class DebugOverlay {
  private readonly el: HTMLElement;
  private controls: OrbitControls | null = null;
  private readonly lastTarget = new THREE.Vector3();
  private acc = 1;

  constructor(
    root: HTMLElement,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'debug';
    root.append(this.el);
  }

  get freeCam(): boolean {
    return this.controls !== null;
  }

  toggleFreeCam(target: THREE.Vector3): void {
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
      return;
    }
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true;
    c.target.copy(target).setY(1);
    c.maxDistance = 3000;
    c.maxPolarAngle = Math.PI * 0.495;
    c.update();
    this.lastTarget.copy(target);
    this.controls = c;
  }

  /** Keeps the orbit pivot on the moving car. */
  updateCamera(target: THREE.Vector3): void {
    const c = this.controls;
    if (!c) return;
    const dx = target.x - this.lastTarget.x;
    const dz = target.z - this.lastTarget.z;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
    c.target.x += dx;
    c.target.z += dz;
    this.lastTarget.copy(target);
    c.update();
  }

  /** Call after rendering (renderer.info is reset manually once per frame). */
  update(dt: number, info: DebugInfo): void {
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    const r = this.renderer.info;
    this.el.textContent = [
      `FPS ${info.fps.toFixed(0)}  calls ${r.render.calls}  tris ${(r.render.triangles / 1000).toFixed(0)}k`,
      `geo ${r.memory.geometries}  tex ${r.memory.textures}`,
      `phase ${info.phase}  t ${info.time.toFixed(2)}  cp ${info.passed}/${info.count}${info.assisted ? ' (assisted)' : ''}`,
      `s ${info.s.toFixed(1)}  d ${info.d.toFixed(2)}  v ${(info.speed * 3.6).toFixed(0)} km/h${info.contact ? '  WALL' : ''}`,
      `1-9 checkpoint  0 turn  F free cam${this.freeCam ? ' (on)' : ''}`,
    ].join('\n');
  }
}
