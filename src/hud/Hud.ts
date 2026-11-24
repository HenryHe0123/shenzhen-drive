import { CONFIG } from '../config';
import { getTimeOfDay, onTimeOfDayChange, setTimeOfDay, TIME_LABELS, TIME_PRESETS } from '../render/timeOfDay';
import type { Route } from '../route/Route';
import { formatTime } from './format';
import { Minimap, type MinimapMode } from './Minimap';
import { HUD_CSS } from './styles';
import type { OverlayKey, OverlaySource } from '../recording/Recorder';
import type { TurnHint } from './turnHint';
import { BUILD } from './version';

export interface HudOptions {
  startName: string;
  finishName: string;
  /** Drawn by the minimap (route, checkpoints, turns, landmarks, finish). */
  route: Route;
  onStart: () => void;
  onRetry: () => void;
  /** Pause menu actions. */
  onResume: () => void;
  onRestart: () => void;
  onResetCheckpoint: () => void;
  onMainMenu: () => void;
  onToggleMute: () => void;
  /** 自动录像 toggle (start and pause menus) and the results-screen download button. */
  onToggleRecording: () => void;
  onDownloadRecording: () => void;
}

/** Results-screen recording state; null hides the download block. */
export type RecordingView = { state: 'finalizing' } | { state: 'ready'; summary: string } | { state: 'error' } | null;

export interface HudFrame {
  speedKmh: number;
  speedFraction: number;
  time: number;
  /** 0..1 distance fraction to the finish. */
  progress: number;
  sectionName: string;
  passed: number;
  /** Rendered car pose for the minimap, and its arc length. */
  x: number;
  z: number;
  yaw: number;
  s: number;
  /** Next-turn hint (see turnHint()); null hides it. */
  turn: TurnHint | null;
  hint: string | null;
}

export interface ResultInfo {
  time: number;
  best: number | null;
  record: boolean;
  assisted: boolean;
}

export interface PauseInfo {
  sectionName: string;
  time: number;
  /** Paused during the countdown: 回到检查点 is unavailable. */
  countdown: boolean;
}

const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-8a4 4 0 0 0-4-4H5"/><path d="M9 4.5 4.5 9 9 13.5"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** DOM overlay: start screen, countdown, driving HUD with minimap, pause menu and results. */
export class Hud implements OverlaySource {
  private readonly menu: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly menuBest: HTMLElement;
  private readonly menuError: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly speedFill: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly timerBest: HTMLElement;
  private readonly sectionName: HTMLElement;
  private readonly cpText: HTMLElement;
  private readonly minimap: Minimap;
  private readonly turn: HTMLElement;
  private readonly turnArrow: SVGElement;
  private readonly turnDist: HTMLElement;
  private readonly turnText: HTMLElement;
  private readonly slowEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly muteEl: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly pauseInfo: HTMLElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly checkpointBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly recToggles: HTMLButtonElement[] = [];
  private readonly recIndicator: HTMLElement;
  private readonly recBlock: HTMLElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly result: HTMLElement;
  private readonly resultTime: HTMLElement;
  private readonly resultBest: HTMLElement;
  private readonly recordEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly cache = new Map<string, string>();
  private toastTimer = 0;
  private countdownTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: HudOptions,
  ) {
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    const n = opts.route.data.checkpoints.length;

    // start screen
    this.menu = el('div', 'screen');
    this.menu.id = 'menu';
    const card = el('div', 'card panel');
    card.innerHTML = `
      <h1 class="title">SHENZHEN <em>DRIVE</em><span class="sep">｜</span><span class="subtitle">深圳极速穿越</span></h1>
      <div class="route">${opts.startName} <span class="arrow">→</span> 福田中心区 · ${opts.finishName}</div>
      <div class="controls">
        <span class="keys"><kbd>W</kbd><kbd>↑</kbd></span><span>加速</span>
        <span class="keys"><kbd>S</kbd><kbd>↓</kbd></span><span>刹车 / 倒车</span>
        <span class="keys"><kbd>A</kbd><kbd>D</kbd> <kbd>←</kbd><kbd>→</kbd></span><span>转向</span>
        <span class="keys"><kbd>R</kbd></span><span>回到上一个检查点（计时不停）</span>
        <span class="keys"><kbd>Esc</kbd><kbd>P</kbd></span><span>暂停</span>
        <span class="keys"><kbd>N</kbd></span><span>小地图：全程 / 局部</span>
        <span class="keys"><kbd>M</kbd></span><span>静音</span>
      </div>
      <div class="best num"></div>`;
    this.menuBest = card.querySelector('.best')!;
    const tod = this.timeSelector(true);
    tod.id = 'time-select';
    const menuRow = el('div', 'opt-row');
    menuRow.append(tod, this.recToggle('rec-toggle-menu', true));
    card.append(menuRow);

    this.startBtn = el('button', 'btn');
    this.startBtn.id = 'start-btn';
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => opts.onStart());
    this.menuError = el('div', 'error hidden');
    card.append(this.startBtn, el('div', 'btn-hint', '按 Enter / 空格 开始'), this.menuError);
    card.append(el('div', 'credit', 'Xiaomi SU7 model by Car2022 (CC BY 4.0) · Map data © OpenStreetMap contributors'));
    const menuVersion = el('div', 'version num', BUILD.label);
    menuVersion.id = 'menu-version';
    card.append(menuVersion);
    this.menu.append(card);

    // countdown
    this.countdown = el('div', 'hidden');
    this.countdown.id = 'countdown';

    // driving HUD
    this.hud = el('div', 'hidden');
    this.hud.id = 'hud';
    const tl = el('div', 'top-left panel minimap');
    tl.id = 'minimap';
    tl.innerHTML = `<div class="section"><span class="section-name"></span><span class="cp num"></span></div>`;
    this.sectionName = tl.querySelector('.section-name')!;
    this.cpText = tl.querySelector('.cp')!;
    this.cpText.textContent = `检查点 0/${n} · 0%`;
    this.minimap = new Minimap(opts.route, tl);

    const tc = el('div', 'top-center');
    const timer = el('div', 'timer panel');
    this.timeEl = el('div', 'num');
    this.timeEl.id = 'hud-time';
    this.timeEl.textContent = formatTime(0);
    this.timerBest = el('div', 'timer-best num');
    timer.append(this.timeEl, this.timerBest);
    this.turn = el('div', 'turn panel hidden', ARROW);
    this.turn.id = 'hud-turn';
    this.turnArrow = this.turn.querySelector('svg')!;
    this.turnDist = el('span', 'turn-dist num');
    this.turnText = el('span', 'turn-road');
    this.turn.append(this.turnDist, this.turnText);
    this.slowEl = el('div', 'slow panel hidden');
    this.slowEl.id = 'hud-slow';
    tc.append(timer, this.turn, this.slowEl);

    const br = el('div', 'bottom-right panel');
    this.speed = el('div', 'num');
    this.speed.id = 'hud-speed';
    this.speed.textContent = '0';
    this.speedFill = el('div', 'speed-fill');
    const speedBar = el('div', 'speed-bar');
    speedBar.append(this.speedFill);
    br.append(this.speed, el('div', 'unit', 'KM/H'), speedBar);

    this.toastEl = el('div', 'toast panel hidden');
    this.hintEl = el('div', 'hint panel hidden');
    this.muteEl = el('div', 'mute panel hidden', '已静音 · M');
    this.recIndicator = el('div', 'rec-ind panel hidden', '<i></i>REC');
    this.recIndicator.id = 'rec-indicator';
    const tr = el('div', 'top-right');
    tr.append(this.muteEl, this.recIndicator);
    const hudVersion = el('div', 'version-tag num', BUILD.label);
    hudVersion.id = 'hud-version';
    this.hud.append(tl, tc, br, tr, this.toastEl, this.hintEl, hudVersion);

    // pause menu
    this.pause = el('div', 'screen hidden');
    this.pause.id = 'pause';
    this.pause.setAttribute('role', 'dialog');
    this.pause.setAttribute('aria-label', '已暂停');
    const pc = el('div', 'card panel pause-card');
    pc.append(el('div', 'result-title', '已暂停'));
    this.pauseInfo = el('div', 'pause-info num');
    pc.append(this.pauseInfo);
    const button = (id: string, label: string, key: string, onClick: () => void, primary = false) => {
      const b = el('button', primary ? 'pbtn primary' : 'pbtn', `<span>${label}</span>${key ? `<kbd>${key}</kbd>` : ''}`);
      b.id = id;
      b.type = 'button';
      b.addEventListener('click', () => onClick());
      return b;
    };
    this.resumeBtn = button('pause-resume', '继续', 'Esc', opts.onResume, true);
    this.checkpointBtn = button('pause-checkpoint', '回到检查点', 'R', opts.onResetCheckpoint);
    const actions = el('div', 'pause-actions');
    actions.append(
      this.resumeBtn,
      button('pause-restart', '重新开始本局', '', opts.onRestart),
      this.checkpointBtn,
      button('pause-menu', '返回主菜单', '', opts.onMainMenu),
    );
    const row = el('div', 'pause-row');
    const ptod = this.timeSelector(false);
    ptod.id = 'pause-time-select';
    this.muteBtn = button('pause-mute', '声音 开', 'M', opts.onToggleMute);
    this.muteBtn.classList.add('mute-toggle');
    this.muteBtn.setAttribute('aria-pressed', 'false');
    row.append(ptod, this.muteBtn, this.recToggle('rec-toggle-pause', false));
    const pauseVersion = el('div', 'version num', BUILD.label);
    pauseVersion.id = 'pause-version';
    pc.append(actions, row, el('div', 'btn-hint', '↑ ↓ 选择 · Enter / 空格 确认 · Esc 继续'), pauseVersion);
    this.pause.append(pc);

    // results
    this.result = el('div', 'screen hidden');
    this.result.id = 'result';
    const rc = el('div', 'card panel');
    rc.innerHTML = `
      <div class="result-title">抵达终点</div>
      <div class="result-dest">${opts.startName} → 福田中心区 · ${opts.finishName}</div>
      <div class="result-time num" id="result-time"></div>
      <div class="record hidden">新纪录!</div>
      <div class="best num"></div>
      <div class="note hidden"></div>`;
    this.resultTime = rc.querySelector('#result-time')!;
    this.recordEl = rc.querySelector('.record')!;
    this.resultBest = rc.querySelector('.best')!;
    this.noteEl = rc.querySelector('.note')!;
    const retry = el('button', 'btn', '再来一次');
    retry.id = 'retry-btn';
    retry.type = 'button';
    retry.addEventListener('click', () => opts.onRetry());
    rc.append(retry, el('div', 'btn-hint', '按 Enter / 空格 重新挑战'));
    this.recBlock = el('div', 'rec-block hidden');
    this.recBtn = el('button', 'pbtn rec-download', '下载录像');
    this.recBtn.id = 'rec-download';
    this.recBtn.type = 'button';
    this.recBtn.addEventListener('click', () => opts.onDownloadRecording());
    this.recBlock.append(this.recBtn, el('div', 'rec-note', '录像只保存在本页内存中，不点击则不保存'));
    rc.append(this.recBlock);
    this.result.append(rc);

    root.append(this.hud, this.countdown, this.menu, this.result, this.pause);
    this.setLoading(true);
  }

  get menuVisible(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  get resultVisible(): boolean {
    return !this.result.classList.contains('hidden');
  }

  get pauseVisible(): boolean {
    return !this.pause.classList.contains('hidden');
  }

  get startEnabled(): boolean {
    return this.menuVisible && !this.startBtn.disabled;
  }

  get minimapMode(): MinimapMode {
    return this.minimap.mode;
  }

  setLoading(loading: boolean, error?: string): void {
    this.startBtn.disabled = loading || !!error;
    this.startBtn.textContent = loading ? '加载中…' : '开始';
    this.menuError.classList.toggle('hidden', !error);
    if (error) this.menuError.textContent = `加载失败：${error}`;
  }

  showMenu(best: number | null): void {
    this.menuBest.innerHTML = best !== null ? `最佳成绩 <b>${formatTime(best)}</b>` : '';
    this.hidePause();
    this.hideCountdown();
    this.cache.delete('result');
    this.recIndicator.classList.add('hidden');
    this.menu.classList.remove('hidden');
    this.result.classList.add('hidden');
    this.hud.classList.add('hidden');
  }

  /** Switches from menu/results/pause to the driving view of a fresh run. */
  showDriving(best: number | null): void {
    this.hidePause();
    this.menu.classList.add('hidden');
    this.result.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.timerBest.textContent = best !== null ? `最佳 ${formatTime(best)}` : '';
    this.toastEl.classList.add('hidden');
    this.hintEl.classList.add('hidden');
    this.minimap.reset();
    this.cache.clear();
  }

  showCountdown(text: string, go = false): void {
    clearTimeout(this.countdownTimer);
    this.countdown.classList.remove('hidden');
    this.countdown.innerHTML = '';
    const span = el('span', go ? 'go' : '', text);
    this.countdown.append(span);
    this.cache.set('countdown', text);
    if (go) this.countdownTimer = window.setTimeout(() => this.hideCountdown(), 900);
  }

  hideCountdown(): void {
    clearTimeout(this.countdownTimer);
    this.countdown.classList.add('hidden');
    this.cache.delete('countdown');
  }

  get minimapCanvas(): HTMLCanvasElement {
    return this.minimap.canvas;
  }

  /** The HUD strings currently shown, for the recording overlay ('' when hidden). */
  overlayText(key: OverlayKey): string {
    return this.cache.get(key) ?? '';
  }

  setRecordingEnabled(enabled: boolean, supported: boolean): void {
    for (const b of this.recToggles) {
      b.disabled = !supported;
      b.querySelector('span')!.textContent = !supported ? '录像不可用' : enabled ? '自动录像 开' : '自动录像 关';
      b.classList.toggle('on', supported && enabled);
      b.setAttribute('aria-pressed', String(supported && enabled));
    }
  }

  /** ● REC while frames are captured (DOM only, so it is not in the video). */
  setRecIndicator(on: boolean): void {
    this.recIndicator.classList.toggle('hidden', !on);
  }

  showRecording(view: RecordingView): void {
    this.recBlock.classList.toggle('hidden', !view);
    if (!view) return;
    this.recBtn.disabled = view.state !== 'ready';
    this.recBtn.classList.toggle('busy', view.state === 'finalizing');
    this.recBtn.textContent =
      view.state === 'ready' ? `下载录像 · ${view.summary}` : view.state === 'finalizing' ? '录像处理中…' : '录像失败';
  }

  /** Enter / Space on the results screen: true if a button other than Retry had focus and was clicked. */
  activateResultFocus(): boolean {
    const a = document.activeElement;
    if (!(a instanceof HTMLButtonElement) || !this.result.contains(a) || a.id === 'retry-btn' || a.disabled) return false;
    a.click();
    return true;
  }

  showPause(info: PauseInfo): void {
    this.pauseInfo.textContent = info.countdown
      ? `倒计时已暂停 · ${info.sectionName}`
      : `计时 ${formatTime(info.time)} · ${info.sectionName}`;
    this.checkpointBtn.disabled = info.countdown;
    this.pause.classList.remove('hidden');
    this.root.classList.add('paused');
    this.resumeBtn.focus({ preventScroll: true });
  }

  hidePause(): void {
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.pause.contains(a)) a.blur();
    this.pause.classList.add('hidden');
    this.root.classList.remove('paused');
  }

  /** Enter / Space in the pause menu: activates the focused button (继续 if none). */
  activatePauseFocus(): void {
    const a = document.activeElement;
    if (a instanceof HTMLButtonElement && this.pause.contains(a) && !a.disabled) a.click();
    else this.resumeBtn.click();
  }

  /** ↑ / ↓ in the pause menu. */
  movePauseFocus(delta: number): void {
    const list = Array.from(this.pause.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
    list[next].focus({ preventScroll: true });
  }

  toggleMinimap(): void {
    this.minimap.toggle();
  }

  toast(label: string, time?: number): void {
    clearTimeout(this.toastTimer);
    this.toastEl.innerHTML = '';
    this.toastEl.append(label);
    if (time !== undefined) this.toastEl.append(el('span', 'num', formatTime(time)));
    // restart the entry animation
    this.toastEl.classList.add('hidden');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.remove('hidden');
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), CONFIG.race.toastSeconds * 1000);
  }

  update(f: HudFrame): void {
    const n = this.opts.route.data.checkpoints.length;
    const pct = Math.floor(Math.min(1, Math.max(0, f.progress)) * 100);
    this.set(this.speed, 'speed', String(Math.round(f.speedKmh)));
    this.set(this.timeEl, 'time', formatTime(f.time));
    this.set(this.sectionName, 'section', f.sectionName);
    this.set(this.cpText, 'cp', `检查点 ${f.passed}/${n} · ${pct}%`);
    this.setStyle(this.speedFill, 'speedbar', `${(Math.min(1, f.speedFraction) * 100).toFixed(1)}%`);
    this.minimap.update(f.x, f.z, f.yaw, f.s, f.passed);
    const t = f.turn;
    const dir = t?.direction === 'right' ? '右转' : '左转';
    const dist = !t ? '' : t.distance > 0 ? `${Math.max(10, Math.round(t.distance / 10) * 10)} m` : '';
    this.set(this.turnDist, 'turnDist', dist);
    this.turnDist.classList.toggle('hidden', !dist);
    this.set(this.turnText, 'turn', t ? `${dir} · ${t.name}` : '');
    this.turn.classList.toggle('hidden', !t);
    this.turn.classList.toggle('near', !!t && t.distance < 250);
    if (t && this.cache.get('turnDir') !== t.direction) {
      this.cache.set('turnDir', t.direction);
      this.turnArrow.style.transform = t.direction === 'right' ? 'scaleX(-1)' : '';
    }
    this.set(this.slowEl, 'slow', t?.slowDown ? `减速 ≤ ${t.safeKmh} km/h` : '');
    this.slowEl.classList.toggle('hidden', !t?.slowDown);
    this.set(this.hintEl, 'hint', f.hint ?? '');
    this.hintEl.classList.toggle('hidden', !f.hint);
  }

  showResult(r: ResultInfo): void {
    this.resultTime.textContent = formatTime(r.time);
    this.cache.set('result', this.resultTime.textContent);
    this.recordEl.classList.toggle('hidden', !r.record);
    this.resultBest.innerHTML = r.best !== null ? `最佳成绩 <b>${formatTime(r.best)}</b>` : '';
    this.noteEl.classList.toggle('hidden', !r.assisted);
    this.noteEl.textContent = r.assisted ? '本局使用了调试传送，不计入最佳成绩' : '';
    this.result.classList.remove('hidden');
    this.hintEl.classList.add('hidden');
    this.turn.classList.add('hidden');
    this.slowEl.classList.add('hidden');
  }

  setMuted(muted: boolean): void {
    this.muteEl.classList.toggle('hidden', !muted);
    this.muteBtn.querySelector('span')!.textContent = muted ? '已静音' : '声音 开';
    this.muteBtn.classList.toggle('off', muted);
    this.muteBtn.setAttribute('aria-pressed', String(muted));
  }

  private recToggle(id: string, blurOnClick: boolean): HTMLButtonElement {
    const b = el('button', 'pbtn rec-toggle', '<i></i><span>自动录像 开</span>');
    b.id = id;
    b.type = 'button';
    b.addEventListener('click', () => {
      this.opts.onToggleRecording();
      if (blurOnClick) b.blur();
    });
    this.recToggles.push(b);
    return b;
  }

  /** 白天 / 日落 / 入夜 radio group; applies live behind the menus. */
  private timeSelector(blurOnClick: boolean): HTMLElement {
    const tod = el('div', 'tod');
    tod.setAttribute('role', 'radiogroup');
    tod.setAttribute('aria-label', '时间');
    const btns = TIME_PRESETS.map((t) => {
      const b = el('button', 'tod-btn', TIME_LABELS[t]);
      b.type = 'button';
      b.dataset.time = t;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        setTimeOfDay(t);
        if (blurOnClick) b.blur();
      });
      return b;
    });
    const sync = () => {
      const cur = getTimeOfDay();
      for (const b of btns) {
        const on = b.dataset.time === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      }
    };
    sync();
    onTimeOfDayChange(sync);
    tod.append(el('span', 'tod-label', '时间'), ...btns);
    return tod;
  }

  private set(e: HTMLElement, key: string, text: string): void {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    e.textContent = text;
  }

  private setStyle(e: HTMLElement, key: string, width: string): void {
    if (this.cache.get(key) === width) return;
    this.cache.set(key, width);
    e.style.width = width;
  }
}
