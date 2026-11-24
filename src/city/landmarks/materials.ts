import * as THREE from 'three';
import { CONFIG } from '../../config';
import { createFacadeMaterial } from '../buildings/facadeMaterial';

export interface LandmarkMaterials {
  /** Facade shader with thinned fog: skyline towers visible from km away. */
  glassFar: THREE.MeshStandardMaterial;
  glassNear: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  /** Light bands / crown frames: brushed metal by day, LED glow at night. */
  crownGlow: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  goldGlow: THREE.MeshStandardMaterial;
  hill: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  plaza: THREE.MeshStandardMaterial;
  all: THREE.Material[];
  /** Applies the day/night look for night level 0 (day) … 1 (dusk). */
  setNight(night: number): void;
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
    new THREE.MeshStandardMaterial({ name: 'LandmarkSteel', color: '#c9ced6', metalness: 1, roughness: 0.3, emissive: '#a9bcd6' }),
    k,
  );
  const crownGlow = fogScaled(
    new THREE.MeshStandardMaterial({
      name: 'CrownGlow',
      color: '#b9bec5',
      metalness: 0.85,
      roughness: 0.3,
      emissive: new THREE.Color(2.2, 2.6, 3.2).multiplyScalar(1 / 3.2),
      side: THREE.DoubleSide,
    }),
    k,
  );
  const gold = new THREE.MeshStandardMaterial({ name: 'EiffelGold', color: '#7a5a30', metalness: 0.7, roughness: 0.45, emissive: '#ffae4a' });
  const goldGlow = new THREE.MeshStandardMaterial({
    name: 'EiffelLamp',
    color: '#6b5a40',
    metalness: 0.6,
    roughness: 0.4,
    emissive: new THREE.Color(4, 2.6, 1.2).multiplyScalar(1 / 4),
  });
  const hill = fogScaled(
    new THREE.MeshStandardMaterial({ name: 'Hill', color: '#ffffff', vertexColors: true, roughness: 0.95 }),
    0.75,
  );
  const stone = new THREE.MeshStandardMaterial({ name: 'LandmarkStone', color: '#8c8a86', roughness: 0.8 });
  const plaza = new THREE.MeshStandardMaterial({ name: 'Plaza', color: '#6f6c68', roughness: 0.85 });

  const dayGold = new THREE.Color('#b08a4c');
  const duskGold = new THREE.Color('#7a5a30');
  const setNight = (night: number) => {
    const lights = THREE.MathUtils.smoothstep(night, 0.08, 1);
    steel.emissiveIntensity = 0.9 * lights;
    steel.roughness = THREE.MathUtils.lerp(0.22, 0.3, night);
    crownGlow.emissiveIntensity = 3.2 * lights;
    goldGlow.emissiveIntensity = 4 * lights;
    // Bronze-gold metal in daylight, floodlit gold at night.
    gold.color.copy(dayGold).lerp(duskGold, night);
    gold.metalness = THREE.MathUtils.lerp(0.9, 0.7, night);
    gold.roughness = THREE.MathUtils.lerp(0.36, 0.45, night);
    gold.emissiveIntensity = 1.25 * lights;
    // Lianhuashan's forest reads as dark green in daylight, near black at dusk.
    hill.color.setScalar(THREE.MathUtils.lerp(2.6, 1, night));
    stone.color.set(night > 0.5 ? '#8c8a86' : '#b5b1aa');
    plaza.color.set(night > 0.5 ? '#6f6c68' : '#a39e96');
  };

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
    setNight,
  };
}
