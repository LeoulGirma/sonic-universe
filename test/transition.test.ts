import { describe, expect, it } from 'vitest';
import { planTransition, MAX_STRETCH, type MixSong } from '../src/audio/mix/transition';

function song(bpm: number, dur: number, secs: [number, number][] = [], conf = 0.8): MixSong {
  const p = 60 / bpm;
  const beats = Float64Array.from({ length: Math.floor((dur - 0.5) / p) }, (_, i) => 0.5 + i * p);
  const sections = secs.map(([sb, energy], i) => ({
    start: beats[sb], end: i + 1 < secs.length ? beats[secs[i + 1][0]] : dur, startBeat: sb, label: i, biome: 0 as const, energy,
  }));
  return { beats, bpm, duration: dur, sections, beatConfidence: conf };
}

describe('transition planner', () => {
  const a = song(120, 200, [[0, 0.3], [32, 0.8], [96, 0.6], [224, 1], [320, 0.4]]);
  it('beatmatches close tempos: leaves A at its outro, lands B’s main section as A ends', () => {
    const b = song(124, 180, [[0, 0.2], [32, 0.9], [128, 0.5]]);
    const p = planTransition(a, b);
    expect(p.kind).toBe('beatmatch');
    expect(p.outBeat).toBe(320);
    expect(p.rate).toBeCloseTo(120 / 124, 5);
    expect(p.inBeat + 32).toBe(32); // B's main section starts exactly when the overlap ends
    expect(p.len).toBeCloseTo(32 * 0.5, 5);
    expect(p.swap).toBeCloseTo(16 * 0.5, 5);
  });
  it('matches at double / half time', () => {
    const p = planTransition(a, song(62, 200, [[0, 0.3], [16, 0.9]]));
    expect(p.kind).toBe('beatmatch');
    expect(p.ratio).toBe(0.5);
    expect(Math.abs(p.rate - 1)).toBeLessThanOrEqual(MAX_STRETCH);
  });
  it('echoes out when tempos are too far apart', () => {
    const p = planTransition(a, song(97, 200, [[0, 0.5], [64, 0.9]]));
    expect(p.kind).toBe('echo');
    expect(p.rate).toBe(1);
    expect(p.inT).toBeLessThan(0.5);
  });
  it('fades when one side has no beat', () => {
    const p = planTransition(a, { ...song(100, 150), bpm: 0, beats: new Float64Array(0) });
    expect(p.kind).toBe('fade');
    expect(p.outT + p.len).toBeLessThanOrEqual(200);
  });
  it('stays inside A and leaves room for the overlap', () => {
    for (const bpm of [96, 118, 121, 140, 175]) {
      const p = planTransition(a, song(bpm, 150, [[0, 0.4], [16, 0.8]]));
      expect(p.outT).toBeGreaterThan(90);
      expect(p.outT + p.len).toBeLessThan(200);
    }
  });
});

describe('mix now', () => {
  it('starts at the next phrase after the given time', () => {
    const a = song(120, 200, [[0, 0.3], [32, 0.8], [96, 0.6], [224, 1], [320, 0.4]]);
    const p = planTransition(a, song(121, 150, [[0, 0.4], [16, 0.8]]), 30);
    expect(p.outT).toBeGreaterThanOrEqual(30);
    expect(p.outT).toBeLessThan(30 + 16 * 0.5 + 0.01);
    expect((p.outBeat - 0) % 16 === 0 || p.outBeat === 96).toBe(true);
  });
});
