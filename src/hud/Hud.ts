import { CONFIG } from '../config';
import { formatTime } from './format';
import { HUD_CSS } from './styles';

export interface HudOptions {
  startName: string;
  finishName: string;
  /** Checkpoint positions as fractions of the distance to the finish. */
  checkpointFractions: number[];
  turnName: string;
  turnDirection: 'left' | 'right';
  onStart: () => void;
  onRetry: () => void;
}

export interface HudFrame {
  speedKmh: number;
  speedFraction: number;
  time: number;
  /** 0..1 distance fraction to the finish. */
  progress: number;
  sectionName: string;
  passed: number;
  /** Meters to the turn entry (0 inside the turn); null hides the hint. */
  turnDistance: number | null;
  hint: string | null;
}

export interface ResultInfo {
  time: number;
  best: number | null;
  record: boolean;
  assisted: boolean;
}

const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-8a4 4 0 0 0-4-4H5"/><path d="M9 4.5 4.5 9 9 13.5"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** DOM overlay: start screen, countdown, driving HUD and results. */
export class Hud {
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
  private readonly barFill: HTMLElement;
  private readonly ticks: HTMLElement[] = [];
  private readonly turn: HTMLElement;
  private readonly turnText: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly muteEl: HTMLElement;
  private readonly result: HTMLElement;
  private readonly resultTime: HTMLElement;
  private readonly resultBest: HTMLElement;
  private readonly recordEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly cache = new Map<string, string>();
  private toastTimer = 0;
  private countdownTimer = 0;

  constructor(
    root: HTMLElement,
    private readonly opts: HudOptions,
  ) {
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    const n = opts.checkpointFractions.length;

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
        <span class="keys"><kbd>M</kbd></span><span>静音</span>
      </div>
      <div class="best num"></div>`;
    this.menuBest = card.querySelector('.best')!;
    this.startBtn = el('button', 'btn');
    this.startBtn.id = 'start-btn';
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => opts.onStart());
    this.menuError = el('div', 'error hidden');
    card.append(this.startBtn, el('div', 'btn-hint', '按 Enter / 空格 开始'), this.menuError);
    card.append(el('div', 'credit', 'Xiaomi SU7 model by Car2022 (CC BY 4.0) · Map data © OpenStreetMap contributors'));
    this.menu.append(card);

    // countdown
    this.countdown = el('div', 'hidden');
    this.countdown.id = 'countdown';

    // driving HUD
    this.hud = el('div', 'hidden');
    this.hud.id = 'hud';
    const tl = el('div', 'top-left panel');
    tl.innerHTML = `
      <div class="section"><span class="section-name"></span><span class="cp num"></span></div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="bar-ends"><span>${opts.startName}</span><span>${opts.finishName}</span></div>`;
    this.sectionName = tl.querySelector('.section-name')!;
    this.cpText = tl.querySelector('.cp')!;
    this.barFill = tl.querySelector('.bar-fill')!;
    const bar = tl.querySelector('.bar')!;
    for (const f of opts.checkpointFractions) {
      const t = el('div', 'tick');
      t.style.left = `${(f * 100).toFixed(2)}%`;
      bar.append(t);
      this.ticks.push(t);
    }
    const flag = el('div', 'tick flag');
    flag.style.left = '100%';
    bar.append(flag);
    this.cpText.textContent = `检查点 0/${n}`;

    const tc = el('div', 'top-center');
    const timer = el('div', 'timer panel');
    this.timeEl = el('div', 'num');
    this.timeEl.id = 'hud-time';
    this.timeEl.textContent = formatTime(0);
    this.timerBest = el('div', 'timer-best num');
    timer.append(this.timeEl, this.timerBest);
    this.turn = el('div', 'turn panel hidden', ARROW);
    if (opts.turnDirection === 'right') this.turn.querySelector('svg')!.style.transform = 'scaleX(-1)';
    this.turnText = el('span', 'num');
    this.turn.append(this.turnText);
    tc.append(timer, this.turn);

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
    this.hud.append(tl, tc, br, this.toastEl, this.hintEl, this.muteEl);

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
    this.result.append(rc);

    root.append(this.hud, this.countdown, this.menu, this.result);
    this.setLoading(true);
  }

  get menuVisible(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  get resultVisible(): boolean {
    return !this.result.classList.contains('hidden');
  }

  get startEnabled(): boolean {
    return this.menuVisible && !this.startBtn.disabled;
  }

  setLoading(loading: boolean, error?: string): void {
    this.startBtn.disabled = loading || !!error;
    this.startBtn.textContent = loading ? '加载中…' : '开始';
    this.menuError.classList.toggle('hidden', !error);
    if (error) this.menuError.textContent = `加载失败：${error}`;
  }

  showMenu(best: number | null): void {
    this.menuBest.innerHTML = best !== null ? `最佳成绩 <b>${formatTime(best)}</b>` : '';
    this.menu.classList.remove('hidden');
    this.result.classList.add('hidden');
    this.hud.classList.add('hidden');
  }

  /** Switches from menu/results to the driving view. */
  showDriving(best: number | null): void {
    this.menu.classList.add('hidden');
    this.result.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.timerBest.textContent = best !== null ? `最佳 ${formatTime(best)}` : '';
    this.toastEl.classList.add('hidden');
    this.ticks.forEach((t) => t.classList.remove('done'));
    this.cache.clear();
  }

  showCountdown(text: string, go = false): void {
    clearTimeout(this.countdownTimer);
    this.countdown.classList.remove('hidden');
    this.countdown.innerHTML = '';
    const span = el('span', go ? 'go' : '', text);
    this.countdown.append(span);
    if (go) this.countdownTimer = window.setTimeout(() => this.countdown.classList.add('hidden'), 900);
  }

  hideCountdown(): void {
    clearTimeout(this.countdownTimer);
    this.countdown.classList.add('hidden');
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
    const n = this.opts.checkpointFractions.length;
    this.set(this.speed, 'speed', String(Math.round(f.speedKmh)));
    this.set(this.timeEl, 'time', formatTime(f.time));
    this.set(this.sectionName, 'section', f.sectionName);
    this.set(this.cpText, 'cp', `检查点 ${f.passed}/${n}`);
    this.setStyle(this.barFill, 'bar', `${(Math.min(1, Math.max(0, f.progress)) * 100).toFixed(1)}%`);
    this.setStyle(this.speedFill, 'speedbar', `${(Math.min(1, f.speedFraction) * 100).toFixed(1)}%`);
    if (this.cache.get('passed') !== String(f.passed)) {
      this.cache.set('passed', String(f.passed));
      this.ticks.forEach((t, i) => t.classList.toggle('done', i < f.passed));
    }
    const dir = this.opts.turnDirection === 'left' ? '左转' : '右转';
    const turnText =
      f.turnDistance === null
        ? ''
        : f.turnDistance > 0
          ? `前方 ${Math.max(10, Math.round(f.turnDistance / 10) * 10)} m ${dir} · ${this.opts.turnName}`
          : `${dir} · ${this.opts.turnName}`;
    this.set(this.turnText, 'turn', turnText);
    this.turn.classList.toggle('hidden', !turnText);
    this.turn.classList.toggle('near', f.turnDistance !== null && f.turnDistance < 200);
    this.set(this.hintEl, 'hint', f.hint ?? '');
    this.hintEl.classList.toggle('hidden', !f.hint);
  }

  showResult(r: ResultInfo): void {
    this.resultTime.textContent = formatTime(r.time);
    this.recordEl.classList.toggle('hidden', !r.record);
    this.resultBest.innerHTML = r.best !== null ? `最佳成绩 <b>${formatTime(r.best)}</b>` : '';
    this.noteEl.classList.toggle('hidden', !r.assisted);
    this.noteEl.textContent = r.assisted ? '本局使用了调试传送，不计入最佳成绩' : '';
    this.result.classList.remove('hidden');
    this.hintEl.classList.add('hidden');
    this.turn.classList.add('hidden');
  }

  setMuted(muted: boolean): void {
    this.muteEl.classList.toggle('hidden', !muted);
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
