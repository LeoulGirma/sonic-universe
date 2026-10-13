import { describe, expect, it } from 'vitest';
import { buildSongMap } from '../src/audio/songMap';
import { FamilyTracker, F, FAMILY_IDS, NF, famFrame } from '../src/audio/soundFamilies';
import { FeatureExtractor } from '../src/audio/FeatureExtractor';
import { synthDemo } from '../src/audio/demoTrack';
import { analyse, rng } from './analyserSim';

/**
 * Ground truth: a layered arrangement where each source enters at a known time.
 *   0 s pads (held chord) · 4 s bass (notes every 1 s) · 8 s kick · 12 s hats
 *   16 s lead (a melody, notes every 0.2 s) · 20 s hits (snare-like) · 24 s end
 */
const ENTER = { pads: 0, bass: 4, kick: 8, hats: 12, lead: 16, hits: 20 } as const;
const DUR = 24;

export function arrangement(sr: number) {
  const N = DUR * sr;
  const x = new Float32Array(N);
  const rand = rng(3);
  const tone = (t0: number, t1: number, f0: number, amp: number, harm = 4, attack = 0.02, rel = 0.03) => {
    for (let i = Math.floor(t0 * sr); i < Math.min(N, t1 * sr); i++) {
      const t = i / sr - t0;
      const env = Math.min(1, t / attack, (t1 - t0 - t) / rel);
      let v = 0;
      for (let h = 1; h <= harm; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      x[i] += amp * env * v;
    }
  };
  // pads: C major chord held for the whole song (with a change to F at 12 s)
  tone(0, 12, 261.6, 0.05); tone(0, 12, 329.6, 0.05); tone(0, 12, 392, 0.05);
  tone(12, DUR, 349.2, 0.05); tone(12, DUR, 440, 0.05); tone(12, DUR, 523.3, 0.05);
  // bass: a note per second
  const bassNotes = [55, 65.4, 73.4, 49];
  for (let t = ENTER.bass, k = 0; t < DUR; t += 1, k++) tone(t, t + 0.95, bassNotes[k % 4], 0.22, 5, 0.01, 0.05);
  // kick: pitch-swept sine, short
  for (let t = ENTER.kick; t < DUR; t += 0.5) {
    let ph = 0;
    for (let i = 0; i < 0.25 * sr; i++) {
      const tt = i / sr;
      ph += (2 * Math.PI * (45 + 80 * Math.exp(-tt / 0.025))) / sr;
      const j = Math.floor(t * sr) + i;
      if (j < N) x[j] += 0.8 * Math.sin(ph) * Math.exp(-tt / 0.06);
    }
  }
  // hats: noise ticks every 1/8 s, high-passed at 12 dB/octave (a second difference; real hats
  // are steeper still, with most energy above 6 kHz)
  for (let t = ENTER.hats; t < DUR; t += 0.125) {
    let p1 = 0, p2 = 0;
    for (let i = 0; i < 0.04 * sr; i++) {
      const n = rand() * 2 - 1;
      const j = Math.floor(t * sr) + i;
      if (j < N) x[j] += 0.2 * (n - 2 * p1 + p2) * Math.exp(-(i / sr) / 0.012);
      p2 = p1;
      p1 = n;
    }
  }
  // lead: a legato melody, a new note every 0.2 s (each note overlaps the next by its 30 ms
  // release, as a lead line is played; hard-gated staccato notes click, and those clicks can
  // legitimately read as hits)
  const mel = [523, 587, 659, 784, 880, 784, 659, 698, 587, 523, 494, 587];
  for (let t = ENTER.lead, k = 0; t < DUR - 0.25; t += 0.2, k++) tone(t, t + 0.23, mel[k % mel.length], 0.08, 3, 0.02, 0.03);
  // hits: snare = broadband noise burst + 190 Hz body, on the off-beats
  for (let t = ENTER.hits + 0.25; t < DUR; t += 0.5) {
    for (let i = 0; i < 0.15 * sr; i++) {
      const tt = i / sr;
      const j = Math.floor(t * sr) + i;
      if (j < N) x[j] += 0.35 * (rand() * 2 - 1) * Math.exp(-tt / 0.05) + 0.3 * Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.04);
    }
  }
  return x;
}

const mean = (a: ArrayLike<number>, i0: number, i1: number) => {
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i];
  return s / Math.max(1, i1 - i0);
};
/** high percentile: hits are brief (a snare is ~4 frames in 30), so "is it there" is about peaks */
const pq = (a: ArrayLike<number>, i0: number, i1: number, q: number) => {
  const v = Array.from(a).slice(i0, i1).sort((x, y) => x - y);
  return v.length ? v[Math.floor(q * (v.length - 1))] : 0;
};
const p90 = (a: ArrayLike<number>, i0: number, i1: number) => pq(a, i0, i1, 0.9);
const PERC: number[] = [F.kick, F.hits, F.hats];
const peakQ = (f: number) => (PERC.includes(f) ? 0.97 : 0.9);

describe('sound families, whole-song (song map)', () => {
  const SR = 22050;
  const map = buildSongMap(arrangement(SR), SR);
  const fam = map.families!;
  const lvl = (f: number, a: number, b: number) => mean(fam.level[f], famFrame(fam, a), famFrame(fam, b));
  const peak = (f: number, a: number, b: number) => pq(fam.level[f], famFrame(fam, a), famFrame(fam, b), peakQ(f));

  it.each(FAMILY_IDS.map((id) => [id]))('%s lights up when it enters, not before', (id) => {
    const f = F[id];
    const t = ENTER[id];
    const after = peak(f, t + 0.5, Math.min(DUR - 0.3, t + 3.5));
    expect(after).toBeGreaterThan(0.5);
    if (t >= 4) {
      const before = peak(f, Math.max(0.3, t - 3.5), t - 0.3);
      expect(after - before).toBeGreaterThan(0.3);
    }
  });

  it('keeps the held chord as pads, not lead', () => {
    expect(lvl(F.pads, 1, 3.5)).toBeGreaterThan(lvl(F.lead, 1, 3.5) + 0.3);
  });

  it('places the melody above the bass register and sees the chord change', () => {
    const m = Array.from(fam.melody.subarray(famFrame(fam, 17), famFrame(fam, 23))).filter((v) => v >= 0);
    expect(m.reduce((a, b) => a + b, 0) / m.length).toBeGreaterThan(0.3);
    const circ = (a: number, b: number) => {
      let c = 0, s = 0;
      for (let i = famFrame(fam, a); i < famFrame(fam, b); i++) { c += Math.cos(2 * Math.PI * fam.hue[i]); s += Math.sin(2 * Math.PI * fam.hue[i]); }
      return ((Math.atan2(s, c) / (2 * Math.PI)) % 1 + 1) % 1;
    };
    const hueA = circ(5, 11.5), hueB = circ(13, 23);
    // C major → F major is one step on the circle of fifths (1/12 of a turn); chord tones and
    // overtones blur it, so ask for a clear move in the right direction
    let d = hueB - hueA;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    expect(d).toBeLessThan(-0.03);
  });

  it('counts hats and lead notes at their real rates', () => {
    const rate = (f: number, a: number, b: number) => fam.events[f].filter((t) => t >= a && t < b).length / (b - a);
    expect(rate(F.hats, 13, 23)).toBeGreaterThan(6); // 8 per second
    expect(rate(F.hats, 13, 23)).toBeLessThan(9);
    expect(rate(F.lead, 17, 23)).toBeGreaterThan(2.5); // 5 per second; repeated pitches merge
  });

  it('catches every snare as a hit', () => {
    // hits are any mid-range transient (note attacks too), so test recall on the snare
    const snares: number[] = [];
    for (let t = ENTER.hits + 0.25; t < DUR - 0.2; t += 0.5) snares.push(t);
    const caught = snares.filter((t) => fam.events[F.hits].some((e) => e >= t - 0.01 && e <= t + 0.07)).length;
    expect(caught / snares.length).toBeGreaterThan(0.9);
  });
});

describe('sound families, live (causal, through the analyser)', () => {
  const SR = 44100;
  const data = arrangement(SR);
  const fx = new FeatureExtractor();
  const rows: { t: number; lv: number[] }[] = [];
  const hitTimes: number[] = [];
  let lastHits = 0;
  analyse({ sr: SR, data, kicks: [], hats: [], bassHits: [] }, (freq, td, t, dt) => {
    const f = fx.process(freq, td, SR, t, dt);
    rows.push({ t, lv: [...f.fam.level] });
    if (f.fam.count[F.hits] > lastHits) hitTimes.push(t);
    lastHits = f.fam.count[F.hits];
  });
  const lvl = (f: number, a: number, b: number) => {
    const r = rows.filter((x) => x.t >= a && x.t < b).map((x) => x.lv[f]);
    return pq(r, 0, r.length, peakQ(f));
  };

  it('catches the snare live', () => {
    const snares: number[] = [];
    for (let t = ENTER.hits + 0.25; t < DUR - 0.2; t += 0.5) snares.push(t);
    const caught = snares.filter((t) => hitTimes.some((e) => e >= t && e <= t + 0.08)).length;
    expect(caught / snares.length).toBeGreaterThan(0.8);
  });

  it.each(FAMILY_IDS.filter((id) => id !== 'hits').map((id) => [id]))('%s rises when it enters', (id) => {
    const f = F[id];
    const t = ENTER[id];
    if (t < 4) return;
    expect(lvl(f, t + 0.5, Math.min(DUR - 0.3, t + 3.5)) - lvl(f, t - 3.5, t - 0.3)).toBeGreaterThan(0.2);
  });

  it('runs well inside a frame budget', () => {
    const tr2 = new FamilyTracker();
    const freq = new Float32Array(1024).map((_, i) => -60 - i * 0.02);
    const t0 = performance.now();
    for (let i = 0; i < 600; i++) tr2.process(freq, SR / 2048, i / 60, 1 / 60, true);
    expect((performance.now() - t0) / 600).toBeLessThan(1.5); // ms per frame
  });
});

describe('sound families on the demo track (map vs. its arrangement)', () => {
  const SR = 22050;
  const demo = synthDemo(SR);
  const fam = buildSongMap(demo.data, SR).families!;
  const lvl = (f: number, a: number, b: number) => mean(fam.level[f], famFrame(fam, a), famFrame(fam, b));
  const peak = (f: number, a: number, b: number) => p90(fam.level[f], famFrame(fam, a), famFrame(fam, b));
  const [b0, b1] = demo.breakdown;

  it('drops kick and bass in the breakdown and brings them back on the drop', () => {
    for (const f of [F.kick, F.bass]) {
      expect(lvl(f, b0 + 1, b1 - 4)).toBeLessThan(0.2);
      expect(peak(f, demo.dropAt + 1, demo.dropAt + 8)).toBeGreaterThan(peak(f, b0 + 1, b1 - 4) + 0.5);
    }
  });

  it('opens up pads and lead in the breakdown', () => {
    expect(lvl(F.pads, b0 + 1, b1 - 1)).toBeGreaterThan(lvl(F.pads, b0 - 8, b0));
    expect(lvl(F.lead, b0 + 1, b1 - 1)).toBeGreaterThan(lvl(F.lead, b0 - 8, b0));
  });

  it('the live extractor exposes the same families from a map', () => {
    const fx = new FeatureExtractor();
    const map = buildSongMap(demo.data, SR);
    fx.setMap(map);
    expect(fx.f.fam.level.length).toBe(NF);
  });
});
