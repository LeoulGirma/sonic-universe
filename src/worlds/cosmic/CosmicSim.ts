import * as THREE from 'three';
import { GPUComputationRenderer, Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { positionShader, velocityShader } from './shaders';
import type { Drives } from '../../mapping/drives';
import type { SimParams } from '../../store/useStore';
import { Envelope } from '../../audio/dsp';

const PATTERN_SPEED = 0.09; // rad/s, density-wave pattern speed (corotation ≈ r 20)
const MAX_SHOCKS = 12;

interface Shock { r: number; r0: number; strength: number; width: number; speed: number; age: number; center: THREE.Vector3 }

export interface CursorInput { active: boolean; point: THREE.Vector3; sign: number; boost: number }

/**
 * Layer 3 — simulation state for Cosmic Genesis.
 * Positions/velocities live in float textures and are integrated on the GPU
 * (GPUComputationRenderer ping-pong). The CPU owns only the handful of global objects:
 * shockwave shells, the two satellite wells, and the ripple phase.
 */
export class CosmicSim {
  readonly side: number;
  readonly count: number;
  readonly floatType: 'float' | 'half';
  private gpu: GPUComputationRenderer;
  private vel: Variable;
  private pos: Variable;
  private vU: Record<string, THREE.IUniform>;
  private pU: Record<string, THREE.IUniform>;
  private shocks: Shock[] = [];
  private lastKick = 0;
  private lastDrop = 0;
  private wavePhase = 0;
  private simTime = 0;
  private compAngle = [0.4, 2.6];
  private compEnv = new Envelope(0.6, 9, 0);
  private gEnv = new Envelope(0.04, 0.35, 0);
  private tensionEnv = new Envelope(0.4, 0.25, 0); // follows the map's build-up ramp closely
  readonly wells = [new THREE.Vector4(), new THREE.Vector4()];
  /** read by the renderer for glows */
  readonly shockUniform: THREE.Vector4[] = Array.from({ length: MAX_SHOCKS }, () => new THREE.Vector4());
  readonly shockCenter: THREE.Vector3[] = Array.from({ length: MAX_SHOCKS }, () => new THREE.Vector3());
  gravityPulse = 0;
  error: string | null = null;

  constructor(renderer: THREE.WebGLRenderer, side: number, params: SimParams) {
    this.side = side;
    this.count = side * side;
    const gl = renderer.getContext();
    const canFloat = renderer.capabilities.isWebGL2 && !!gl.getExtension('EXT_color_buffer_float');
    this.floatType = canFloat ? 'float' : 'half';
    this.gpu = new GPUComputationRenderer(side, side, renderer);
    this.gpu.setDataType(canFloat ? THREE.FloatType : THREE.HalfFloatType);

    const p0 = this.gpu.createTexture();
    const v0 = this.gpu.createTexture();
    this.seed(p0.image.data as unknown as Float32Array, v0.image.data as unknown as Float32Array, params);

    this.vel = this.gpu.addVariable('textureVelocity', velocityShader, v0);
    this.pos = this.gpu.addVariable('texturePosition', positionShader, p0);
    this.gpu.setVariableDependencies(this.vel, [this.pos, this.vel]);
    this.gpu.setVariableDependencies(this.pos, [this.pos, this.vel]);

    const common = () => ({
      uTime: { value: 0 },
      uSeed: { value: 0 },
      uG: { value: params.G },
      uSoft: { value: params.softening },
      uPatternSpeed: { value: PATTERN_SPEED },
      uSpiralA: { value: 0.12 },
      uDt: { value: 0 },
    });
    this.vU = this.vel.material.uniforms;
    Object.assign(this.vU, common(), {
      uWells: { value: this.wells },
      uShock: { value: this.shockUniform },
      uShockC: { value: this.shockCenter },
      uCursor: { value: new THREE.Vector3() },
      uCursorK: { value: 0 },
      uCooling: { value: params.cooling },
      uWaveA: { value: 0 },
      uWavePhase: { value: 0 },
    });
    this.pU = this.pos.material.uniforms;
    Object.assign(this.pU, common());
    for (const v of [this.vel, this.pos]) {
      v.wrapS = THREE.ClampToEdgeWrapping;
      v.wrapT = THREE.ClampToEdgeWrapping;
      v.minFilter = THREE.NearestFilter;
      v.magFilter = THREE.NearestFilter;
    }
    const err = this.gpu.init();
    if (err) this.error = err;
  }

  /** Initial galaxy: exponential disk on two log-spiral arms + an inter-arm population + a bulge. */
  private seed(pos: Float32Array, vel: Float32Array, params: SimParams) {
    const G = params.G;
    const s2 = params.softening * params.softening;
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    for (let i = 0; i < this.count; i++) {
      const k = i * 4;
      const seed = Math.random();
      let x: number, y: number, z: number;
      const kind = Math.random();
      if (kind < 0.13) {
        // bulge: spherical, slightly flattened
        const r = Math.abs(gauss()) * 2.6 + 0.8;
        const u = Math.random() * 2 - 1;
        const ph = Math.random() * Math.PI * 2;
        const q = Math.sqrt(1 - u * u);
        x = r * q * Math.cos(ph); y = r * u * 0.6; z = r * q * Math.sin(ph);
      } else {
        const r = Math.min(44, 3.5 - 9.5 * Math.log(1 - Math.random() * 0.985));
        let th: number;
        if (kind < 0.82) {
          const arm = Math.random() < 0.5 ? 0 : Math.PI;
          th = (4.0 * Math.log(r)) / 2 + arm + gauss() * 0.2 * (1 + r / 40);
        } else th = Math.random() * Math.PI * 2;
        x = Math.cos(th) * r; z = Math.sin(th) * r;
        y = gauss() * 0.22 * (1 + r / 15);
      }
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z; pos[k + 3] = seed;
      const r2 = x * x + z * z;
      const rr = Math.sqrt(r2) + 1e-4;
      const s = r2 + s2;
      const vc = Math.sqrt((G * r2) / (s * Math.sqrt(s)));
      const disp = kind < 0.13 ? 0.35 : 0.06;
      vel[k] = (-z / rr) * vc + gauss() * vc * disp;
      vel[k + 1] = gauss() * vc * disp * 0.5;
      vel[k + 2] = (x / rr) * vc + gauss() * vc * disp;
      vel[k + 3] = 0;
    }
  }

  get positionTarget() {
    return this.gpu.getCurrentRenderTarget(this.pos);
  }
  get velocityTarget() {
    return this.gpu.getCurrentRenderTarget(this.vel);
  }
  get positionTexture() {
    return this.gpu.getCurrentRenderTarget(this.pos).texture;
  }
  get velocityTexture() {
    return this.gpu.getCurrentRenderTarget(this.vel).texture;
  }
  get time() {
    return this.simTime;
  }
  get patternSpeed() {
    return PATTERN_SPEED;
  }

  private spawnShock(strength: number, width: number, speed: number, center: THREE.Vector3) {
    // never evict a shell mid-flight: it would leave stars with the push but not the return
    if (this.shocks.length >= MAX_SHOCKS) return;
    // start 3 widths "behind" the centre so every star sees the whole pulse from S(+∞) = 0
    this.shocks.push({ r: -3 * width, r0: -3 * width, strength, width, speed, age: 0, center: center.clone() });
  }

  update(dt: number, d: Drives, params: SimParams, gravityScale: number, cursor: CursorInput) {
    // breakdowns slow time down ("suspended" feel); drops briefly speed it up
    // build-ups wind the galaxy up (faster spin, tighter gravity) so the drop has something to release
    const timeScale = params.timeScale * (1 - 0.5 * d.calm) * (1 + 0.25 * d.release) * (1 + 0.6 * d.tension);
    const sdt = dt * timeScale;

    // discrete events → shockwaves
    if (d.kickEvents !== this.lastKick) {
      this.lastKick = d.kickEvents;
      const s = Math.min(1.4, 0.35 + d.lastKick);
      this.spawnShock(params.shockStrength * s * (1 - 0.6 * d.calm), 6, params.shockSpeed, ORIGIN);
    }
    if (d.dropEvents !== this.lastDrop) {
      this.lastDrop = d.dropEvents;
      this.spawnShock(params.shockStrength * 2.6, 9, params.shockSpeed * 1.2, ORIGIN);
      this.compEnv.value = Math.max(this.compEnv.value, 0.6); // satellites surge in on the drop
    }
    // shells advance in the integration loop below (so sub-steps see exact R0 → R1)
    this.shocks = this.shocks.filter((s) => s.r < 80 + 3 * s.width); // fully past every star (R_OUT 78)

    // gravity: bass breathes it, build-ups slowly tighten it (inhale before the drop),
    // and the drop releases it (exhale)
    this.gravityPulse = this.gEnv.step(d.gravity, dt);
    const tension = this.tensionEnv.step(d.tension, dt);
    const G = params.G * gravityScale * (1 + 0.32 * this.gravityPulse + 0.55 * tension - 0.25 * d.release);

    // satellite wells: active around drops and in sustained high-energy passages
    const compTarget = Math.max(d.release > 0.05 ? 1 : 0, d.energy > 0.72 ? 0.45 : 0);
    const comp = this.compEnv.step(compTarget, dt);
    const radii = [26, 33];
    for (let i = 0; i < 2; i++) {
      const R = radii[i];
      const w = Math.sqrt(params.G / (R * R * R)) * (i ? -1 : 1);
      this.compAngle[i] += w * sdt;
      const a = this.compAngle[i];
      const tilt = i ? -0.35 : 0.25;
      this.wells[i].set(Math.cos(a) * R, Math.sin(a) * R * Math.sin(tilt), Math.sin(a) * R * Math.cos(tilt), params.G * 0.22 * params.companionMass * comp);
    }

    this.wavePhase += sdt * 2.8;

    const fr = Math.random() * 1000;
    this.simTime += sdt;
    const spiralA = 0.16 * params.spiralAmp * (0.6 + 0.9 * d.flow + 0.4 * d.idle) * (1 + 0.8 * d.tension);
    const cooling = params.cooling * (1.2 - 0.3 * d.energy) * (1 - 0.6 * Math.min(1, d.release)) * (1 + 1.2 * d.calm);

    // integrate (sub-step for large frames so the explicit integrator stays stable)
    const steps = sdt > 1 / 40 ? 2 : 1;
    const h = Math.min(sdt, 1 / 20) / steps;
    if (h <= 0) return;

    for (const U of [this.vU, this.pU]) {
      U.uG.value = G;
      U.uSoft.value = params.softening;
      U.uSpiralA.value = spiralA;
      U.uDt.value = h;
      U.uSeed.value = fr;
    }
    this.vU.uCooling.value = cooling;
    this.vU.uWaveA.value = params.waveAmp * 2.4 * this.gravityPulse * (1 - 0.6 * d.calm);
    this.vU.uWavePhase.value = this.wavePhase;
    if (cursor.active) {
      this.vU.uCursor.value.copy(cursor.point);
      this.vU.uCursorK.value = cursor.sign * params.cursorStrength * cursor.boost;
    } else this.vU.uCursorK.value = 0;

    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < MAX_SHOCKS; i++) {
        const sh = this.shocks[i];
        if (sh) {
          sh.r0 = sh.r;
          sh.r += sh.speed * h;
          sh.age += h;
          // R0/R1 bracket this sub-step exactly; strength is constant per shell (the shader
          // attenuates by each star's distance) so push and pull cancel
          this.shockUniform[i].set(sh.r0, sh.r, sh.strength, sh.width);
          this.shockCenter[i].copy(sh.center);
        } else this.shockUniform[i].set(0, 0, 0, 1);
      }
      const t = this.simTime - sdt + h * (s + 1);
      this.vU.uTime.value = t;
      this.pU.uTime.value = t;
      this.gpu.compute();
    }
    this.compStrength = comp;
  }
  compStrength = 0;

  /** For effects that want the smooth shock state. */
  get activeShocks() {
    return this.shocks.length;
  }

  dispose() {
    this.gpu.dispose();
  }
}

const ORIGIN = new THREE.Vector3();
