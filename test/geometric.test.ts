import { describe, expect, it } from 'vitest';
import { GeoSim, COLUMNS } from '../src/worlds/geometric/geoState';
import { createDrives } from '../src/mapping/drives';
import { F } from '../src/audio/soundFamilies';

/** Each sound family drives its own part of the architecture, and only that part. */
describe('Geometric Intelligence state', () => {
  const run = (setup: (d: ReturnType<typeof createDrives>, i: number) => void, frames = 240) => {
    const sim = new GeoSim(642);
    const d = createDrives();
    d.idle = 0;
    for (let i = 0; i < frames; i++) {
      setup(d, i);
      sim.step(1 / 60, d);
    }
    return sim.stats();
  };
  const silent = run(() => {});

  it('kicks fire shells; nothing else reacts', () => {
    const s = run((d, i) => { if (i % 30 === 0) { d.fam.events[F.kick]++; d.fam.hit[F.kick] = 1; } d.fam.level[F.kick] = 0.8; });
    expect(s.shellsAlive).toBeGreaterThan(0);
    expect(s.shardsAlive).toBe(0);
    expect(s.sparkleSum).toBe(0);
  });

  it('hits throw shards and hats light the lattice', () => {
    const s = run((d, i) => { if (i % 30 === 0) d.fam.events[F.hits]++; if (i % 8 === 0) d.fam.events[F.hats]++; });
    expect(s.shardsAlive).toBeGreaterThan(5);
    expect(s.sparkleSum).toBeGreaterThan(3);
    expect(s.shellsAlive).toBe(0);
  });

  it('sustained pads construct the shells, silence dissolves them', () => {
    const built = run((d) => { d.fam.level[F.pads] = 0.9; }, 600);
    expect(built.build0).toBeGreaterThan(0.9);
    expect(built.build2).toBeGreaterThan(0.5);
    expect(silent.build0).toBeLessThan(0.05);
  });

  it('bass raises the skyline; the lead ribbon follows the melody register', () => {
    const s = run((d) => { d.fam.level[F.bass] = 0.8; d.fam.level[F.lead] = 0.8; d.fam.melody = 0.5; }, 600);
    expect(s.bassMean).toBeGreaterThan(0.3);
    expect(silent.bassMean).toBeLessThan(0.01);
    const low = run((d) => { d.fam.level[F.lead] = 0.8; d.fam.melody = 0.15; }, 300);
    expect(s.leadY).toBeGreaterThan(low.leadY + 4);
    expect(COLUMNS).toBe(64);
  });
});
