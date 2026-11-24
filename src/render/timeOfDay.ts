/**
 * Global time-of-day preset. Chosen on the start menu (persisted in localStorage)
 * or forced with ?time=day|golden. Anything with lights (lit windows, lamps,
 * light pools, glowing signs, landmark lighting) scales its emission by
 * `nightUniform.value` (0 = full daylight, 1 = night) so it follows the preset.
 */
export type TimeOfDay = 'day' | 'golden' | 'dusk';

/** Selectable presets. 'dusk' is retired (not shown in the final game); stored or ?time=dusk falls back to the default. */
export const TIME_PRESETS: readonly TimeOfDay[] = ['day', 'golden'];

export const TIME_LABELS: Record<TimeOfDay, string> = {
  day: '白天',
  golden: '日落',
  dusk: '入夜',
};

const STORAGE_KEY = 'shenzhen-drive.time.v1';
const DEFAULT_TIME: TimeOfDay = 'day';

const NIGHT_LEVEL: Record<TimeOfDay, number> = { day: 0, golden: 0.35, dusk: 1 };

/** Shared shader uniform; pass it by reference into materials (uniforms.uNight = nightUniform). */
export const nightUniform = { value: 1 };

type Listener = (time: TimeOfDay) => void;
const listeners = new Set<Listener>();

function isTime(v: unknown): v is TimeOfDay {
  return typeof v === 'string' && (TIME_PRESETS as readonly string[]).includes(v);
}

function initialTime(): TimeOfDay {
  if (typeof window === 'undefined') return DEFAULT_TIME;
  const fromUrl = new URLSearchParams(window.location.search).get('time');
  if (isTime(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTime(stored)) return stored;
  } catch {
    // localStorage unavailable (privacy mode); fall through to the default.
  }
  return DEFAULT_TIME;
}

let current: TimeOfDay = initialTime();
nightUniform.value = NIGHT_LEVEL[current];

export function getTimeOfDay(): TimeOfDay {
  return current;
}

/** 0 = daylight … 1 = night for the given (or current) preset. */
export function nightLevel(time: TimeOfDay = current): number {
  return NIGHT_LEVEL[time];
}

export function setTimeOfDay(time: TimeOfDay): void {
  if (time === current) return;
  current = time;
  nightUniform.value = NIGHT_LEVEL[time];
  try {
    window.localStorage.setItem(STORAGE_KEY, time);
  } catch {
    // Not persisted; the choice still applies to this session.
  }
  for (const cb of listeners) cb(time);
}

/** Subscribe to preset changes; returns an unsubscribe function. */
export function onTimeOfDayChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
