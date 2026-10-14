import { describe, expect, it } from 'vitest';
import { songMood } from '../src/audio/songMood';
import type { RawProfile } from '../src/audio/songProfile';

const base: RawProfile = {
  loud: -9, dyn: 9, centroid: 600, bpm: 110, pulse: 0.6, kickRate: 1, onsetRate: 10, noteRate: 5,
  share: [0.04, 0.1, 0.02, 0.45, 0.25, 0.14], melody: 0.75, tonal: 0.6, chordRate: 0.6, mode: 0, keyClarity: 0.8,
  third: 0, chroma: new Array(12).fill(1 / 12), bassChroma: new Array(12).fill(1 / 12), flat: 0.04, hiShare: 0.02,
  drops: 0.3, breakdown: 0.1, sections: 4,
};

describe('song mood', () => {
  it('places values in 0..1 and names a lead trait', () => {
    const m = songMood(base);
    for (const v of [m.energy, m.bright, ...Object.values(m.traits)]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(m.traits[m.lead]).toBe(Math.max(...Object.values(m.traits)));
  });
  it('louder and busier is more energetic; major is brighter', () => {
    const calm = songMood({ ...base, loud: -16, onsetRate: 4, kickRate: 0.2, dyn: 16 });
    const hot = songMood({ ...base, loud: -6, onsetRate: 16, kickRate: 2.2, dyn: 5 });
    expect(hot.energy).toBeGreaterThan(calm.energy + 0.4);
    const minor = songMood({ ...base, mode: -0.25 }), major = songMood({ ...base, mode: 0.25 });
    expect(major.bright).toBeGreaterThan(minor.bright + 0.3);
  });
  it('a bass-heavy mix is bass-led', () => {
    expect(songMood({ ...base, share: [0.1, 0.05, 0.01, 0.7, 0.08, 0.06] }).lead).toBe('bass');
  });
});
