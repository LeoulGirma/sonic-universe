/**
 * Small, allocation-free DSP primitives used by the feature extractor.
 * Everything here is pure and frame-rate independent (time constants in seconds),
 * so it runs identically in the browser and in the Node test-suite.
 */

/** Exponential smoothing coefficient for a time constant `tau` over a step `dt`. */
export const expCoef = (dt: number, tau: number) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Envelope follower with separate attack / release time constants. */
export class Envelope {
  value: number;
  constructor(private attack: number, private release: number, initial = 0) {
    this.value = initial;
  }
  step(target: number, dt: number) {
    const tau = target > this.value ? this.attack : this.release;
    this.value += (target - this.value) * expCoef(dt, tau);
    return this.value;
  }
  reset(v = 0) {
    this.value = v;
  }
}

/** Running mean / variance with exponential forgetting (time constant `tau`). */
export class RunningStats {
  mean = 0;
  variance = 0;
  private primed = false;
  constructor(private tau: number) {}
  step(x: number, dt: number) {
    if (!this.primed) {
      this.mean = x;
      this.variance = 0;
      this.primed = true;
      return;
    }
    const a = expCoef(dt, this.tau);
    const d = x - this.mean;
    this.mean += a * d;
    this.variance = (1 - a) * (this.variance + a * d * d);
  }
  get std() {
    return Math.sqrt(Math.max(this.variance, 0));
  }
  reset() {
    this.primed = false;
    this.mean = 0;
    this.variance = 0;
  }
}

/**
 * Adaptive range normaliser working in the log (dB) domain.
 *
 * The ceiling jumps up instantly and decays slowly; the floor drops instantly and rises slowly.
 * This maps any song — mastered loud or quiet — onto 0..1 while preserving the dynamics *within*
 * a song: the ceiling decays at only `ceilDecay` dB/s, so a 20 s breakdown still reads as quiet.
 * During the first `warmup` seconds both edges adapt faster so a new track settles quickly.
 */
export class AdaptiveRange {
  floor: number;
  ceil: number;
  private age = 0;
  constructor(
    private initFloor: number,
    private initCeil: number,
    private minSpan = 12,
    private ceilDecay = 0.35,
    private floorRise = 0.6,
    private warmup = 4,
  ) {
    this.floor = initFloor;
    this.ceil = initCeil;
  }
  step(x: number, dt: number) {
    if (this.age === 0) {
      // prime from the first real measurement instead of an arbitrary preset
      this.ceil = x;
      this.floor = x - this.minSpan;
    }
    this.age += dt;
    const boost = this.age < this.warmup ? 8 : 1;
    if (x > this.ceil) this.ceil = x;
    else this.ceil -= this.ceilDecay * boost * dt;
    if (x < this.floor) this.floor = x;
    else this.floor += this.floorRise * boost * dt;
    if (this.ceil - this.floor < this.minSpan) {
      // keep a minimum span centred on the ceiling so noise floors don't get amplified to full scale
      this.floor = this.ceil - this.minSpan;
    }
    return clamp01((x - this.floor) / (this.ceil - this.floor));
  }
  reset() {
    this.floor = this.initFloor;
    this.ceil = this.initCeil;
    this.age = 0;
  }
  /** Set the range from a known distribution (e.g. a whole-song analysis) and skip warm-up. */
  prime(floor: number, ceil: number) {
    this.ceil = Math.max(ceil, this.ceil - 3); // never below what this song has already shown
    this.floor = Math.min(floor, this.ceil - this.minSpan);
    this.age = Math.max(this.age, this.warmup + 1e-3);
  }
}

/** Convert an AnalyserNode dB value to linear magnitude. */
export const dbToMag = (db: number) => Math.pow(10, db / 20);

/** Fixed-size ring buffer of timestamps (onsets) for the beat tracker. */
export class TimeRing {
  readonly data: Float64Array;
  private head = 0;
  count = 0;
  constructor(size: number) {
    this.data = new Float64Array(size);
  }
  push(t: number) {
    this.data[this.head] = t;
    this.head = (this.head + 1) % this.data.length;
    if (this.count < this.data.length) this.count++;
  }
  /** iterate oldest → newest */
  forEach(fn: (t: number) => void) {
    const n = this.count;
    const start = (this.head - n + this.data.length) % this.data.length;
    for (let i = 0; i < n; i++) fn(this.data[(start + i) % this.data.length]);
  }
  clear() {
    this.head = 0;
    this.count = 0;
  }
}
