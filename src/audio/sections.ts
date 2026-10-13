import { NF, type FamilyTrack, famFrame } from './soundFamilies';
import { SPEC_BANDS, type SpecTrack, specFrame } from './spectrum';

/**
 * Song sections from the whole-song analysis, and which of them are the same kind of section.
 *
 *  1. One feature vector per beat: the mean 32-band spectrum and the six sound-family levels
 *     (z-scored per dimension across the song, families weighted up: they carry instrumentation).
 *  2. Novelty (Foote, ICME 2000): a Gaussian-tapered checkerboard kernel slid along the diagonal of
 *     the beat-by-beat cosine self-similarity matrix peaks where the music before and after a beat
 *     differ. Peaks above an adaptive threshold become boundaries, snapped to whole bars; the
 *     song map's breakdown spans and drops are always boundaries.
 *  3. Labels: sections are compared by their mean vectors; a section close enough to an earlier
 *     label takes it (a returning chorus is recognised), otherwise it starts a new one.
 *  4. Biomes, by each label's energy rank: the loudest becomes mountains, the quietest (or any
 *     breakdown) a lake, the rest dunes and spires in turn. Same label → same biome.
 */
export type Biome = 0 | 1 | 2 | 3; // dunes, mountains, lake, spires
export const BIOME_NAMES = ['Dunes', 'Mountains', 'Lake', 'Spires'] as const;

export interface Section {
  start: number; // seconds
  end: number;
  startBeat: number; // map beat index
  label: number; // 0.. — sections with the same label are the same kind of passage
  biome: Biome;
  energy: number; // 0..1, relative within the song
}

const KERNEL = 16; // beats on each side (4 bars)
const MIN_LEN = 16; // beats

export function findSections(
  beats: Float64Array, duration: number, spec: SpecTrack | null, fam: FamilyTrack | null,
  breakdowns: [number, number][], drops: { t: number }[],
): Section[] {
  const nb = beats.length - 1;
  if (nb < MIN_LEN * 2 || !spec || !fam) return nb > 0 ? [{ start: 0, end: duration, startBeat: 0, label: 0, biome: 0, energy: 0.5 }] : [];
  const D = SPEC_BANDS + NF;
  const X = Array.from({ length: nb }, () => new Float64Array(D));
  const energy = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const t0 = beats[i], t1 = beats[i + 1];
    const j0 = specFrame(spec, t0), j1 = Math.max(j0 + 1, specFrame(spec, t1));
    for (let j = j0; j < j1; j++) for (let k = 0; k < SPEC_BANDS; k++) X[i][k] += spec.data[j * SPEC_BANDS + k] / 255 / (j1 - j0);
    const f0 = famFrame(fam, t0), f1 = Math.max(f0 + 1, famFrame(fam, t1));
    for (let f = 0; f < NF; f++) {
      let s = 0;
      for (let j = f0; j < f1; j++) s += fam.level[f][j];
      X[i][SPEC_BANDS + f] = s / (f1 - f0);
    }
    for (let k = 0; k < D; k++) energy[i] += X[i][k] / D;
  }
  // z-score per dimension, families weighted ×3 (6 dims against 32 spectral ones)
  for (let k = 0; k < D; k++) {
    let m = 0, v = 0;
    for (let i = 0; i < nb; i++) m += X[i][k];
    m /= nb;
    for (let i = 0; i < nb; i++) v += (X[i][k] - m) ** 2;
    const sd = Math.sqrt(v / nb) || 1;
    const w = k >= SPEC_BANDS ? 3 : 1;
    for (let i = 0; i < nb; i++) X[i][k] = ((X[i][k] - m) / sd) * w;
  }
  const norm = X.map((x) => Math.sqrt(x.reduce((a, b) => a + b * b, 0)) || 1);
  const sim = (a: number, b: number) => {
    let s = 0;
    for (let k = 0; k < D; k++) s += X[a][k] * X[b][k];
    return s / (norm[a] * norm[b]);
  };

  // Foote novelty along the diagonal
  const nov = new Float64Array(nb);
  const g = (u: number) => Math.exp(-0.5 * (u / (KERNEL / 2)) ** 2);
  for (let i = KERNEL; i < nb - KERNEL; i++) {
    let s = 0;
    for (let a = -KERNEL; a < KERNEL; a++) for (let b = -KERNEL; b < KERNEL; b++) {
      const sign = (a < 0) === (b < 0) ? 1 : -1;
      s += sign * g(a + 0.5) * g(b + 0.5) * sim(i + a, i + b);
    }
    nov[i] = Math.max(0, s);
  }
  let mean = 0, sd = 0, cnt = 0;
  for (let i = KERNEL; i < nb - KERNEL; i++) { mean += nov[i]; cnt++; }
  mean /= Math.max(1, cnt);
  for (let i = KERNEL; i < nb - KERNEL; i++) sd += (nov[i] - mean) ** 2;
  sd = Math.sqrt(sd / Math.max(1, cnt));
  const thr = mean + 0.6 * sd;

  const beatAt = (t: number) => {
    let lo = 0, hi = nb;
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m + 1; else hi = m; }
    return lo;
  };
  const snap = (i: number) => Math.round(i / 4) * 4; // whole bars (relative to the first beat)
  const cand: { i: number; w: number }[] = [];
  for (let i = KERNEL; i < nb - KERNEL; i++) {
    let peak = nov[i] > thr;
    for (let d = -8; d <= 8 && peak; d++) if (d && nov[i + d] > nov[i]) peak = false;
    if (peak) cand.push({ i: snap(i), w: nov[i] });
  }
  // structure the map already knows is always a boundary
  for (const [a, b] of breakdowns) { cand.push({ i: beatAt(a), w: Infinity }); cand.push({ i: beatAt(b), w: Infinity }); }
  for (const d of drops) cand.push({ i: beatAt(d.t), w: Infinity });
  cand.sort((x, y) => y.w - x.w);
  const bounds: number[] = [];
  for (const c of cand) {
    if (c.i < MIN_LEN / 2 || c.i > nb - MIN_LEN / 2) continue;
    if (bounds.some((b) => Math.abs(b - c.i) < MIN_LEN)) continue;
    bounds.push(c.i);
  }
  bounds.sort((a, b) => a - b);
  const starts = [0, ...bounds];

  // label by similarity of section means
  const segs = starts.map((s, k) => ({ s, e: k + 1 < starts.length ? starts[k + 1] : nb }));
  const means = segs.map(({ s, e }) => {
    const m = new Float64Array(D);
    for (let i = s; i < e; i++) for (let k = 0; k < D; k++) m[k] += X[i][k] / (e - s);
    return m;
  });
  const dist = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let k = 0; k < D; k++) s += (a[k] - b[k]) ** 2;
    return Math.sqrt(s / D);
  };
  // "the same kind of section" is relative to how different this song's sections are from each
  // other: a uniform groove still has exact repeats (distance ~0.1) among phrases (~0.6)
  const pair: number[] = [];
  for (let a = 0; a < means.length; a++) for (let b = a + 1; b < means.length; b++) pair.push(dist(means[a], means[b]));
  pair.sort((x, y) => x - y);
  const med = pair.length ? pair[Math.floor(pair.length / 2)] : 1;
  const theta = Math.min(0.75, Math.max(0.25, 0.45 * med));
  const labels: number[] = [];
  const reps: { m: Float64Array; n: number }[] = [];
  for (const m of means) {
    let best = -1, bd = Infinity;
    reps.forEach((r, j) => { const d = dist(m, r.m); if (d < bd) { bd = d; best = j; } });
    if (best >= 0 && (bd < theta || reps.length >= 5)) {
      const r = reps[best];
      for (let k = 0; k < D; k++) r.m[k] = (r.m[k] * r.n + m[k]) / (r.n + 1);
      r.n++;
      labels.push(best);
    } else {
      reps.push({ m: Float64Array.from(m), n: 1 });
      labels.push(reps.length - 1);
    }
  }

  // energy per section and per label; biomes by label energy rank
  const segE = segs.map(({ s, e }) => { let x = 0; for (let i = s; i < e; i++) x += energy[i]; return x / (e - s); });
  const eMin = Math.min(...segE), eMax = Math.max(...segE);
  const rel = segE.map((x) => (eMax > eMin ? (x - eMin) / (eMax - eMin) : 0.5));
  const labE = reps.map((_, j) => { let x = 0, n = 0; labels.forEach((l, k) => { if (l === j) { x += rel[k]; n++; } }); return x / n; });
  const order = labE.map((e, j) => [e, j] as const).sort((a, b) => a[0] - b[0]).map(([, j]) => j);
  const biomeOf = new Array<Biome>(reps.length).fill(0);
  if (order.length === 1) biomeOf[order[0]] = 0;
  else {
    biomeOf[order[order.length - 1]] = 1; // loudest: mountains
    if (labE[order[0]] < 0.45) biomeOf[order[0]] = 2; // clearly quiet: lake
    const mid = order.slice(labE[order[0]] < 0.45 ? 1 : 0, -1);
    mid.forEach((j, k) => { biomeOf[j] = k % 2 === 0 ? 0 : 3; });
  }
  const inBreakdown = (s: number, e: number) => breakdowns.some(([a, b]) => beatAt(a) <= s + 2 && beatAt(b) >= e - 2);

  const out: Section[] = [];
  segs.forEach(({ s, e }, k) => {
    const biome: Biome = inBreakdown(s, e) ? 2 : biomeOf[labels[k]];
    const last = out[out.length - 1];
    if (last && last.label === labels[k] && last.biome === biome) {
      // the same passage continuing: one section, no gate
      last.end = e >= nb ? duration : beats[e];
      last.energy = Math.max(last.energy, rel[k]);
      return;
    }
    out.push({ start: s === 0 ? 0 : beats[s], end: e >= nb ? duration : beats[e], startBeat: s, label: labels[k], biome, energy: rel[k] });
  });
  return out;
}
