import { CONFIG } from '../config';

export function loadBestTime(): number | null {
  try {
    const v = Number(localStorage.getItem(CONFIG.race.bestTimeKey));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Stores t if it beats the saved best; returns true for a new record. */
export function submitBestTime(t: number): boolean {
  const best = loadBestTime();
  if (best !== null && best <= t) return false;
  try {
    localStorage.setItem(CONFIG.race.bestTimeKey, String(t));
  } catch {
    // storage unavailable (private mode): the record still counts for this session
  }
  return true;
}
