import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LifeSim } from './LifeSim';
import { pointFragment, pointVertex } from './lifeShaders';
import { S } from './lifeRules';
import { LIFE_DIMS, useStore } from '../../store/useStore';
import { speciesColors } from '../../engine/palettes';
import { drives, perf, pointer } from '../../engine/frameBus';
import { cursorState } from '../../engine/PointerTracker';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';

/** Spark species (0) is tiny; the rest grow so bodies read as solid forms. */
const SIZES = [0.3, 0.62, 0.7, 0.58, 0.74, 0.66];

/**
 * Layer 4 — rendering for World D. One draw call: points that read their position and
 * velocity straight from the simulation textures.
 */
export function ParticleLife() {
  const { gl, size } = useThree();
  const quality = useStore((s) => s.quality);
  const paletteId = useStore((s) => s.palette);
  const dims = LIFE_DIMS[quality];

  const sim = useMemo(() => new LifeSim(gl, dims.w, dims.h, dims.cap, useStore.getState().lifeParams), [gl, dims.w, dims.h, dims.cap]);

  useEffect(() => {
    perf.particles = sim.count;
    perf.worldLabel = 'Ecosystem';
    useStore.getState().set({ floatType: 'float' });
    if (sim.error) useStore.getState().set({ floatType: 'half' });
    if (debugEnabled) {
      registerSim({ gl, w: sim.w, h: sim.h, pos: () => sim.positionTarget, vel: () => sim.velocityTarget });
      const off = { active: false, point: pointer.world, sign: 0, boost: 0 };
      registerStepper((dt, d) => {
        const st = useStore.getState();
        sim.update(dt, d, st.lifeParams, st.gravityScale, off);
      });
      registerExtras({
        stats: () => sim.metrics(),
        selfTest: () => ({ ...sim.selfTest(useStore.getState().lifeParams), estimator: sim.estimatorTest(useStore.getState().lifeParams) }),
        info: () => ({ ecosystem: sim.ecosystem, songEcosystem: sim.isSongEcosystem ? 1 : 0, generation: sim.generation }),
      });
    }
    return () => {
      perf.worldLabel = '';
      registerSim(null);
      registerStepper(null);
      registerExtras(null);
      sim.dispose();
    };
  }, [sim, gl]);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const ref = new Float32Array(sim.count * 2);
    for (let i = 0; i < sim.count; i++) {
      ref[i * 2] = i % sim.w;
      ref[i * 2 + 1] = Math.floor(i / sim.w);
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sim.count * 3), 3));
    g.setAttribute('ref', new THREE.BufferAttribute(ref, 2));
    return g;
  }, [sim]);

  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: pointVertex,
        fragmentShader: pointFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          tPos: { value: null },
          tVel: { value: null },
          uCol: { value: Array.from({ length: S }, () => new THREE.Color()) },
          uSizes: { value: [...SIZES] },
          uScale: { value: 400 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
        },
      }),
    [],
  );
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  useEffect(() => {
    const cols = speciesColors(paletteId);
    (mat.uniforms.uCol.value as THREE.Color[]).forEach((c, i) => c.copy(cols[i]));
  }, [paletteId, mat]);

  useFrame((_, dt) => {
    const d = drives();
    const st = useStore.getState();
    if (!st.frozen && !sim.error) {
      sim.update(Math.min(dt, 0.1), d, st.lifeParams, st.gravityScale, { ...cursorState(), point: pointer.world });
    }
    perf.worldValue = sim.isSongEcosystem ? `${sim.ecosystem}${sim.generation ? `, generation ${sim.generation + 1}` : ''}` : `${sim.ecosystem} (default)`;
    const u = mat.uniforms;
    u.tPos.value = sim.positionTarget.texture;
    u.tVel.value = sim.velocityTarget.texture;
    u.uScale.value = size.height * gl.getPixelRatio() * 0.5;
    const k = st.lifeParams.size * sim.scale * (size.width < 700 ? 1.2 : 1);
    (u.uSizes.value as number[]).forEach((_, i, a) => (a[i] = SIZES[i] * k));
    u.uEnergy.value = Math.min(1.2, d.energy + 0.3 * d.idle);
    u.uPulse.value = sim.pulseLevel;
  });

  return <points geometry={geo} material={mat} frustumCulled={false} />;
}
