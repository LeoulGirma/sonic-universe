import { describe, expect, it } from 'vitest';
import { FeatureExtractor, MusicFeatures } from '../src/audio/FeatureExtractor';
import { analyse, makeTrack } from './analyserSim';

interface Frame { t: number; f: MusicFeatures }

function run(bpm = 120, gain = 1) {
  const track = makeTrack(bpm, gain);
  const fx = new FeatureExtractor();
  const frames: Frame[] = [];
  const kickTimes: number[] = [];
  const dropTimes: number[] = [];
  let lastKick = 0;
  let lastDrop = 0;
  analyse(track, (freq, time, t, dt) => {
    const f = fx.process(freq, time, track.sr, t, dt);
    if (f.kickCount !== lastKick) kickTimes.push(t);
    if (f.dropCount !== lastDrop) dropTimes.push(t);
    lastKick = f.kickCount;
    lastDrop = f.dropCount;
    frames.push({ t, f: { ...f } });
  });
  return { track, frames, kickTimes, dropTimes };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const between = (fr: Frame[], a: number, b: number) => fr.filter((x) => x.t >= a && x.t < b);

// `kick` is defined as a low-frequency transient: off-beat bass stabs are valid detections too,
// so recall is measured on kicks and false positives are anything matching neither.
function matchKicks(truth: number[], detected: number[], from: number, to: number, alsoValid: number[] = [], tol = 0.07) {
  const tr = truth.filter((t) => t >= from && t < to);
  const de = detected.filter((t) => t >= from && t < to + tol);
  const near = (d: number, t: number) => d >= t - 0.01 && d - t <= tol;
  const hit = tr.filter((t) => de.some((d) => near(d, t))).length;
  const falsePos = de.filter((d) => !tr.some((t) => near(d, t)) && !alsoValid.some((t) => near(d, t))).length;
  return { recall: hit / tr.length, falsePos, n: tr.length };
}

describe('FeatureExtractor on a synthetic track with known structure', () => {
  const full = run(120, 1);

  it('detects kicks on the beat with high recall and few false positives', () => {
    const m = matchKicks(full.track.kicks, full.kickTimes, 2, 16, full.track.bassHits);
    expect(m.recall).toBeGreaterThanOrEqual(0.9);
    expect(m.falsePos).toBeLessThanOrEqual(Math.ceil(m.n * 0.1));
    const d = matchKicks(full.track.kicks, full.kickTimes, 28.5, 39);
    expect(d.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('reports no kicks during the kick-free breakdown', () => {
    expect(full.kickTimes.filter((t) => t > 16.3 && t < 27.9).length).toBeLessThanOrEqual(1);
  });

  it('estimates tempo at 120 BPM', () => {
    const late = between(full.frames, 12, 16);
    expect(Math.abs(mean(late.map((x) => x.f.bpm)) - 120)).toBeLessThan(2);
  });

  it('locks beat phase to the kicks', () => {
    const errs: number[] = [];
    for (const k of full.track.kicks.filter((t) => t > 10 && t < 16)) {
      const fr = full.frames.find((x) => x.t >= k + 0.03);
      if (!fr) continue;
      const p = fr.f.beatPhase;
      errs.push(Math.min(p, 1 - p)); // circular distance to the beat
    }
    expect(mean(errs)).toBeLessThan(0.15);
  });

  it('separates bass-heavy groove from the breakdown', () => {
    const groove = mean(between(full.frames, 6, 16).map((x) => x.f.bass));
    const brk = mean(between(full.frames, 19, 24).map((x) => x.f.bass));
    expect(groove).toBeGreaterThan(0.35);
    expect(brk).toBeLessThan(groove * 0.5);
  });

  it('flags the breakdown and the riser as structure', () => {
    const brk = between(full.frames, 19, 27.5);
    const flagged = brk.filter((x) => x.f.breakdown > 0.5).length / brk.length;
    expect(flagged).toBeGreaterThan(0.8);
    const groove = between(full.frames, 4, 15.5);
    expect(groove.filter((x) => x.f.breakdown > 0.5).length).toBe(0);
    const riser = between(full.frames, 25.5, 27.9);
    expect(Math.max(...riser.map((x) => x.f.build))).toBeGreaterThan(0.35);
  });

  it('fires a drop on the first kick after the breakdown', () => {
    const near = full.dropTimes.filter((t) => t >= 28 && t < 28.4);
    expect(near.length).toBe(1);
    expect(full.dropTimes.filter((t) => t < 27.9).length).toBe(0);
  });

  it('responds to hi-hats in the high band', () => {
    const hatFrames = between(full.frames, 6, 16);
    const hats = hatFrames.at(-1)!.f.hatCount - hatFrames[0].f.hatCount;
    const truth = full.track.hats.filter((t) => t >= 6 && t < 16).length;
    expect(hats).toBeGreaterThanOrEqual(truth * 0.85);
    expect(hats).toBeLessThanOrEqual(truth * 1.3);
  });

  it('behaves consistently when the same song is 20 dB quieter (adaptive normalisation)', () => {
    const quiet = run(120, 0.1);
    const g1 = mean(between(full.frames, 8, 16).map((x) => x.f.bass));
    const g2 = mean(between(quiet.frames, 8, 16).map((x) => x.f.bass));
    expect(Math.abs(g1 - g2)).toBeLessThan(0.12);
    const l1 = mean(between(full.frames, 8, 16).map((x) => x.f.loudness));
    const l2 = mean(between(quiet.frames, 8, 16).map((x) => x.f.loudness));
    expect(Math.abs(l1 - l2)).toBeLessThan(0.15);
    const m = matchKicks(quiet.track.kicks, quiet.kickTimes, 2, 16);
    expect(m.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('tracks a different tempo (100 BPM)', () => {
    const slow = run(100, 1);
    const late = between(slow.frames, 12, 16);
    expect(Math.abs(mean(late.map((x) => x.f.bpm)) - 100)).toBeLessThan(2);
  });
});
