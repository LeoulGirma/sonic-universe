import { describe, expect, it } from 'vitest';
import { BeatTracker } from '../src/audio/BeatTracker';

/**
 * Calibration on a real syncopated R&B production found the beat grid locked half a beat off:
 * the grid is seeded from whichever onset comes last when tempo is first found, and the
 * phase-locked loop only corrects errors under 20 % of a beat, so an off-beat seed never heals.
 * Here an intro of off-beat kicks seeds the grid wrongly, then the real pattern starts.
 */
function run(align: boolean) {
  const bt = new BeatTracker();
  if (!align) (bt as unknown as { alignPhase: () => void }).alignPhase = () => {};
  const beat = 0.5; // 120 BPM, true beats at multiples of 0.5 s
  const events: { t: number; s: number }[] = [];
  for (let t = 0.25; t < 6; t += beat) events.push({ t, s: 1 }); // off-beat intro (seeds the wrong phase)
  for (let bar = 0; bar < 12; bar++) {
    const b = 6 + bar * 2;
    events.push({ t: b, s: 1 }, { t: b + 0.375, s: 0.5 }, { t: b + 1, s: 0.9 }, { t: b + 1.25, s: 0.6 }); // 1, a-of-1, 3, and-of-3
  }
  events.sort((a, b) => a.t - b.t);
  const errs: number[] = [];
  let k = 0;
  for (let t = 0; t < 30; t += 1 / 60) {
    while (k < events.length && events[k].t <= t) bt.addOnset(events[k].t, true, events[k].s), k++;
    bt.update(t);
    if (t > 20 && bt.beat) {
      const p = (t / beat) % 1;
      errs.push(Math.min(p, 1 - p));
    }
  }
  return { bpm: bt.bpm, phaseErr: errs.reduce((a, b) => a + b, 0) / errs.length };
}

describe('beat phase recovery on syncopated drums', () => {
  it('re-aligns a grid that was seeded on the off-beat', () => {
    const r = run(true);
    expect(Math.abs(r.bpm - 120)).toBeLessThan(2);
    expect(r.phaseErr).toBeLessThan(0.12);
  });
  it('(control) without phase alignment the off-beat seed persists', () => {
    expect(run(false).phaseErr).toBeGreaterThan(0.3);
  });
});
