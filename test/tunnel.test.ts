import { describe, expect, it } from 'vitest';
import { synthDemo } from '../src/audio/demoTrack';
import { buildSongMap } from '../src/audio/songMap';
import { FeatureExtractor } from '../src/audio/FeatureExtractor';
import { DriveMapper } from '../src/mapping/drives';
import { DEFAULT_GAINS } from '../src/store/useStore';
import { TunnelClock, createRingParams, STYLES, BEHIND } from '../src/worlds/tunnel/tunnelState';
import { analyse } from './analyserSim';

const SR = 22050;
const demo = synthDemo(SR);
const map = buildSongMap(demo.data, SR);

/** Drive the clock exactly as the app does: extractor → mapper → tunnel, 60 fps. */
function drive(withMap: boolean, each: (t: number, clock: TunnelClock, m: DriveMapper) => void) {
  const fx = new FeatureExtractor();
  const mp = new DriveMapper();
  const clock = new TunnelClock();
  let mapped = false;
  analyse({ sr: SR, data: demo.data, kicks: [], hats: [], bassHits: [] }, (fr, td, t, dt) => {
    if (withMap && !mapped && t > 2) { fx.setMap(map); mapped = true; }
    const f = fx.process(fr, td, SR, t, dt);
    const d = mp.update(f, DEFAULT_GAINS, 1, dt);
    clock.update(dt, d);
    each(t, clock, mp);
  }, 1024, 60);
}

describe('tunnel clock', () => {
  it('with a song map, the camera crosses a ring within one frame of every beat', () => {
    const crossings: number[] = [];
    let last = NaN;
    drive(true, (t, c) => {
      const ring = Math.floor(c.pos);
      if (t > 3 && ring !== last && !Number.isNaN(last)) crossings.push(t);
      last = ring;
    });
    const beats = Array.from(map.beats).filter((b) => b > 3.2 && b < demo.data.length / SR - 0.5);
    const err = beats.map((b) => Math.min(...crossings.map((c) => Math.abs(c - b))));
    expect(Math.max(...err)).toBeLessThanOrEqual(1 / 60 + 1e-6);
    expect(crossings.length).toBeGreaterThanOrEqual(beats.length);
    expect(crossings.length).toBeLessThanOrEqual(beats.length + 1);
  });

  it('live (no map), crossings phase-lock to the beat once the tempo is tracked', () => {
    const crossings: number[] = [];
    let last = NaN;
    drive(false, (t, c) => {
      const ring = Math.floor(c.pos);
      if (t > 14 && t < 31 && ring !== last && !Number.isNaN(last)) crossings.push(t);
      last = ring;
    });
    const beats = Array.from(map.beats);
    const err = crossings.map((c) => Math.min(...beats.map((b) => Math.abs(c - b))));
    const mean = err.reduce((a, b) => a + b, 0) / err.length;
    expect(mean).toBeLessThan(0.05);
  });
});

describe('structure ahead (song map)', () => {
  it('shows the breakdown chamber, the build-up squeeze and the drop gate before the camera gets there', () => {
    const [b0] = map.breakdowns.find(([a, b]) => b - a > 8)!;
    const drop = map.drops.find((d) => d.t > b0)!;
    const rings = createRingParams();
    let sawChamberAhead = false, sawSqueezeAhead = false, sawGateAhead = false, styleChanges = false;
    drive(true, (t, c, m) => {
      if (t < b0 - 12 || t > drop.t) return;
      c.rings(m.d, rings);
      for (let j = BEHIND + 4; j < rings.wide.length; j++) {
        if (t < b0 - 2 && rings.wide[j] > 0.8) sawChamberAhead = true;
        if (t < drop.t - 6 && rings.narrow[j] > 0.5) sawSqueezeAhead = true;
        if (t < drop.t - 4 && rings.gate[j] === 1) {
          sawGateAhead = true;
          if (j + 1 < rings.style.length && rings.style[j + 1] !== rings.style[j - 1]) styleChanges = true;
        }
      }
    });
    expect(sawChamberAhead).toBe(true);
    expect(sawSqueezeAhead).toBe(true);
    expect(sawGateAhead).toBe(true);
    expect(styleChanges).toBe(true);
    expect(STYLES.length).toBeGreaterThan(2);
  });
});
