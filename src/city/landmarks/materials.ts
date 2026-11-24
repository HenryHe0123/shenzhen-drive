import * as THREE from 'three';
import { CONFIG } from '../../config';
import { createFacadeMaterial } from '../buildings/facadeMaterial';

export interface LandmarkMaterials {
  /** Facade shader with thinned fog: skyline towers visible from km away. */
  glassFar: THREE.MeshStandardMaterial;
  glassNear: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  crownGlow: THREE.MeshBasicMaterial;
  gold: THREE.MeshStandardMaterial;
  goldGlow: THREE.MeshBasicMaterial;
  hill: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  plaza: THREE.MeshStandardMaterial;
  all: THREE.Material[];
}

function fogScaled<T extends THREE.Material>(m: T, k: number): T {
  m.defines = { ...(m.defines ?? {}), FOG_SCALE: k.toFixed(3) };
  return m;
}

export function createLandmarkMaterials(): LandmarkMaterials {
  const k = CONFIG.city.landmarkFogScale;
  const glassFar = createFacadeMaterial({ fogScale: k, litRatio: 0.32 });
  const glassNear = createFacadeMaterial({ litRatio: 0.5 });
  const steel = fogScaled(
    new THREE.MeshStandardMaterial({
      name: 'LandmarkSteel',
      color: '#c9ced6',
      metalness: 1,
      roughness: 0.3,
      emissive: '#a9bcd6',
      emissiveIntensity: 0.9,
    }),
    k,
  );
  const crownGlow = fogScaled(
    new THREE.MeshBasicMaterial({ name: 'CrownGlow', color: new THREE.Color(2.2, 2.6, 3.2), side: THREE.DoubleSide }),
    k,
  );
  const gold = new THREE.MeshStandardMaterial({
    name: 'EiffelGold',
    color: '#7a5a30',
    metalness: 0.7,
    roughness: 0.45,
    emissive: '#ffae4a',
    emissiveIntensity: 1.25,
  });
  const goldGlow = new THREE.MeshBasicMaterial({ name: 'EiffelLamp', color: new THREE.Color(4, 2.6, 1.2) });
  const hill = fogScaled(
    new THREE.MeshStandardMaterial({ name: 'Hill', color: '#ffffff', vertexColors: true, roughness: 0.95 }),
    0.75,
  );
  const stone = new THREE.MeshStandardMaterial({ name: 'LandmarkStone', color: '#8c8a86', roughness: 0.8 });
  const plaza = new THREE.MeshStandardMaterial({ name: 'Plaza', color: '#6f6c68', roughness: 0.85 });
  return {
    glassFar,
    glassNear,
    steel,
    crownGlow,
    gold,
    goldGlow,
    hill,
    stone,
    plaza,
    all: [glassFar, glassNear, steel, crownGlow, gold, goldGlow, hill, stone, plaza],
  };
}
