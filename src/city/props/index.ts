import type { SceneryModule, WorldContext } from '../../game/contracts';

/**
 * Street furniture: trees, street lamps, signs, crosswalks, turn arrows,
 * start/finish gates, turn guidance markers. Placeholder: nothing.
 */
export async function createProps(_ctx: WorldContext): Promise<SceneryModule> {
  return { update() {} };
}
