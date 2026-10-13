/**
 * Sound families: which kinds of sound are playing, frame by frame.
 *
 * This is NOT instrument recognition (no model knows "violin" here). It separates the spectrum
 * by how sound behaves, which is what tells instruments apart to the ear as well:
 *
 *  1. Harmonic / percussive separation by median filtering (Fitzgerald, DAFx 2010) on a
 *     log-frequency spectrum (64 bands, 30 Hz – 11 kHz). Sustained tones are smooth along TIME,
 *     so a median over time keeps them and rejects clicks; transients are smooth along
 *     FREQUENCY (broadband), so a median across bands keeps them and rejects tones. Soft
 *     Wiener-style masks split every band between the two.
 *  2. The harmonic part is split again on a longer time scale: what a ~1.7 s median still
 *     holds is SUSTAINED (pads, strings, drones, held chords); what rises above it is MOVING
 *     (melodies, arpeggios, ostinati, new notes).
 *  3. Each family is a component in a frequency range:
 *        kick   percussive   30–150 Hz     kick drums, toms, low hits
 *        hits   percussive  150–4000 Hz    snares, claps, congas, and the attacks of plucked/struck notes
 *        hats   percussive    5–11 kHz     hi-hats, shakers, ticks, cymbals
 *        bass   harmonic     30–250 Hz     bass lines, sub drones, 808 tails
 *        pads   sustained   250–5000 Hz    chords, strings, pads, drones
 *        lead   moving      250–5000 Hz    melody, vocals, arps, riffs
 *  4. Levels are normalised against the song's own range AND gated by how far below the whole
 *     mix they sit, so a family that is absent stays dark instead of being stretched to full.
 *
 * Hits are any mid-range transient: a snare, but also the attack of a piano or pluck. A
 * broadband test (flatness, percentile floors) was tried and dropped: on real mixes claps are
 * band-limited and share frames with everything else, so it rejected real claps as often as
 * note attacks.
 *
 * For song files the medians are centred (they look ~0.15 s and ~0.85 s ahead); live (mic /
 * system audio) they are causal, so a new chord reads as "moving" for about half a second before
 * it settles into "sustained". Known confusions, honestly: an 808 or boomy kick's tail is tonal
 * and counts partly as bass; a piano's attack counts as hits and its decay as lead or pads;
 * a vocal and a synth lead in the same register are one family.
 */

export const FAMILY_IDS = ['kick', 'hits', 'hats', 'bass', 'pads', 'lead'] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];
export const NF = FAMILY_IDS.length;
export const F = { kick: 0, hits: 1, hats: 2, bass: 3, pads: 4, lead: 5 } as const;

export interface FamilyInfo {
  id: FamilyId;
  name: string;
  examples: string;
  color: string;
}
export const FAMILY_INFO: FamilyInfo[] = [
  { id: 'kick', name: 'Kick', examples: 'kick drums, toms, low hits', color: '#ff4d5a' },
  { id: 'hits', name: 'Hits', examples: 'snares, claps, plucks, percussion', color: '#ffa62b' },
  { id: 'hats', name: 'Hats', examples: 'hi-hats, shakers, ticks, cymbals', color: '#fff0a6' },
  { id: 'bass', name: 'Bass', examples: 'bass lines, sub drones', color: '#8b6bff' },
  { id: 'pads', name: 'Pads', examples: 'chords, strings, pads, drones', color: '#2ad4c2' },
  { id: 'lead', name: 'Lead', examples: 'melody, vocals, arps, riffs', color: '#ff5fd2' },
];

// ---- log-frequency bands --------------------------------------------------------------------
export const NB = 64;
const F_LO = 30;
const F_HI = 11000;
const edges = new Float64Array(NB + 1);
for (let k = 0; k <= NB; k++) edges[k] = F_LO * Math.pow(F_HI / F_LO, k / NB);
const centre = new Float64Array(NB);
for (let k = 0; k < NB; k++) centre[k] = Math.sqrt(edges[k] * edges[k + 1]);

type Comp = 'p' | 'h' | 's' | 'm';
const DEF: { comp: Comp; lo: number; hi: number }[] = [
  { comp: 'p', lo: 30, hi: 150 },
  { comp: 'p', lo: 150, hi: 4000 },
  { comp: 'p', lo: 5000, hi: 11000 },
  { comp: 'h', lo: 30, hi: 250 },
  { comp: 's', lo: 250, hi: 5000 },
  { comp: 'm', lo: 250, hi: 5000 },
];
const famBands = DEF.map(({ lo, hi }) => {
  const out: number[] = [];
  for (let k = 0; k < NB; k++) if (centre[k] >= lo && centre[k] < hi) out.push(k);
  return Int16Array.from(out);
});
/**
 * How far (dB) below the mix's loud level a family may sit and still count as present.
 * Calibrated on real mixes (pop, hybrid orchestral score) and the synthetic demo.
 */
const RANGE_DB = [26, 30, 38, 24, 28, 30];
const MIN_SPAN_DB = 12;
const LOCAL_DB = 12; // a family within this many dB of what is sounding right now is present
const LOCAL_WEIGHT = 0.8;

/**
 * Level of a family: the larger of
 *  - its loudness within this song's own range (dynamics: the chorus is bigger than the verse), and
 *  - its share of what is sounding right now (presence: a quiet intro drone still reads as pads).
 */
function familyLevel(x: number, lo: number, hi: number, localDb: number) {
  const g = (x - lo) / (hi - lo);
  const l = (x - (localDb - LOCAL_DB)) / LOCAL_DB;
  return clamp01(Math.max(g, LOCAL_WEIGHT * l));
}

const MEL_LO = Math.log2(250);
const MEL_HI = Math.log2(5000);
const CHROMA_LO = 400;
const CHROMA_HI = 4000;

/** Maps an FFT magnitude spectrum (dB per bin) onto the bands; cached per (bins, binHz). */
class BandMap {
  readonly start: Int32Array;
  readonly idx: Int32Array;
  readonly w: Float32Array;
  /** equivalent number of bins per band (power density → band power) */
  readonly width: Float32Array;
  readonly pc: Int8Array; // pitch class per bin in the chroma range, -1 elsewhere
  constructor(readonly nBins: number, readonly binHz: number) {
    const start: number[] = [];
    const idx: number[] = [];
    const w: number[] = [];
    this.width = new Float32Array(NB);
    for (let k = 0; k < NB; k++) {
      start.push(idx.length);
      const a = Math.ceil(edges[k] / binHz);
      const b = Math.ceil(edges[k + 1] / binHz) - 1;
      if (b >= a) {
        for (let i = a; i <= Math.min(b, nBins - 1); i++) { idx.push(i); w.push(1); }
      } else {
        // band narrower than a bin: interpolate at its centre
        const x = centre[k] / binHz;
        const i = Math.floor(x);
        idx.push(Math.min(i, nBins - 1), Math.min(i + 1, nBins - 1));
        w.push(1 - (x - i), x - i);
      }
      this.width[k] = (edges[k + 1] - edges[k]) / binHz;
    }
    start.push(idx.length);
    this.start = Int32Array.from(start);
    this.idx = Int32Array.from(idx);
    this.w = Float32Array.from(w);
    this.pc = new Int8Array(nBins).fill(-1);
    for (let i = 1; i < nBins; i++) {
      const f = i * binHz;
      if (f < CHROMA_LO || f > CHROMA_HI) continue;
      this.pc[i] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
    }
  }
  /** band power density (linear) from dB bins; also returns linear bin powers in `pow` */
  bands(db: Float32Array, out: Float32Array, pow: Float32Array) {
    for (let i = 0; i < this.nBins; i++) pow[i] = Math.pow(10, Math.max(db[i], -140) / 10);
    for (let k = 0; k < NB; k++) {
      let s = 0, ws = 0;
      for (let j = this.start[k]; j < this.start[k + 1]; j++) { s += pow[this.idx[j]] * this.w[j]; ws += this.w[j]; }
      out[k] = ws > 0 ? s / ws : 0;
    }
  }
}
const bandMaps = new Map<string, BandMap>();
export function bandMap(nBins: number, binHz: number) {
  const key = `${nBins}:${binHz.toFixed(4)}`;
  let m = bandMaps.get(key);
  if (!m) { m = new BandMap(nBins, binHz); bandMaps.set(key, m); }
  return m;
}

// ---- small medians -------------------------------------------------------------------------
const scratch = new Float32Array(64);
/** median of `n` values read through `get` (insertion sort; n ≤ 64) */
function medianOf(n: number, get: (i: number) => number) {
  for (let i = 0; i < n; i++) {
    const v = get(i);
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) { scratch[j + 1] = scratch[j]; j--; }
    scratch[j + 1] = v;
  }
  return n & 1 ? scratch[n >> 1] : 0.5 * (scratch[(n >> 1) - 1] + scratch[n >> 1]);
}

const FREQ_HALF = 6; // ±6 bands ≈ ±0.8 octave for the percussive (across-frequency) median

/** Percussive estimate: median across neighbouring bands of the current frame. */
function freqMedian(X: Float32Array, out: Float32Array) {
  for (let k = 0; k < NB; k++) {
    const a = Math.max(0, k - FREQ_HALF);
    const b = Math.min(NB - 1, k + FREQ_HALF);
    out[k] = medianOf(b - a + 1, (i) => X[a + i]);
  }
}

/** Raw family energies (linear band power), melody height and chroma for one frame. */
export interface FrameParts {
  energy: Float64Array; // NF
  melody: number; // 0..1 log-frequency centroid of the moving part (−1 when there is none)
  chromaS: Float64Array; // 12, sustained harmonic
  total: number; // linear power of the whole frame (all bands)
}
export const createParts = (): FrameParts => ({ energy: new Float64Array(NF), melody: -1, chromaS: new Float64Array(12), total: 0 });

const EPS = 1e-20;
const MARGIN = 2; // 3 dB (power ratio)
const MARGIN2 = MARGIN * MARGIN;
const MOVE_MARGIN = 2.5; // 4 dB
const LOW_W = Float32Array.from(centre, (c) => Math.min(1, Math.max(0, Math.log2(300 / c)))); // 1 below 150 Hz → 0 at 300 Hz
const _h = new Float64Array(NB), _p = new Float64Array(NB), _s = new Float64Array(NB), _m = new Float64Array(NB);
/**
 * Split one frame given its band densities X, the short time-median Hs, the long time-median Hl
 * and the across-frequency median P. Optional bin powers give chroma.
 */
function splitFrame(X: Float32Array, Hs: Float32Array, Hl: Float32Array, P: Float32Array, map: BandMap | null, pow: Float32Array | null, out: FrameParts, shareS: Float32Array) {
  out.energy.fill(0);
  let mNum = 0, mDen = 0, total = 0;
  const h = _h, p = _p, s = _s, m = _m;
  for (let k = 0; k < NB; k++) {
    const x = X[k];
    // Masks with a separation margin (Driedger, Müller & Disch, ISMIR 2014): a band counts as
    // harmonic only where the time-median beats the frequency-median by MARGIN, and vice versa;
    // what is neither (reverb, breath, noise textures) is the residual and joins no family.
    // Below ~300 Hz the analysis window is too short to resolve tones across frequency (a bass
    // note smears over many bands), so there the split is by time alone: only the part of a band
    // above MARGIN × its 0.28 s median is a hit.
    const hs = Hs[k], pk = P[k];
    const hs2 = hs * hs, p2 = pk * pk;
    const mhF = hs2 / (hs2 + MARGIN2 * p2 + EPS);
    const mpF = p2 / (p2 + MARGIN2 * hs2 + EPS);
    const wl = LOW_W[k];
    const pT = x > 0 ? Math.max(0, x - MARGIN * hs) / x : 0;
    const mp = (1 - wl) * mpF + wl * pT;
    const mh = (1 - wl) * mhF + wl * (1 - pT);
    h[k] = x * mh;
    p[k] = x * mp;
    // moving = what rises clearly above the long median (4 dB): beating partials and chorused
    // pads swell a little around it and stay sustained; a new note jumps well above it
    m[k] = Math.max(0, h[k] - MOVE_MARGIN * Hl[k]);
    s[k] = h[k] - m[k];
    shareS[k] = x > 0 ? s[k] / x : 0;
    const wd = map ? map.width[k] : 1;
    total += x * wd;
    if (centre[k] >= 250 && centre[k] < 5000) {
      const mw = m[k] * wd;
      mNum += mw * Math.log2(centre[k]);
      mDen += mw;
    }
  }
  for (let f = 0; f < NF; f++) {
    const comp = DEF[f].comp;
    const src = comp === 'p' ? p : comp === 'h' ? h : comp === 's' ? s : m;
    let e = 0;
    for (const k of famBands[f]) e += src[k] * (map ? map.width[k] : 1);
    out.energy[f] = e;
  }
  out.total = total;
  out.melody = mDen > total * 1e-4 ? Math.min(1, Math.max(0, (mNum / mDen - MEL_LO) / (MEL_HI - MEL_LO))) : -1;
  out.chromaS.fill(0);
  if (map && pow) {
    for (let i = 0; i < map.nBins; i++) {
      const c = map.pc[i];
      if (c < 0) continue;
      const k = bandOf(i * map.binHz);
      out.chromaS[c] += pow[i] * shareS[k];
    }
  }
}
const LOG_RATIO = Math.log(F_HI / F_LO);
const bandOf = (f: number) => Math.min(NB - 1, Math.max(0, Math.floor((Math.log(f / F_LO) / LOG_RATIO) * NB)));

/** Circle-of-fifths colour of a chroma vector: related chords get related hues. */
export function harmonyOf(chroma: ArrayLike<number>) {
  let C = 0, S = 0, W = 0;
  for (let pc = 0; pc < 12; pc++) {
    const w = chroma[pc] * chroma[pc]; // emphasise the chord tones over leakage
    const a = (((pc * 7) % 12) / 12) * 2 * Math.PI;
    C += w * Math.cos(a);
    S += w * Math.sin(a);
    W += w;
  }
  if (W <= 0) return { hue: 0, strength: 0 };
  return { hue: ((Math.atan2(S, C) / (2 * Math.PI)) % 1 + 1) % 1, strength: Math.hypot(C, S) / W };
}

// ---- events --------------------------------------------------------------------------------
/** Per-family onset rules, shared by the song map and live analysis so they mean the same. */
const ONSET = [
  { rise: 6, min: 0.3, refr: 0.1 }, // kick
  { rise: 6, min: 0.3, refr: 0.08 }, // hits
  { rise: 6, min: 0.25, refr: 0.06 }, // hats
  { rise: 5, min: 0.3, refr: 0.12 }, // bass notes
  { rise: 4, min: 0.35, refr: 0.5 }, // pads swells / new chords
  { rise: 4.5, min: 0.3, refr: 0.11 }, // lead notes
];

export class FamilyOnsets {
  private hist = Array.from({ length: NF }, () => new Float32Array(4).fill(-200));
  private head = 0;
  private last = new Float64Array(NF).fill(-10);
  private lastHue = -1;
  /** returns a bitmask of families with an onset this frame; strengths in `strength` */
  readonly strength = new Float32Array(NF);
  step(t: number, db: ArrayLike<number>, level: ArrayLike<number>, hue: number, hueStrength: number) {
    let mask = 0;
    for (let f = 0; f < NF; f++) {
      const h = this.hist[f];
      let lo = db[f];
      for (let i = 0; i < h.length; i++) lo = Math.min(lo, h[i]);
      const r = ONSET[f];
      let hit = db[f] - lo > r.rise && level[f] > r.min;
      if (f === F.pads && !hit && level[f] > r.min && hueStrength > 0.3 && this.lastHue >= 0) {
        let dh = Math.abs(hue - this.lastHue);
        dh = Math.min(dh, 1 - dh);
        hit = dh > 0.12; // the chord moved around the circle of fifths
      }
      if (hit && t - this.last[f] > r.refr) {
        this.last[f] = t;
        mask |= 1 << f;
        this.strength[f] = Math.min(1, 0.3 + 0.7 * level[f]);
      }
      h[this.head] = db[f];
    }
    this.head = (this.head + 1) % 4;
    // a slow follower of the harmony colour; a chord change is the fast hue moving away from it
    if (hueStrength > 0.3) this.lastHue = this.lastHue < 0 ? hue : (this.lastHue + wrapDiff(hue, this.lastHue) * 0.15 + 1) % 1;
    return mask;
  }
  reset() {
    for (const h of this.hist) h.fill(-200);
    this.last.fill(-10);
    this.lastHue = -1;
  }
}
const wrapDiff = (a: number, b: number) => {
  let d = a - b;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
};

/** forward-backward circular smoothing of the harmony colour, weighted by how tonal each frame is */
function smoothHue(hue: Float32Array, str: Float32Array, tauFrames: number) {
  const n = hue.length;
  const a = 1 - Math.exp(-1 / tauFrames);
  const C = new Float32Array(n), S = new Float32Array(n);
  let c = 0, sn = 0;
  for (let i = 0; i < n; i++) {
    const w = str[i];
    c += a * (w * Math.cos(2 * Math.PI * hue[i]) - c);
    sn += a * (w * Math.sin(2 * Math.PI * hue[i]) - sn);
    C[i] = c; S[i] = sn;
  }
  c = sn = 0;
  for (let i = n - 1; i >= 0; i--) {
    c += a * (C[i] - c);
    sn += a * (S[i] - sn);
    hue[i] = ((Math.atan2(sn, c) / (2 * Math.PI)) % 1 + 1) % 1;
  }
}

const toDb = (x: number) => 10 * Math.log10(x + 1e-14);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---- whole-song (offline, centred) ------------------------------------------------------------
export interface FamilyTrack {
  fps: number;
  t0: number; // time of frame 0
  n: number;
  level: Float32Array[]; // NF × n, 0..1
  melody: Float32Array; // n, 0..1 (−1 = none)
  hue: Float32Array; // n, harmony colour 0..1
  hueStrength: Float32Array; // n
  events: Float32Array[]; // NF lists of onset times
  eventStrength: Float32Array[];
  ranges: [number, number][]; // per-family dB [lo, hi] used for normalisation
  /** raw family dB per frame (diagnostics; dropped before the map is posted to the page) */
  db?: Float32Array[];
}

const SHORT = 17; // ±8 frames at 60 fps ≈ 0.28 s window
const LONG_STEP = 6; // long median samples every 0.1 s …
const LONG_N = 17; // … 17 of them ≈ 1.7 s window
const LIVE_SHORT = 9; // causal: a new note counts as harmonic after ~5 frames (80 ms)

/**
 * Collects band spectra during the song-map pass, then separates with centred medians.
 * Chroma is only kept every third frame (harmony moves slowly) to bound memory.
 */
export class FamilyCollector {
  private X: Float32Array[] = [];
  private bins: Float32Array[] = []; // chroma-range bin powers, every 3rd frame
  private loud: number[] = [];
  private map: BandMap | null = null;
  private binLo = 0;
  private binHi = 0;
  private pow: Float32Array | null = null;
  keepDb = false;
  constructor(readonly fps: number, readonly t0: number) {}

  push(db: Float32Array, binHz: number, loudDb: number) {
    const map = (this.map ??= bandMap(db.length, binHz));
    if (!this.pow) {
      this.pow = new Float32Array(db.length);
      this.binLo = Math.ceil(CHROMA_LO / binHz);
      this.binHi = Math.min(db.length - 1, Math.floor(CHROMA_HI / binHz));
    }
    const x = new Float32Array(NB);
    map.bands(db, x, this.pow);
    this.X.push(x);
    if (this.X.length % 3 === 1) this.bins.push(this.pow.slice(this.binLo, this.binHi + 1));
    this.loud.push(loudDb);
  }

  build(silenceDb: number): FamilyTrack {
    const n = this.X.length;
    const X = this.X;
    const map = this.map;
    const level = Array.from({ length: NF }, () => new Float32Array(n));
    const dbs = Array.from({ length: NF }, () => new Float32Array(n));
    const totalDb = new Float32Array(n);
    const melody = new Float32Array(n);
    const hue = new Float32Array(n);
    const hueStrength = new Float32Array(n);
    const Hs = new Float32Array(NB), Hl = new Float32Array(NB), P = new Float32Array(NB), shareS = new Float32Array(NB);
    const parts = createParts();
    const pow = map ? new Float32Array(map.nBins) : null;
    const half = SHORT >> 1;
    const lHalf = (LONG_N >> 1) * LONG_STEP;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
      for (let k = 0; k < NB; k++) Hs[k] = medianOf(b - a + 1, (j) => X[a + j][k]);
      const la = Math.max(0, i - lHalf), lb = Math.min(n - 1, i + lHalf);
      const ln = Math.floor((lb - la) / LONG_STEP) + 1;
      for (let k = 0; k < NB; k++) Hl[k] = medianOf(ln, (j) => X[la + j * LONG_STEP][k]);
      freqMedian(X[i], P);
      let usePow: Float32Array | null = null;
      if (map && pow && i % 3 === 0 && this.bins[i / 3]) {
        pow.fill(0);
        pow.set(this.bins[i / 3], this.binLo);
        usePow = pow;
      }
      splitFrame(X[i], Hs, Hl, P, map, usePow, parts, shareS);
      for (let f = 0; f < NF; f++) dbs[f][i] = toDb(parts.energy[f]);
      totalDb[i] = toDb(parts.total);
      melody[i] = parts.melody;
      if (usePow) {
        const hm = harmonyOf(parts.chromaS);
        hue[i] = hm.hue;
        hueStrength[i] = hm.strength;
      } else if (i > 0) {
        hue[i] = hue[i - 1];
        hueStrength[i] = hueStrength[i - 1];
      }
    }
    smoothHue(hue, hueStrength, 0.4 * this.fps);
    // normalisation from the song's own distribution, gated by the mix's loud level
    const valid: number[] = [];
    for (let i = 0; i < n; i++) if (this.loud[i] > silenceDb) valid.push(i);
    const pct = (arr: Float32Array, p: number) => {
      if (!valid.length) return -100;
      const v = Float32Array.from(valid.map((i) => arr[i])).sort();
      return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    };
    const G = pct(totalDb, 0.95);
    // local mix level: max of the total over ±1.5 s (sampled every 0.1 s)
    const local = new Float32Array(n);
    {
      const step = LONG_STEP, span = Math.round(1.5 * this.fps);
      const coarse = new Float32Array(Math.ceil(n / step));
      for (let c = 0; c < coarse.length; c++) {
        let m = -200;
        for (let i = c * step; i < Math.min(n, (c + 1) * step); i++) m = Math.max(m, totalDb[i]);
        coarse[c] = m;
      }
      const cs = Math.ceil(span / step);
      for (let i = 0; i < n; i++) {
        const c = Math.floor(i / step);
        let m = -200;
        for (let j = Math.max(0, c - cs); j <= Math.min(coarse.length - 1, c + cs); j++) m = Math.max(m, coarse[j]);
        local[i] = m;
      }
    }
    const ranges: [number, number][] = [];
    for (let f = 0; f < NF; f++) {
      const lo = Math.max(pct(dbs[f], 0.1), G - RANGE_DB[f]);
      // percussive families are brief, so their loud level is a higher percentile
      const hi = Math.max(pct(dbs[f], DEF[f].comp === 'p' ? 0.995 : 0.98), lo + MIN_SPAN_DB);
      ranges.push([lo, hi]);
      for (let i = 0; i < n; i++) level[f][i] = this.loud[i] > silenceDb ? familyLevel(dbs[f][i], lo, hi, local[i]) : 0;
    }
    // events, with the same detector as live
    const det = new FamilyOnsets();
    const ev: number[][] = Array.from({ length: NF }, () => []);
    const es: number[][] = Array.from({ length: NF }, () => []);
    const dbf = new Float32Array(NF), lv = new Float32Array(NF);
    for (let i = 0; i < n; i++) {
      for (let f = 0; f < NF; f++) { dbf[f] = dbs[f][i]; lv[f] = level[f][i]; }
      const t = this.t0 + i / this.fps;
      const mask = det.step(t, dbf, lv, hue[i], hueStrength[i]);
      if (mask) for (let f = 0; f < NF; f++) if (mask & (1 << f)) { ev[f].push(t); es[f].push(det.strength[f]); }
    }
    this.X = [];
    this.bins = [];
    return {
      fps: this.fps, t0: this.t0, n, level, melody, hue, hueStrength,
      events: ev.map((e) => Float32Array.from(e)), eventStrength: es.map((e) => Float32Array.from(e)), ranges,
      ...(this.keepDb ? { db: dbs } : {}),
    };
  }
}

// ---- live (causal) --------------------------------------------------------------------------
/**
 * Causal version for the microphone / system audio: medians over the PAST only (short ≈ 0.15 s,
 * long ≈ 0.9 s sampled every 0.1 s), running normalisation with the same presence gate.
 */
export class FamilyTracker {
  private ring: Float32Array[] = Array.from({ length: LIVE_SHORT }, () => new Float32Array(NB));
  private head = 0;
  private filled = 0;
  private longRing: Float32Array[] = Array.from({ length: 9 }, () => new Float32Array(NB));
  private longHead = 0;
  private longFilled = 0;
  private longAcc = 0;
  private X = new Float32Array(NB);
  private Hs = new Float32Array(NB);
  private Hl = new Float32Array(NB);
  private P = new Float32Array(NB);
  private shareS = new Float32Array(NB);
  private pow: Float32Array | null = null;
  private parts = createParts();
  private onsets = new FamilyOnsets();
  // running normalisation (dB)
  private ceil = new Float64Array(NF).fill(-200);
  private floor = new Float64Array(NF).fill(200);
  private gCeil = -200;
  private localCeil = -200;
  private age = 0;
  readonly db = new Float32Array(NF);
  readonly level = new Float32Array(NF);
  melody = -1;
  hue = 0;
  hueStrength = 0;
  /** bitmask of onsets on the last frame */
  onsetMask = 0;
  get onsetStrength() {
    return this.onsets.strength;
  }

  reset() {
    this.filled = this.longFilled = 0;
    this.longAcc = 0;
    this.ceil.fill(-200);
    this.floor.fill(200);
    this.gCeil = -200;
    this.localCeil = -200;
    this.age = 0;
    this.level.fill(0);
    this.onsets.reset();
    this.onsetMask = 0;
    this.melody = -1;
  }

  /** @param active false during silence: levels fall and the normalisers are left alone */
  process(db: Float32Array, binHz: number, t: number, dt: number, active: boolean) {
    const map = bandMap(db.length, binHz);
    if (!this.pow || this.pow.length !== db.length) this.pow = new Float32Array(db.length);
    map.bands(db, this.X, this.pow);
    this.ring[this.head].set(this.X);
    this.head = (this.head + 1) % LIVE_SHORT;
    this.filled = Math.min(LIVE_SHORT, this.filled + 1);
    this.longAcc += dt;
    if (this.longAcc >= 0.1 || this.longFilled === 0) {
      this.longAcc = 0;
      this.longRing[this.longHead].set(this.X);
      this.longHead = (this.longHead + 1) % this.longRing.length;
      this.longFilled = Math.min(this.longRing.length, this.longFilled + 1);
    }
    const n = this.filled;
    for (let k = 0; k < NB; k++) this.Hs[k] = medianOf(n, (j) => this.ring[j][k]);
    for (let k = 0; k < NB; k++) this.Hl[k] = medianOf(this.longFilled, (j) => this.longRing[j][k]);
    freqMedian(this.X, this.P);
    splitFrame(this.X, this.Hs, this.Hl, this.P, map, this.pow, this.parts, this.shareS);
    const p = this.parts;
    this.melody = p.melody;
    const hm = harmonyOf(p.chromaS);
    if (hm.strength > 0.2) this.hue = (this.hue + wrapDiff(hm.hue, this.hue) * Math.min(1, dt * 3) + 1) % 1;
    this.hueStrength += (hm.strength - this.hueStrength) * Math.min(1, dt * 3);

    const totalDb = toDb(p.total);
    for (let f = 0; f < NF; f++) this.db[f] = toDb(p.energy[f]);
    if (!active) {
      for (let f = 0; f < NF; f++) this.level[f] = 0;
      this.onsetMask = 0;
      return;
    }
    this.age += dt;
    const fast = this.age < 4 ? 8 : 1;
    this.gCeil = totalDb > this.gCeil ? totalDb : this.gCeil - 0.4 * fast * dt;
    this.localCeil = totalDb > this.localCeil ? totalDb : this.localCeil - 4 * dt; // ~1.5 s memory of the mix
    for (let f = 0; f < NF; f++) {
      const x = this.db[f];
      this.ceil[f] = x > this.ceil[f] ? x : this.ceil[f] - 0.5 * fast * dt;
      this.floor[f] = x < this.floor[f] ? x : this.floor[f] + 0.6 * fast * dt;
      const lo = Math.max(this.floor[f], this.gCeil - 3 - RANGE_DB[f]); // gCeil ≈ peak, a bit above p95
      const hi = Math.max(this.ceil[f], lo + MIN_SPAN_DB);
      this.level[f] = familyLevel(x, lo, hi, this.localCeil);
    }
    this.onsetMask = this.onsets.step(t, this.db, this.level, this.hue, this.hueStrength);
  }
}

/** Index into a FamilyTrack for playback time t. */
export const famFrame = (tr: FamilyTrack, t: number) => Math.min(tr.n - 1, Math.max(0, Math.round((t - tr.t0) * tr.fps)));
