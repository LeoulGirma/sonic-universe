/**
 * Particle Life rules (Mohr / Ventrella "Clusters" model), pure TypeScript.
 *
 * Every particle belongs to one of S species. Species i feels species j through a radial force
 * that is (1) universal short-range repulsion below β·rMax, then (2) a triangular bump whose
 * height is the matrix entry K[i][j] ∈ [-1, 1] (positive attracts, negative repels), falling
 * to zero at rMax. The matrix is asymmetric, so i can chase j while j flees i — that asymmetry
 * is what makes cells, chains, swimmers and predator–prey patterns emerge.
 *
 * Shared by the GPU pipeline (as uniforms), the unit tests and the GPU self-test, so the CPU
 * reference and the shader implement exactly the same law.
 */
export const S = 6;

/** Normalised force for distance rn = r / rMax. */
export function kernel(rn: number, a: number, beta: number, repel = 1) {
  if (rn >= 1 || rn <= 0) return 0;
  if (rn < beta) return (rn / beta - 1) * repel;
  return a * (1 - Math.abs(2 * rn - 1 - beta) / (1 - beta));
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A species matrix from a seed. Self-attraction is biased positive (so each species can form
 * bodies), cross terms span the full range, and one random "chase" pair is made strongly
 * asymmetric so every ecosystem has at least one moving structure.
 */
export function makeMatrix(seed: number): Float32Array {
  const r = mulberry32(seed);
  const K = new Float32Array(S * S);
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < S; j++) {
      K[i * S + j] = i === j ? 0.25 + 0.7 * r() : r() * 2 - 1;
    }
  }
  const a = Math.floor(r() * S);
  const b = (a + 1 + Math.floor(r() * (S - 1))) % S;
  K[a * S + b] = 0.8 + 0.2 * r(); // a chases b
  K[b * S + a] = -0.8 - 0.2 * r(); // b flees a
  return K;
}

/** Element-wise blend (in place into `out`). */
export function mixMatrix(out: Float32Array, a: Float32Array, b: Float32Array, t: number) {
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/**
 * A song's fingerprint → ecosystem seed. Measured over the first seconds of real playback:
 * tempo (in 4-BPM steps), spectral centroid and the bass/treble balance (in coarse bins), so
 * the same song always grows the same organisms and different songs grow different ones.
 */
export function fingerprintSeed(bpm: number, centroidHz: number, bassToHigh: number) {
  const tb = bpm > 0 ? Math.round(bpm / 4) : 0;
  const cb = Math.round(Math.log2(Math.max(100, centroidHz) / 100) * 3); // third-octave bins
  const bb = Math.round(Math.max(-12, Math.min(12, bassToHigh)) / 3); // 3 dB bins
  let h = 2166136261;
  for (const v of [tb, cb, bb]) {
    h ^= v + 1000;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A short readable name for an ecosystem seed, shown in the performance panel. */
export function ecosystemName(seed: number) {
  return (seed >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4);
}

// ---------------------------------------------------------------------------------------
// Brute-force CPU reference (tests and the GPU self-test)
// ---------------------------------------------------------------------------------------
export interface LifeParamsLike {
  rMax: number;
  beta: number;
  repel: number;
  force: number;
  contain: number;
}

/** Acceleration on particle i from every other particle (O(N) per particle). */
export function referenceAcc(
  pos: Float32Array, // xyz + species in w, stride 4
  i: number,
  K: Float32Array,
  p: LifeParamsLike,
  out: [number, number, number],
) {
  const n = pos.length / 4;
  const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
  const si = Math.round(pos[i * 4 + 3]);
  let fx = 0, fy = 0, fz = 0;
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const dx = pos[j * 4] - x, dy = pos[j * 4 + 1] - y, dz = pos[j * 4 + 2] - z;
    const r = Math.hypot(dx, dy, dz);
    if (r <= 1e-4 || r >= p.rMax) continue;
    const f = kernel(r / p.rMax, K[si * S + Math.round(pos[j * 4 + 3])], p.beta, p.repel);
    fx += (dx / r) * f; fy += (dy / r) * f; fz += (dz / r) * f;
  }
  let ax = fx * p.force, ay = fy * p.force, az = fz * p.force;
  const rp = Math.hypot(x, y, z);
  if (rp > p.contain) {
    const k = ((rp - p.contain) * 10) / rp;
    ax -= x * k; ay -= y * k; az -= z * k;
  }
  out[0] = ax; out[1] = ay; out[2] = az;
  return out;
}

/** Small brute-force simulation used by the tests to check that the law forms structure. */
export function referenceStep(pos: Float32Array, vel: Float32Array, K: Float32Array, p: LifeParamsLike, dt: number, frictionHalfLife: number) {
  const n = pos.length / 4;
  const acc: [number, number, number] = [0, 0, 0];
  const damp = Math.pow(0.5, dt / frictionHalfLife);
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    referenceAcc(pos, i, K, p, acc);
    a[i * 3] = acc[0]; a[i * 3 + 1] = acc[1]; a[i * 3 + 2] = acc[2];
  }
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      vel[i * 3 + c] = vel[i * 3 + c] * damp + a[i * 3 + c] * dt;
      pos[i * 4 + c] += vel[i * 3 + c] * dt;
    }
  }
}

/** Structure metrics from positions: mean nearest-neighbour distance, same-species share of neighbours within r, rms radius. */
export function structureMetrics(pos: Float32Array, r: number, sample = 1500) {
  const n = pos.length / 4;
  const step = Math.max(1, Math.floor(n / sample));
  // uniform grid hash for neighbour queries
  const cell = r;
  const map = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let j = 0; j < n; j++) {
    const k = keyOf(pos[j * 4], pos[j * 4 + 1], pos[j * 4 + 2]);
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(j);
  }
  let nnSum = 0, nnN = 0, same = 0, total = 0, rr = 0, crowd = 0;
  for (let i = 0; i < n; i += step) {
    const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
    const s = Math.round(pos[i * 4 + 3]);
    rr += x * x + y * y + z * z;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let nn = Infinity, cnt = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const a = map.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!a) continue;
      for (const j of a) {
        if (j === i) continue;
        const d = Math.hypot(pos[j * 4] - x, pos[j * 4 + 1] - y, pos[j * 4 + 2] - z);
        if (d < nn) nn = d;
        if (d < r) {
          cnt++;
          total++;
          if (Math.round(pos[j * 4 + 3]) === s) same++;
        }
      }
    }
    if (isFinite(nn)) { nnSum += nn; nnN++; }
    crowd += cnt;
  }
  const m = Math.ceil(n / step);
  return {
    meanNN: nnN ? nnSum / nnN : Infinity,
    sameSpecies: total ? same / total : 0, // 1/S ≈ 0.17 = fully mixed
    neighbours: crowd / m, // mean neighbours within r: higher = denser bodies
    rmsRadius: Math.sqrt(rr / m),
  };
}
