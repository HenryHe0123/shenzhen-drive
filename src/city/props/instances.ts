import * as THREE from 'three';
import { lowerBound } from '../road/builder';

export interface InstanceItem {
  s: number;
  m: THREE.Matrix4;
  c?: THREE.Color;
}

/**
 * One InstancedMesh for a whole prop type along the route; only instances whose s
 * lies in a window around the car are uploaded, so the draw call stays cheap
 * without per-chunk meshes.
 */
export class WindowedInstances {
  readonly mesh: THREE.InstancedMesh;
  private readonly sArr: Float64Array;
  private readonly mats: Float32Array;
  private readonly cols: Float32Array | null;
  private readonly cap: number;
  private lo = -1;
  private hi = -1;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    items: InstanceItem[],
    private readonly ahead: number,
    private readonly behind: number,
  ) {
    items.sort((a, b) => a.s - b.s);
    const n = items.length;
    this.sArr = Float64Array.from(items, (it) => it.s);
    this.mats = new Float32Array(n * 16);
    items.forEach((it, i) => it.m.toArray(this.mats, i * 16));
    const hasColor = items.some((it) => it.c);
    this.cols = hasColor ? new Float32Array(n * 3) : null;
    if (this.cols) {
      const white = new THREE.Color(1, 1, 1);
      items.forEach((it, i) => (it.c ?? white).toArray(this.cols!, i * 3));
    }
    const span = ahead + behind + 40;
    let cap = 0;
    for (let i = 0, j = 0; i < n; i++) {
      while (j < n && this.sArr[j] < this.sArr[i] + span) j++;
      cap = Math.max(cap, j - i);
    }
    this.cap = Math.max(1, cap);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.cols) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get total() {
    return this.sArr.length;
  }

  update(s: number) {
    const q = Math.round(s / 20) * 20;
    const lo = lowerBound(this.sArr, q - this.behind);
    const hi = Math.min(lowerBound(this.sArr, q + this.ahead), lo + this.cap);
    if (lo === this.lo && hi === this.hi) return;
    this.lo = lo;
    this.hi = hi;
    const cnt = hi - lo;
    const im = this.mesh.instanceMatrix;
    (im.array as Float32Array).set(this.mats.subarray(lo * 16, hi * 16));
    im.clearUpdateRanges();
    im.addUpdateRange(0, cnt * 16);
    im.needsUpdate = true;
    const ic = this.mesh.instanceColor;
    if (ic && this.cols) {
      (ic.array as Float32Array).set(this.cols.subarray(lo * 3, hi * 3));
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, cnt * 3);
      ic.needsUpdate = true;
    }
    this.mesh.count = cnt;
  }
}
