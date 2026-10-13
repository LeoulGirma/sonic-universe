import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CosmicSim } from './CosmicSim';
import {
  fieldFragment, fieldVertex, gasFragment, gasVertex, glowFragment, glowVertex, ringFragment,
  skyFragment, skyVertex, starFragment, starVertex,
} from './shaders';
import { QUALITY_SIDE, useStore } from '../../store/useStore';
import { paletteVec3 } from '../../engine/palettes';
import { drives, perf, pointer } from '../../engine/frameBus';
import { cursorState } from '../../engine/PointerTracker';
import { debugEnabled, registerSim, registerStepper } from '../../engine/debug';

const additive = {
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
} as const;

/**
 * Layer 4 — rendering for World A. Reads the simulation textures; never touches audio.
 */
export function CosmicGenesis() {
  const { gl, size, camera } = useThree();
  const quality = useStore((s) => s.quality);
  const paletteId = useStore((s) => s.palette);
  const side = QUALITY_SIDE[quality];

  // ---- simulation (recreated only when particle count changes) ------------------
  const sim = useMemo(() => new CosmicSim(gl, side, useStore.getState().params), [gl, side]);
  useEffect(() => {
    perf.particles = sim.count;
    perf.worldLabel = '';
    useStore.getState().set({ floatType: sim.floatType });
    if (sim.error) console.error('[CosmicSim]', sim.error);
    if (debugEnabled) {
      registerSim({ gl, w: side, h: side, pos: () => sim.positionTarget, vel: () => sim.velocityTarget });
      const off = { active: false, point: pointer.world, sign: 0, boost: 0 };
      registerStepper((dt, d) => { const st = useStore.getState(); sim.update(dt, d, st.params, st.gravityScale, off); });
    }
    return () => {
      registerSim(null);
      registerStepper(null);
      sim.dispose();
    };
  }, [sim, gl, side]);

  const pal = useMemo(() => paletteVec3(paletteId), [paletteId]);

  // ---- stars ------------------------------------------------------------------------
  const starGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const ref = new Float32Array(sim.count * 2);
    for (let i = 0; i < sim.count; i++) {
      ref[i * 2] = ((i % side) + 0.5) / side;
      ref[i * 2 + 1] = (Math.floor(i / side) + 0.5) / side;
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sim.count * 3), 3));
    g.setAttribute('reference', new THREE.BufferAttribute(ref, 2));
    return g;
  }, [sim, side]);
  useEffect(() => () => starGeo.dispose(), [starGeo]);

  const starMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: starVertex,
        fragmentShader: starFragment,
        ...additive,
        uniforms: {
          tPos: { value: null },
          tVel: { value: null },
          uSize: { value: 0.22 },
          uScale: { value: 400 },
          uTime: { value: 0 },
          uShimmer: { value: 0 },
          uSparkle: { value: 0 },
          uSparkleSeed: { value: 0 },
          uEnergy: { value: 0 },
          uHue: { value: 0.4 },
          uC0: { value: new THREE.Color() },
          uC1: { value: new THREE.Color() },
          uC2: { value: new THREE.Color() },
          uC3: { value: new THREE.Color() },
          uAccent: { value: new THREE.Color() },
          uSimTime: { value: 0 },
          uPatternSpeed: { value: 0.09 },
          uArmBoost: { value: 0.8 },
        },
      }),
    [],
  );

  // ---- gas disk (three thin layers give it volume from oblique angles) -----------
  const gasMats = useMemo(
    () =>
      [0, 1, 2].map(
        (layer) =>
          new THREE.ShaderMaterial({
            vertexShader: gasVertex,
            fragmentShader: gasFragment,
            ...additive,
            side: THREE.DoubleSide,
            uniforms: {
              uTime: { value: 0 },
              uPatternSpeed: { value: sim.patternSpeed },
              uFlow: { value: 0 },
              uEnergy: { value: 0 },
              uGravity: { value: 0 },
              uLayer: { value: layer },
              uC0: { value: new THREE.Color() },
              uC1: { value: new THREE.Color() },
              uC2: { value: new THREE.Color() },
              uC3: { value: new THREE.Color() },
            },
          }),
      ),
    [sim],
  );

  const ringMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: gasVertex,
        fragmentShader: ringFragment,
        ...additive,
        side: THREE.DoubleSide,
        uniforms: { uShock: { value: sim.shockUniform }, uShockC: { value: sim.shockCenter }, uColor: { value: new THREE.Color() } },
      }),
    [sim],
  );

  const skyMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uCalm: { value: 0 }, uN0: { value: new THREE.Color() }, uN1: { value: new THREE.Color() } },
      }),
    [],
  );

  const field = useMemo(() => {
    const n = 5000;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const ph = Math.random() * Math.PI * 2;
      const r = 380 + Math.random() * 220;
      const q = Math.sqrt(1 - u * u);
      pos[i * 3] = r * q * Math.cos(ph);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * q * Math.sin(ph);
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: fieldVertex,
      fragmentShader: fieldFragment,
      ...additive,
      uniforms: { uTime: { value: 0 }, uShimmer: { value: 0 }, uPixelRatio: { value: 1 } },
    });
    return { g, m };
  }, []);

  const glowMats = useMemo(
    () =>
      [0, 1, 2].map(
        () =>
          new THREE.ShaderMaterial({
            vertexShader: glowVertex,
            fragmentShader: glowFragment,
            ...additive,
            uniforms: { uColor: { value: new THREE.Color() }, uIntensity: { value: 1 } },
          }),
      ),
    [],
  );

  useEffect(
    () => () => {
      [starMat, ringMat, skyMat, field.m, ...gasMats, ...glowMats].forEach((m) => m.dispose());
      field.g.dispose();
    },
    [starMat, ringMat, skyMat, field, gasMats, glowMats],
  );

  // palette → uniforms
  useEffect(() => {
    const [c0, c1, c2, c3] = pal.c;
    const u = starMat.uniforms;
    u.uC0.value.copy(c0); u.uC1.value.copy(c1); u.uC2.value.copy(c2); u.uC3.value.copy(c3); u.uAccent.value.copy(pal.accent);
    for (const m of gasMats) {
      m.uniforms.uC0.value.copy(c0); m.uniforms.uC1.value.copy(c1); m.uniforms.uC2.value.copy(c2); m.uniforms.uC3.value.copy(c3);
    }
    ringMat.uniforms.uColor.value.copy(c2).lerp(c3, 0.5);
    skyMat.uniforms.uN0.value.copy(pal.nebula[0]);
    skyMat.uniforms.uN1.value.copy(pal.nebula[1]);
    glowMats[0].uniforms.uColor.value.copy(c3);
    glowMats[1].uniforms.uColor.value.copy(pal.accent);
    glowMats[2].uniforms.uColor.value.copy(c2);
  }, [pal, starMat, gasMats, ringMat, skyMat, glowMats]);

  const glowRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const fieldRef = useRef<THREE.Points>(null);
  const sparkleSeed = useRef({ seed: 0, last: 0, sparkle: 0 });

  useFrame((state, dt) => {
    const d = drives();
    const st = useStore.getState();
    const cs = cursorState();

    if (!st.frozen) {
      sim.update(Math.min(dt, 0.1), d, st.params, st.gravityScale, { ...cs, point: pointer.world });
    }

    const t = state.clock.elapsedTime;
    const pr = gl.getPixelRatio();

    // stars
    const su = starMat.uniforms;
    su.tPos.value = sim.positionTexture;
    su.tVel.value = sim.velocityTexture;
    su.uTime.value = t;
    su.uSimTime.value = sim.time;
    su.uPatternSpeed.value = sim.patternSpeed;
    su.uArmBoost.value = 0.8 - 0.4 * d.release; // drops scatter the arms, briefly
    su.uScale.value = size.height * pr * 0.5;
    su.uSize.value = 0.2 * st.params.starSize * (size.width < 700 ? 1.25 : 1);
    su.uShimmer.value = d.shimmer;
    su.uEnergy.value = Math.min(1.2, d.energy + 0.25 * d.idle);
    su.uHue.value = d.hue;
    const sp = sparkleSeed.current;
    if (d.hatEvents !== sp.last) {
      sp.last = d.hatEvents;
      sp.seed = (sp.seed + 1) % 997;
      sp.sparkle = Math.min(1.2, 0.4 + d.sparkle + d.shimmer * 0.4);
    }
    sp.sparkle *= Math.exp(-dt / 0.12);
    su.uSparkle.value = sp.sparkle;
    su.uSparkleSeed.value = sp.seed;

    // gas
    for (const m of gasMats) {
      m.uniforms.uTime.value = sim.time;
      m.uniforms.uFlow.value = d.flow;
      m.uniforms.uEnergy.value = d.energy + 0.3 * d.idle;
      m.uniforms.uGravity.value = sim.gravityPulse;
    }
    skyMat.uniforms.uTime.value = t;
    skyMat.uniforms.uEnergy.value = d.energy;
    skyMat.uniforms.uCalm.value = d.calm;
    field.m.uniforms.uTime.value = t;
    field.m.uniforms.uShimmer.value = d.shimmer;
    field.m.uniforms.uPixelRatio.value = pr;
    if (fieldRef.current) fieldRef.current.rotation.y += dt * 0.004;

    // glows: core breathes with bass gravity; satellites appear with the drop
    const [core, w1, w2] = glowRefs.map((r) => r.current);
    if (core) {
      core.quaternion.copy(camera.quaternion);
      const sc = 6 * (1 + 0.45 * sim.gravityPulse + 0.25 * d.pulse + 0.6 * d.release);
      core.scale.setScalar(sc);
      glowMats[0].uniforms.uIntensity.value = 0.4 + 0.5 * sim.gravityPulse + 0.35 * d.pulse + 0.15 * d.idle;
    }
    [w1, w2].forEach((m, i) => {
      if (!m) return;
      const w = sim.wells[i];
      m.position.set(w.x, w.y, w.z);
      m.quaternion.copy(camera.quaternion);
      const a = sim.compStrength;
      m.visible = a > 0.01;
      m.scale.setScalar(5 + 7 * a);
      glowMats[i + 1].uniforms.uIntensity.value = a * (0.7 + 0.5 * d.pulse);
    });
  });

  return (
    <group>
      <mesh material={skyMat} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[900, 32, 16]} />
      </mesh>
      <points ref={fieldRef} geometry={field.g} material={field.m} frustumCulled={false} renderOrder={-5} />
      {gasMats.map((m, i) => (
        <mesh key={i} material={m} rotation={[-Math.PI / 2, 0, 0]} position={[0, (i - 1) * 0.7, 0]} renderOrder={-2}>
          <planeGeometry args={[100, 100, 1, 1]} />
        </mesh>
      ))}
      <mesh material={ringMat} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
        <planeGeometry args={[180, 180, 1, 1]} />
      </mesh>
      <points geometry={starGeo} material={starMat} frustumCulled={false} />
      {glowMats.map((m, i) => (
        <mesh key={i} ref={glowRefs[i]} material={m} renderOrder={2}>
          <planeGeometry args={[1, 1]} />
        </mesh>
      ))}
    </group>
  );
}
