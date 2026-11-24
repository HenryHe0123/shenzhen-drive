import * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import { ChaseCamera } from '../camera/ChaseCamera';
import { CONFIG, KMH } from '../config';
import { DebugOverlay } from '../debug/DebugOverlay';
import type { Hud } from '../hud/Hud';
import type { Input } from '../input/Input';
import { loadBestTime, submitBestTime } from '../race/bestTime';
import { Race, type Phase, type RaceEvent } from '../race/Race';
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
  fps: number;
}

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** Owns the frame loop: fixed-rate physics with interpolated rendering, race flow, HUD, audio and debug. */
export class Game {
  readonly vehicle: Vehicle;
  readonly race: Race;
  private readonly chase: ChaseCamera;
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
  private muted = false;
  private audioStarted = false;
  private onFirstFrame: (() => void) | null = null;

  constructor(private readonly deps: GameDeps) {
    const { route } = deps;
    this.vehicle = new Vehicle(route);
    this.race = new Race({ checkpoints: route.data.checkpoints, finish: route.data.finish, startS: CONFIG.race.startS });
    this.chase = new ChaseCamera(deps.camera);
    this.debugUi = deps.debugRoot ? new DebugOverlay(deps.debugRoot, deps.renderer, deps.camera) : null;
    this.frameInfo = { dt: 0, time: 0, focus: this.focus, s: 0, speed: 0 };
    this.placeCar(CONFIG.race.startS, true);
    deps.input.onPress = (code) => this.onKey(code);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) deps.audio.suspend();
      else deps.audio.resume();
      this.lastNow = null;
    });
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
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.deps.audio.start().catch((e) => console.warn('[audio] start failed:', e));
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.placeCar(CONFIG.race.startS, phase !== 'menu');
    this.race.begin();
    this.deps.hud.showDriving(this.best);
    this.stuck = this.pinned = this.wrongWay = 0;
  }

  /** R: back to the last passed checkpoint (or the start); the timer keeps running. */
  resetToCheckpoint(): void {
    if (this.race.phase !== 'racing') return;
    this.placeCar(this.race.resetS(), true);
    this.race.syncS(this.vehicle.s);
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
      fps: this.fps,
    };
  }

  private placeCar(s: number, snapCamera: boolean): void {
    const v = this.vehicle;
    v.place(s, CONFIG.race.laneD);
    v.impact = 0;
    this.prev.x = v.x;
    this.prev.z = v.z;
    this.prev.yaw = v.yaw;
    if (snapCamera) this.chase.snap(v.x, v.z, v.yaw);
  }

  private onKey(code: string): boolean {
    const phase = this.race.phase;
    switch (code) {
      case 'KeyR':
        this.resetToCheckpoint();
        return true;
      case 'KeyM':
        this.muted = !this.muted;
        this.deps.audio.setMuted(this.muted);
        this.deps.hud.setMuted(this.muted);
        return true;
      case 'Enter':
      case 'Space':
        if (phase === 'menu' || phase === 'finished') {
          this.startRace();
          return true;
        }
        return false;
    }
    if (!this.debugUi) return false;
    if (code === 'KeyF') {
      this.debugUi.toggleFreeCam(this.focus);
      if (!this.debugUi.freeCam) this.chase.snap(this.vehicle.x, this.vehicle.z, this.vehicle.yaw);
      return true;
    }
    const m = /^Digit(\d)$/.exec(code);
    if (m) {
      const i = Number(m[1]);
      const data = this.deps.route.data;
      if (i === 0) this.teleport(data.turn.s0 - CONFIG.debug.turnTeleportOffset);
      else if (i <= data.checkpoints.length) this.teleport(data.checkpoints[i - 1].s);
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
      if (v.impact >= CONFIG.collision.thudMinSpeed) audio.collision(Math.min(1, v.impact / 25));
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
        hud.showResult({ time: e.time, best: this.best, record, assisted });
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
    this.elapsed += dt;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    const h = 1 / CONFIG.physics.hz;
    this.acc += dt;
    while (this.acc >= h) {
      this.fixedStep(h);
      this.acc -= h;
    }
    const a = this.acc / h;
    const v = this.vehicle;
    const p = this.prev;
    const x = p.x + (v.x - p.x) * a;
    const z = p.z + (v.z - p.z) * a;
    const yaw = p.yaw + wrapAngle(v.yaw - p.yaw) * a;
    car.update(x, z, yaw, v.longAccel, v.latAccel, dt);
    this.focus.set(x, 0, z);

    const phase = this.race.phase;
    if (this.debugUi?.freeCam) this.debugUi.updateCamera(this.focus);
    else if (phase === 'menu' || phase === 'loading') this.chase.orbit(dt, x, z, yaw);
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
      const toTurn = data.turn.s0 - v.s;
      const vmax = CONFIG.vehicle.maxSpeedKmh * KMH;
      hud.update({
        speedKmh: Math.abs(v.speed) * 3.6,
        speedFraction: Math.abs(v.speed) / vmax,
        time: this.race.time,
        progress: v.s / data.finish.s,
        sectionName: route.sectionAt(v.s).name,
        passed: this.race.passed,
        turnDistance:
          phase === 'racing' && v.s < data.turn.s1 && toTurn <= CONFIG.race.turnHintDistance ? Math.max(0, toTurn) : null,
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

    if (this.onFirstFrame) {
      const cb = this.onFirstFrame;
      this.onFirstFrame = null;
      cb();
    }
  }
}
