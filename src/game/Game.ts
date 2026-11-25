import * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import { ChaseCamera } from '../camera/ChaseCamera';
import { CockpitCamera } from '../camera/CockpitCamera';
import { getViewMode, toggleViewMode, type ViewMode } from '../camera/viewMode';
import { CONFIG, KMH } from '../config';
import { DebugOverlay } from '../debug/DebugOverlay';
import type { Hud } from '../hud/Hud';
import { turnHint } from '../hud/turnHint';
import type { Input } from '../input/Input';
import { loadBestTime, submitBestTime } from '../race/bestTime';
import { Race, type Phase, type RaceEvent } from '../race/Race';
import type { GameRecorder, RecordingState } from '../recording/Recorder';
import type { Route } from '../route/Route';
import type { CarVisual } from '../vehicle/CarVisual';
import { NO_INPUT, Vehicle, type DriveInput } from '../vehicle/Vehicle';
import type { FrameInfo, RenderPipeline, SceneryModule } from './contracts';

export interface GameDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  route: Route;
  env: SceneryModule;
  city: SceneryModule;
  pipeline: RenderPipeline;
  audio: AudioEngine;
  car: CarVisual;
  hud: Hud;
  input: Input;
  recorder: GameRecorder;
  /** Container for the ?debug overlay; null disables debug mode. */
  debugRoot: HTMLElement | null;
}

export interface GameState {
  phase: Phase;
  time: number;
  /** m/s, signed */
  speed: number;
  x: number;
  z: number;
  yaw: number;
  s: number;
  d: number;
  checkpointsPassed: number;
  checkpointCount: number;
  /** Wall impacts above the thud threshold during the current run (statistic only, no penalty). */
  wallHits: number;
  fps: number;
  /** Countdown / race frozen by the pause menu (Esc / P, window blur, hidden tab). */
  paused: boolean;
  minimap: 'overview' | 'local';
  /** Selected driving camera (the start menu always shows the orbit view). */
  view: ViewMode;
  /** Camera actually rendering this frame. */
  activeCamera: ActiveCamera;
  recording: RecordingState;
}

type ActiveCamera = 'orbit' | 'chase' | 'cockpit' | 'free';

/** Debug key 0 places the car this far before the next turn (m). */
const TURN_TELEPORT_OFFSET = 250;

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** Owns the frame loop: fixed-rate physics with interpolated rendering, race flow, HUD, audio and debug. */
export class Game {
  readonly vehicle: Vehicle;
  readonly race: Race;
  private readonly chase: ChaseCamera;
  private readonly cockpit: CockpitCamera;
  private activeCamera: ActiveCamera = 'orbit';
  private readonly debugUi: DebugOverlay | null;
  private readonly prev = { x: 0, z: 0, yaw: 0 };
  private readonly focus = new THREE.Vector3();
  private readonly frameInfo: FrameInfo;
  private readonly tan = { x: 0, z: 0 };
  private input: DriveInput = NO_INPUT;
  private best = loadBestTime();
  private lastNow: number | null = null;
  private elapsed = 0;
  private acc = 0;
  private fps = 60;
  private fpsFrames = 0;
  private fpsTime = 0;
  private stuck = 0;
  private pinned = 0;
  private wrongWay = 0;
  private wallHits = 0;
  private muted = false;
  private audioStarted = false;
  private onFirstFrame: (() => void) | null = null;

  constructor(private readonly deps: GameDeps) {
    const { route } = deps;
    this.vehicle = new Vehicle(route);
    this.race = new Race({ checkpoints: route.data.checkpoints, finish: route.data.finish, startS: CONFIG.race.startS });
    this.chase = new ChaseCamera(deps.camera);
    this.cockpit = new CockpitCamera(deps.camera);
    this.debugUi = deps.debugRoot ? new DebugOverlay(deps.debugRoot, deps.renderer, deps.camera) : null;
    this.frameInfo = { dt: 0, time: 0, focus: this.focus, s: 0, speed: 0 };
    this.placeCar(CONFIG.race.startS, true);
    deps.input.onPress = (code) => this.onKey(code);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pause();
        deps.audio.suspend();
      } else if (!this.paused) {
        deps.audio.resume();
      }
      this.lastNow = null;
    });
    window.addEventListener('blur', () => this.pause());
    deps.recorder.onChange = () => this.syncRecording();
    this.syncRecording();
  }

  get paused(): boolean {
    return this.race.paused;
  }

  /** Shows the menu and starts rendering; onReady runs after the first frame. */
  start(onReady?: () => void): void {
    this.race.ready();
    this.deps.hud.showMenu(this.best);
    this.onFirstFrame = onReady ?? null;
    this.deps.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Start button / Retry: fresh run from the start line with a countdown. */
  startRace(): void {
    const phase = this.race.phase;
    if (phase === 'menu' ? !this.deps.hud.startEnabled : phase !== 'finished') return;
    this.beginRun(phase !== 'menu');
  }

  /** Pause menu 重新开始本局: the current run starts over from the start line with a countdown. */
  restartRace(): void {
    const phase = this.race.phase;
    if (phase !== 'countdown' && phase !== 'racing') return;
    this.beginRun(true);
  }

  /** Pause menu 返回主菜单: abandons the run. */
  quitToMenu(): void {
    const phase = this.race.phase;
    if (phase !== 'countdown' && phase !== 'racing') return;
    this.deps.recorder.discard();
    this.race.toMenu();
    this.placeCar(CONFIG.race.startS, true);
    this.deps.hud.showMenu(this.best);
    if (!document.hidden) this.deps.audio.resume();
  }

  /** 自动录像 toggle in the start / pause menus. */
  toggleRecording(): void {
    this.deps.recorder.setEnabled(!this.deps.recorder.enabled);
  }

  downloadRecording(): boolean {
    return this.deps.recorder.download();
  }

  private syncRecording(): void {
    const { recorder, hud } = this.deps;
    hud.setRecordingEnabled(recorder.enabled, recorder.supported);
    hud.setRecIndicator(recorder.capturing);
    if (this.race.phase !== 'finished') return;
    const st = recorder.state().status;
    hud.showRecording(
      st === 'ready'
        ? { state: 'ready', summary: recorder.summary() }
        : st === 'tail' || st === 'finalizing'
          ? { state: 'finalizing' }
          : st === 'error'
            ? { state: 'error' }
            : null,
    );
  }

  /** Esc / P, window blur, hidden tab: freezes physics, countdown and timer, suspends audio. */
  pause(): boolean {
    if (!this.race.pause()) return false;
    this.deps.recorder.pause();
    this.deps.audio.suspend();
    this.deps.hud.showPause({
      sectionName: this.deps.route.sectionAt(this.vehicle.s).name,
      time: this.race.time,
      countdown: this.race.phase === 'countdown',
    });
    return true;
  }

  resume(): boolean {
    if (!this.race.resume()) return false;
    this.deps.hud.hidePause();
    if (!document.hidden) this.deps.audio.resume();
    this.deps.recorder.resume();
    return true;
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.deps.audio.setMuted(this.muted);
    this.deps.hud.setMuted(this.muted);
  }

  /** R (also from the pause menu): back to the last passed checkpoint (or the start); the timer keeps running. */
  resetToCheckpoint(): void {
    if (this.race.phase !== 'racing') return;
    this.resume();
    this.placeCar(this.race.resetS(), true);
    this.race.syncS(this.vehicle.s);
    this.stuck = this.pinned = this.wrongWay = 0;
  }

  private beginRun(snapCamera: boolean): void {
    this.wallHits = 0;
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.deps.audio.start().catch((e) => console.warn('[audio] start failed:', e));
    } else if (this.race.paused && !document.hidden) {
      this.deps.audio.resume();
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.placeCar(CONFIG.race.startS, snapCamera);
    this.race.begin();
    this.deps.hud.hideCountdown();
    this.deps.hud.showDriving(this.best);
    this.deps.hud.showRecording(null);
    // A new run always replaces the previous recording; it starts with the countdown.
    this.deps.recorder.start(this.fps);
    this.stuck = this.pinned = this.wrongWay = 0;
  }

  /** Debug / test teleport to lane center at s; earlier checkpoints count as passed, the run as assisted. */
  teleport(s: number): void {
    const margin = CONFIG.vehicle.length;
    const t = Math.min(
      this.deps.route.length - CONFIG.collision.endMargin - margin,
      Math.max(CONFIG.collision.startMargin + margin, s),
    );
    this.placeCar(t, true);
    this.race.teleportTo(t);
  }

  getState(): GameState {
    const v = this.vehicle;
    return {
      phase: this.race.phase,
      time: this.race.time,
      speed: v.speed,
      x: v.x,
      z: v.z,
      yaw: v.yaw,
      s: v.s,
      d: v.d,
      checkpointsPassed: this.race.passed,
      checkpointCount: this.race.checkpointCount,
      wallHits: this.wallHits,
      fps: this.fps,
      paused: this.race.paused,
      minimap: this.deps.hud.minimapMode,
      view: getViewMode(),
      activeCamera: this.activeCamera,
      recording: this.deps.recorder.state(),
    };
  }

  private placeCar(s: number, snapCamera: boolean): void {
    const v = this.vehicle;
    v.place(s, CONFIG.race.laneD);
    v.impact = 0;
    this.prev.x = v.x;
    this.prev.z = v.z;
    this.prev.yaw = v.yaw;
    if (snapCamera) {
      this.chase.snap(v.x, v.z, v.yaw);
      this.cockpit.reset();
    }
  }

  /** Cuts to another camera: the chase view snaps behind the car unless it blends in from the menu orbit. */
  private switchCamera(next: ActiveCamera, x: number, z: number, yaw: number): void {
    const prev = this.activeCamera;
    this.activeCamera = next;
    if (next === 'chase' && prev !== 'orbit') this.chase.snap(x, z, yaw);
    if (next === 'cockpit') this.cockpit.reset();
    const cam = this.deps.camera;
    const near = next === 'cockpit' ? CONFIG.cockpit.near : CONFIG.camera.near;
    if (cam.near !== near) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  private onKey(code: string): boolean {
    const phase = this.race.phase;
    const { hud } = this.deps;
    if (this.paused) {
      switch (code) {
        case 'Escape':
        case 'KeyP':
          this.resume();
          return true;
        case 'Enter':
        case 'Space':
          hud.activatePauseFocus();
          return true;
        case 'ArrowUp':
        case 'ArrowDown':
          hud.movePauseFocus(code === 'ArrowUp' ? -1 : 1);
          return true;
        case 'KeyR':
          this.resetToCheckpoint();
          return true;
        case 'KeyM':
          this.toggleMute();
          return true;
        case 'KeyN':
          hud.toggleMinimap();
          return true;
        case 'KeyC':
          toggleViewMode();
          return true;
      }
      return false;
    }
    switch (code) {
      case 'Escape':
      case 'KeyP':
        return this.pause();
      case 'KeyN':
        hud.toggleMinimap();
        return true;
      case 'KeyC':
        toggleViewMode();
        return true;
      case 'KeyR':
        this.resetToCheckpoint();
        return true;
      case 'KeyM':
        this.toggleMute();
        return true;
      case 'Enter':
      case 'Space':
        if (phase === 'finished' && hud.activateResultFocus()) return true;
        if (phase === 'menu' || phase === 'finished') {
          this.startRace();
          return true;
        }
        return false;
    }
    if (!this.debugUi) return false;
    if (code === 'KeyF') {
      this.debugUi.toggleFreeCam(this.focus);
      return true;
    }
    const m = /^Digit(\d)$/.exec(code);
    if (m) {
      const i = Number(m[1]);
      const { route } = this.deps;
      if (i === 0) {
        // Next turn ahead of the car; repeated presses cycle through all turns.
        const turns = route.turns;
        const next = turns.find((t) => t.s0 - TURN_TELEPORT_OFFSET > this.vehicle.s + 20) ?? turns[0];
        if (next) this.teleport(next.s0 - TURN_TELEPORT_OFFSET);
      } else if (i <= route.data.checkpoints.length) this.teleport(route.data.checkpoints[i - 1].s);
      return true;
    }
    return false;
  }

  private driveInput(): DriveInput {
    const { input } = this.deps;
    switch (this.race.phase) {
      case 'racing':
        return { throttle: input.throttle, brake: input.brake, steer: input.steer };
      case 'finished':
        return { throttle: 0, brake: this.vehicle.speed > 0.3 ? 0.6 : 0, steer: 0 };
      default:
        return NO_INPUT;
    }
  }

  private fixedStep(h: number): void {
    const v = this.vehicle;
    const { route, audio } = this.deps;
    this.prev.x = v.x;
    this.prev.z = v.z;
    this.prev.yaw = v.yaw;
    this.input = this.driveInput();
    const n = CONFIG.physics.substeps;
    for (let i = 0; i < n; i++) v.step(this.input, h / n);
    if (v.impact > 0) {
      if (v.impact >= CONFIG.collision.thudMinSpeed) {
        audio.collision(Math.min(1, v.impact / 25));
        if (this.race.phase === 'racing') this.wallHits++;
      }
      v.impact = 0;
    }
    route.tangentAt(route.clampS(v.s), this.tan);
    const headingDot = -Math.sin(v.yaw) * this.tan.x - Math.cos(v.yaw) * this.tan.z;
    for (const e of this.race.update(h, v.s, v.speed * headingDot)) this.onRaceEvent(e);

    if (this.race.phase === 'racing') {
      this.stuck = this.input.throttle > 0 && Math.abs(v.speed) < 0.5 ? this.stuck + h : 0;
      this.pinned = v.inContact && Math.abs(v.speed) < 2 ? this.pinned + h : Math.max(0, this.pinned - h);
      this.wrongWay = headingDot < -0.3 && v.speed > 3 ? this.wrongWay + h : 0;
    } else {
      this.stuck = this.pinned = this.wrongWay = 0;
    }
  }

  private onRaceEvent(e: RaceEvent): void {
    const { hud, audio } = this.deps;
    switch (e.type) {
      case 'tick':
        hud.showCountdown(String(e.value));
        audio.beep(false);
        break;
      case 'go':
        hud.showCountdown('GO', true);
        audio.beep(true);
        break;
      case 'checkpoint':
        hud.toast(`检查点 ${e.index + 1}/${this.race.checkpointCount} · ${e.name}`, e.time);
        audio.chime(false);
        break;
      case 'finish': {
        audio.chime(true);
        const assisted = this.race.assisted;
        const record = !assisted && submitBestTime(e.time);
        this.best = loadBestTime();
        hud.showResult({ time: e.time, best: this.best, record, assisted, wallHits: this.wallHits });
        this.deps.recorder.finish(e.time);
        this.syncRecording();
        break;
      }
    }
  }

  private hint(): string | null {
    if (this.race.phase !== 'racing') return null;
    if (this.wrongWay > 1) return '方向错误 · 按 R 回到检查点';
    const limit = CONFIG.race.stuckSeconds;
    if (this.stuck > limit || this.pinned > limit) return '按 R 回到检查点';
    return null;
  }

  private frame(nowMs: number): void {
    const { renderer, env, city, pipeline, car, hud, audio, route } = this.deps;
    const now = nowMs / 1000;
    const dt = this.lastNow === null ? 1 / 60 : Math.min(Math.max(now - this.lastNow, 0), CONFIG.physics.maxFrameDt);
    this.lastNow = now;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    // Paused: physics, race clock and scenery time stand still; the frame is still rendered
    // (the pause menu can switch the time of day).
    const h = 1 / CONFIG.physics.hz;
    if (!this.paused) {
      this.elapsed += dt;
      this.acc += dt;
      while (this.acc >= h) {
        this.fixedStep(h);
        this.acc -= h;
      }
    }
    const a = this.acc / h;
    const v = this.vehicle;
    const p = this.prev;
    const x = p.x + (v.x - p.x) * a;
    const z = p.z + (v.z - p.z) * a;
    const yaw = p.yaw + wrapAngle(v.yaw - p.yaw) * a;
    car.update(x, z, yaw, v.longAccel, v.latAccel, dt, v);
    this.focus.set(x, 0, z);

    const phase = this.race.phase;
    const active: ActiveCamera = this.debugUi?.freeCam
      ? 'free'
      : phase === 'menu' || phase === 'loading'
        ? 'orbit'
        : getViewMode();
    if (active !== this.activeCamera) this.switchCamera(active, x, z, yaw);
    if (active === 'free') this.debugUi!.updateCamera(this.focus);
    else if (active === 'orbit') this.chase.orbit(dt, x, z, yaw);
    else if (active === 'cockpit') this.cockpit.update(dt, car.body, v);
    else this.chase.update(dt, x, z, yaw, v.speed, v.longAccel);

    const f = this.frameInfo;
    f.dt = dt;
    f.time = this.elapsed;
    f.s = v.s;
    f.speed = v.speed;
    env.update(f);
    city.update(f);
    renderer.info.reset();
    pipeline.render(dt);

    if (phase === 'countdown' || phase === 'racing' || phase === 'finished') {
      const data = route.data;
      const vmax = CONFIG.vehicle.maxSpeedKmh * KMH;
      hud.update({
        speedKmh: Math.abs(v.speed) * 3.6,
        speedFraction: Math.abs(v.speed) / vmax,
        time: this.race.time,
        progress: v.s / data.finish.s,
        sectionName: route.sectionAt(v.s).name,
        passed: this.race.passed,
        x,
        z,
        yaw,
        s: v.s,
        turn: phase === 'racing' ? turnHint(route.nextTurn(v.s), v.s, v.speed) : null,
        hint: this.hint(),
      });
    }
    this.debugUi?.update(dt, {
      fps: this.fps,
      phase,
      s: v.s,
      d: v.d,
      speed: v.speed,
      time: this.race.time,
      passed: this.race.passed,
      count: this.race.checkpointCount,
      contact: v.inContact,
      assisted: this.race.assisted,
    });
    audio.update({
      dt,
      speed: v.speed,
      throttle: this.input.throttle,
      braking: this.input.brake > 0 && v.speed > 0.5,
      driving: phase === 'racing',
    });
    const { recorder } = this.deps;
    if (recorder.capturing) recorder.composite(renderer.domElement, hud, dt, this.fps);

    if (this.onFirstFrame) {
      const cb = this.onFirstFrame;
      this.onFirstFrame = null;
      cb();
    }
  }
}
