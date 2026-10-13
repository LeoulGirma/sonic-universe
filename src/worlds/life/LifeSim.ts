import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  copyFragment, cellFragment, forceFragment, keyFragment, moveFragment, quadVertex, sortFragment,
} from './lifeShaders';
import {
  S, ecosystemName, fingerprintSeed, makeMatrix, mixMatrix, mulberry32, referenceAcc, structureMetrics,
} from './lifeRules';
import type { Drives } from '../../mapping/drives';
import { Envelope } from '../../audio/dsp';

export interface LifeParams {
  rMax: number; // interaction radius (scene units)
  beta: number; // universal-repulsion share of rMax
  force: number; // acceleration per unit of summed force
  friction: number; // velocity half-life, seconds
  repel: number; // universal repulsion strength
  align: number; // flocking alignment at full mids (1/s)
  jitter: number; // random acceleration on the spark species at full highs
  contain: number; // soft containment radius
  cursorStrength: number;
  timeScale: number;
  size: number;
  bloom: number;
}

/** rMax and sizes are given for REF_COUNT particles and scale as (REF_COUNT / N)^(1/3), so every
 * quality level keeps the same neighbour count per particle (same dynamics, same tuning). */
export const REF_COUNT = 8192;

export const DEFAULT_LIFE: LifeParams = {
  rMax: 6.4, beta: 0.3, force: 6, friction: 0.2, repel: 2.5, align: 2.5, jitter: 60, contain: 30,
  cursorStrength: 160, timeScale: 1, size: 1, bloom: 1,
};

export const B = 44; // half-size of the hashed domain
export const RMAX_HEADROOM = 1.25; // build-ups grow rMax up to this factor; cells are sized for it

export interface CursorInput { active: boolean; point: THREE.Vector3; sign: number; boost: number }

const DEFAULT_SEED = 0x5eed1e;

function rt(w: number, h: number) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

/**
 * Layer 3 — simulation for World D. Positions and velocities live in float textures; each step
 * rebuilds a sorted spatial hash and integrates the Particle Life law on the GPU. The CPU owns
 * the ecosystem: which species matrix is active, how the music bends it, and transitions.
 */
export class LifeSim {
  readonly w: number;
  readonly h: number;
  readonly count: number;
  readonly cap: number;
  readonly G: number;
  readonly cell: number;
  /** length scale for this particle count (1 at REF_COUNT) */
  readonly scale: number;
  private readonly cw: number;
  private gl: THREE.WebGLRenderer;
  private quad = new FullScreenQuad();
  private pos: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private vel: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private keys: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cells: THREE.WebGLRenderTarget;
  private pi = 0;
  private vi = 0;
  private ki = 0;
  private mats: Record<'copy' | 'key' | 'sort' | 'cell' | 'force' | 'move', THREE.ShaderMaterial>;
  private sortPasses: [number, number][] = [];
  private simTime = 0;
  error: string | null = null;

  // ecosystem state
  private K = new Float32Array(S * S); // what the shader sees this frame
  private from = makeMatrix(DEFAULT_SEED);
  private to = makeMatrix(DEFAULT_SEED);
  private toBright = makeMatrix(DEFAULT_SEED ^ 0x9e3779b9);
  private fromBright = makeMatrix(DEFAULT_SEED ^ 0x9e3779b9);
  private fade = 1;
  private fadeDur = 1;
  private perturb = new Float32Array(S * S);
  private perturbAmp = 0;
  private pulse = 0;
  private lastKick = 0;
  private lastDrop = 0;
  private track = -1;
  private songSeed = DEFAULT_SEED;
  private fingerprinted = false;
  private tensionEnv = new Envelope(0.4, 0.3, 0);
  seed = DEFAULT_SEED;
  generation = 0; // how many ecosystems this track has grown (drops add one each)
  /** read by the renderer */
  pulseLevel = 0;

  constructor(gl: THREE.WebGLRenderer, w: number, h: number, cap: number, params: LifeParams) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.count = w * h;
    this.cap = cap;
    this.scale = Math.cbrt(REF_COUNT / this.count);
    this.cell = params.rMax * this.scale * RMAX_HEADROOM;
    this.G = Math.ceil((2 * B) / this.cell);
    this.cw = Math.ceil(Math.sqrt(this.G ** 3));
    const ctx = gl.getContext();
    if (!gl.capabilities.isWebGL2 || !ctx.getExtension('EXT_color_buffer_float')) {
      this.error = 'Particle Life needs WebGL 2 with float render targets.';
    }
    this.pos = [rt(w, h), rt(w, h)];
    this.vel = [rt(w, h), rt(w, h)];
    this.keys = [rt(w, h), rt(w, h)];
    this.cells = rt(this.cw, this.cw);

    const log2n = Math.round(Math.log2(this.count));
    const defines = {
      W: w, N: this.count, LOG2N: log2n, G: this.G, CW: this.cw, CAP: cap, S,
      CELL: this.cell.toFixed(4), B: B.toFixed(1),
    };
    const mk = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: quadVertex, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false });
    this.mats = {
      copy: mk(copyFragment, { tSrc: { value: null } }),
      key: mk(keyFragment, { tPos: { value: null } }),
      sort: mk(sortFragment, { tKeys: { value: null }, uBlock: { value: 2 }, uDist: { value: 1 } }),
      cell: mk(cellFragment, { tKeys: { value: null } }),
      force: mk(forceFragment, {
        tPos: { value: null }, tVel: { value: null }, tKeys: { value: null }, tCells: { value: null },
        uK: { value: this.K }, uRMax: { value: params.rMax }, uBeta: { value: params.beta }, uRepel: { value: params.repel },
        uForce: { value: params.force }, uFriction: { value: params.friction }, uAlign: { value: 0 }, uJitter: { value: 0 },
        uContain: { value: params.contain }, uDt: { value: 1 / 60 }, uSeed: { value: 0 },
        uCursor: { value: new THREE.Vector3() }, uCursorK: { value: 0 }, uDebug: { value: 0 },
      }),
      move: mk(moveFragment, { tPos: { value: null }, tVel: { value: null }, uDt: { value: 1 / 60 } }),
    };
    for (let k = 2; k <= this.count; k <<= 1) for (let j = k >> 1; j > 0; j >>= 1) this.sortPasses.push([k, j]);

    this.seedParticles(params);
    this.K.set(this.to);
  }

  private run(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    const prev = this.gl.getRenderTarget();
    this.gl.setRenderTarget(target);
    this.quad.material = mat;
    this.quad.render(this.gl);
    this.gl.setRenderTarget(prev);
  }

  /** Uniform cloud in a sphere, species in round-robin, at rest. */
  private seedParticles(params: LifeParams) {
    const n = this.count;
    const p = new Float32Array(n * 4);
    const r = mulberry32(12345);
    for (let i = 0; i < n; i++) {
      let x, y, z;
      do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; } while (x * x + y * y + z * z > 1);
      const rad = params.contain * 0.92;
      p[i * 4] = x * rad; p[i * 4 + 1] = y * rad; p[i * 4 + 2] = z * rad; p[i * 4 + 3] = i % S;
    }
    const upload = (data: Float32Array, target: THREE.WebGLRenderTarget) => {
      const t = new THREE.DataTexture(data as Float32Array<ArrayBuffer>, this.w, this.h, THREE.RGBAFormat, THREE.FloatType);
      t.needsUpdate = true;
      this.mats.copy.uniforms.tSrc.value = t;
      this.run(this.mats.copy, target);
      t.dispose();
    };
    upload(p, this.pos[0]);
    upload(new Float32Array(n * 4), this.vel[0]);
  }

  get positionTarget() { return this.pos[this.pi]; }
  get velocityTarget() { return this.vel[this.vi]; }
  get time() { return this.simTime; }
  get ecosystem() { return ecosystemName(this.seed); }
  get isSongEcosystem() { return this.fingerprinted; }

  /** Spatial hash: keys → sort → cell ranges. */
  private buildHash() {
    const m = this.mats;
    m.key.uniforms.tPos.value = this.pos[this.pi].texture;
    this.run(m.key, this.keys[0]);
    this.ki = 0;
    for (const [k, j] of this.sortPasses) {
      m.sort.uniforms.tKeys.value = this.keys[this.ki].texture;
      m.sort.uniforms.uBlock.value = k;
      m.sort.uniforms.uDist.value = j;
      this.run(m.sort, this.keys[1 - this.ki]);
      this.ki = 1 - this.ki;
    }
    m.cell.uniforms.tKeys.value = this.keys[this.ki].texture;
    this.run(m.cell, this.cells);
  }

  private step(h: number) {
    this.buildHash();
    const f = this.mats.force.uniforms;
    f.tPos.value = this.pos[this.pi].texture;
    f.tVel.value = this.vel[this.vi].texture;
    f.tKeys.value = this.keys[this.ki].texture;
    f.tCells.value = this.cells.texture;
    f.uDt.value = h;
    f.uSeed.value = (this.simTime * 97.13) % 1000;
    this.run(this.mats.force, this.vel[1 - this.vi]);
    this.vi = 1 - this.vi;
    const mv = this.mats.move.uniforms;
    mv.tPos.value = this.pos[this.pi].texture;
    mv.tVel.value = this.vel[this.vi].texture;
    mv.uDt.value = h;
    this.run(this.mats.move, this.pos[1 - this.pi]);
    this.pi = 1 - this.pi;
  }

  private startFade(seed: number, dur: number) {
    // freeze the currently blended matrices as the new starting point
    mixMatrix(this.from, this.from, this.to, this.fade);
    mixMatrix(this.fromBright, this.fromBright, this.toBright, this.fade);
    this.to = makeMatrix(seed);
    this.toBright = makeMatrix(seed ^ 0x9e3779b9);
    this.fade = 0;
    this.fadeDur = dur;
    this.seed = seed;
  }

  /**
   * The ecosystem follows the music:
   *  - identity: after 8 s of real audio the song's fingerprint (tempo, centroid, spectral
   *    balance) picks the species matrix; brighter timbre morphs toward a companion matrix
   *  - bass strengthens every attraction; kicks briefly scramble the matrix and boost
   *    short-range repulsion (a scatter); highs agitate the spark species; mids add flocking
   *  - breakdowns cool and slow the system; build-ups widen the interaction radius;
   *    drops grow a new ecosystem from the song's seed
   */
  update(dt: number, d: Drives, params: LifeParams, gravityScale: number, cursor: CursorInput) {
    // --- identity -----------------------------------------------------------
    if (d.track !== this.track) {
      this.track = d.track;
      this.fingerprinted = false;
      this.generation = 0;
      this.lastKick = d.kickEvents;
      this.lastDrop = d.dropEvents;
    }
    if (!this.fingerprinted && d.idle < 0.5 && d.activeTime > 8) {
      this.fingerprinted = true;
      this.songSeed = fingerprintSeed(d.bpm, d.centroidHz, d.tilt);
      this.startFade(this.songSeed, 3);
    }
    if (d.dropEvents !== this.lastDrop) {
      this.lastDrop = d.dropEvents;
      this.generation++;
      this.startFade((Math.imul(this.songSeed ^ 0x85ebca6b, this.generation + 1) >>> 0), 1.5);
      this.pulse = Math.max(this.pulse, 1);
    }
    if (d.kickEvents !== this.lastKick) {
      this.lastKick = d.kickEvents;
      const r = mulberry32(d.kickEvents * 2654435761);
      for (let i = 0; i < S * S; i++) this.perturb[i] = r() * 2 - 1;
      const s = Math.min(1, 0.3 + d.lastKick);
      this.perturbAmp = Math.max(this.perturbAmp, 0.55 * s);
      this.pulse = Math.max(this.pulse, 0.6 * s);
    }
    this.perturbAmp *= Math.exp(-dt / 0.35);
    this.pulse *= Math.exp(-dt / 0.25);
    this.pulseLevel = this.pulse;
    this.fade = Math.min(1, this.fade + dt / this.fadeDur);
    const e = this.fade * this.fade * (3 - 2 * this.fade);

    // --- matrix the shader sees this frame -----------------------------------
    const bright = Math.min(1, Math.max(0, (d.hue - 0.35) / 0.4)) * 0.35;
    const attract = 1 + 0.5 * d.gravity;
    for (let i = 0; i < S * S; i++) {
      const base = this.from[i] + (this.to[i] - this.from[i]) * e;
      const alt = this.fromBright[i] + (this.toBright[i] - this.fromBright[i]) * e;
      let k = base + (alt - base) * bright;
      if (k > 0) k *= attract;
      k += this.perturb[i] * this.perturbAmp;
      this.K[i] = Math.max(-1.5, Math.min(1.5, k));
    }

    // --- physical parameters --------------------------------------------------
    const tension = this.tensionEnv.step(d.tension, dt);
    const f = this.mats.force.uniforms;
    f.uRMax.value = Math.min(params.rMax * this.scale * (1 + 0.25 * tension), this.cell);
    f.uBeta.value = params.beta;
    f.uRepel.value = params.repel * (1 + 2.5 * this.pulse);
    f.uForce.value = params.force * gravityScale * (0.75 + 0.5 * d.energy) * (1 - 0.2 * d.idle);
    f.uFriction.value = params.friction * (1 - 0.55 * d.calm) * (1 + 0.6 * d.release);
    f.uAlign.value = params.align * d.flow;
    f.uJitter.value = params.jitter * Math.min(1.5, d.shimmer + 1.5 * d.sparkle);
    f.uContain.value = params.contain;
    if (cursor.active) {
      f.uCursor.value.copy(cursor.point);
      f.uCursorK.value = cursor.sign * params.cursorStrength * cursor.boost;
    } else f.uCursorK.value = 0;

    const sdt = dt * params.timeScale * (1 - 0.45 * d.calm) * (1 + 0.3 * d.release);
    this.simTime += sdt;
    const steps = sdt > 1 / 45 ? 2 : 1;
    const h = Math.min(sdt, 1 / 30) / steps;
    if (h <= 0) return;
    for (let s = 0; s < steps; s++) this.step(h);
  }

  // ---------------------------------------------------------------------------------
  // Verification (?debug only)
  // ---------------------------------------------------------------------------------
  private read(target: THREE.WebGLRenderTarget, w = this.w, h = this.h) {
    const buf = new Float32Array(w * h * 4);
    this.gl.readRenderTargetPixels(target, 0, 0, w, h, buf);
    return buf;
  }

  /** Structure metrics on the current state (CPU, from a GPU readback). */
  metrics(r = 3 * this.scale) {
    return structureMetrics(this.read(this.pos[this.pi]), r, 1500);
  }

  /**
   * Checks the GPU pipeline against the brute-force CPU law on the current positions:
   * the sorted keys are a permutation ordered by cell, every cell range is right, and the
   * GPU acceleration matches the reference wherever no neighbouring cell exceeds CAP.
   */
  selfTest(params: LifeParams, samples = 400) {
    const P = this.read(this.pos[this.pi]);
    this.buildHash();
    const keys = this.read(this.keys[this.ki]);
    const n = this.count;
    const cellOf = (x: number, y: number, z: number) => {
      const c = [x, y, z].map((v) => Math.min(this.G - 1, Math.max(0, Math.floor((v + B) / this.cell))));
      return c[0] + this.G * (c[1] + this.G * c[2]);
    };
    let sorted = true, perm = true, keyRight = true;
    const seen = new Uint8Array(n);
    for (let m = 0; m < n; m++) {
      const k = keys[m * 4], idx = keys[m * 4 + 1];
      if (m > 0 && k < keys[(m - 1) * 4]) sorted = false;
      if (idx < 0 || idx >= n || seen[idx]) perm = false;
      else seen[idx] = 1;
      if (cellOf(P[idx * 4], P[idx * 4 + 1], P[idx * 4 + 2]) !== k) keyRight = false;
    }
    const cellsBuf = this.read(this.cells, this.cw, this.cw);
    let rangesRight = true, maxCell = 0;
    const counts = new Int32Array(this.G ** 3);
    for (let m = 0; m < n; m++) counts[keys[m * 4]]++;
    for (let c = 0; c < this.G ** 3; c++) {
      const s = cellsBuf[c * 4], e = cellsBuf[c * 4 + 1];
      if (e - s !== counts[c]) rangesRight = false;
      if (counts[c] && keys[s * 4] !== c) rangesRight = false;
      maxCell = Math.max(maxCell, counts[c]);
    }

    // forces: debug mode writes acceleration (pair forces + containment) into the spare target
    const f = this.mats.force.uniforms;
    const saved = { rMax: f.uRMax.value, repel: f.uRepel.value, force: f.uForce.value, contain: f.uContain.value };
    f.uRMax.value = params.rMax * this.scale; f.uRepel.value = params.repel; f.uForce.value = params.force; f.uContain.value = params.contain;
    f.tPos.value = this.pos[this.pi].texture;
    f.tVel.value = this.vel[this.vi].texture;
    f.tKeys.value = this.keys[this.ki].texture;
    f.tCells.value = this.cells.texture;
    f.uDebug.value = 1;
    this.run(this.mats.force, this.vel[1 - this.vi]);
    f.uDebug.value = 0;
    const A = this.read(this.vel[1 - this.vi]);
    f.uRMax.value = saved.rMax; f.uRepel.value = saved.repel; f.uForce.value = saved.force; f.uContain.value = saved.contain;

    const ref: [number, number, number] = [0, 0, 0];
    const lp = { rMax: params.rMax * this.scale, beta: params.beta, repel: params.repel, force: params.force, contain: params.contain };
    const r = mulberry32(77);
    let checked = 0, maxRel = 0, sumRel = 0, skipped = 0;
    for (let t = 0; t < samples; t++) {
      const i = Math.floor(r() * n);
      const x = P[i * 4], y = P[i * 4 + 1], z = P[i * 4 + 2];
      // skip particles whose neighbourhood was sampled (estimate, not exact)
      let dense = false;
      for (let dz = -1; dz <= 1 && !dense; dz++) for (let dy = -1; dy <= 1 && !dense; dy++) for (let dx = -1; dx <= 1 && !dense; dx++) {
        const c = cellOf(x + dx * this.cell, y + dy * this.cell, z + dz * this.cell);
        if (counts[c] > this.cap) dense = true;
      }
      if (dense) { skipped++; continue; }
      referenceAcc(P, i, this.K, lp, ref);
      const g = [A[i * 4], A[i * 4 + 1], A[i * 4 + 2]];
      const mag = Math.max(1e-3, Math.hypot(...ref));
      const err = Math.hypot(g[0] - ref[0], g[1] - ref[1], g[2] - ref[2]) / Math.max(mag, params.force * 0.05);
      maxRel = Math.max(maxRel, err);
      sumRel += err;
      checked++;
    }
    return { n, sorted, perm, keyRight, rangesRight, maxCell, cap: this.cap, checked, skipped, meanRelErr: checked ? sumRel / checked : NaN, maxRelErr: maxRel };
  }

  /**
   * Dense cells are estimated by sampling. Checks the estimator is unbiased: averaged over many
   * random sample offsets, the GPU acceleration must converge on the exact brute-force law.
   */
  estimatorTest(params: LifeParams, runs = 32, samples = 120) {
    const P = this.read(this.pos[this.pi]);
    this.buildHash();
    const f = this.mats.force.uniforms;
    const saved = { rMax: f.uRMax.value, repel: f.uRepel.value, force: f.uForce.value, contain: f.uContain.value, seed: f.uSeed.value };
    f.uRMax.value = params.rMax * this.scale; f.uRepel.value = params.repel; f.uForce.value = params.force; f.uContain.value = params.contain;
    f.tPos.value = this.pos[this.pi].texture;
    f.tVel.value = this.vel[this.vi].texture;
    f.tKeys.value = this.keys[this.ki].texture;
    f.tCells.value = this.cells.texture;
    f.uDebug.value = 1;
    const n = this.count;
    const sum = new Float64Array(n * 3);
    let first: Float32Array | null = null;
    for (let k = 0; k < runs; k++) {
      f.uSeed.value = 13.37 * (k + 1);
      this.run(this.mats.force, this.vel[1 - this.vi]);
      const A = this.read(this.vel[1 - this.vi]);
      if (!first) first = A;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum[i * 3 + c] += A[i * 4 + c];
    }
    f.uDebug.value = 0;
    f.uRMax.value = saved.rMax; f.uRepel.value = saved.repel; f.uForce.value = saved.force; f.uContain.value = saved.contain; f.uSeed.value = saved.seed;
    const lp = { rMax: params.rMax * this.scale, beta: params.beta, repel: params.repel, force: params.force, contain: params.contain };
    const ref: [number, number, number] = [0, 0, 0];
    const r = mulberry32(5);
    let single = 0, averaged = 0, m = 0;
    for (let t = 0; t < samples; t++) {
      const i = Math.floor(r() * n);
      referenceAcc(P, i, this.K, lp, ref);
      const scale = Math.max(Math.hypot(...ref), params.force * 0.5);
      single += Math.hypot(first![i * 4] - ref[0], first![i * 4 + 1] - ref[1], first![i * 4 + 2] - ref[2]) / scale;
      averaged += Math.hypot(sum[i * 3] / runs - ref[0], sum[i * 3 + 1] / runs - ref[1], sum[i * 3 + 2] / runs - ref[2]) / scale;
      m++;
    }
    return { runs, singleFrameErr: single / m, averagedErr: averaged / m, expectedShrink: Math.sqrt(runs) };
  }

  dispose() {
    for (const t of [...this.pos, ...this.vel, ...this.keys, this.cells]) t.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this.quad.dispose();
  }
}
