import { BUILD } from '../hud/version';

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'tail' | 'finalizing' | 'ready' | 'error';

export interface RecordingState {
  /** 自动录像 setting. */
  enabled: boolean;
  supported: boolean;
  status: RecordingStatus;
  /** Frames are being captured right now. */
  active: boolean;
  mimeType: string;
  bytes: number;
  /** Recorded seconds, paused time excluded. */
  duration: number;
  width: number;
  height: number;
  /** Capture rate: 60, or 30 after sustained low game FPS. */
  fps: number;
}

/** HUD strings (exactly as shown in the DOM) and the minimap canvas, drawn into the video. */
export type OverlayKey = 'time' | 'speed' | 'section' | 'cp' | 'turn' | 'turnDist' | 'slow' | 'countdown' | 'result';

export interface OverlaySource {
  readonly minimapCanvas: HTMLCanvasElement;
  overlayText(key: OverlayKey): string;
}

interface AudioSource {
  captureStream(): MediaStream | null;
}

const STORAGE_KEY = 'shenzhen-drive.record.v1';
/** Preference order; MP4 first (plays everywhere, with AAC sound). */
const MIME_AV = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];
const MIME_V = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
/** Requested video rate; Chrome's H.264 encoder on macOS runs ~2× over on this footage, so 4 Mbps lands near 8 Mbps. */
const VIDEO_BPS = 4_000_000;
const AUDIO_BPS = 128_000;
/** Recording continues this long after a legal finish (ms). */
const TAIL_MS = 2000;
/** Below this game FPS for LOW_FPS_SECONDS, capture drops to every other frame (30 fps). */
const LOW_FPS = 48;
const LOW_FPS_SECONDS = 2;

const ACCENT = '#2ec8de';
const PANEL = 'rgba(9, 13, 22, 0.62)';
const LINE = 'rgba(255, 255, 255, 0.12)';
const TEXT = '#eef3f8';
const DIM = 'rgba(238, 243, 248, 0.72)';
const FONT = '-apple-system, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif';

export function pickMimeType(withAudio: boolean): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of withAudio ? MIME_AV : MIME_V) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function initialEnabled(): boolean {
  const q = new URLSearchParams(location.search).get('record');
  if (q === '0' || q === '1') return q === '1';
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Automatic gameplay recording. A 2D compositor canvas at a fixed resolution (1920×1080,
 * 1280×720 with ?recres=720 or when the game already runs slowly) receives the WebGL
 * canvas, letterboxed, plus a Canvas 2D copy of the HUD each frame; captureStream(60) and
 * the audio engine's mix feed a MediaRecorder. Only one recording is held in memory.
 */
export class GameRecorder {
  readonly supported: boolean;
  /** Called whenever status / setting changes (REC indicator, download button). */
  onChange: (() => void) | null = null;
  private enabledFlag: boolean;
  private status: RecordingStatus = 'idle';
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private rec: MediaRecorder | null = null;
  private token = 0;
  private chunks: Blob[] = [];
  private bytes = 0;
  private mime = '';
  private blob: Blob | null = null;
  private url: string | null = null;
  private fileName = '';
  private startedAt = new Date();
  private activeSince = 0;
  private recorded = 0;
  private tailTimer = 0;
  private W = 1920;
  private H = 1080;
  private halfRate = false;
  private lowFor = 0;
  private frameIndex = 0;
  // letterbox layout of the last source size, and fonts scaled to it
  private srcW = 0;
  private srcH = 0;
  private bx = 0;
  private by = 0;
  private bw = 0;
  private bh = 0;
  private u = 1;
  private readonly fonts = { section: '', cp: '', time: '', speed: '', unit: '', turn: '', tag: '', count: '', banner: '', bannerTitle: '' };
  private readonly tag = `SHENZHEN DRIVE v${BUILD.version}`;
  private turnDist = '';
  private turnName = '';
  private turnLabel = '';

  constructor(private readonly audio: AudioSource) {
    this.supported = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
    this.enabledFlag = this.supported && initialEnabled();
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** Frames are composited and captured (recording or the post-finish tail). */
  get capturing(): boolean {
    return this.status === 'recording' || this.status === 'tail';
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  /** Turning it off discards a recording in progress; turning it on applies from the next run. */
  setEnabled(on: boolean): void {
    if (!this.supported) return;
    this.enabledFlag = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      // not persisted
    }
    if (!on && this.status !== 'ready') this.discard();
    this.onChange?.();
  }

  state(): RecordingState {
    return {
      enabled: this.enabledFlag,
      supported: this.supported,
      status: this.status,
      active: this.capturing,
      mimeType: this.mime,
      bytes: this.bytes,
      duration: this.duration(),
      width: this.W,
      height: this.H,
      fps: this.halfRate ? 30 : 60,
    };
  }

  /** 'MP4 · 3:42 · 186 MB' */
  summary(): string {
    const d = Math.round(this.duration());
    const mb = this.bytes / 1e6;
    const size = mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
    return `${this.mime.startsWith('video/mp4') ? 'MP4' : 'WebM'} · ${Math.floor(d / 60)}:${pad2(d % 60)} · ${size}`;
  }

  /** Countdown start: discards any previous recording and starts a new one (if enabled). */
  start(gameFps: number): void {
    this.discard();
    if (!this.enabledFlag) return;
    const low = new URLSearchParams(location.search).get('recres') === '720' || (gameFps > 0 && gameFps < LOW_FPS);
    this.W = low ? 1280 : 1920;
    this.H = low ? 720 : 1080;
    try {
      this.ensureCanvas();
      const tracks: MediaStreamTrack[] = [this.videoTrack!];
      const audio = this.audio.captureStream()?.getAudioTracks()[0];
      if (audio) tracks.push(audio);
      this.mime = pickMimeType(!!audio);
      const bps = Number(new URLSearchParams(location.search).get('recbps')) || VIDEO_BPS;
      const rec = new MediaRecorder(new MediaStream(tracks), {
        ...(this.mime ? { mimeType: this.mime } : {}),
        videoBitsPerSecond: bps,
        audioBitsPerSecond: AUDIO_BPS,
      });
      this.mime = rec.mimeType || this.mime;
      const token = ++this.token;
      rec.ondataavailable = (e) => {
        if (token !== this.token || !e.data.size) return;
        this.chunks.push(e.data);
        this.bytes += e.data.size;
      };
      rec.onstop = () => {
        if (token === this.token) this.finalize();
      };
      rec.onerror = (e) => {
        console.warn('[recording] MediaRecorder error:', e);
        if (token === this.token) this.fail();
      };
      this.rec = rec;
      this.startedAt = new Date();
      this.halfRate = false;
      this.lowFor = 0;
      this.srcW = this.srcH = 0;
      this.clear();
      rec.start(1000);
      this.activeSince = performance.now();
      this.status = 'recording';
    } catch (e) {
      console.warn('[recording] start failed:', e);
      this.fail();
      return;
    }
    this.onChange?.();
  }

  pause(): void {
    if (this.status !== 'recording' || this.rec?.state !== 'recording') return;
    this.rec.pause();
    this.recorded += performance.now() - this.activeSince;
    this.status = 'paused';
    this.onChange?.();
  }

  resume(): void {
    if (this.status !== 'paused' || this.rec?.state !== 'paused') return;
    this.rec.resume();
    this.activeSince = performance.now();
    this.status = 'recording';
    this.onChange?.();
  }

  /** Legal finish: keeps recording TAIL_MS for the finish moment, then finalizes. raceTime names the file. */
  finish(raceTime: number): void {
    if (this.status !== 'recording') return;
    const cs = Math.max(0, Math.floor(raceTime * 100 + 1e-6));
    const d = this.startedAt;
    const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    const time = `${pad2(Math.floor(cs / 6000))}m${pad2(Math.floor(cs / 100) % 60)}s${pad2(cs % 100)}`;
    this.fileName = `shenzhen-drive-${date}-${time}.${this.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
    this.status = 'tail';
    this.onChange?.();
    this.tailTimer = window.setTimeout(() => {
      if (this.status !== 'tail' || !this.rec) return;
      this.recorded += performance.now() - this.activeSince;
      this.status = 'finalizing';
      this.rec.stop();
      this.onChange?.();
    }, TAIL_MS);
  }

  /** Restart / back to menu / setting off: drops the recording (in progress or finished). */
  discard(): void {
    clearTimeout(this.tailTimer);
    this.token++;
    if (this.rec && this.rec.state !== 'inactive') {
      try {
        this.rec.stop();
      } catch {
        // already stopped
      }
    }
    this.rec = null;
    this.chunks = [];
    this.bytes = 0;
    this.recorded = 0;
    this.blob = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    const changed = this.status !== 'idle';
    this.status = 'idle';
    if (changed) this.onChange?.();
  }

  /** Saves the finished recording through a download link; nothing is written otherwise. */
  download(): boolean {
    if (!this.url) return false;
    const a = document.createElement('a');
    a.href = this.url;
    a.download = this.fileName;
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  }

  /** Per rendered frame, right after the WebGL render (same task, so the drawing buffer is intact). */
  composite(src: HTMLCanvasElement, hud: OverlaySource, dt: number, gameFps: number): void {
    if (!this.capturing || !this.ctx) return;
    this.lowFor = gameFps < LOW_FPS ? this.lowFor + dt : 0;
    if (!this.halfRate && this.lowFor > LOW_FPS_SECONDS) {
      this.halfRate = true;
      console.info('[recording] sustained low FPS: capturing every other frame (30 fps)');
    }
    if (this.halfRate && this.frameIndex++ % 2) return;
    const c = this.ctx;
    if (src.width !== this.srcW || src.height !== this.srcH) this.layout(src.width, src.height);
    c.drawImage(src, 0, 0, this.srcW, this.srcH, this.bx, this.by, this.bw, this.bh);
    this.drawOverlay(c, hud);
  }

  private duration(): number {
    const live = this.status === 'recording' || this.status === 'tail' ? performance.now() - this.activeSince : 0;
    return (this.recorded + live) / 1000;
  }

  private ensureCanvas(): void {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false })!;
      this.videoTrack = this.canvas.captureStream(60).getVideoTracks()[0];
    }
    this.canvas.width = this.W;
    this.canvas.height = this.H;
  }

  private clear(): void {
    const c = this.ctx!;
    c.fillStyle = '#000';
    c.fillRect(0, 0, this.W, this.H);
  }

  /** Letterbox rectangle for a source size, and overlay fonts scaled like a 720 px tall viewport. */
  private layout(sw: number, sh: number): void {
    this.srcW = sw;
    this.srcH = sh;
    const k = Math.min(this.W / sw, this.H / sh);
    this.bw = Math.round(sw * k);
    this.bh = Math.round(sh * k);
    this.bx = Math.round((this.W - this.bw) / 2);
    this.by = Math.round((this.H - this.bh) / 2);
    this.clear();
    const u = (this.u = this.bh / 720);
    const f = this.fonts;
    const px = (w: number, size: number) => `${w} ${Math.round(size * u)}px ${FONT}`;
    f.section = px(700, 15);
    f.cp = px(500, 12);
    f.time = px(800, 34);
    f.speed = px(800, 64);
    f.unit = px(600, 13);
    f.turn = px(700, 18);
    f.tag = px(600, 12);
    f.count = px(900, 150);
    f.banner = px(800, 56);
    f.bannerTitle = px(700, 15);
  }

  private panel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke: string): void {
    c.beginPath();
    c.roundRect(x, y, w, h, 12 * this.u);
    c.fillStyle = fill;
    c.fill();
    c.lineWidth = Math.max(1, this.u);
    c.strokeStyle = stroke;
    c.stroke();
  }

  private drawOverlay(c: CanvasRenderingContext2D, hud: OverlaySource): void {
    const u = this.u;
    const x0 = this.bx;
    const y0 = this.by;
    const w = this.bw;
    const h = this.bh;
    const f = this.fonts;
    c.textBaseline = 'alphabetic';

    // minimap panel, top-left
    const mx = x0 + 18 * u;
    const my = y0 + 18 * u;
    this.panel(c, mx, my, 300 * u, 130 * u, PANEL, LINE);
    c.fillStyle = TEXT;
    c.font = f.section;
    c.textAlign = 'left';
    c.fillText(hud.overlayText('section'), mx + 14 * u, my + 22 * u);
    c.fillStyle = DIM;
    c.font = f.cp;
    c.textAlign = 'right';
    c.fillText(hud.overlayText('cp'), mx + 286 * u, my + 22 * u);
    const mm = hud.minimapCanvas;
    if (mm.width > 0) c.drawImage(mm, mx, my + 26 * u, 300 * u, 104 * u);

    // timer, top-center, with the turn hint / slow-down warning below
    const cx = x0 + w / 2;
    this.panel(c, cx - 100 * u, y0 + 18 * u, 200 * u, 52 * u, PANEL, LINE);
    c.fillStyle = TEXT;
    c.font = f.time;
    c.textAlign = 'center';
    c.fillText(hud.overlayText('time'), cx, y0 + 56 * u);
    let ty = y0 + 80 * u;
    const turn = hud.overlayText('turn');
    if (turn) {
      this.panel(c, cx - 150 * u, ty, 300 * u, 44 * u, 'rgba(40, 26, 6, 0.66)', 'rgba(255, 181, 71, 0.6)');
      c.font = f.turn;
      c.fillStyle = '#ffd08a';
      c.textAlign = 'center';
      const dist = hud.overlayText('turnDist');
      if (dist !== this.turnDist || turn !== this.turnName) {
        this.turnDist = dist;
        this.turnName = turn;
        this.turnLabel = dist ? `${dist}  ·  ${turn}` : turn;
      }
      c.fillText(this.turnLabel, cx, ty + 29 * u);
      ty += 54 * u;
    }
    const slow = hud.overlayText('slow');
    if (slow) {
      this.panel(c, cx - 130 * u, ty, 260 * u, 42 * u, 'rgba(150, 18, 18, 0.8)', 'rgba(255, 90, 80, 0.85)');
      c.font = f.turn;
      c.fillStyle = '#fff';
      c.fillText(slow, cx, ty + 28 * u);
    }

    // speed, bottom-right
    const sx = x0 + w - 22 * u;
    const sy = y0 + h - 22 * u;
    this.panel(c, sx - 170 * u, sy - 104 * u, 170 * u, 104 * u, PANEL, LINE);
    c.textAlign = 'right';
    c.fillStyle = TEXT;
    c.font = f.speed;
    c.fillText(hud.overlayText('speed'), sx - 20 * u, sy - 40 * u);
    c.fillStyle = DIM;
    c.font = f.unit;
    c.fillText('KM/H', sx - 20 * u, sy - 20 * u);

    // countdown digits and the finish banner
    const count = hud.overlayText('countdown');
    if (count) {
      c.font = f.count;
      c.textAlign = 'center';
      c.lineWidth = 6 * u;
      c.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      c.strokeText(count, cx, y0 + 0.14 * h + 150 * u);
      c.fillStyle = count === 'GO' ? ACCENT : '#fff';
      c.fillText(count, cx, y0 + 0.14 * h + 150 * u);
    }
    const result = hud.overlayText('result');
    if (result) {
      const by = y0 + h * 0.36;
      this.panel(c, cx - 190 * u, by, 380 * u, 120 * u, 'rgba(9, 13, 22, 0.72)', 'rgba(46, 200, 222, 0.5)');
      c.textAlign = 'center';
      c.fillStyle = ACCENT;
      c.font = f.bannerTitle;
      c.fillText('抵达终点', cx, by + 32 * u);
      c.fillStyle = TEXT;
      c.font = f.banner;
      c.fillText(result, cx, by + 96 * u);
    }

    // corner tag, bottom-left
    c.textAlign = 'left';
    c.font = f.tag;
    c.fillStyle = 'rgba(255, 255, 255, 0.55)';
    c.fillText(this.tag, x0 + 16 * u, y0 + h - 14 * u);
  }

  private finalize(): void {
    this.blob = new Blob(this.chunks, { type: this.mime.split(';')[0] || 'video/webm' });
    this.chunks = [];
    this.bytes = this.blob.size;
    this.url = URL.createObjectURL(this.blob);
    this.rec = null;
    this.status = 'ready';
    this.onChange?.();
  }

  private fail(): void {
    this.token++;
    this.rec = null;
    this.chunks = [];
    this.status = 'error';
    this.onChange?.();
  }
}
