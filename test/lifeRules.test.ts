import { describe, expect, it } from 'vitest';
import {
  S, kernel, makeMatrix, fingerprintSeed, mulberry32, referenceStep, structureMetrics, LifeParamsLike,
} from '../src/worlds/life/lifeRules';

describe('force kernel', () => {
  const beta = 0.3;
  it('repels at contact regardless of the matrix entry', () => {
    expect(kernel(0.01, 1, beta)).toBeLessThan(-0.9);
    expect(kernel(0.15, -1, beta)).toBeCloseTo(-0.5, 5);
  });
  it('is continuous at β, peaks at (1+β)/2 with height a, and vanishes at rMax', () => {
    expect(kernel(beta - 1e-9, 0.7, beta)).toBeCloseTo(0, 6);
    expect(kernel(beta + 1e-9, 0.7, beta)).toBeCloseTo(0, 6);
    expect(kernel((1 + beta) / 2, 0.7, beta)).toBeCloseTo(0.7, 6);
    expect(kernel(1 - 1e-9, 0.7, beta)).toBeCloseTo(0, 6);
    expect(kernel(1.2, 0.7, beta)).toBe(0);
  });
});

describe('ecosystems', () => {
  it('a seed always gives the same matrix and different seeds differ', () => {
    expect(Array.from(makeMatrix(42))).toEqual(Array.from(makeMatrix(42)));
    const a = makeMatrix(1), b = makeMatrix(2);
    let diff = 0;
    for (let i = 0; i < S * S; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff / (S * S)).toBeGreaterThan(0.3);
  });
  it('every matrix has self-attraction and one chase pair', () => {
    for (let seed = 0; seed < 50; seed++) {
      const K = makeMatrix(seed);
      for (let i = 0; i < S; i++) expect(K[i * S + i]).toBeGreaterThan(0.2);
      let chase = 0;
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) if (K[i * S + j] >= 0.8 && K[j * S + i] <= -0.8) chase++;
      expect(chase).toBeGreaterThanOrEqual(1);
    }
  });
  it('fingerprints separate different songs and are stable for the same one', () => {
    expect(fingerprintSeed(120, 1200, 6)).toBe(fingerprintSeed(121, 1250, 6.5)); // measurement noise
    expect(fingerprintSeed(120, 1200, 6)).not.toBe(fingerprintSeed(96, 1200, 6)); // tempo
    expect(fingerprintSeed(120, 1200, 6)).not.toBe(fingerprintSeed(120, 3200, 6)); // timbre
    expect(fingerprintSeed(120, 1200, 6)).not.toBe(fingerprintSeed(120, 1200, -6)); // balance
  });
});

/** 300 particles, brute force: the law itself must create structure from uniform noise. */
function run(K: Float32Array, steps = 400) {
  const n = 300;
  const r = mulberry32(9);
  const pos = new Float32Array(n * 4);
  const vel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // uniform in a sphere of radius 14
    let x, y, z;
    do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; } while (x * x + y * y + z * z > 1);
    pos[i * 4] = x * 14; pos[i * 4 + 1] = y * 14; pos[i * 4 + 2] = z * 14; pos[i * 4 + 3] = i % S;
  }
  const p: LifeParamsLike = { rMax: 6, beta: 0.3, repel: 1, force: 12, contain: 14 };
  const before = structureMetrics(pos, 3);
  for (let s = 0; s < steps; s++) referenceStep(pos, vel, K, p, 1 / 60, 0.08);
  return { before, after: structureMetrics(pos, 3) };
}

describe('the law forms structure (CPU reference)', () => {
  it('self-attraction only: species gather into their own bodies', () => {
    const K = new Float32Array(S * S);
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) K[i * S + j] = i === j ? 1 : -0.3;
    const { before, after } = run(K);
    expect(after.sameSpecies).toBeGreaterThan(before.sameSpecies * 2.5);
    expect(after.neighbours).toBeGreaterThan(before.neighbours * 1.5);
  });
  it('universal repulsion: no bodies form', () => {
    const K = new Float32Array(S * S).fill(-0.6);
    const { before, after } = run(K);
    expect(after.sameSpecies).toBeLessThan(0.3);
    expect(after.neighbours).toBeLessThanOrEqual(before.neighbours * 1.1);
  });
  it('a random ecosystem departs from uniform noise', () => {
    const { before, after } = run(makeMatrix(7));
    const change = Math.abs(after.sameSpecies - before.sameSpecies) + Math.abs(after.neighbours - before.neighbours) / Math.max(1, before.neighbours);
    expect(change).toBeGreaterThan(0.3);
  });
});
