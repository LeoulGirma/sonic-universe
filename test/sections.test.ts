import { describe, expect, it } from 'vitest';
import { synthDemo } from '../src/audio/demoTrack';
import { buildSongMap } from '../src/audio/songMap';
import { FeatureExtractor } from '../src/audio/FeatureExtractor';
import { F } from '../src/audio/soundFamilies';
import { analyse } from './analyserSim';

const SR = 22050;
const demo = synthDemo(SR);
const map = buildSongMap(demo.data, SR);

describe('sections (song map)', () => {
  it('splits the demo at its breakdown and drop', () => {
    const [b0, b1] = demo.breakdown;
    const starts = map.sections.map((s) => s.start);
    expect(map.sections.length).toBeGreaterThanOrEqual(3);
    expect(starts.some((t) => Math.abs(t - b0) < 2.5)).toBe(true);
    expect(starts.some((t) => Math.abs(t - b1) < 0.6)).toBe(true); // the drop opens a section
  });

  it('gives the breakdown its own calm landscape (a lake) and the drop a different one', () => {
    const [b0, b1] = demo.breakdown;
    const mid = (b0 + b1) / 2;
    const brk = map.sections.find((s) => s.start <= mid && s.end > mid)!;
    const drop = map.sections.find((s) => s.start <= demo.dropAt + 4 && s.end > demo.dropAt + 4)!;
    expect(brk.biome).toBe(2);
    expect(drop.label).not.toBe(brk.label);
    expect(drop.energy).toBeGreaterThan(brk.energy);
  });

  it('covers the song without gaps', () => {
    for (let i = 1; i < map.sections.length; i++) expect(map.sections[i].start).toBeCloseTo(map.sections[i - 1].end, 5);
    expect(map.sections[0].start).toBe(0);
    expect(map.sections[map.sections.length - 1].end).toBeCloseTo(map.duration, 3);
  });
});

describe('sync: kicks from the song map at their exact times', () => {
  it('fires the kick family on the map\'s kick times, within a frame', () => {
    const fx = new FeatureExtractor();
    fx.setMap(map);
    const fired: number[] = [];
    let last = 0;
    analyse({ sr: SR, data: demo.data, kicks: [], hats: [], bassHits: [] }, (freq, td, t, dt) => {
      const f = fx.process(freq, td, SR, t, dt);
      if (f.fam.count[F.kick] > last) fired.push(t);
      last = f.fam.count[F.kick];
    }, 1024);
    const truth = demo.kicks;
    const near = truth.filter((k) => fired.some((t) => t - k >= -0.005 && t - k < 1 / 60 + 0.025)).length;
    expect(near / truth.length).toBeGreaterThan(0.9);
  });
});
