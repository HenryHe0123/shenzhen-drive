const THROTTLE = ['KeyW', 'ArrowUp'];
const BRAKE = ['KeyS', 'ArrowDown'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const NO_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/** Keyboard state. Held keys are cleared on blur / tab switch so nothing gets stuck. */
export class Input {
  /** Called once per physical key press (no auto-repeat) with KeyboardEvent.code; return true if handled. */
  onPress: ((code: string) => boolean | void) | null = null;
  private held = new Set<string>();

  constructor() {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.clear);
  }

  get throttle(): number {
    return this.any(THROTTLE) ? 1 : 0;
  }

  get brake(): number {
    return this.any(BRAKE) ? 1 : 0;
  }

  /** -1 (left) .. +1 (right) */
  get steer(): number {
    return (this.any(RIGHT) ? 1 : 0) - (this.any(LEFT) ? 1 : 0);
  }

  readonly clear = (): void => {
    this.held.clear();
  };

  dispose(): void {
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.clear);
    document.removeEventListener('visibilitychange', this.clear);
  }

  private any(codes: string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  private readonly down = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (NO_SCROLL.has(e.code)) e.preventDefault();
    this.held.add(e.code);
    if (!e.repeat && this.onPress?.(e.code)) e.preventDefault();
  };

  private readonly up = (e: KeyboardEvent): void => {
    if (NO_SCROLL.has(e.code)) e.preventDefault();
    this.held.delete(e.code);
  };
}
