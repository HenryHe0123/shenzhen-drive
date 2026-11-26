import type { FrameInfo, SceneryModule, WorldContext } from '../../game/contracts';
import { createMetroBuildings, type MetroBuildings } from './buildings';
import type { MetroData } from './load';
import { createTerrain, type TerrainHandle } from './terrain';
import { createWater } from './water';

export interface MetroDebug {
  terrain: TerrainHandle;
  buildings: MetroBuildings;
}

/** Whole-city scenery beyond the route corridor: terrain, water, buildings (and roads). */
export async function createMetro(ctx: WorldContext, metro: MetroData): Promise<SceneryModule> {
  const [terrain, water, buildings] = await Promise.all([createTerrain(ctx, metro), createWater(ctx, metro), createMetroBuildings(ctx, metro)]);
  const modules: SceneryModule[] = [terrain, water, buildings];
  if (ctx.debug) (window as unknown as { __METRO__?: MetroDebug }).__METRO__ = { terrain, buildings };
  return {
    update(frame: FrameInfo) {
      for (const m of modules) m.update(frame);
    },
    dispose() {
      for (const m of modules) m.dispose?.();
    },
  };
}
