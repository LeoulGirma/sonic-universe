import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { AHEAD, BEHIND, FAM_ROWS, FamilyRows, RINGS, ROWS_PER_BEAT, TunnelClock, createRingParams } from './tunnelState';
import { FAMILY_INFO } from '../../audio/soundFamilies';
export { DEFAULT_TUNNEL } from './tunnelState';
export type { TunnelParams } from './tunnelState';
import { tunnelFragment, tunnelVertex } from './tunnelShaders';
import { TUNNEL_Q, useStore } from '../../store/useStore';
import { paletteVec3 } from '../../engine/palettes';
import { cameraOwner, drives, perf, pointer } from '../../engine/frameBus';
import { keys } from '../../engine/CameraRig';
import { Envelope, expCoef } from '../../audio/dsp';
import type { Drives } from '../../mapping/drives';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';


/**
 * World E. One procedural tube; the camera rides the beat clock, so it crosses a ring on every
 * beat. This world owns the camera while it is active (orbiting makes no sense inside a tunnel):
 * the pointer looks around, arrow keys / WASD steer within the tunnel.
 */
export function Tunnel() {
  const { camera } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const quality = useStore((s) => s.quality);
  const paletteId = useStore((s) => s.palette);
  const segs = TUNNEL_Q[quality].segments;

  const geo = useMemo(() => {
    const rows = (BEHIND + AHEAD) * ROWS_PER_BEAT + 1;
    const cols = segs + 1;
    const tk = new Float32Array(rows * cols * 2);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      tk[i * 2] = c / segs;
      tk[i * 2 + 1] = r;
    }
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < segs; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3));
    g.setAttribute('tk', new THREE.BufferAttribute(tk, 2));
    g.setIndex(idx);
    return g;
  }, [segs]);

  const rings = useMemo(() => createRingParams(), []);
  const famRows = useMemo(() => new FamilyRows(), []);
  const famTex = useMemo(() => {
    const t = new THREE.DataTexture(famRows.data, FAM_ROWS, 2, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }, [famRows]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: tunnelVertex,
        fragmentShader: tunnelFragment,
        defines: { RINGS, ROWS_PER_BEAT, FAM_ROWS },
        side: THREE.DoubleSide,
        uniforms: {
          uPos: { value: 0 }, uBase: { value: 0 },
          uWide: { value: rings.wide }, uNarrow: { value: rings.narrow }, uGate: { value: rings.gate },
          uStyle: { value: rings.style }, uCurve: { value: rings.curve },
          uSpacing: { value: 9 }, uRadius: { value: 7 }, uTwist: { value: 0 }, uTwistPhase: { value: 0 },
          uBass: { value: 0 }, uMid: { value: 0 }, uHigh: { value: 0 }, uTime: { value: 0 }, uCurveAmp: { value: 1 },
          uFlash: { value: 0 }, uEnergy: { value: 0 }, uRelease: { value: 0 },
          uFamTex: { value: famTex }, uFam: { value: FAMILY_INFO.map((f) => new THREE.Color(f.color)) }, uFamDepth: { value: 1 }, uFamGlow: { value: 1 },
          uDeep: { value: new THREE.Color() }, uLine: { value: new THREE.Color() }, uBright: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() },
        },
      }),
    [rings, famTex],
  );
  useEffect(() => () => { geo.dispose(); mat.dispose(); famTex.dispose(); }, [geo, mat, famTex]);

  useEffect(() => {
    const pal = paletteVec3(paletteId);
    const u = mat.uniforms;
    u.uDeep.value.copy(pal.c[1]);
    u.uLine.value.copy(pal.c[2]);
    u.uBright.value.copy(pal.c[3]);
    u.uAccent.value.copy(pal.accent);
  }, [paletteId, mat]);

  const bgGeo = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  const bgMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }',
        fragmentShader: 'uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }',
        uniforms: { uColor: { value: new THREE.Color() } },
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => { bgGeo.dispose(); bgMat.dispose(); }, [bgGeo, bgMat]);

  const clock = useMemo(() => new TunnelClock(), []);
  // the drives the clock last saw (live frames, or the offline verification harness)
  const lastDrives = useRef<Drives | null>(null);
  const s = useRef({
    steer: new THREE.Vector2(), look: new THREE.Vector2(), twistPhase: 0, flash: 0, lastKick: 0, fov: 72, t: 0,
    bass: new Envelope(0.04, 0.35), mid: new Envelope(0.1, 0.5), high: new Envelope(0.02, 0.2), tension: new Envelope(0.3, 0.3),
  });

  useEffect(() => {
    cameraOwner.world = true;
    perf.particles = geo.getAttribute('tk').count;
    perf.countLabel = 'Tunnel vertices';
    perf.worldLabel = 'Beat clock';
    if (debugEnabled) {
      registerSim(null);
      registerStepper((dt, d) => { clock.update(dt, d); lastDrives.current = { ...d }; });
      registerExtras({ stats: () => ({ pos: clock.pos }), info: () => ({ mode: clock.mode }) });
    }
    return () => {
      cameraOwner.world = false;
      perf.countLabel = '';
      perf.worldLabel = '';
      registerStepper(null);
      registerExtras(null);
    };
  }, [geo, clock]);

  useFrame((_, dt) => {
    const d = drives();
    const st = useStore.getState();
    const tp = st.tunnelParams;
    const S = s.current;
    if (!st.frozen) {
      clock.update(dt, d);
      lastDrives.current = d;
      S.t += dt;
      S.twistPhase += dt * tp.twist * 0.8 * d.flow;
    }
    clock.rings(lastDrives.current ?? d, rings);
    famRows.fill(clock, lastDrives.current ?? d);
    famTex.needsUpdate = true;
    perf.worldValue = `${clock.mode === 'map' ? 'Song map' : clock.mode === 'live' ? 'Live' : 'Drifting'}, ring ${Math.floor(clock.pos)}`;

    if (d.kickEvents !== S.lastKick) {
      S.lastKick = d.kickEvents;
      S.flash = Math.min(1.4, 0.4 + d.lastKick);
    }
    S.flash *= Math.exp(-dt / 0.12);

    const u = mat.uniforms;
    u.uPos.value = clock.pos;
    u.uBase.value = clock.base();
    u.uSpacing.value = tp.spacing;
    u.uRadius.value = tp.radius;
    u.uTwist.value = tp.twist * (0.15 + 0.85 * d.flow) * (1 - 0.7 * d.calm);
    u.uTwistPhase.value = S.twistPhase;
    u.uCurveAmp.value = tp.curve;
    u.uBass.value = S.bass.step(d.gravity, dt);
    u.uMid.value = S.mid.step(d.flow, dt);
    u.uHigh.value = S.high.step(Math.min(1.5, d.shimmer + d.sparkle), dt);
    u.uTime.value = S.t;
    u.uFlash.value = S.flash;
    u.uEnergy.value = d.energy + 0.3 * d.idle;
    u.uRelease.value = d.release;
    const far = (1 - Math.exp(-AHEAD / 16)) * Math.exp(-AHEAD / 60) * (0.35 + 0.4 * (d.energy + 0.3 * d.idle));
    (bgMat.uniforms.uColor.value as THREE.Color).copy(u.uLine.value).lerp(u.uBright.value, 0.6).multiplyScalar(far);

    // --- camera: ride the centre line; steer and look ----------------------------------
    const steerMax = tp.radius * 0.55;
    let sx = 0, sy = 0;
    if (keys.has('a') || keys.has('arrowleft')) sx -= 1;
    if (keys.has('d') || keys.has('arrowright')) sx += 1;
    if (keys.has('w') || keys.has('arrowup') || keys.has('e')) sy += 1;
    if (keys.has('s') || keys.has('arrowdown') || keys.has('q')) sy -= 1;
    const target = new THREE.Vector2();
    if (st.cinematic && sx === 0 && sy === 0) {
      target.set(Math.sin(S.t * 0.23) * 0.6, Math.sin(S.t * 0.31 + 1) * 0.4).multiplyScalar(steerMax);
    } else target.set(S.steer.x + sx * dt * 8, S.steer.y + sy * dt * 8);
    if (target.length() > steerMax) target.setLength(steerMax);
    S.steer.lerp(target, st.cinematic ? expCoef(dt, 1.2) : 1);
    const lookTarget = pointer.over && !st.cinematic ? pointer.ndc : new THREE.Vector2(Math.sin(S.t * 0.17) * 0.15, Math.sin(S.t * 0.13) * 0.1);
    S.look.lerp(lookTarget, expCoef(dt, 0.35));
    cam.position.set(S.steer.x, S.steer.y, 0);
    cam.up.set(Math.sin(S.twistPhase * 0.3) * 0.25, 1, 0).normalize();
    cam.lookAt(S.look.x * 22 + S.steer.x * 0.5, S.look.y * 14 + S.steer.y * 0.5, -40);

    const tension = S.tension.step(d.tension, dt);
    const fov = 70 + 16 * tension + 14 * d.release - 3 * d.pulse - 6 * d.calm;
    S.fov += (fov - S.fov) * expCoef(dt, d.pulse > 0.4 ? 0.06 : 0.3);
    if (Math.abs(cam.fov - S.fov) > 0.01) {
      cam.fov = S.fov;
      cam.updateProjectionMatrix();
    }
  });

  return (
    <>
      {/* backdrop in the far-glow colour, so the tube's open end never shows as a black hole */}
      <mesh geometry={bgGeo} material={bgMat} frustumCulled={false} renderOrder={-10} />
      <mesh geometry={geo} material={mat} frustumCulled={false} />
    </>
  );
}
