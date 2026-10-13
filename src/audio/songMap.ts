import { FeatureExtractor } from './FeatureExtractor';
import { fftMagDb } from './fft';
import { FamilyCollector, type FamilyTrack } from './soundFamilies';
import { SpecCollector, type SpecTrack } from './spectrum';

/**
 * A whole-song analysis built ahead of time for files (not the microphone).
 *
 * The real-time extractor only knows the past. With the full file we can look ahead:
 * the beat grid is anchored by kicks on both sides of every beat (correct from the first
 * second, through breakdowns, after seeks), sections are found by their whole extent, and
 * every drop is known before it arrives, so the world can build toward it.
 */
export interface SongMap {
  duration: number;
  bpm: number; // 0 when the song has no usable pulse (the live tracker is used instead)
  beats: Float64Array; // beat times in seconds
  beatConfidence: number; // 0..1 how tightly kicks agree with the grid
  breakdowns: [number, number][]; // kick-free, low-energy spans
  drops: { t: number; strength: number }[];
  anticipation: [number, number][]; // [start, drop time] ramps leading into each drop
  /** dB percentiles [p5, p99] for priming the adaptive normalisers */
  levels: { bass: [number, number]; mid: [number, number]; high: [number, number]; loud: [number, number] };
  /** sound families over the whole song (centred, look-ahead separation) */
  families: FamilyTrack | null;
  /** 32-band spectrogram at 30 fps, normalised per band (for visuals that draw the music's shape) */
  spectrum: SpecTrack | null;
}

export interface MapHit {
  start: number;
  strength: number;
  strong: boolean;
  peak: number;
}

const BPM_MIN = 70;
const BPM_MAX = 180;
const SILENCE_DB = -58;

function percentile(sorted: Float32Array | number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** Global tempo: pairwise inter-onset votes (k = 1..8) with a broad 120 BPM prior. */
function estimateTempo(hits: MapHit[]) {
  const bin = 0.25;
  const nb = Math.round((BPM_MAX - BPM_MIN) / bin) + 1;
  const h = new Float64Array(nb);
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const d = hits[j].start - hits[i].start;
      if (d < 0.25) continue;
      if (d > 4) break;
      const w = hits[i].strength * hits[j].strength;
      for (let k = 1; k <= 8; k++) {
        const bpm = (60 * k) / d;
        if (bpm < BPM_MIN - 2) continue;
        if (bpm > BPM_MAX + 2) break;
        const c = (bpm - BPM_MIN) / bin;
        const c0 = Math.max(0, Math.floor(c - 6));
        const c1 = Math.min(nb - 1, Math.ceil(c + 6));
        for (let b = c0; b <= c1; b++) {
          const x = (b - c) / 2.5;
          h[b] += (w / Math.sqrt(k)) * Math.exp(-0.5 * x * x);
        }
      }
    }
  }
  let best = -1;
  let total = 0;
  for (let b = 0; b < nb; b++) {
    const bpm = BPM_MIN + b * bin;
    const lg = Math.log2(bpm / 120) / 0.7;
    h[b] *= Math.exp(-0.5 * lg * lg);
    total += h[b];
    if (best < 0 || h[b] > h[best]) best = b;
  }
  if (best < 0 || total <= 0) return 0;
  let peak = best;
  if (best > 0 && best < nb - 1) {
    const den = h[best - 1] - 2 * h[best] + h[best + 1];
    if (den !== 0) peak = best + (0.5 * (h[best - 1] - h[best + 1])) / den;
  }
  return BPM_MIN + peak * bin;
}

/**
 * Beat grid with look-ahead: each predicted beat is pulled toward the strength-weighted circular
 * mean phase of kicks within ±4 beats on BOTH sides, so it is right from the first beat and
 * flywheels through kick-free passages.
 */
function buildGrid(hits: MapHit[], bpm: number, duration: number) {
  const T = 60 / bpm;
  const times = hits.map((h) => h.start);
  const phaseNear = (p: number, span: number) => {
    let C = 0, S = 0, W = 0, n = 0;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < p - span) lo = m + 1; else hi = m; }
    for (let i = lo; i < times.length && times[i] <= p + span; i++) {
      const d = times[i] - p;
      const w = hits[i].strength * Math.exp(-0.5 * (d / (span / 2)) ** 2);
      const th = (2 * Math.PI * d) / T;
      C += w * Math.cos(th);
      S += w * Math.sin(th);
      W += w;
      n++;
    }
    if (n < 3 || W <= 0) return null;
    return { err: (Math.atan2(S, C) / (2 * Math.PI)) * T, R: Math.hypot(C, S) / W };
  };
  // seed from the first 16 s of kicks (in absolute time, modulo the period)
  let C = 0, S = 0;
  for (const h of hits) {
    if (h.start > hits[0].start + 16) break;
    const th = (2 * Math.PI * (h.start % T)) / T;
    C += h.strength * Math.cos(th);
    S += h.strength * Math.sin(th);
  }
  let p = (((Math.atan2(S, C) / (2 * Math.PI)) * T) % T + T) % T;
  const beats: number[] = [];
  let Rsum = 0, Rn = 0;
  while (p < duration) {
    const a = phaseNear(p, 4 * T);
    if (a && a.R > 0.3) {
      p += a.err * 0.6;
      Rsum += a.R;
      Rn++;
    }
    beats.push(p);
    p += T;
  }
  return { beats: Float64Array.from(beats), confidence: Rn ? Rsum / Rn : 0 };
}

/**
 * Analyse a whole mono signal. Runs the same FeatureExtractor as live playback (so hits mean
 * the same thing), collects per-frame levels, then post-processes with knowledge of the future.
 */
export function buildSongMap(pcm: Float32Array, sr: number, onProgress?: (p: number) => void): SongMap {
  const fps = 60;
  const N = sr >= 32000 ? 2048 : 1024; // ~46 ms window either way
  const dt = 1 / fps;
  const duration = pcm.length / sr;
  const nFrames = Math.max(0, Math.floor((duration - N / sr) * fps));
  const fx = new FeatureExtractor();
  const hits: MapHit[] = [];
  // a hit is timestamped when the ~46 ms analysis window first registers it, ~15 ms after the
  // heard onset; the map can afford to correct that (live playback can't look back)
  const DETECT_LATENCY = 0.015;
  fx.onHit = (h) => hits.push({ ...h, start: h.start - DETECT_LATENCY });
  const frame = new Float32Array(N);
  const freq = new Float32Array(N / 2);
  const bassDb = new Float32Array(nFrames);
  const midDb = new Float32Array(nFrames);
  const highDb = new Float32Array(nFrames);
  const loudDb = new Float32Array(nFrames);
  const inten = new Float32Array(nFrames);
  const fam = new FamilyCollector(fps, N / sr);
  const spec = new SpecCollector(fps / 2, N / sr);
  for (let i = 0; i < nFrames; i++) {
    const t = N / sr + i * dt;
    const end = Math.floor(t * sr);
    frame.set(pcm.subarray(end - N, end));
    fftMagDb(frame, freq);
    const f = fx.process(freq, frame, sr, t, dt);
    bassDb[i] = f.bassDb;
    midDb[i] = f.midDb;
    highDb[i] = f.highDb;
    loudDb[i] = f.loudnessDb;
    inten[i] = f.intensity;
    fam.push(freq, sr / N, f.loudnessDb);
    if (i % 2 === 0) spec.push(freq, sr / N, f.loudnessDb);
    if (onProgress && i % 1500 === 0) onProgress(0.8 * (i / nFrames));
  }
  const tOf = (i: number) => N / sr + i * dt;

  // ---- level percentiles (non-silent frames) ---------------------------------------
  const valid: number[] = [];
  for (let i = 0; i < nFrames; i++) if (loudDb[i] > SILENCE_DB) valid.push(i);
  const pct = (arr: Float32Array): [number, number] => {
    const v = Float32Array.from(valid.map((i) => arr[i])).sort();
    return [percentile(v, 0.05), percentile(v, 0.99)];
  };
  const levels = { bass: pct(bassDb), mid: pct(midDb), high: pct(highDb), loud: pct(loudDb) };

  // ---- tempo and grid ------------------------------------------------------------------
  const strong = hits.filter((h) => h.strong);
  const pulse = strong.length >= 16 ? strong : hits;
  let bpm = pulse.length >= 8 ? estimateTempo(pulse) : 0;
  let beats = new Float64Array(0);
  let beatConfidence = 0;
  if (bpm > 0) {
    const g = buildGrid(pulse, bpm, duration);
    beats = g.beats;
    beatConfidence = g.confidence;
    if (beatConfidence < 0.25) {
      bpm = 0; // no reliable pulse: leave rhythm to the live tracker
      beats = new Float64Array(0);
    }
  }

  // ---- sections ----------------------------------------------------------------------
  // low-end level smoothed over 1 s; "kick-free" = no strong hit within ±1 s
  const win = fps;
  const lowS = new Float32Array(nFrames);
  {
    let acc = 0;
    const q: number[] = [];
    for (let i = 0; i < nFrames; i++) {
      const v = Math.max(bassDb[i], -100);
      q.push(v);
      acc += v;
      if (q.length > win) acc -= q.shift()!;
      lowS[Math.max(0, i - (win >> 1))] = acc / q.length;
    }
  }
  const sortedLow = Float32Array.from(valid.map((i) => lowS[i])).sort();
  const lowMedian = percentile(sortedLow, 0.5);
  const st = strong.map((h) => h.start);
  let si = 0;
  const inBreak = new Uint8Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const t = tOf(i);
    while (si < st.length && st[si] < t - 1) si++;
    const kickNear = si < st.length && st[si] <= t + 1;
    inBreak[i] = !kickNear && loudDb[i] > SILENCE_DB && lowS[i] < lowMedian - 6 ? 1 : 0;
  }
  let spans: [number, number][] = [];
  for (let i = 0; i < nFrames; i++) {
    if (!inBreak[i]) continue;
    let j = i;
    while (j + 1 < nFrames && inBreak[j + 1]) j++;
    spans.push([tOf(i), tOf(j)]);
    i = j;
  }
  // merge gaps under 1 s, keep spans of at least 2 s
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 1) last[1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  spans = merged.filter(([a, b]) => b - a >= 2);

  // ---- drops ---------------------------------------------------------------------------
  const nearestBeat = (t: number) => {
    if (!beats.length) return t;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m + 1; else hi = m; }
    const c = [beats[Math.max(0, lo - 1)], beats[lo]].sort((x, y) => Math.abs(x - t) - Math.abs(y - t))[0];
    return Math.abs(c - t) < 0.1 ? c : t;
  };
  const meanOver = (arr: Float32Array, a: number, b: number) => {
    const i0 = Math.max(0, Math.floor((a - N / sr) * fps));
    const i1 = Math.min(nFrames, Math.ceil((b - N / sr) * fps));
    let s = 0;
    for (let i = i0; i < i1; i++) s += arr[i];
    return i1 > i0 ? s / (i1 - i0) : 0;
  };
  const drops: { t: number; strength: number }[] = [];
  const anticipation: [number, number][] = [];
  const breakdowns: [number, number][] = [];
  for (const [a, b] of spans) {
    // the drop is the first strong kick after the span (a kick-free span ends ≥ 1 s before the
    // next kick by construction, and some songs leave a beat or two of silence), if the low end
    // really comes back
    const k = st.find((x) => x >= b - 0.5 && x <= b + 3);
    const back = k !== undefined && meanOver(lowS, k, k + 2) >= lowMedian - 3 && st.filter((x) => x > k && x < k + 2.5).length >= 2;
    const end = back ? k! : b;
    breakdowns.push([a, end]);
    if (back) {
      const d = nearestBeat(k!);
      drops.push({ t: d, strength: 1 });
      anticipation.push([Math.max(a, d - 8), d]);
    }
  }
  // energy-jump drops for songs without breakdowns: big rise across a strong kick
  const firstSound = valid.length ? tOf(valid[0]) : 0;
  for (const k of st) {
    if (k < firstSound + 8) continue; // the song starting is not a drop
    if (drops.some((d) => Math.abs(d.t - k) < 10)) continue;
    const before = meanOver(inten, k - 4, k);
    const after = meanOver(inten, k + 0.5, k + 4.5);
    if (after - before > 0.25) {
      const d = nearestBeat(k);
      drops.push({ t: d, strength: 0.7 });
      anticipation.push([d - 3, d]);
    }
  }
  drops.sort((x, y) => x.t - y.t);
  anticipation.sort((x, y) => x[1] - y[1]);
  onProgress?.(0.85);
  const families = nFrames > 0 ? fam.build(SILENCE_DB) : null;
  const spectrum = nFrames > 0 ? spec.build(SILENCE_DB) : null;
  onProgress?.(1);

  return { duration, bpm, beats, beatConfidence, breakdowns, drops, anticipation, levels, families, spectrum };
}

/** Index of the last beat at or before t (-1 if before the first). */
export function beatIndexAt(beats: Float64Array, t: number, hint = -1) {
  const n = beats.length;
  if (!n || t < beats[0]) return -1;
  if (hint >= 0 && hint < n && beats[hint] <= t && (hint + 1 >= n || beats[hint + 1] > t)) return hint;
  if (hint >= 0 && hint + 1 < n && beats[hint + 1] <= t && (hint + 2 >= n || beats[hint + 2] > t)) return hint + 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (beats[m] <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** Build-up ramp 0..1 (eased) inside an anticipation window, 0 elsewhere. */
export function anticipationAt(map: SongMap, t: number) {
  for (const [a, d] of map.anticipation) {
    if (t >= a && t < d) {
      const x = (t - a) / (d - a);
      return x * x * (3 - 2 * x);
    }
  }
  return 0;
}
