import * as THREE from 'three';
import type { SceneryModule, WorldContext } from '../../game/contracts';

/**
 * Road surface, markings, curbs, median, opposite carriageway, ground.
 * Placeholder: flat grey ribbon covering the drivable width plus a ground plane.
 */
export async function createRoad(ctx: WorldContext): Promise<SceneryModule> {
  const { route, scene } = ctx;
  const positions: number[] = [];
  const indices: number[] = [];
  const n = route.n;
  for (let i = 0; i < n; i++) {
    const s = route.cum[i];
    const l = route.pointAt(s, route.dMin);
    const r = route.pointAt(s, route.dMax);
    positions.push(l.x, 0.01, l.z, r.x, 0.01, r.z);
    if (i < n - 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#2a2a2e', roughness: 0.9 }));
  road.receiveShadow = true;
  scene.add(road);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#3d4a35', roughness: 1 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  return { update() {} };
}
