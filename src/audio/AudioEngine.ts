import type { AudioFrame } from '../game/contracts';

/**
 * Procedural Web Audio sound for an electric car (motor whine, wind, tyre noise,
 * collision thud). Placeholder implementation: silent.
 */
export class AudioEngine {
  /** Must be called from a user gesture (e.g. the Start button click). */
  async start(): Promise<void> {}

  update(_frame: AudioFrame): void {}

  /** intensity 0..1 */
  collision(_intensity: number): void {}

  /** Countdown tick; final = true for the "go" beep. */
  beep(_final: boolean): void {}

  /** Checkpoint / finish chime. */
  chime(_finish: boolean): void {}

  setMuted(_muted: boolean): void {}

  /** Call on window blur / visibility change. */
  suspend(): void {}
  resume(): void {}
}
