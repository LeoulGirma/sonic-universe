import type { Drives } from '../../mapping/drives';
import { F, NF } from '../../audio/soundFamilies';

/**
 * Geometric Intelligence — simulation state (pure TypeScript, no Three.js, unit-tested).
 *
 * Every sound family builds its own part of one architecture, in its legend colour:
 *   kick  → the CORE: a polyhedron that pulses and sends a wire shell outward on every kick
 *   hits  → SHARDS: tetrahedra thrown from the core on every hit
 *   hats  → the LATTICE: a geodesic sphere of points; every tick lights a few of them
 *   bass  → the FOUNDATION: a ring of columns, a radial record of the bass line (one column per
 *           sixteenth note when the tempo is known), so the skyline is the last four bars of bass
 *   pads  → the SHELLS: three nested polyhedra that are CONSTRUCTED edge by edge while sustained
 *           sound holds, dissolve when it stops, and turn to a new orientation on a chord change
 *   lead  → the RIBBON: a trail drawn around the structure at the melody's height
 * This is art direction, not physics: the mapping is chosen so each family is readable alone.
 */

export const COLUMNS = 64;
export const SHELLS = 8; // kick waves in flight
export const SHARDS = 160;
export const NODES = 24;
export const TRAIL = 400;
export const LATTICE_R = 13;

export const RING_R = 8.5;
export const FLOOR_Y = -5.5;
const LEAD_R = 6.8;

export interface KickShell { age: number; strength: number; alive: boolean }
export interface Shard { x: number; y: number; z: number; vx: number; vy: number; vz: number; ax: number; ay: number; az: number; spin: number; angle: number; age: number; life: number; size: number; alive: boolean }
export interface Node { x: number; y: number; z: number; age: number; alive: boolean }

export class GeoSim {
  t = 0;
  rotY = 0;
  latticeRot = 0;
  // kick
  core = 1;
  coreFlash = 0;
  shells: KickShell[] = Array.from({ length: SHELLS }, () => ({ age: 0, strength: 0, alive: false }));
  // bass
  heights = new Float32Array(COLUMNS);
  fresh = new Float32Array(COLUMNS); // 1 where just written, decays: the "writing head" glow
  head = 0; // column index being written
  private headPos = 0; // fractional, advances with tempo
  private headMax = 0; // loudest bass since this column started
  // pads
  build = [0, 0, 0]; // 0..1 per shell, inner first
  shellRot = [0, 0, 0];
  private shellRotTarget = [0, 0, 0];
  padHue = 0;
  // lead
  trail = new Float32Array(TRAIL * 4); // x, y, z, level (ring buffer)
  trailHead = 0;
  private leadAngle = 0;
  leadY = 0;
  nodes: Node[] = Array.from({ length: NODES }, () => ({ x: 0, y: 0, z: 0, age: 0, alive: false }));
  // hits
  shards: Shard[] = Array.from({ length: SHARDS }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 1, az: 0, spin: 0, angle: 0, age: 0, life: 1, size: 1, alive: false }));
  // hats
  sparkle: Float32Array;
  readonly latticeN: number;
  // drops
  dropFlash = 0;

  private lastEv = new Array(NF).fill(0);
  private lastDrop = 0;
  private track = -1;
  private seed = 12345;
  private rnd = () => ((this.seed = (this.seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  constructor(latticeN: number) {
    this.latticeN = latticeN;
    this.sparkle = new Float32Array(latticeN);
    for (let i = 0; i < TRAIL; i++) this.trail[i * 4 + 1] = FLOOR_Y; // start hidden at the floor
  }

  /** counts for the debug harness */
  stats() {
    return {
      shellsAlive: this.shells.filter((s) => s.alive).length,
      shardsAlive: this.shards.filter((s) => s.alive).length,
      nodesAlive: this.nodes.filter((s) => s.alive).length,
      sparkleSum: this.sparkle.reduce((a, b) => a + b, 0),
      build0: this.build[0], build2: this.build[2],
      bassMean: this.heights.reduce((a, b) => a + b, 0) / COLUMNS,
      leadY: this.leadY,
    };
  }

  step(dt: number, d: Drives) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const fam = d.fam;
    const lv = fam.level;
    if (d.track !== this.track) {
      this.track = d.track;
      for (let k = 0; k < NF; k++) this.lastEv[k] = fam.events[k];
      this.lastDrop = d.dropEvents;
    }
    const fired = (k: number) => {
      const n = fam.events[k] - this.lastEv[k];
      this.lastEv[k] = fam.events[k];
      return n > 0;
    };
    const ambient = d.idle; // with nothing playing, keep a quiet scaffold alive
    this.rotY += dt * (0.05 + 0.1 * d.energy) * (1 - 0.6 * d.calm);
    this.latticeRot -= dt * (0.02 + 0.05 * lv[F.hats]);

    // ---- drops: everything answers at once --------------------------------------------
    if (d.dropEvents !== this.lastDrop) {
      this.lastDrop = d.dropEvents;
      this.dropFlash = 1;
      for (let i = 0; i < this.latticeN; i++) this.sparkle[i] = Math.max(this.sparkle[i], 0.6 + 0.4 * this.rnd());
      for (let s = 0; s < 3; s++) this.shellRotTarget[s] += (2 * Math.PI) / 5;
    }
    this.dropFlash *= Math.exp(-dt / 0.8);

    // ---- kick: core + shells --------------------------------------------------------------
    if (fired(F.kick)) {
      const str = Math.max(0.3, fam.hit[F.kick]);
      this.coreFlash = Math.max(this.coreFlash, str);
      const sh = this.shells.find((s) => !s.alive) ?? this.shells.reduce((a, b) => (a.age > b.age ? a : b));
      sh.alive = true;
      sh.age = 0;
      sh.strength = str;
    }
    this.coreFlash *= Math.exp(-dt / 0.15);
    const coreT = 1 + 0.22 * lv[F.kick] + 0.45 * this.coreFlash + 0.06 * ambient * Math.sin(this.t * 1.3);
    this.core += (coreT - this.core) * Math.min(1, dt * 30);
    for (const s of this.shells) {
      if (!s.alive) continue;
      s.age += dt;
      if (s.age > SHELL_LIFE) s.alive = false;
    }

    // ---- bass: the foundation ----------------------------------------------------------
    // one column per sixteenth note when the tempo is known (64 columns = 4 bars), else 8/s
    const colsPerSec = d.bpm > 40 && d.confidence > 0.1 ? (d.bpm / 60) * 4 : 8;
    this.headMax = Math.max(this.headMax, lv[F.bass]);
    this.heights[this.head] = Math.max(this.heights[this.head], lv[F.bass]);
    this.headPos += dt * colsPerSec * (1 - ambient * 0.8);
    while (this.headPos >= 1) {
      this.headPos -= 1;
      this.head = (this.head + 1) % COLUMNS;
      this.heights[this.head] = lv[F.bass];
      this.fresh[this.head] = 1;
      this.headMax = 0;
    }
    if (fired(F.bass)) this.fresh[this.head] = 1.6;
    for (let i = 0; i < COLUMNS; i++) {
      this.fresh[i] *= Math.exp(-dt / 0.9);
      if (i !== this.head) this.heights[i] *= Math.exp(-dt / 14); // the record fades over a few laps
    }

    // ---- pads: construction ----------------------------------------------------------------
    // the shells build (inner first) while sustained sound holds and dissolve when it stops
    const padT = Math.max(lv[F.pads] * 1.25, 0.28 * ambient);
    for (let s = 0; s < 3; s++) {
      const target = Math.min(1, Math.max(0, padT * 3 - s * 0.9));
      const rate = target > this.build[s] ? 0.6 : 0.35; // construct over ~2 s, dissolve a bit slower
      this.build[s] += (target - this.build[s]) * Math.min(1, dt * rate * 2);
    }
    if (fired(F.pads)) for (let s = 0; s < 3; s++) this.shellRotTarget[s] += ((s % 2 ? -1 : 1) * 2 * Math.PI) / (5 + s);
    for (let s = 0; s < 3; s++) {
      this.shellRot[s] += (this.shellRotTarget[s] - this.shellRot[s]) * Math.min(1, dt * 2.2);
      this.shellRotTarget[s] += dt * 0.04 * (s + 1) * (1 - 0.7 * d.calm);
    }
    if (fam.hueStrength > 0.15) {
      let dh = fam.hue - this.padHue;
      if (dh > 0.5) dh -= 1;
      if (dh < -0.5) dh += 1;
      this.padHue = (this.padHue + dh * Math.min(1, dt * 1.5) + 1) % 1;
    }

    // ---- lead: the ribbon ------------------------------------------------------------------
    const lapSec = d.bpm > 40 && d.confidence > 0.1 ? (16 * 60) / d.bpm : 8; // a lap = 4 bars
    this.leadAngle += (dt * 2 * Math.PI) / lapSec;
    const yT = FLOOR_Y + 2 + Math.min(1, Math.max(0, (fam.melody - 0.12) / 0.45)) * 11;
    const ll = lv[F.lead];
    // the ribbon only follows pitch while there is a melody to follow (else it holds, dark)
    if (ll > 0.12) this.leadY += (yT - this.leadY) * Math.min(1, dt * 8 * Math.min(1, ll * 2));
    const x = Math.cos(this.leadAngle) * LEAD_R, z = Math.sin(this.leadAngle) * LEAD_R;
    this.trailHead = (this.trailHead + 1) % TRAIL;
    const o = this.trailHead * 4;
    this.trail[o] = x; this.trail[o + 1] = this.leadY; this.trail[o + 2] = z; this.trail[o + 3] = ll;
    if (fired(F.lead)) {
      const n = this.nodes.find((q) => !q.alive) ?? this.nodes.reduce((a, b) => (a.age > b.age ? a : b));
      Object.assign(n, { x, y: this.leadY, z, age: 0, alive: true });
    }
    for (const n of this.nodes) if (n.alive && (n.age += dt) > NODE_LIFE) n.alive = false;

    // ---- hits: shards --------------------------------------------------------------------
    if (fired(F.hits)) {
      const str = Math.max(0.3, fam.hit[F.hits]);
      const count = Math.round(5 + 9 * str);
      for (let c = 0; c < count; c++) {
        const sh = this.shards.find((q) => !q.alive);
        if (!sh) break;
        // random direction, biased to the horizontal so shards fly between shells and lattice
        const u = this.rnd() * 2 - 1, th = this.rnd() * 2 * Math.PI;
        const r = Math.sqrt(1 - u * u);
        const dx = r * Math.cos(th), dy = u * 0.6, dz = r * Math.sin(th);
        const sp = 7 + 7 * this.rnd() * str;
        Object.assign(sh, {
          x: dx * 1.5, y: dy * 1.5, z: dz * 1.5, vx: dx * sp, vy: dy * sp, vz: dz * sp,
          ax: this.rnd() - 0.5, ay: this.rnd() - 0.5, az: this.rnd() - 0.5, spin: 6 + 10 * this.rnd(), angle: 0,
          age: 0, life: 0.8 + 0.6 * this.rnd(), size: 0.6 + 0.8 * this.rnd() * str, alive: true,
        });
      }
    }
    const drag = Math.exp(-dt * 1.8);
    for (const s of this.shards) {
      if (!s.alive) continue;
      s.age += dt;
      if (s.age > s.life) { s.alive = false; continue; }
      s.vx *= drag; s.vy *= drag; s.vz *= drag;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.angle += s.spin * dt;
    }

    // ---- hats: the lattice -----------------------------------------------------------------
    if (fired(F.hats)) {
      const n = Math.round(6 + 14 * Math.max(0.3, fam.hit[F.hats]));
      for (let c = 0; c < n; c++) this.sparkle[Math.floor(this.rnd() * this.latticeN)] = 1;
    }
    const sd = Math.exp(-dt / 0.28);
    for (let i = 0; i < this.latticeN; i++) this.sparkle[i] *= sd;
  }
}

export const SHELL_LIFE = 1.2;
export const NODE_LIFE = 2.6;
