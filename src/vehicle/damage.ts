import { CONFIG, KMH } from '../config';

export type ImpactTier = 'scrape' | 'light' | 'heavy' | 'severe';

/** Tier of an impact by its normal speed into the wall (m/s). */
export function impactTier(normalSpeed: number): ImpactTier {
  const C = CONFIG.collision;
  if (normalSpeed >= C.severeKmh * KMH) return 'severe';
  if (normalSpeed >= C.heavyKmh * KMH) return 'heavy';
  if (normalSpeed >= C.lightKmh * KMH) return 'light';
  return 'scrape';
}

/**
 * Car damage from heavy wall impacts: a stall (severe only) during which the car cannot be
 * driven, then a power / top-speed deficit that recovers linearly. Advanced by fixed steps, so
 * it freezes with the physics while paused.
 */
export class Damage {
  /** Seconds left without drive (severe impacts). */
  stall = 0;
  private loss = 0;
  private total = 0;
  private remaining = 0;

  /** Registers an impact; returns its tier. */
  hit(normalSpeed: number): ImpactTier {
    const tier = impactTier(normalSpeed);
    if (tier !== 'heavy' && tier !== 'severe') return tier;
    const C = CONFIG.collision;
    const t = Math.min(1, (normalSpeed / KMH - C.heavyKmh) / (C.severeKmh - C.heavyKmh));
    const loss = C.damageLoss[0] + (C.damageLoss[1] - C.damageLoss[0]) * t;
    const seconds = C.damageSeconds[0] + (C.damageSeconds[1] - C.damageSeconds[0]) * t;
    if (loss >= this.deficit) {
      this.loss = loss;
      this.total = this.remaining = Math.max(seconds, this.remaining);
    }
    if (tier === 'severe') this.stall = Math.max(this.stall, C.stallSeconds);
    return tier;
  }

  update(dt: number): void {
    const tick = (t: number) => (t - dt > 1e-9 ? t - dt : 0);
    if (this.stall > 0) this.stall = tick(this.stall);
    else if (this.remaining > 0) this.remaining = tick(this.remaining);
  }

  /** Current fraction of power and top speed lost. */
  get deficit(): number {
    return this.total > 0 ? (this.loss * this.remaining) / this.total : 0;
  }

  /** Multiplier on drive power and top speed (1 = undamaged). */
  get powerScale(): number {
    return 1 - this.deficit;
  }

  get active(): boolean {
    return this.stall > 0 || this.remaining > 0;
  }

  /** Seconds until the car is back to full power. */
  get secondsLeft(): number {
    return this.stall + this.remaining;
  }

  reset(): void {
    this.stall = this.loss = this.total = this.remaining = 0;
  }
}
