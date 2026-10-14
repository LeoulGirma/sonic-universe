import { describe, expect, it } from 'vitest';
import { synthDemo, DEMO_BPM } from '../src/audio/demoTrack';
import { FeatureExtractor } from '../src/audio/FeatureExtractor';
import { analyse } from './analyserSim';

describe('the built-in demo track through the real extractor', () => {
  const t0 = performance.now();
  const demo = synthDemo(44100);
  const synthMs = performance.now() - t0;
  const fx = new FeatureExtractor();
  const kicks: number[] = [];
  const kickStrength: number[] = [];
  const drops: number[] = [];
  const frames: { t: number; bpm: number; breakdown: number; bass: number; section: string }[] = [];
  let lk = 0, ld = 0;
  analyse({ sr: demo.sampleRate, data: demo.data, kicks: demo.kicks, hats: [], bassHits: [] }, (fr, td, t, dt) => {
    const f = fx.process(fr, td, demo.sampleRate, t, dt);
    if (f.kickCount > lk) { kicks.push(t); kickStrength.push(f.kick); }
    if (f.dropCount > ld) drops.push(t);
    lk = f.kickCount; ld = f.dropCount;
    frames.push({ t, bpm: f.bpm, breakdown: f.breakdown, bass: f.bass, section: f.section });
  });

  it('synthesises quickly enough for a phone', () => {
    // ~3 s alone; CI runs the test files in parallel on shared machines, so leave headroom
    expect(synthMs).toBeLessThan(8000);
  });

  it('finds the kicks', () => {
    const truth = demo.kicks.filter((t) => t > 10);
    const hit = truth.filter((t) => kicks.some((d) => d >= t - 0.01 && d - t < 0.07)).length;
    expect(hit / truth.length).toBeGreaterThan(0.9);
  });

  it('gives true kicks stronger impulses than other low-end hits (bass notes)', () => {
    const isKick = (d: number) => demo.kicks.some((t) => d >= t - 0.01 && d - t < 0.07);
    const k = kickStrength.filter((_, i) => kicks[i] > 10 && isKick(kicks[i]));
    const o = kickStrength.filter((_, i) => kicks[i] > 10 && !isKick(kicks[i]));
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
    expect(mean(k)).toBeGreaterThan(mean(o) * 1.3);
  });

  it('locks to 122 BPM', () => {
    const late = frames.filter((f) => f.t > 20 && f.t < 30);
    const bpm = late.reduce((a, f) => a + f.bpm, 0) / late.length;
    expect(Math.abs(bpm - DEMO_BPM)).toBeLessThan(2);
  });

  it('detects the breakdown and the drop', () => {
    const [b0, b1] = demo.breakdown;
    const inside = frames.filter((f) => f.t > b0 + 3 && f.t < b1 - 0.3);
    expect(inside.filter((f) => f.breakdown > 0.5).length / inside.length).toBeGreaterThan(0.8);
    expect(drops.some((t) => t >= demo.dropAt && t < demo.dropAt + 0.4)).toBe(true);
    expect(drops.filter((t) => t < demo.dropAt - 0.1).length).toBeLessThanOrEqual(1);
    // one breakdown → one drop: nothing else in the following 12 s
    expect(drops.filter((t) => t > demo.dropAt + 0.4 && t < demo.dropAt + 12).length).toBe(0);
  });
});
