import { describe, expect, it } from 'vitest';
import { synthDemo, DEMO_BPM } from '../src/audio/demoTrack';
import { buildSongMap } from '../src/audio/songMap';
import { FeatureExtractor } from '../src/audio/FeatureExtractor';
import { analyse, rng } from './analyserSim';

// the app decodes at 22.05 kHz for mapping, so test that path
const SR = 22050;
const demo = synthDemo(SR);
const t0 = performance.now();
const map = buildSongMap(demo.data, SR);
const buildMs = performance.now() - t0;

describe('song map of the demo track', () => {
  it('is fast enough to run in the background', () => {
    expect(buildMs).toBeLessThan(10000); // ~64 s of audio
  });

  it('finds the tempo', () => {
    expect(Math.abs(map.bpm - DEMO_BPM)).toBeLessThan(0.5);
  });

  it('puts a beat on every kick, from the first one', () => {
    const kicks = demo.kicks;
    const near = kicks.filter((k) => map.beats.some((b) => Math.abs(b - k) < 0.035)).length;
    expect(near / kicks.length).toBeGreaterThan(0.95);
  });

  it('keeps the grid through the kick-free breakdown', () => {
    const [b0, b1] = demo.breakdown;
    const inside = Array.from(map.beats).filter((b) => b > b0 + 1 && b < b1 - 1);
    const period = 60 / DEMO_BPM;
    for (let i = 1; i < inside.length; i++) expect(Math.abs(inside[i] - inside[i - 1] - period)).toBeLessThan(0.01);
    expect(inside.length).toBeGreaterThan(25);
  });

  it('finds the breakdown by its whole extent', () => {
    const [b0, b1] = demo.breakdown;
    expect(map.breakdowns.some(([a, b]) => a <= b0 + 1.5 && b >= b1 - 0.3)).toBe(true);
    expect(map.breakdowns.some(([a, b]) => a < 31 && b > 9.5)).toBe(false); // nothing inside the groove
  });

  it('knows the drop in advance, on its beat, with a build-up window before it', () => {
    const drop = map.drops.find((d) => Math.abs(d.t - demo.dropAt) < 0.12);
    expect(drop).toBeDefined();
    // the only other allowed drop is the beat entering after the kick-free intro
    for (const d of map.drops) expect(Math.abs(d.t - demo.dropAt) < 0.12 || Math.abs(d.t - 8.37) < 0.3).toBe(true);
    const w = map.anticipation.find(([, e]) => Math.abs(e - drop!.t) < 1e-6);
    expect(w).toBeDefined();
    expect(w![1] - w![0]).toBeGreaterThanOrEqual(3);
  });
});

describe('real-time extractor driven by the map', () => {
  it('builds up BEFORE the drop, fires it on time, and beats land on the grid', () => {
    const fx = new FeatureExtractor();
    let mapped = false;
    let ld = 0;
    const drops: number[] = [];
    const build: { t: number; v: number }[] = [];
    const beatErr: number[] = [];
    analyse({ sr: SR, data: demo.data, kicks: [], hats: [], bassHits: [] }, (fr, td, t, dt) => {
      if (!mapped && t > 3) { fx.setMap(map); mapped = true; } // the map arrives a few seconds in
      const f = fx.process(fr, td, SR, t, dt);
      if (f.dropCount > ld) drops.push(t);
      ld = f.dropCount;
      build.push({ t, v: f.build });
      if (mapped && f.beat && t > 4) {
        const b = map.beats.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), 1e9);
        beatErr.push(t - b);
      }
    }, 1024, 60);
    const at = (x: number) => build.reduce((best, b) => (Math.abs(b.t - x) < Math.abs(best.t - x) ? b : best)).v;
    expect(at(demo.dropAt - 1)).toBeGreaterThan(0.5); // anticipation, not reaction
    expect(at(demo.dropAt - 10)).toBeLessThan(0.05);
    const mapDrop = map.drops.find((d) => Math.abs(d.t - demo.dropAt) < 0.12)!.t;
    expect(Math.abs(mapDrop - demo.dropAt)).toBeLessThan(0.012); // on the heard onset
    expect(drops.some((d) => d >= mapDrop && d - mapDrop < 1 / 60 + 1e-6)).toBe(true); // fired the frame it arrives
    expect(Math.max(...beatErr.map(Math.abs))).toBeLessThan(1 / 60 + 1e-6); // within one frame
  });

  it('does not fire drops or beats across a seek', () => {
    const fx = new FeatureExtractor();
    fx.setMap(map);
    const N = 1024;
    const frame = new Float32Array(N);
    const freq = new Float32Array(N / 2).fill(-60);
    let beats = 0;
    let ld = 0;
    let drops = 0;
    const step = (t: number) => {
      const f = fx.process(freq, frame, SR, t, 1 / 60);
      if (f.beat) beats++;
      if (f.dropCount > ld) drops++;
      ld = f.dropCount;
    };
    step(20); step(20 + 1 / 60);
    fx.seek();
    step(demo.dropAt + 2); // jumped over the drop and many beats
    expect(drops).toBe(0);
    expect(beats).toBe(0);
  });
});

describe('song map on syncopated drums with an off-beat pickup', () => {
  it('has the right phase from the first bar', () => {
    const sr = SR;
    const N = sr * 24;
    const data = new Float32Array(N);
    const beat = 0.5;
    const start = 1.0;
    const rand = rng(5);
    const kick = (t: number, amp: number) => {
      let ph = 0;
      const i0 = Math.floor(t * sr);
      for (let i = 0; i < sr * 0.6 && i0 + i < N; i++) {
        const x = i / sr;
        ph += (2 * Math.PI * (45 + 90 * Math.exp(-x / 0.03))) / sr;
        data[i0 + i] += amp * Math.sin(ph) * Math.exp(-x / 0.13);
      }
    };
    kick(start - beat / 2, 0.8);
    for (let b = start; b < 23; b += 4 * beat) {
      kick(b, 0.95); kick(b + 0.75 * beat, 0.6); kick(b + 2 * beat, 0.9); kick(b + 2.5 * beat, 0.7);
      for (let k = 0; k < 8; k++) {
        const i0 = Math.floor((b + (k * beat) / 2) * sr);
        let prev = 0;
        for (let i = 0; i < sr * 0.04 && i0 + i < N; i++) { const n = rand() * 2 - 1; data[i0 + i] += 0.15 * (n - prev) * Math.exp(-(i / sr) / 0.015); prev = n; }
      }
    }
    const m = buildSongMap(data, sr);
    expect(Math.abs(m.bpm - 120)).toBeLessThan(1);
    const early = Array.from(m.beats).filter((b) => b > start - 0.1 && b < start + 4);
    for (const b of early) {
      const p = ((b - start) / beat) % 1;
      expect(Math.min(p, 1 - p)).toBeLessThan(0.1);
    }
  });
});
