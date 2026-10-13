import { fftMagDb } from '../src/audio/fft';
export { fftMagDb };

/**
 * Test helpers: a faithful Node emulation of Web Audio's AnalyserNode
 * (Blackman window → FFT → |X|/N → dB, smoothingTimeConstant = 0) plus a small synthesiser
 * for signals with known ground truth.
 */
/** Deterministic PRNG so tests are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Synth {
  sr: number;
  data: Float32Array;
  kicks: number[];
  hats: number[];
  bassHits: number[];
}

/**
 * A 40 s test track at `bpm`:
 *   0–16 s  groove   (kick on every beat, off-beat hats, bass stabs, pad)
 *  16–28 s  breakdown (pad only, rising noise riser over the last 4 s)
 *  28–40 s  drop     (everything back, louder)
 */
export function makeTrack(bpm = 120, gain = 1, sr = 44100): Synth {
  const dur = 40;
  const data = new Float32Array(dur * sr);
  const rand = rng(7);
  const beat = 60 / bpm;
  const kicks: number[] = [];
  const hats: number[] = [];
  const bassHits: number[] = [];
  const add = (t0: number, len: number, fn: (t: number) => number) => {
    const i0 = Math.floor(t0 * sr);
    const n = Math.floor(len * sr);
    const fade = Math.floor(0.01 * sr); // 10 ms release so truncation doesn't create spurious clicks
    for (let i = 0; i < n && i0 + i < data.length; i++) data[i0 + i] += fn(i / sr) * Math.min(1, (n - i) / fade);
  };
  const inGroove = (t: number) => t < 16 || t >= 28;
  for (let t = 0; t < dur - 0.5; t += beat) {
    if (!inGroove(t)) continue;
    const loud = t >= 28 ? 1 : 0.8;
    kicks.push(t);
    let ph = 0;
    add(t, 0.7, (x) => {
      const f = 45 + 75 * Math.exp(-x / 0.03);
      ph += (2 * Math.PI * f) / sr;
      return loud * 0.9 * Math.sin(ph) * Math.exp(-x / 0.12);
    });
    const th = t + beat / 2;
    hats.push(th);
    let prev = 0;
    add(th, 0.12, (x) => {
      const n = rand() * 2 - 1;
      const hp = n - prev;
      prev = n;
      return 0.25 * hp * Math.exp(-x / 0.03);
    });
    // bass stab on the off-beat (a legitimate low-frequency transient)
    bassHits.push(th);
    add(th, 0.7, (x) => 0.35 * loud * Math.sin(2 * Math.PI * 55 * x) * Math.min(1, x / 0.01) * Math.exp(-x / 0.12));
  }
  // pad throughout
  for (let i = 0; i < data.length; i++) {
    const t = i / sr;
    data[i] += 0.04 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
  }
  // riser 24–28 s: high-passed noise swelling up
  let prev = 0;
  add(24, 4, (x) => {
    const n = rand() * 2 - 1;
    const hp = n - prev;
    prev = n;
    return 0.12 * (x / 4) * (x / 4) * hp;
  });
  if (gain !== 1) for (let i = 0; i < data.length; i++) data[i] *= gain;
  return { sr, data, kicks, hats, bassHits };
}

/** Run an analyser-style STFT over `track` at `fps`, calling `cb` with (freqDb, timeData, t, dt). */
export function analyse(
  track: Synth,
  cb: (freqDb: Float32Array, timeData: Float32Array, t: number, dt: number) => void,
  fftSize = 2048,
  fps = 60,
) {
  const freq = new Float32Array(fftSize / 2);
  const frame = new Float32Array(fftSize);
  const dt = 1 / fps;
  const total = track.data.length / track.sr;
  for (let t = fftSize / track.sr; t < total; t += dt) {
    const end = Math.floor(t * track.sr);
    frame.set(track.data.subarray(end - fftSize, end));
    fftMagDb(frame, freq);
    cb(freq, frame, t, dt);
  }
}
