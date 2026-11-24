import type { SceneryModule, WorldContext } from '../../game/contracts';

/**
 * OSM building footprints extruded and merged per chunk with a shared
 * procedural facade shader. Placeholder: nothing.
 */
export async function createBuildings(_ctx: WorldContext): Promise<SceneryModule> {
  return { update() {} };
}
