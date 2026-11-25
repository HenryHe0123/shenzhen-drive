/**
 * Driving camera: third-person chase or first-person driver's seat. Toggled with C or in
 * the start / pause menus (persisted in localStorage), or forced with ?view=chase|cockpit.
 */
export type ViewMode = 'chase' | 'cockpit';

export const VIEW_MODES: readonly ViewMode[] = ['chase', 'cockpit'];

export const VIEW_LABELS: Record<ViewMode, string> = {
  chase: '车外',
  cockpit: '车内',
};

const STORAGE_KEY = 'shenzhen-drive.view.v1';
const DEFAULT_VIEW: ViewMode = 'chase';

type Listener = (view: ViewMode) => void;
const listeners = new Set<Listener>();

function isView(v: unknown): v is ViewMode {
  return typeof v === 'string' && (VIEW_MODES as readonly string[]).includes(v);
}

function initialView(): ViewMode {
  if (typeof window === 'undefined') return DEFAULT_VIEW;
  const fromUrl = new URLSearchParams(window.location.search).get('view');
  if (isView(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isView(stored)) return stored;
  } catch {
    // localStorage unavailable (privacy mode); fall through to the default.
  }
  return DEFAULT_VIEW;
}

let current: ViewMode = initialView();

export function getViewMode(): ViewMode {
  return current;
}

export function setViewMode(view: ViewMode): void {
  if (view === current) return;
  current = view;
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Not persisted; the choice still applies to this session.
  }
  for (const cb of listeners) cb(view);
}

export function toggleViewMode(): ViewMode {
  setViewMode(current === 'chase' ? 'cockpit' : 'chase');
  return current;
}

/** Subscribe to view changes; returns an unsubscribe function. */
export function onViewModeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
