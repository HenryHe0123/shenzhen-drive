import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CockpitCamera } from '../src/camera/CockpitCamera';
import { getViewMode, onViewModeChange, setViewMode, toggleViewMode } from '../src/camera/viewMode';
import { CONFIG, KMH } from '../src/config';

const K = CONFIG.cockpit;
const PARKED = { speed: 0, steer: 0, longAccel: 0, latAccel: 0 };

function rig(x = 0, z = 0, yaw = 0) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.position.set(x, 0, z);
  root.rotation.y = yaw;
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1000);
  return { body, camera, cockpit: new CockpitCamera(camera) };
}

/** Heading of the camera's view direction (0 = -Z, positive = turned left). */
function heading(camera: THREE.Camera): number {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return Math.atan2(-d.x, -d.z);
}

describe('view mode', () => {
  it('toggles between chase and cockpit and notifies listeners', () => {
    setViewMode('chase');
    const seen: string[] = [];
    const off = onViewModeChange((v) => seen.push(v));
    expect(toggleViewMode()).toBe('cockpit');
    expect(getViewMode()).toBe('cockpit');
    setViewMode('cockpit');
    expect(toggleViewMode()).toBe('chase');
    off();
    toggleViewMode();
    expect(seen).toEqual(['cockpit', 'chase']);
    setViewMode('chase');
  });
});

describe('cockpit camera', () => {
  it('sits at the driver eye point and looks forward, slightly down', () => {
    const { body, camera, cockpit } = rig();
    cockpit.update(1 / 60, body, PARKED);
    expect(camera.position.x).toBeCloseTo(K.eyeX, 6);
    expect(camera.position.y).toBeCloseTo(K.eyeY, 6);
    expect(camera.position.z).toBeCloseTo(K.eyeZ, 6);
    const d = camera.getWorldDirection(new THREE.Vector3());
    expect(d.z).toBeLessThan(-0.9);
    expect(Math.asin(d.y)).toBeCloseTo(K.pitch, 6);
  });

  it('follows the car position and heading', () => {
    const yaw = 1.2;
    const { body, camera, cockpit } = rig(100, -50, yaw);
    cockpit.update(1 / 60, body, PARKED);
    const eye = new THREE.Vector3(K.eyeX, K.eyeY, K.eyeZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    expect(camera.position.x).toBeCloseTo(100 + eye.x, 6);
    expect(camera.position.z).toBeCloseTo(-50 + eye.z, 6);
    expect(heading(camera)).toBeCloseTo(yaw, 6);
  });

  it('glances into the turn at speed, not when parked', () => {
    const moving = { ...PARKED, speed: 100 * KMH };
    const right = rig();
    for (let i = 0; i < 120; i++) right.cockpit.update(1 / 60, right.body, { ...moving, steer: 1 });
    expect(heading(right.camera)).toBeLessThan(-0.5 * K.lookInto);
    const parked = rig();
    for (let i = 0; i < 120; i++) parked.cockpit.update(1 / 60, parked.body, { ...PARKED, steer: 1 });
    expect(Math.abs(heading(parked.camera))).toBeLessThan(1e-6);
    parked.cockpit.reset();
  });

  it('leans the head against acceleration within maxLean', () => {
    const { body, camera, cockpit } = rig();
    for (let i = 0; i < 240; i++) cockpit.update(1 / 60, body, { ...PARKED, speed: 30, longAccel: 50, latAccel: 50 });
    expect(camera.position.z - K.eyeZ).toBeGreaterThan(0);
    expect(camera.position.x - K.eyeX).toBeGreaterThan(0);
    expect(Math.abs(camera.position.z - K.eyeZ)).toBeLessThanOrEqual(K.maxLean + 1e-9);
  });
});
