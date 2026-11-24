import type { FrameInfo, SceneryModule, WorldContext } from '../game/contracts';
import { createBuildings } from './buildings';
import { createLandmarks } from './landmarks';
import { createProps } from './props';
import { createRoad } from './road';

/** Builds all static scenery along the route. */
export async function createCity(ctx: WorldContext): Promise<SceneryModule> {
  const modules = await Promise.all([
    createRoad(ctx),
    createProps(ctx),
    createBuildings(ctx),
    createLandmarks(ctx),
  ]);
  return {
    update(frame: FrameInfo) {
      for (const m of modules) m.update(frame);
    },
    dispose() {
      for (const m of modules) m.dispose?.();
    },
  };
}
