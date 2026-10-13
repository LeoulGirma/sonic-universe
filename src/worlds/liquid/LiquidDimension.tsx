import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LiquidSim } from './liquidSim';
import { liquidFragment, liquidVertex } from './liquidShaders';
import { LIQUID_Q, useStore } from '../../store/useStore';
import { paletteVec3 } from '../../engine/palettes';
import { drives, perf, pointer } from '../../engine/frameBus';
import { cursorState } from '../../engine/PointerTracker';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';
import { Envelope } from '../../audio/dsp';

/**
 * Layer 4 — rendering for World B. The CPU blob simulation feeds one full-screen raymarching
 * shader; there is no mesh geometry at all.
 */
export function LiquidDimension() {
  const { camera } = useThree();
  const quality = useStore((s) => s.quality);
  const paletteId = useStore((s) => s.palette);
  const q = LIQUID_Q[quality];
  const sim = useMemo(() => new LiquidSim(q.blobs), [q.blobs]);

  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: liquidVertex,
        fragmentShader: liquidFragment,
        defines: { MAXB: q.blobs, STEPS: q.steps },
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uInvViewProj: { value: new THREE.Matrix4() },
          uCam: { value: new THREE.Vector3() },
          uBlobs: { value: Array.from({ length: q.blobs }, () => new THREE.Vector4()) },
          uBand: { value: new Float32Array(q.blobs) },
          uCount: { value: q.blobs },
          uWaves: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
          uWaveAmp: { value: new Float32Array(4) },
          uBound: { value: new THREE.Vector4() },
          uTime: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uHigh: { value: 0 },
          uRipple: { value: 1 },
          uIri: { value: 1 },
          uEnergy: { value: 0 },
          uDeep: { value: new THREE.Color() },
          uTint: { value: new THREE.Color() },
          uBright: { value: new THREE.Color() },
          uAccent: { value: new THREE.Color() },
        },
      }),
    [q.blobs, q.steps],
  );
  const geo = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  useEffect(() => () => { mat.dispose(); geo.dispose(); }, [mat, geo]);

  useEffect(() => {
    const pal = paletteVec3(paletteId);
    const u = mat.uniforms;
    u.uDeep.value.copy(pal.c[0]);
    u.uTint.value.copy(pal.c[1]).lerp(pal.c[2], 0.5);
    u.uBright.value.copy(pal.c[3]);
    u.uAccent.value.copy(pal.accent);
  }, [paletteId, mat]);

  useEffect(() => {
    perf.particles = sim.n;
    perf.countLabel = 'Liquid blobs';
    perf.worldLabel = 'Bodies';
    useStore.getState().set({ floatType: 'float' });
    if (debugEnabled) {
      registerSim(null);
      registerStepper((dt, d) => sim.update(dt, d, useStore.getState().liquidParams));
      registerExtras({ stats: () => sim.stats() });
    }
    return () => {
      perf.countLabel = '';
      perf.worldLabel = '';
      registerStepper(null);
      registerExtras(null);
    };
  }, [sim]);

  const env = useMemo(() => ({ bass: new Envelope(0.05, 0.4), mid: new Envelope(0.08, 0.5), high: new Envelope(0.02, 0.2), m: new THREE.Matrix4() }), []);

  useFrame((_, dt) => {
    const d = drives();
    const st = useStore.getState();
    const lp = st.liquidParams;
    if (!st.frozen) {
      const c = cursorState();
      sim.update(Math.min(dt, 0.1), d, lp, { ...c, x: pointer.world.x, y: pointer.world.y, z: pointer.world.z });
    }
    perf.worldValue = String(sim.bodies());

    const u = mat.uniforms;
    camera.updateMatrixWorld();
    env.m.multiplyMatrices(camera.matrixWorld, (camera as THREE.PerspectiveCamera).projectionMatrixInverse);
    u.uInvViewProj.value.copy(env.m);
    u.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    const blobs = u.uBlobs.value as THREE.Vector4[];
    const band = u.uBand.value as Float32Array;
    for (let i = 0; i < sim.n; i++) {
      blobs[i].set(sim.p[i * 3], sim.p[i * 3 + 1], sim.p[i * 3 + 2], sim.r[i]);
      band[i] = sim.band[i];
    }
    const waves = u.uWaves.value as THREE.Vector4[];
    const amps = u.uWaveAmp.value as Float32Array;
    for (let i = 0; i < 4; i++) {
      const w = sim.waves[i];
      if (w) { waves[i].set(w.x, w.y, w.z, w.age); amps[i] = w.amp * lp.ripple; } else amps[i] = 0;
    }
    const [cx, cy, cz] = sim.centroid;
    u.uBound.value.set(cx, cy, cz, sim.extent + 4);
    u.uTime.value += dt * (1 - 0.6 * d.calm) * (0.6 + 0.6 * d.energy + 0.3 * d.idle);
    u.uBass.value = env.bass.step(d.gravity, dt);
    u.uMid.value = env.mid.step(d.flow, dt);
    u.uHigh.value = env.high.step(Math.min(1.5, d.shimmer + d.sparkle), dt);
    u.uRipple.value = lp.ripple;
    u.uIri.value = lp.iridescence;
    u.uEnergy.value = d.energy + 0.3 * d.idle;
  });

  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={-100} />;
}
