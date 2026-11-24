import { CONFIG } from '../config';

export type Phase = 'loading' | 'menu' | 'countdown' | 'racing' | 'finished';

export type RaceEvent =
  | { type: 'tick'; value: number }
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; name: string; time: number }
  | { type: 'finish'; time: number };

export interface RaceCourse {
  checkpoints: { s: number; name: string }[];
  finish: { s: number; name: string };
  startS: number;
}

/**
 * Pure race state machine: loading → menu → countdown → racing → finished.
 * Checkpoints must be crossed in order while moving forward; the finish only counts
 * after all of them. Crossing times are interpolated inside the step.
 */
export class Race {
  phase: Phase = 'loading';
  /** Elapsed race time (s); runs only while racing. */
  time = 0;
  /** Seconds left in the countdown. */
  countdown = 0;
  /** Number of checkpoints passed (index of the next one). */
  passed = 0;
  /** True once a debug teleport was used in this run (not eligible for best time). */
  assisted = false;
  finishTime: number | null = null;
  private lastS: number;
  private lastTick = 0;

  constructor(
    readonly course: RaceCourse,
    private readonly countdownSeconds: number = CONFIG.race.countdownSeconds,
  ) {
    this.lastS = course.startS;
  }

  get checkpointCount(): number {
    return this.course.checkpoints.length;
  }

  /** Assets are loaded: show the menu. */
  ready(): void {
    if (this.phase === 'loading') this.phase = 'menu';
  }

  /** Starts a fresh run (also used for Retry). */
  begin(): void {
    this.phase = 'countdown';
    this.countdown = this.countdownSeconds;
    this.lastTick = 0;
    this.time = 0;
    this.passed = 0;
    this.assisted = false;
    this.finishTime = null;
    this.lastS = this.course.startS;
  }

  /** Arc length the car returns to on reset: the last passed checkpoint, or the start. */
  resetS(): number {
    return this.passed > 0 ? this.course.checkpoints[this.passed - 1].s : this.course.startS;
  }

  /** Moves the crossing reference without crossing anything (after a reset). */
  syncS(s: number): void {
    this.lastS = s;
  }

  /** Debug/test teleport: checkpoints at or before s count as passed; the run is marked assisted. */
  teleportTo(s: number): void {
    let n = 0;
    while (n < this.checkpointCount && this.course.checkpoints[n].s <= s) n++;
    this.passed = n;
    this.assisted = true;
    this.lastS = s;
  }

  /** Advances one step with the car's arc length and the sign of velocity · route tangent. */
  update(dt: number, s: number, forwardDot: number): RaceEvent[] {
    const events: RaceEvent[] = [];
    const prev = this.lastS;
    this.lastS = s;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.time = -this.countdown;
        this.countdown = 0;
        events.push({ type: 'go' });
      } else {
        const shown = Math.ceil(this.countdown);
        if (shown !== this.lastTick) {
          this.lastTick = shown;
          events.push({ type: 'tick', value: shown });
        }
      }
      return events;
    }
    if (this.phase !== 'racing') return events;

    const t0 = this.time;
    this.time += dt;
    if (!(forwardDot > CONFIG.race.minForwardDot) || !(s > prev)) return events;
    const at = (target: number) => t0 + (dt * (target - prev)) / (s - prev);
    const cps = this.course.checkpoints;
    while (this.passed < cps.length && prev < cps[this.passed].s && s >= cps[this.passed].s) {
      const cp = cps[this.passed];
      events.push({ type: 'checkpoint', index: this.passed, name: cp.name, time: at(cp.s) });
      this.passed++;
    }
    const fs = this.course.finish.s;
    if (this.passed === cps.length && prev < fs && s >= fs) {
      this.time = at(fs);
      this.finishTime = this.time;
      this.phase = 'finished';
      events.push({ type: 'finish', time: this.time });
    }
    return events;
  }
}
