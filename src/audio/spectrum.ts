/**
 * A compact log-frequency spectrum (32 bands, 40 Hz – 10 kHz) for visuals that draw the music's
 * actual shape (e.g. Sound Valley's ridgelines). Normalised 0..1 per band against the song's
 * own range, so quiet bands still show their movement and loud ones don't saturate.
 */
export const SPEC_BANDS = 32;
const LO = 40;
const HI = 10000;
const edges = Array.from({ length: SPEC_BANDS + 1 }, (_, k) => LO * Math.pow(HI / LO, k / SPEC_BANDS));

/** band levels in dB from an analyser-style dB spectrum */
export function specBands(freqDb: Float32Array, binHz: number, out: Float32Array) {
  const n = freqDb.length;
  for (let k = 0; k < SPEC_BANDS; k++) {
    const a = Math.ceil(edges[k] / binHz);
    const b = Math.min(n - 1, Math.floor(edges[k + 1] / binHz));
    let p = 0, c = 0;
    if (b >= a) for (let i = a; i <= b; i++) { p += Math.pow(10, Math.max(freqDb[i], -140) / 10); c++; }
    else { p = Math.pow(10, Math.max(freqDb[Math.min(n - 1, Math.round(Math.sqrt(edges[k] * edges[k + 1]) / binHz))], -140) / 10); c = 1; }
    out[k] = 10 * Math.log10(p / c + 1e-14);
  }
}

/** whole-song spectrogram, quantised to bytes */
export interface SpecTrack {
  fps: number;
  t0: number;
  n: number;
  data: Uint8Array; // n × SPEC_BANDS, 0..255
}

export class SpecCollector {
  private rows: Float32Array[] = [];
  private loud: number[] = [];
  private tmp = new Float32Array(SPEC_BANDS);
  constructor(readonly fps: number, readonly t0: number) {}
  push(freqDb: Float32Array, binHz: number, loudDb: number) {
    specBands(freqDb, binHz, this.tmp);
    this.rows.push(this.tmp.slice());
    this.loud.push(loudDb);
  }
  build(silenceDb: number): SpecTrack {
    const n = this.rows.length;
    const data = new Uint8Array(n * SPEC_BANDS);
    for (let k = 0; k < SPEC_BANDS; k++) {
      const v: number[] = [];
      for (let i = 0; i < n; i++) if (this.loud[i] > silenceDb) v.push(this.rows[i][k]);
      v.sort((a, b) => a - b);
      const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))] : -100);
      const lo = q(0.1), hi = Math.max(q(0.995), lo + 18);
      for (let i = 0; i < n; i++) {
        const x = this.loud[i] > silenceDb ? (this.rows[i][k] - lo) / (hi - lo) : 0;
        data[i * SPEC_BANDS + k] = Math.round(255 * Math.min(1, Math.max(0, x)));
      }
    }
    this.rows = [];
    return { fps: this.fps, t0: this.t0, n, data };
  }
}

export const specFrame = (s: SpecTrack, t: number) => Math.min(s.n - 1, Math.max(0, Math.round((t - s.t0) * s.fps)));

/** live: running per-band range, coupled to the loudest band so silence isn't stretched to full */
export class SpecLive {
  readonly level = new Float32Array(SPEC_BANDS);
  private db = new Float32Array(SPEC_BANDS);
  private ceil = new Float32Array(SPEC_BANDS).fill(-200);
  private floor = new Float32Array(SPEC_BANDS).fill(200);
  reset() {
    this.ceil.fill(-200);
    this.floor.fill(200);
    this.level.fill(0);
  }
  process(freqDb: Float32Array, binHz: number, dt: number, active: boolean) {
    if (!active) { this.level.fill(0); return; }
    specBands(freqDb, binHz, this.db);
    let top = -200;
    for (let k = 0; k < SPEC_BANDS; k++) {
      const x = this.db[k];
      this.ceil[k] = x > this.ceil[k] ? x : this.ceil[k] - 1.5 * dt;
      this.floor[k] = x < this.floor[k] ? x : this.floor[k] + 2 * dt;
      top = Math.max(top, this.ceil[k]);
    }
    for (let k = 0; k < SPEC_BANDS; k++) {
      const lo = Math.max(this.floor[k], top - 55);
      const hi = Math.max(this.ceil[k], lo + 18);
      this.level[k] = Math.min(1, Math.max(0, (this.db[k] - lo) / (hi - lo)));
    }
  }
}
