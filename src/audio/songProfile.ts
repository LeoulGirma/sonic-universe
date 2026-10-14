/**
 * Song profile: a handful of whole-song descriptors (how loud, busy, bright, major/minor,
 * bass-driven, groovy, melodic…) measured while the song map is built. The raw values are in
 * physical units; `placeProfile` turns them into 0..1 positions against a reference library
 * (percentiles of the same features over a real music collection), so "calm" and "intense"
 * mean calm and intense relative to actual songs, not to guessed thresholds.
 */
import { NF, F, type FamilyTrack } from './soundFamilies';

export interface RawProfile {
  loud: number; // median loudness of non-silent frames, dB
  dyn: number; // p95 − p10 of 1 s loudness, dB (how much the song breathes)
  centroid: number; // median spectral centroid, Hz (brightness)
  bpm: number;
  pulse: number; // beat-grid confidence 0..1
  kickRate: number; // confirmed low-end hits per second
  onsetRate: number; // percussive family onsets per second (kick+hits+hats)
  noteRate: number; // tonal onsets per second (bass+lead notes)
  share: number[]; // NF mean power shares, sum 1
  melody: number; // fraction of frames with a clear melodic line
  tonal: number; // mean harmony clarity (hueStrength) 0..1
  chordRate: number; // harmony hue changes per second
  mode: number; // major − minor key-profile correlation (−1..1, + = major)
  keyClarity: number; // best key-profile correlation 0..1
  third: number; // major − minor third above the bass-weighted tonic (−1..1, + = major)
  chroma: number[]; // 12, mean normalised pitch-class profile (C = 0)
  bassChroma: number[]; // 12, same for 40–200 Hz
  drops: number; // drops per minute
  breakdown: number; // fraction of the song in breakdowns
  sections: number; // distinct section labels
}

// Krumhansl–Kessler key profiles
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: ArrayLike<number>, b: ArrayLike<number>, rot: number) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma, y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const pct = (v: number[], p: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};

/** per-frame accumulation (called every few analysis frames) */
export class ProfileCollector {
  private cents: number[] = [];
  private chroma = new Float64Array(12);
  private bassChroma = new Float64Array(12);
  private pcOf: Int8Array | null = null;
  private lowOf: Int8Array | null = null;
  push(freqDb: Float32Array, binHz: number, loudDb: number, silenceDb: number) {
    if (loudDb <= silenceDb) return;
    const n = freqDb.length;
    if (!this.pcOf) {
      this.pcOf = new Int8Array(n).fill(-1);
      for (let i = 1; i < n; i++) {
        const f = i * binHz;
        if (f < 80 || f > 2500) continue;
        this.pcOf[i] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
      }
      this.lowOf = new Int8Array(n).fill(-1);
      for (let i = 1; i < n; i++) {
        const f = i * binHz;
        if (f >= 40 && f <= 200) this.lowOf[i] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
      }
    }
    let s = 0, w = 0;
    const fr = new Float64Array(12);
    const lo = new Float64Array(12);
    for (let i = 1; i < n; i++) {
      const p = Math.pow(10, freqDb[i] / 10);
      s += p * i * binHz;
      w += p;
      const pc = this.pcOf[i];
      if (pc >= 0) fr[pc] += Math.sqrt(p);
      const lc = this.lowOf![i];
      if (lc >= 0) lo[lc] += p;
    }
    let lt = 0;
    for (let k = 0; k < 12; k++) lt += lo[k];
    if (lt > 0) for (let k = 0; k < 12; k++) this.bassChroma[k] += lo[k] / lt;
    if (w > 0) this.cents.push(s / w);
    // each frame votes with its normalised chroma, so loud passages don't own the key
    let t = 0;
    for (let k = 0; k < 12; k++) t += fr[k];
    if (t > 0) for (let k = 0; k < 12; k++) this.chroma[k] += fr[k] / t;
  }

  finish(o: {
    loudDb: Float32Array; fps: number; silenceDb: number; duration: number; bpm: number; pulse: number;
    kicks: number; fam: FamilyTrack | null; drops: number; breakdowns: [number, number][]; sectionLabels: number;
  }): RawProfile {
    const { loudDb, fps, silenceDb, duration } = o;
    const valid: number[] = [];
    for (let i = 0; i < loudDb.length; i++) if (loudDb[i] > silenceDb) valid.push(loudDb[i]);
    // 1 s means for dynamics
    const sec: number[] = [];
    for (let i = 0; i + fps <= loudDb.length; i += fps) {
      let a = 0, c = 0;
      for (let j = i; j < i + fps; j++) if (loudDb[j] > silenceDb) { a += loudDb[j]; c++; }
      if (c > fps / 2) sec.push(a / c);
    }
    let bestMaj = -1, bestMin = -1;
    for (let r = 0; r < 12; r++) {
      bestMaj = Math.max(bestMaj, corr(this.chroma, KK_MAJ, r));
      bestMin = Math.max(bestMin, corr(this.chroma, KK_MIN, r));
    }
    // tonic: the pitch class the bass and the harmony both lean on (with its fifth); then the
    // third above it says major or minor, which resolves relative-key ambiguity better than
    // key profiles alone
    const C = this.chroma, B = this.bassChroma;
    const cs = C.reduce((a, b) => a + b, 0) || 1, bs = B.reduce((a, b) => a + b, 0) || 1;
    let tonic = 0, best = -1;
    for (let t = 0; t < 12; t++) {
      const sc = 1.5 * (B[t] / bs) + C[t] / cs + 0.5 * (C[(t + 7) % 12] / cs);
      if (sc > best) { best = sc; tonic = t; }
    }
    const M3 = C[(tonic + 4) % 12] / cs, m3 = C[(tonic + 3) % 12] / cs;
    const third = (M3 - m3) / Math.max(1e-6, M3 + m3);
    const share = new Array(NF).fill(0);
    let melody = 0, tonal = 0, chordRate = 0, onsetRate = 0, noteRate = 0;
    const fam = o.fam;
    if (fam) {
      let nv = 0, lastHue = -1;
      let changes = 0;
      for (let i = 0; i < fam.n; i++) {
        let tot = 0;
        if (fam.db) for (let k = 0; k < NF; k++) tot += Math.pow(10, fam.db[k][i] / 10);
        if (tot <= 0 && fam.db) continue;
        nv++;
        if (fam.db) for (let k = 0; k < NF; k++) share[k] += Math.pow(10, fam.db[k][i] / 10) / tot;
        if (fam.melody[i] >= 0) melody++;
        tonal += fam.hueStrength[i];
        if (fam.hueStrength[i] > 0.3) {
          const h = fam.hue[i];
          if (lastHue >= 0) {
            const d = Math.abs(h - lastHue);
            if (Math.min(d, 1 - d) > 1 / 12) { changes++; lastHue = h; }
          } else lastHue = h;
        }
      }
      if (nv) {
        for (let k = 0; k < NF; k++) share[k] /= nv;
        melody /= nv;
        tonal /= nv;
      }
      chordRate = changes / Math.max(1, duration);
      onsetRate = (fam.events[F.kick].length + fam.events[F.hits].length + fam.events[F.hats].length) / Math.max(1, duration);
      noteRate = (fam.events[F.bass].length + fam.events[F.lead].length) / Math.max(1, duration);
    }
    return {
      loud: pct(valid, 0.5),
      dyn: pct(sec, 0.95) - pct(sec, 0.1),
      centroid: pct(this.cents, 0.5),
      bpm: o.bpm,
      pulse: o.pulse,
      kickRate: o.kicks / Math.max(1, duration),
      onsetRate,
      noteRate,
      share,
      melody,
      tonal,
      chordRate,
      mode: bestMaj - bestMin,
      keyClarity: Math.max(bestMaj, bestMin),
      third,
      chroma: Array.from(C, (x) => x / cs),
      bassChroma: Array.from(B, (x) => x / bs),
      drops: (o.drops / Math.max(1, duration)) * 60,
      breakdown: o.breakdowns.reduce((s, [a, b]) => s + b - a, 0) / Math.max(1, duration),
      sections: o.sectionLabels,
    };
  }
}
