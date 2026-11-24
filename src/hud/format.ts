/** mm:ss.cc */
export function formatTime(t: number): string {
  const cs = Math.max(0, Math.floor(t * 100 + 1e-6));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
