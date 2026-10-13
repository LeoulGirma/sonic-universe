import type { Drives } from '../../mapping/drives';
import { mulberry32 } from '../life/lifeRules';

/**
 * Liquid Dimension — blob physics (layer 3), pure TypeScript.
 *
 * The liquid is a few dozen metaballs rendered as one smooth surface. What moves them is a
 * small physical model, not keyframes:
 *  - surface tension between every pair: a spring toward a "partly merged" separation
 *    (0.75·(rᵢ+rⱼ)), applied with reduced mass so momentum is conserved; strong when close,
 *    weak at range so scattered drops drift back together
 *  - linear drag, a soft spherical container, and a weak pull to the centre
 * Each blob belongs to a frequency band, which gives the liquid regions: big slow bass masses,
 * mid-size bodies, and small high-frequency droplets.
 */
export const Band = { Bass: 0, Mid: 1, High: 2 } as const;

export interface LiquidParams {
  tension: number; // surface-tension spring stiffness (1/s²)
  drag: number; // 1/s
  center: number; // pull toward the centre (1/s²)
  swirl: number; // mids → tangential flow (units/s²)
  impact: number; // kick impulse (units/s)
  ripple: number; // surface ripple amplitude multiplier (render)
  iridescence: number; // thin-film strength (render)
  cursorStrength: number;
  timeScale: number;
  bloom: number;
}

export const DEFAULT_LIQUID: LiquidParams = {
  tension: 2.2, drag: 0.9, center: 0.12, swirl: 6, impact: 7, ripple: 1, iridescence: 1,
  cursorStrength: 900, timeScale: 1, bloom: 0.55,
};

export const CONTAIN = 24;

export interface Wave { x: number; y: number; z: number; age: number; amp: number }

export class LiquidSim {
  readonly n: number;
  readonly p: Float64Array;
  readonly v: Float64Array;
  readonly r0: Float64Array; // rest radius
  readonly r: Float64Array; // current radius (breathes with its band)
  readonly band: Uint8Array;
  readonly mass: Float64Array;
  readonly waves: Wave[] = [];
  private lastKick = 0;
  private lastDrop = 0;
  private rnd: () => number;
  private time = 0;
  /** read by the renderer */
  centroid = [0, 0, 0];
  extent = 10;

  constructor(n: number, seed = 7) {
    this.n = n;
    this.p = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    this.r0 = new Float64Array(n);
    this.r = new Float64Array(n);
    this.band = new Uint8Array(n);
    this.mass = new Float64Array(n);
    this.rnd = mulberry32(seed);
    const r = this.rnd;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const b = f < 0.3 ? Band.Bass : f < 0.7 ? Band.Mid : Band.High;
      this.band[i] = b;
      this.r0[i] = b === Band.Bass ? 4.6 + 1.8 * r() : b === Band.Mid ? 2.6 + 1.4 * r() : 0.8 + 0.9 * r();
      this.r[i] = this.r0[i];
      this.mass[i] = this.r0[i] ** 3;
      const a = r() * Math.PI * 2, u = r() * 2 - 1, q = Math.sqrt(1 - u * u), rad = 4 + 10 * Math.cbrt(r());
      this.p[i * 3] = Math.cos(a) * q * rad;
      this.p[i * 3 + 1] = u * rad * 0.7;
      this.p[i * 3 + 2] = Math.sin(a) * q * rad;
    }
  }

  /**
   * Music → physics:
   *  bass swells the bass masses; mids add a swirl; highs agitate the droplets;
   *  kicks fire an impulse outward from the mass centre plus a surface wave;
   *  drops cut surface tension and blast the liquid apart, then it re-fuses;
   *  breakdowns thicken the drag (a slow mirror drift); build-ups squeeze it together.
   */
  update(dt: number, d: Drives, params: LiquidParams, cursor?: { active: boolean; x: number; y: number; z: number; sign: number; boost: number }) {
    const sdt = dt * params.timeScale * (1 - 0.5 * d.calm);
    this.time += sdt;
    // radii breathe with their band
    for (let i = 0; i < this.n; i++) {
      const b = this.band[i];
      const swell = b === Band.Bass ? 0.28 * d.gravity + 0.12 * d.pulse : b === Band.Mid ? 0.14 * d.flow : 0.1 * d.shimmer;
      this.r[i] = this.r0[i] * (1 + swell);
    }
    this.centroidUpdate();

    if (d.kickEvents !== this.lastKick) {
      this.lastKick = d.kickEvents;
      const s = Math.min(1.2, 0.3 + d.lastKick) * (1 - 0.6 * d.calm);
      this.impulse(params.impact * s, 0.25);
      this.addWave(1.2 * s);
    }
    if (d.dropEvents !== this.lastDrop) {
      this.lastDrop = d.dropEvents;
      this.impulse(params.impact * 3.2, 1);
      this.addWave(2.5);
    }
    for (const w of this.waves) w.age += sdt;
    while (this.waves.length && this.waves[0].age > 4) this.waves.shift();

    const steps = sdt > 1 / 45 ? 2 : 1;
    const h = Math.min(sdt, 1 / 20) / steps;
    for (let s = 0; s < steps; s++) this.step(h, d, params, cursor);
  }

  private centroidUpdate() {
    let cx = 0, cy = 0, cz = 0, m = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.mass[i];
      cx += this.p[i * 3] * w; cy += this.p[i * 3 + 1] * w; cz += this.p[i * 3 + 2] * w; m += w;
    }
    cx /= m; cy /= m; cz /= m;
    let ext = 0;
    for (let i = 0; i < this.n; i++) {
      ext = Math.max(ext, Math.hypot(this.p[i * 3] - cx, this.p[i * 3 + 1] - cy, this.p[i * 3 + 2] - cz) + this.r[i]);
    }
    this.centroid = [cx, cy, cz];
    this.extent = ext;
  }

  /** Radial impulse from the mass centre; light droplets fly further (∝ 1/∛mass). */
  private impulse(strength: number, randomness: number) {
    const [cx, cy, cz] = this.centroid;
    const r = this.rnd;
    for (let i = 0; i < this.n; i++) {
      let dx = this.p[i * 3] - cx, dy = this.p[i * 3 + 1] - cy, dz = this.p[i * 3 + 2] - cz;
      dx += (r() - 0.5) * 6 * randomness; dy += (r() - 0.5) * 6 * randomness; dz += (r() - 0.5) * 6 * randomness;
      const l = Math.hypot(dx, dy, dz) || 1;
      const k = strength / Math.cbrt(this.mass[i] / 60);
      this.v[i * 3] += (dx / l) * k; this.v[i * 3 + 1] += (dy / l) * k; this.v[i * 3 + 2] += (dz / l) * k;
    }
  }

  private addWave(amp: number) {
    if (this.waves.length >= 4) this.waves.shift();
    const [x, y, z] = this.centroid;
    this.waves.push({ x, y, z, age: 0, amp });
  }

  private step(h: number, d: Drives, params: LiquidParams, cursor?: { active: boolean; x: number; y: number; z: number; sign: number; boost: number }) {
    const n = this.n, p = this.p, v = this.v;
    const a = new Float64Array(n * 3);
    // build-ups strengthen tension (squeeze); drops cut it so the blast can separate the liquid
    const tension = params.tension * (1 + 1.2 * d.tension + 0.3 * d.calm) * (1 - 0.85 * Math.min(1, d.release));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[j * 3] - p[i * 3], dy = p[j * 3 + 1] - p[i * 3 + 1], dz = p[j * 3 + 2] - p[i * 3 + 2];
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const rs = this.r[i] + this.r[j];
        // spring toward 0.75·rs; full strength within 1.6·rs, 15 % at long range
        const near = dist < rs * 1.6 ? 1 : Math.max(0.15, 1 - (dist - rs * 1.6) / (rs * 2));
        const f = tension * (dist - 0.75 * rs) * near / dist;
        const mi = this.mass[i], mj = this.mass[j], mt = mi + mj;
        const ai = f * (mj / mt), aj = f * (mi / mt); // reduced-mass split: equal and opposite forces
        a[i * 3] += dx * ai; a[i * 3 + 1] += dy * ai; a[i * 3 + 2] += dz * ai;
        a[j * 3] -= dx * aj; a[j * 3 + 1] -= dy * aj; a[j * 3 + 2] -= dz * aj;
      }
    }
    const [cx, , cz] = this.centroid;
    const r = this.rnd;
    const center = params.center * (1 + 3 * d.tension);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      a[i * 3] -= x * center; a[i * 3 + 1] -= y * center; a[i * 3 + 2] -= z * center;
      const rr = Math.hypot(x, y, z);
      if (rr > CONTAIN) {
        const k = (6 * (rr - CONTAIN)) / rr;
        a[i * 3] -= x * k; a[i * 3 + 1] -= y * k; a[i * 3 + 2] -= z * k;
      }
      // mids: swirl around the vertical axis through the mass centre (always a little when idle)
      const sx = x - cx, sz = z - cz, sl = Math.hypot(sx, sz) || 1;
      const sw = params.swirl * (d.flow * (1 - d.calm) + 0.15 * d.idle);
      a[i * 3] += (-sz / sl) * sw; a[i * 3 + 2] += (sx / sl) * sw;
      // highs: droplets jitter
      if (this.band[i] === Band.High) {
        const j = 40 * (d.shimmer + d.sparkle);
        a[i * 3] += (r() - 0.5) * j; a[i * 3 + 1] += (r() - 0.5) * j; a[i * 3 + 2] += (r() - 0.5) * j;
      }
      if (cursor?.active) {
        const ex = cursor.x - x, ey = cursor.y - y, ez = cursor.z - z;
        const e2 = ex * ex + ey * ey + ez * ez + 16;
        const k = (cursor.sign * params.cursorStrength * cursor.boost) / (e2 * Math.sqrt(e2));
        a[i * 3] += ex * k; a[i * 3 + 1] += ey * k; a[i * 3 + 2] += ez * k;
      }
    }
    const drag = Math.exp(-params.drag * (1 + 2.5 * d.calm) * h);
    for (let k = 0; k < n * 3; k++) {
      v[k] = (v[k] + a[k] * h) * drag;
      p[k] += v[k] * h;
    }
    this.centroidUpdate();
  }

  // ---------------------------------------------------------------- metrics (tests, debug)
  /** Connected bodies: blobs whose surfaces overlap (dist < 0.95·(rᵢ+rⱼ)) belong to one body. */
  bodies() {
    const parent = Array.from({ length: this.n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < this.n; i++) for (let j = i + 1; j < this.n; j++) {
      const dd = Math.hypot(this.p[j * 3] - this.p[i * 3], this.p[j * 3 + 1] - this.p[i * 3 + 1], this.p[j * 3 + 2] - this.p[i * 3 + 2]);
      if (dd < 0.95 * (this.r[i] + this.r[j])) parent[find(i)] = find(j);
    }
    const roots = new Set<number>();
    for (let i = 0; i < this.n; i++) roots.add(find(i));
    return roots.size;
  }

  kinetic() {
    let e = 0;
    for (let i = 0; i < this.n; i++) e += 0.5 * this.mass[i] * (this.v[i * 3] ** 2 + this.v[i * 3 + 1] ** 2 + this.v[i * 3 + 2] ** 2);
    return e;
  }

  momentum() {
    const m = [0, 0, 0];
    for (let i = 0; i < this.n; i++) for (let c = 0; c < 3; c++) m[c] += this.mass[i] * this.v[i * 3 + c];
    return m;
  }

  spread() {
    const [cx, cy, cz] = this.centroid;
    let s = 0, m = 0;
    for (let i = 0; i < this.n; i++) {
      s += this.mass[i] * ((this.p[i * 3] - cx) ** 2 + (this.p[i * 3 + 1] - cy) ** 2 + (this.p[i * 3 + 2] - cz) ** 2);
      m += this.mass[i];
    }
    return Math.sqrt(s / m);
  }

  stats() {
    return { bodies: this.bodies(), kinetic: this.kinetic(), spread: this.spread(), extent: this.extent };
  }
}
