import { CONFIG } from '../config';
import type { AudioFrame } from '../game/contracts';

const A = CONFIG.audio;

/** Time constant (s) for continuous parameter smoothing. */
const SMOOTH = 0.06;

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Clamps to 0..1; NaN becomes 0 (AudioParam setters throw on non-finite values). */
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * Looping noise buffer. Brown noise is a leaky integral of white noise; the head is
 * cross-faded with samples generated past the end so the loop point has no click.
 */
function makeNoise(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const fade = Math.floor(ctx.sampleRate * 0.05);
  const raw = new Float32Array(n + fade);
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      b = (b + 0.02 * w) / 1.02;
      raw[i] = b * 3.5;
    } else {
      raw[i] = w;
    }
  }
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = raw[i] * t + raw[n + i] * (1 - t);
  }
  return buf;
}

/** Continuous driving layers whose parameters follow the car every frame. */
interface DriveLayers {
  /** [frequency ratio to the motor fundamental, oscillator] */
  motorOsc: [number, OscillatorNode][];
  motorFilter: BiquadFilterNode;
  motorGain: GainNode;
  inverterOsc: OscillatorNode;
  inverterGain: GainNode;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  windGustDepth: GainNode;
  tyreFilter: BiquadFilterNode;
  tyreGain: GainNode;
  hissGain: GainNode;
}

interface ToneSpec {
  freq: number;
  at: number;
  peak: number;
  /** Seconds at full level before the exponential decay. */
  hold?: number;
  /** Seconds to decay to silence. */
  decay: number;
  type?: OscillatorType;
  /** [frequency multiple, relative amplitude] */
  partials?: readonly (readonly [number, number])[];
}

/**
 * Procedural Web Audio sound for an electric car: motor whine with a faint inverter
 * tone, wind and tyre noise, collision thud, countdown beeps and checkpoint chimes.
 * No audio files. Every method is a safe no-op before start() and when Web Audio is
 * unavailable (e.g. Node tests).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private drive: GainNode | null = null;
  private sfx: GainNode | null = null;
  private white: AudioBuffer | null = null;
  private layers: DriveLayers | null = null;
  private mutedFlag = false;
  private paused = false;
  private lastThudAt = -Infinity;
  private lastThudLevel = 0;

  /** Must be called from a user gesture (e.g. the Start button click). */
  async start(): Promise<void> {
    if (this.ctx) {
      this.resume();
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
      this.build(ctx);
    } catch (err) {
      console.warn('[audio] Web Audio unavailable:', err);
      this.ctx = null;
      return;
    }
    this.paused = false;
    // resume() can stay pending without an audio device; never block the caller on it.
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  update(frame: AudioFrame): void {
    const ctx = this.ctx;
    const L = this.layers;
    if (!ctx || !L || !this.drive || this.paused || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = SMOOTH) => p.setTargetAtTime(v, now, tc);

    const v = Math.abs(frame.speed) || 0;
    const sn = Math.min(v / A.refSpeed, 1.2);
    const sn1 = Math.min(sn, 1);
    const thr = clamp01(frame.throttle);
    const moving = smoothstep(0.15, 2.5, v);
    const braking = frame.braking && v > 0.5 ? 1 : 0;

    // Motor: pitch tracks speed (single-ratio EV drivetrain), throttle adds level and brightness.
    const f = A.motorHzMin + (A.motorHzMax - A.motorHzMin) * Math.min(sn, 1.1);
    for (const [ratio, osc] of L.motorOsc) set(osc.frequency, f * ratio, 0.04);
    set(L.motorFilter.frequency, Math.min(f * (1.6 + 1.6 * thr), 9000));
    set(L.motorGain.gain, A.motorGain * moving * (0.35 + 0.65 * thr) * (0.6 + 0.4 * sn1));
    // Inverter: faint high tone, most audible when pulling away.
    set(L.inverterOsc.frequency, 2300 + f * 1.5, 0.04);
    set(L.inverterGain.gain, A.inverterGain * moving * (0.25 + 0.75 * thr) * (1 - 0.5 * sn1));

    // Wind: level ∝ speed², band opens with speed; slow gusts scale with the level.
    const wind = A.windGain * sn * sn;
    set(L.windFilter.frequency, 250 + 1900 * sn1);
    set(L.windGain.gain, wind, 0.15);
    set(L.windGustDepth.gain, wind * 0.2, 0.15);

    // Tyres: low rumble ∝ speed plus a little hiss; both rise while braking.
    set(L.tyreFilter.frequency, 150 + 550 * sn1 + 200 * braking);
    set(L.tyreGain.gain, A.tyreGain * sn1 * moving * (1 + 0.6 * braking), 0.1);
    set(L.hissGain.gain, A.tyreGain * 0.25 * sn1 * (1 + 1.0 * braking), 0.1);

    set(this.drive.gain, frame.driving ? 1 : A.idleLevel, 0.3);
  }

  /** intensity 0..1 */
  collision(intensity: number): void {
    const ctx = this.ctx;
    const bus = this.sfx;
    if (!ctx || !bus || !this.white || this.paused) return;
    const k = clamp01(intensity);
    if (k < 0.02) return;
    const now = ctx.currentTime;
    if (now - this.lastThudAt < A.thudMinInterval && k <= this.lastThudLevel * 1.5) return;
    this.lastThudAt = now;
    this.lastThudLevel = k;
    const peak = A.thudGain * (0.25 + 0.75 * k);

    // Body: sine with a fast pitch drop.
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(95 + 70 * k, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.18);
    const body = ctx.createGain();
    body.gain.setValueAtTime(0, now);
    body.gain.linearRampToValueAtTime(peak, now + 0.006);
    body.gain.exponentialRampToValueAtTime(0.0001, now + 0.28 + 0.15 * k);
    osc.connect(body).connect(bus);
    osc.start(now);
    osc.stop(now + 0.5);
    osc.onended = () => body.disconnect();

    // Impact: short low-passed noise burst.
    const noise = ctx.createBufferSource();
    noise.buffer = this.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 350 + 1400 * k;
    const burst = ctx.createGain();
    burst.gain.setValueAtTime(0, now);
    burst.gain.linearRampToValueAtTime(peak * 0.6, now + 0.003);
    burst.gain.exponentialRampToValueAtTime(0.0001, now + 0.09 + 0.08 * k);
    noise.connect(lp).connect(burst).connect(bus);
    noise.start(now, Math.random() * 1.5);
    noise.stop(now + 0.25);
    noise.onended = () => burst.disconnect();
  }

  /** Countdown tick; final = true for the "go" beep. */
  beep(final: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || this.paused) return;
    this.tone({
      freq: final ? 1318.5 : 659.25,
      at: ctx.currentTime,
      peak: A.beepGain,
      hold: final ? 0.32 : 0.09,
      decay: final ? 0.25 : 0.06,
      partials: [
        [1, 1],
        [2, 0.12],
      ],
    });
  }

  /** Checkpoint / finish chime. */
  chime(finish: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || this.paused) return;
    const t = ctx.currentTime;
    const bell = [
      [1, 1],
      [2, 0.3],
      [3, 0.08],
    ] as const;
    if (!finish) {
      // A5 → E6, a rising fifth.
      this.tone({ freq: 880, at: t, peak: A.chimeGain, decay: 0.5, partials: bell });
      this.tone({ freq: 1318.5, at: t + 0.11, peak: A.chimeGain, decay: 0.8, partials: bell });
      return;
    }
    // C major arpeggio up to C7 over a soft sustained chord.
    const notes = [1046.5, 1318.5, 1568, 2093];
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1;
      this.tone({ freq, at: t + i * 0.1, peak: A.chimeGain, hold: last ? 0.15 : 0, decay: last ? 1.6 : 0.6, partials: bell });
    });
    for (const freq of [523.25, 659.25, 783.99]) {
      this.tone({ freq, at: t + 0.3, peak: A.chimeGain * 0.25, hold: 0.4, decay: 1.4, type: 'triangle' });
    }
  }

  setMuted(muted: boolean): void {
    this.mutedFlag = muted;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(muted ? 0 : A.masterVolume, ctx.currentTime, 0.03);
  }

  /** Call on window blur / visibility change. */
  suspend(): void {
    if (!this.ctx) return;
    this.paused = true;
    this.ctx.suspend().catch(() => {});
  }

  resume(): void {
    if (!this.ctx) return;
    this.paused = false;
    this.ctx.resume().catch(() => {});
  }

  /** The AudioContext, once start() succeeded. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /**
   * Final mix (after master gain and limiter), e.g. to record gameplay audio through a
   * MediaStreamAudioDestinationNode or to meter it in tests. null before start().
   */
  get output(): AudioNode | null {
    return this.comp;
  }

  private build(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = this.mutedFlag ? 0 : A.masterVolume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);

    const drive = ctx.createGain();
    drive.gain.value = A.idleLevel;
    drive.connect(master);
    const sfx = ctx.createGain();
    sfx.connect(master);

    const white = makeNoise(ctx, 2, false);
    const brown = makeNoise(ctx, 4, true);
    const loop = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start(t, Math.random() * buf.duration);
      return src;
    };
    const gain = (value = 0) => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const osc = (type: OscillatorType, freq: number, detuneCents = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detuneCents;
      o.start(t);
      return o;
    };

    // Motor: detuned saw/triangle pair plus a 2nd harmonic through a tracking low-pass,
    // and a sub-octave sine for body. Everything is high-passed to keep out DC rumble.
    const motorGain = gain();
    const motorHp = filter('highpass', 60, 0.7);
    motorHp.connect(motorGain).connect(drive);
    const motorFilter = filter('lowpass', 600, 1.1);
    motorFilter.connect(motorHp);
    const f0 = A.motorHzMin;
    const motorOsc: [number, OscillatorNode][] = [];
    const addOsc = (ratio: number, o: OscillatorNode, amp: number, dest: AudioNode) => {
      o.connect(gain(amp)).connect(dest);
      motorOsc.push([ratio, o]);
    };
    addOsc(1, osc('sawtooth', f0, -7), 0.35, motorFilter);
    addOsc(1, osc('triangle', f0, 7), 0.6, motorFilter);
    addOsc(2, osc('sine', f0 * 2, 3), 0.18, motorFilter);
    addOsc(0.5, osc('sine', f0 * 0.5), 0.3, motorHp);

    const inverterGain = gain();
    const inverterOsc = osc('sine', 2300 + f0 * 1.5);
    inverterOsc.connect(inverterGain).connect(drive);

    // Wind: white noise through a speed-tracking band-pass and a gentle low-pass.
    const windGain = gain();
    const windFilter = filter('bandpass', 250, 0.6);
    loop(white).connect(windFilter).connect(filter('lowpass', 7000, 0.5)).connect(windGain).connect(drive);
    const windGustDepth = gain();
    osc('sine', 0.17).connect(windGustDepth).connect(windGain.gain);

    // Tyres: brown-noise rumble plus a band-passed hiss of the road surface.
    const tyreGain = gain();
    const tyreFilter = filter('lowpass', 150, 0.5);
    loop(brown).connect(tyreFilter).connect(tyreGain).connect(drive);
    const hissGain = gain();
    loop(white).connect(filter('bandpass', 1100, 0.8)).connect(hissGain).connect(drive);

    this.ctx = ctx;
    this.master = master;
    this.comp = comp;
    this.drive = drive;
    this.sfx = sfx;
    this.white = white;
    this.layers = {
      motorOsc,
      motorFilter,
      motorGain,
      inverterOsc,
      inverterGain,
      windFilter,
      windGain,
      windGustDepth,
      tyreFilter,
      tyreGain,
      hissGain,
    };
  }

  /** Short enveloped tone (sum of sine partials) into the effects bus. */
  private tone(spec: ToneSpec): void {
    const ctx = this.ctx!;
    const attack = 0.005;
    const hold = spec.hold ?? 0;
    const end = spec.at + attack + hold + spec.decay;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, spec.at);
    env.gain.linearRampToValueAtTime(spec.peak, spec.at + attack);
    env.gain.setValueAtTime(spec.peak, spec.at + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(this.sfx!);
    const partials: readonly (readonly [number, number])[] = spec.partials ?? [[1, 1]];
    partials.forEach(([mult, amp], i) => {
      const o = ctx.createOscillator();
      o.type = spec.type ?? 'sine';
      o.frequency.value = spec.freq * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(env);
      o.start(spec.at);
      o.stop(end + 0.02);
      if (i === partials.length - 1) o.onended = () => env.disconnect();
    });
  }
}
