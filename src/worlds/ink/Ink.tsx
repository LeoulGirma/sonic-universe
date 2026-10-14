import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  advectFrag, baseVertex, curlFrag, displayFrag, displayVertex, divergenceFrag, gradientFrag, pressureFrag, scaleFrag,
  splatFrag, vorticityFrag,
} from './inkShaders';
import { F, FAMILY_INFO, NF } from '../../audio/soundFamilies';
import { useStore, type Quality } from '../../store/useStore';
import { cameraOwner, drives, perf, pointer } from '../../engine/frameBus';
import { Spring } from '../../audio/dsp';
import type { Drives } from '../../mapping/drives';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';
import { conductor } from '../../mapping/conductor';

/**
 * World G — Ink in Water. A real 2D fluid (stable fluids on the GPU); every kind of sound injects
 * its own colour of dye with its own kind of force, and the fluid does the blending:
 *   kick  → a pressure burst from the centre (red)
 *   bass  → a slow whirlpool low in the water (violet)
 *   pads  → soft clouds breathing in from both sides (teal)
 *   lead  → a stream drawn by an emitter that rises and falls with the melody (pink)
 *   hits  → quick darts at random places (orange)
 *   hats  → tiny flecks (gold)
 *   a new section or a drop stirs the whole tank into one big vortex
 * Timescales are split: phrases move the emitters, beats only add impulses, so nothing jitters.
 * Physics: the incompressible Euler equations, discretised (semi-Lagrangian advection, Jacobi
 * pressure). Art: what the music injects, where, and the colours.
 */
export const INK_Q: Record<Quality, { sim: number; dye: number; iters: number }> = {
  low: { sim: 96, dye: 512, iters: 16 },
  medium: { sim: 128, dye: 768, iters: 20 },
  high: { sim: 160, dye: 1024, iters: 22 },
  ultra: { sim: 224, dye: 1440, iters: 26 },
};

const BASE_COL = FAMILY_INFO.map((f) => new THREE.Color(f.color));
/** the family colours as poured right now (recoloured into the song's palette with song mood on) */
const COL = BASE_COL.map((c) => c.clone());
const WATER = new THREE.Color('#05061a');

interface DoubleFBO { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; swap: () => void; texel: THREE.Vector2 }

function makeTarget(w: number, h: number) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false,
  });
}
function makeDouble(w: number, h: number): DoubleFBO {
  const f = {
    read: makeTarget(w, h), write: makeTarget(w, h), texel: new THREE.Vector2(1 / w, 1 / h),
    swap() { const t = f.read; f.read = f.write; f.write = t; },
  };
  return f;
}

export function Ink() {
  const { gl, size } = useThree();
  const quality = useStore((s) => s.quality);
  const q = INK_Q[quality];

  const sim = useMemo(() => {
    const aspect = Math.max(0.5, size.width / Math.max(1, size.height));
    const sw = Math.round(q.sim * Math.max(1, aspect)), sh = Math.round(q.sim * Math.max(1, 1 / aspect));
    const dw = Math.round(q.dye * Math.max(1, aspect) / Math.max(1, aspect)), dh = Math.round(dw / aspect);
    const velocity = makeDouble(sw, sh);
    const dye = makeDouble(dw, dh);
    const pressure = makeDouble(sw, sh);
    const divergence = makeTarget(sw, sh);
    const curl = makeTarget(sw, sh);
    const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: baseVertex, fragmentShader: frag, uniforms: { texelSize: { value: velocity.texel }, ...uniforms }, depthTest: false, depthWrite: false });
    const m = {
      splat: mat(splatFrag, { uTarget: { value: null }, aspectRatio: { value: aspect }, color: { value: new THREE.Vector3() }, point: { value: new THREE.Vector2() }, radius: { value: 0.01 } }),
      advect: mat(advectFrag, { uVelocity: { value: null }, uSource: { value: null }, dt: { value: 0 }, dissipation: { value: 0 } }),
      divergence: mat(divergenceFrag, { uVelocity: { value: null } }),
      curl: mat(curlFrag, { uVelocity: { value: null } }),
      vorticity: mat(vorticityFrag, { uVelocity: { value: null }, uCurl: { value: null }, curl: { value: 22 }, dt: { value: 0 } }),
      pressure: mat(pressureFrag, { uPressure: { value: null }, uDivergence: { value: null } }),
      gradient: mat(gradientFrag, { uPressure: { value: null }, uVelocity: { value: null } }),
      scale: mat(scaleFrag, { uTexture: { value: null }, value: { value: 0.8 } }),
    };
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m.splat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const cam = new THREE.Camera();
    return { velocity, dye, pressure, divergence, curl, m, quad, scene, cam, aspect, sw, sh };
  }, [q.sim, q.dye, size.width, size.height]);

  const display = useMemo(() => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: displayVertex, fragmentShader: displayFrag, depthWrite: false,
      uniforms: { uDye: { value: null }, uWater: { value: new THREE.Color('#05061a') }, dyeTexel: { value: new THREE.Vector2() } },
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }, []);

  useEffect(() => () => {
    for (const t of [sim.velocity.read, sim.velocity.write, sim.dye.read, sim.dye.write, sim.pressure.read, sim.pressure.write, sim.divergence, sim.curl]) t.dispose();
    Object.values(sim.m).forEach((x) => x.dispose());
    sim.quad.geometry.dispose();
  }, [sim]);
  useEffect(() => () => { display.geometry.dispose(); (display.material as THREE.Material).dispose(); }, [display]);

  const st = useRef({
    t: 0, lastEv: new Array(NF).fill(-1), lastDrop: -1, lastBurst: -1, buildAcc: 0, lastSection: -1, track: -1, seed: 1,
    lv: Array.from({ length: NF }, () => new Spring()), mel: new Spring(0.3), bassPhase: 0,
    leadPrev: new THREE.Vector2(0.5, 0.5), ptrPrev: new THREE.Vector2(), ptrDown: false,
  });

  const step = useMemo(() => {
    const blit = (target: THREE.WebGLRenderTarget | null, material: THREE.ShaderMaterial) => {
      sim.quad.material = material;
      gl.setRenderTarget(target);
      gl.render(sim.scene, sim.cam);
    };
    const INK = 0.4; // how much dye a sound pours: enough to read, little enough to keep dark water
    const splat = (x: number, y: number, dx: number, dy: number, color: THREE.Color, k0: number, radius: number) => {
      const k = k0 * INK;
      const u = sim.m.splat.uniforms;
      u.point.value.set(x, y);
      u.radius.value = radius;
      u.uTarget.value = sim.velocity.read.texture;
      u.color.value.set(dx, dy, 0);
      blit(sim.velocity.write, sim.m.splat);
      sim.velocity.swap();
      u.uTarget.value = sim.dye.read.texture;
      u.color.value.set(color.r * k, color.g * k, color.b * k);
      blit(sim.dye.write, sim.m.splat);
      sim.dye.swap();
    };
    const rnd = () => ((st.current.seed = (st.current.seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    /** music → splats, then one fluid step */
    return (dt: number, d: Drives) => {
      const S = st.current;
      dt = Math.min(dt, 1 / 30);
      S.t += dt;
      const fam = d.fam;
      if (d.track !== S.track) { S.track = d.track; S.lastEv = [...fam.events]; S.lastDrop = d.dropEvents; }
      const fired = (k: number) => { const n = fam.events[k] !== S.lastEv[k]; S.lastEv[k] = fam.events[k]; return n; };
      // phrase timescale: smooth levels (springs), slow emitter drift
      const C = conductor, G = C.look.gain;
      for (let k = 0; k < NF; k++) C.grade(BASE_COL[k], COL[k]);
      // how much each part pours follows what the song is built around (song mood)
      const gain = [G.groove, G.groove, G.groove, G.bass, G.space, G.melody].map((g) => Math.min(1.7, g));
      const lv = S.lv.map((s, k) => s.step(fam.level[k], dt, k <= F.hats ? 4 : 1.2) * gain[k]);
      const live = 1 - d.idle;
      // a build draws the ink inward in a tightening spiral; the drop bursts it out from the centre
      S.buildAcc += dt * (1 + 6 * C.build);
      if (C.build > 0.12 && live > 0.5 && S.buildAcc > 0.25) {
        S.buildAcc = 0;
        const n = 6, sp = 260 + 700 * C.build;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + S.t * (0.6 + 2 * C.build);
          const r = 0.42 - 0.22 * C.build;
          splat(0.5 + (r * Math.cos(a)) / sim.aspect, 0.5 + r * Math.sin(a), (-Math.cos(a) * 0.6 - Math.sin(a)) * sp, (-Math.sin(a) * 0.6 + Math.cos(a)) * sp, COL[i % NF], 0.02 * C.build, 0.006);
        }
      }
      if (S.lastBurst < 0) S.lastBurst = d.dropEvents;
      if (d.dropEvents !== S.lastBurst && live > 0.5) {
        S.lastBurst = d.dropEvents;
        const k = Math.min(1.6, G.arc);
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          splat(0.5, 0.5, Math.cos(a) * 1600 * k, Math.sin(a) * 1600 * k, COL[i % NF], 0.08 * k, 0.004);
        }
      }

      // bass: a slow whirlpool low in the tank
      S.bassPhase += dt * (0.25 + 0.5 * lv[F.bass]);
      if (lv[F.bass] > 0.08) {
        const a = S.bassPhase;
        splat(0.5 + 0.22 * Math.cos(a), 0.28 + 0.1 * Math.sin(a), -Math.sin(a) * 180 * lv[F.bass], Math.cos(a) * 120 * lv[F.bass], COL[F.bass], 0.05 * lv[F.bass] * live, 0.012);
      }
      // pads: soft clouds breathing in from both sides
      if (lv[F.pads] > 0.12) {
        const y = 0.5 + 0.25 * Math.sin(S.t * 0.13);
        splat(0.06, y, 140 * lv[F.pads], 30 * Math.sin(S.t * 0.4), COL[F.pads], 0.04 * lv[F.pads] * live, 0.02);
        splat(0.94, 1 - y, -140 * lv[F.pads], -30 * Math.sin(S.t * 0.4), COL[F.pads], 0.04 * lv[F.pads] * live, 0.02);
      }
      // lead: an emitter that wanders across and rises/falls with the melody, drawing a stream
      const m = S.mel.step(fam.melody, dt, 2);
      const lx = 0.5 + 0.3 * Math.sin(S.t * 0.21), ly = 0.2 + 0.65 * Math.min(1, Math.max(0, (m - 0.12) / 0.45));
      const vx = (lx - S.leadPrev.x) / Math.max(dt, 1e-3), vy = (ly - S.leadPrev.y) / Math.max(dt, 1e-3);
      S.leadPrev.set(lx, ly);
      if (lv[F.lead] > 0.1) splat(lx, ly, vx * 900, vy * 900 + 40, COL[F.lead], 0.12 * lv[F.lead] * live, 0.0016 + 0.002 * lv[F.lead]);
      if (fired(F.lead)) splat(lx, ly, 0, 220, COL[F.lead], 0.25 * fam.hit[F.lead], 0.003);
      // kick: a pressure burst from the centre
      if (fired(F.kick)) {
        const k = Math.min(1, 0.3 + fam.hit[F.kick]);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + S.t;
          splat(0.5 + 0.03 * Math.cos(a), 0.5 + 0.03 * Math.sin(a) * sim.aspect, Math.cos(a) * 700 * k, Math.sin(a) * 700 * k, COL[F.kick], 0.05 * k, 0.0025);
        }
      }
      // hits: quick darts
      if (fired(F.hits)) {
        const a = rnd() * Math.PI * 2, k = Math.min(1, 0.3 + fam.hit[F.hits]);
        splat(0.15 + 0.7 * rnd(), 0.15 + 0.7 * rnd(), Math.cos(a) * 900 * k, Math.sin(a) * 900 * k, COL[F.hits], 0.18 * k, 0.0012);
      }
      // hats: flecks
      if (fired(F.hats)) for (let i = 0; i < 3; i++) splat(rnd(), rnd(), (rnd() - 0.5) * 200, (rnd() - 0.5) * 200, COL[F.hats], 0.12, 0.0004);
      fired(F.bass); fired(F.pads);
      // sections and drops: stir the whole tank into a vortex
      const sec = d.map?.sections ?? [];
      let si = -1;
      for (let i = 0; i < sec.length; i++) if (sec[i].start <= d.songTime) si = i;
      const stir = (d.dropEvents !== S.lastDrop) || (S.lastSection >= 0 && si !== S.lastSection);
      S.lastDrop = d.dropEvents;
      S.lastSection = si;
      if (stir && live > 0.5) {
        const dir = si % 2 ? 1 : -1;
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          splat(0.5 + 0.3 * Math.cos(a) / sim.aspect, 0.5 + 0.3 * Math.sin(a), -Math.sin(a) * 900 * dir, Math.cos(a) * 900 * dir, COL[i % NF], 0.05, 0.01);
        }
      }
      // idle: a slow ambient swirl so the tank is never dead
      if (d.idle > 0.5) splat(0.5 + 0.3 * Math.cos(S.t * 0.3), 0.5 + 0.3 * Math.sin(S.t * 0.37), -Math.sin(S.t * 0.3) * 60, Math.cos(S.t * 0.37) * 60, COL[(Math.floor(S.t / 6) % NF)], 0.004, 0.02);

      // ---- fluid step -----------------------------------------------------------------------
      const m_ = sim.m;
      m_.curl.uniforms.uVelocity.value = sim.velocity.read.texture;
      blit(sim.curl, m_.curl);
      m_.vorticity.uniforms.uVelocity.value = sim.velocity.read.texture;
      m_.vorticity.uniforms.uCurl.value = sim.curl.texture;
      m_.vorticity.uniforms.dt.value = dt;
      m_.vorticity.uniforms.curl.value = 14 + 18 * lv[F.hits] + 10 * d.energy;
      blit(sim.velocity.write, m_.vorticity);
      sim.velocity.swap();
      m_.divergence.uniforms.uVelocity.value = sim.velocity.read.texture;
      blit(sim.divergence, m_.divergence);
      m_.scale.uniforms.uTexture.value = sim.pressure.read.texture;
      m_.scale.uniforms.value.value = 0.8;
      blit(sim.pressure.write, m_.scale);
      sim.pressure.swap();
      m_.pressure.uniforms.uDivergence.value = sim.divergence.texture;
      for (let i = 0; i < q.iters; i++) {
        m_.pressure.uniforms.uPressure.value = sim.pressure.read.texture;
        blit(sim.pressure.write, m_.pressure);
        sim.pressure.swap();
      }
      m_.gradient.uniforms.uPressure.value = sim.pressure.read.texture;
      m_.gradient.uniforms.uVelocity.value = sim.velocity.read.texture;
      blit(sim.velocity.write, m_.gradient);
      sim.velocity.swap();
      const adv = m_.advect.uniforms;
      adv.dt.value = dt;
      adv.uVelocity.value = sim.velocity.read.texture;
      adv.uSource.value = sim.velocity.read.texture;
      adv.dissipation.value = 0.25;
      blit(sim.velocity.write, m_.advect);
      sim.velocity.swap();
      adv.uVelocity.value = sim.velocity.read.texture;
      adv.uSource.value = sim.dye.read.texture;
      adv.dissipation.value = 0.9 + 0.8 * d.calm; // ink fades within seconds; breakdowns clear faster
      blit(sim.dye.write, m_.advect);
      sim.dye.swap();
      gl.setRenderTarget(null);
    };
  }, [gl, sim, q.iters]);

  useEffect(() => {
    cameraOwner.world = true;
    perf.particles = sim.sw * sim.sh;
    perf.countLabel = 'Fluid cells';
    perf.worldLabel = 'Fluid grid';
    perf.worldValue = `${sim.sw} × ${sim.sh}`;
    if (debugEnabled) {
      registerSim(null);
      registerStepper((dt, d) => step(dt, d));
      registerExtras({ stats: () => ({ t: st.current.t }) });
    }
    return () => {
      cameraOwner.world = false;
      perf.countLabel = '';
      perf.worldLabel = '';
      registerStepper(null);
      registerExtras(null);
    };
  }, [sim, step]);

  useFrame((_, dt) => {
    const S = st.current;
    if (!useStore.getState().frozen) step(dt, drives());
    // stir with the pointer
    if (pointer.down) {
      const x = pointer.ndc.x * 0.5 + 0.5, y = pointer.ndc.y * 0.5 + 0.5;
      if (S.ptrDown) {
        const dx = (x - S.ptrPrev.x) / Math.max(dt, 1e-3), dy = (y - S.ptrPrev.y) / Math.max(dt, 1e-3);
        const u = sim.m.splat.uniforms;
        u.point.value.set(x, y); u.radius.value = 0.003;
        u.uTarget.value = sim.velocity.read.texture; u.color.value.set(dx * 600, dy * 600, 0);
        sim.quad.material = sim.m.splat;
        gl.setRenderTarget(sim.velocity.write); gl.render(sim.scene, sim.cam); sim.velocity.swap();
        gl.setRenderTarget(null);
      }
      S.ptrPrev.set(x, y);
      S.ptrDown = true;
    } else S.ptrDown = false;
    const u = (display.material as THREE.ShaderMaterial).uniforms;
    (u.uWater.value as THREE.Color).copy(WATER).lerp(conductor.look.bg, conductor.look.amt * 0.8);
    u.uDye.value = sim.dye.read.texture;
    u.dyeTexel.value.set(1 / sim.dye.read.width, 1 / sim.dye.read.height);
  });

  return <primitive object={display} />;
}
