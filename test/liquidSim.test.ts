import { describe, expect, it } from 'vitest';
import { Band, DEFAULT_LIQUID, LiquidSim } from '../src/worlds/liquid/liquidSim';
import { createDrives, Drives } from '../src/mapping/drives';

const P = DEFAULT_LIQUID;
const quiet = (): Drives => ({ ...createDrives(), idle: 0 });
const run = (sim: LiquidSim, seconds: number, d: Drives, each?: (t: number) => void) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    sim.update(1 / 60, d, P);
    each?.(t);
  }
};

describe('liquid blob physics', () => {
  it('without music the liquid settles and fuses into a few bodies, inside the container', () => {
    const sim = new LiquidSim(16);
    const start = sim.bodies();
    run(sim, 25, quiet());
    expect(sim.bodies()).toBeLessThanOrEqual(3);
    expect(sim.bodies()).toBeLessThan(start);
    expect(sim.kinetic()).toBeLessThan(5);
    expect(sim.extent).toBeLessThan(30);
  });

  it('surface tension conserves momentum (forces are equal and opposite)', () => {
    const sim = new LiquidSim(16);
    const d = quiet();
    const p0 = sim.momentum();
    // one step with drag and centring off isolates the pair forces
    sim.update(1 / 60, d, { ...P, drag: 0, center: 0, swirl: 0 });
    const p1 = sim.momentum();
    for (let c = 0; c < 3; c++) expect(Math.abs(p1[c] - p0[c])).toBeLessThan(1e-6 * (1 + Math.abs(p0[c])));
  });

  it('a drop blasts the liquid apart, then it re-fuses', () => {
    const sim = new LiquidSim(16);
    const d = quiet();
    run(sim, 20, d);
    const settled = sim.bodies();
    d.dropEvents++;
    d.release = 1;
    let peak = 0;
    run(sim, 1.2, d, () => { d.release *= Math.exp(-(1 / 60) / 1.6); peak = Math.max(peak, sim.bodies()); });
    expect(peak).toBeGreaterThan(settled + 3);
    run(sim, 12, d, () => { d.release *= Math.exp(-(1 / 60) / 1.6); });
    expect(sim.bodies()).toBeLessThanOrEqual(settled + 2);
  });

  it('kicks push outward and send a surface wave', () => {
    const sim = new LiquidSim(16);
    const d = quiet();
    run(sim, 15, d);
    const before = sim.spread();
    d.kickEvents++;
    d.lastKick = 1;
    run(sim, 0.25, d);
    expect(sim.spread()).toBeGreaterThan(before * 1.05);
    expect(sim.waves.length).toBe(1);
  });

  it('bass swells only the bass masses', () => {
    const sim = new LiquidSim(16);
    const d = quiet();
    d.gravity = 1;
    sim.update(1 / 60, d, P);
    for (let i = 0; i < sim.n; i++) {
      const ratio = sim.r[i] / sim.r0[i];
      if (sim.band[i] === Band.Bass) expect(ratio).toBeGreaterThan(1.25);
      else expect(ratio).toBeCloseTo(1, 6);
    }
  });

  it('breakdowns calm the liquid: the same kick moves it less', () => {
    const energyAfterKick = (calm: number) => {
      const sim = new LiquidSim(16);
      const d = quiet();
      run(sim, 15, d);
      d.calm = calm;
      d.kickEvents++;
      d.lastKick = 1;
      run(sim, 1, d);
      return sim.kinetic();
    };
    expect(energyAfterKick(1)).toBeLessThan(energyAfterKick(0) * 0.4);
  });

  it('build-ups squeeze the liquid together', () => {
    const sim = new LiquidSim(16);
    const d = quiet();
    run(sim, 15, d);
    d.flow = 1; // some motion so there is something to squeeze
    run(sim, 3, d);
    const before = sim.spread();
    d.tension = 1;
    run(sim, 4, d);
    expect(sim.spread()).toBeLessThan(before);
  });
});
