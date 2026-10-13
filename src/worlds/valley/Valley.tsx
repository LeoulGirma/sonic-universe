import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FamilyRows, TunnelClock } from '../tunnel/tunnelState';
import { F, FAMILY_INFO } from '../../audio/soundFamilies';
import { useStore } from '../../store/useStore';
import { cameraOwner, drives, perf, pointer } from '../../engine/frameBus';
import { expCoef } from '../../audio/dsp';
import type { Drives } from '../../mapping/drives';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';
import {
  auroraFragment, auroraVertex, dustFragment, dustVertex, groundFragment, groundVertex, monoFragment, monoVertex,
  pathFragment, pathVertex, skyFragment, skyVertex,
} from './valleyShaders';

/**
 * World F — Sound Valley. You travel forward through the song over a wide night valley; each
 * kind of sound builds its own part of the landscape, in the legend colours:
 *   bass  → the ground: ridgelines (one per beat) over hills that the bass raises
 *   kick  → a soft ring spreading across the ground
 *   pads  → aurora curtains in the sky, taller when the pads are louder, tinted by the chord
 *   lead  → a glowing path ahead that rises and falls with the melody
 *   hits  → light monoliths along the sides, taller for louder hits
 *   hats  → dust in the air that glints with the hats
 * With a song map the landscape AHEAD is built from what the song is about to play.
 *
 * Built for comfort after the tunnel gave headaches: wide open space with a horizon, slow travel
 * (2.4 units per beat), a fixed field of view, no camera roll, light on darkness, no full-screen
 * flashes or streaks.
 */
const RPB = 4; // rows per beat (16th notes)
const BEHIND_B = 6;
const AHEAD_B = 72;
const NROWS = (BEHIND_B + AHEAD_B) * RPB + 2;
const SPACING = 2.4;
const X_SEG = 170;
const CURTAINS = 6;
const CURTAIN_EVERY = 16; // beats
const DUST_PER_ROW = 8;

const COL = FAMILY_INFO.map((f) => new THREE.Color(f.color));
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

export function Valley() {
  const { camera, size } = useThree();
  const cam = camera as THREE.PerspectiveCamera;

  const rows = useMemo(() => new FamilyRows(RPB, NROWS), []);
  const tex = useMemo(() => {
    const t = new THREE.DataTexture(rows.data, NROWS, 2, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }, [rows]);
  const clock = useMemo(() => new TunnelClock(), []);
  const lastDrives = useRef<Drives | null>(null);

  const scene = useMemo(() => {
    const defines = { RPB, NROWS };
    const common = () => ({ uFamTex: { value: tex }, uPos: { value: 0 }, uBase: { value: 0 }, uSpacing: { value: SPACING }, uTime: { value: 0 } });
    const horizon = new THREE.Color('#120d2a');

    // ground
    const vRows = (BEHIND_B + AHEAD_B) * RPB + 1;
    const gk = new Float32Array((X_SEG + 1) * vRows * 2);
    for (let r = 0; r < vRows; r++) for (let c = 0; c <= X_SEG; c++) {
      const i = r * (X_SEG + 1) + c;
      // denser columns near the middle, where you look most
      const u = (c / X_SEG) * 2 - 1;
      gk[i * 2] = Math.sign(u) * Math.pow(Math.abs(u), 1.35);
      gk[i * 2 + 1] = r;
    }
    const gIdx: number[] = [];
    for (let r = 0; r < vRows - 1; r++) for (let c = 0; c < X_SEG; c++) {
      const a = r * (X_SEG + 1) + c, b = a + 1, d = a + X_SEG + 1, e = d + 1;
      gIdx.push(a, b, d, b, e, d);
    }
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gk.length / 2 * 3), 3));
    gGeo.setAttribute('gk', new THREE.BufferAttribute(gk, 2));
    gGeo.setIndex(gIdx);
    const ground = new THREE.Mesh(gGeo, new THREE.ShaderMaterial({
      vertexShader: groundVertex, fragmentShader: groundFragment, defines, side: THREE.DoubleSide,
      uniforms: { ...common(), uBassCol: { value: COL[F.bass] }, uKickCol: { value: COL[F.kick] }, uHorizon: { value: horizon }, uKickAge: { value: 9 }, uKickStr: { value: 0 } },
    }));
    ground.frustumCulled = false;

    // sky
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: skyVertex, fragmentShader: skyFragment, depthWrite: false,
      uniforms: { uHorizon: { value: horizon }, uTop: { value: new THREE.Color('#010104') }, uGlow: { value: 0 }, uRes: { value: new THREE.Vector2() } },
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -10;

    // aurora curtains
    const aGeo = new THREE.BufferGeometry();
    {
      // a few rows up the curtain so the vertical shape is smooth
      const nx = 140, ny = 8, ak: number[] = [], idx: number[] = [];
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) ak.push((i / nx) * 2 - 1, j / ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
      aGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ak.length / 2) * 3), 3));
      aGeo.setAttribute('ak', new THREE.BufferAttribute(new Float32Array(ak), 2));
      aGeo.setIndex(idx);
    }
    const curtains = Array.from({ length: CURTAINS }, (_, i) => {
      const m = new THREE.Mesh(aGeo, new THREE.ShaderMaterial({
        vertexShader: auroraVertex, fragmentShader: auroraFragment, defines, side: THREE.DoubleSide, ...additive,
        uniforms: { ...common(), uCb: { value: -1e4 }, uSeed: { value: i * 0.37 }, uPadsCol: { value: COL[F.pads] } },
      }));
      m.frustumCulled = false;
      return m;
    });

    // melody path
    const pk = new Float32Array(vRows * 2 * 2);
    for (let r = 0; r < vRows; r++) { pk.set([-1, r, 1, r], r * 4); }
    const pIdx: number[] = [];
    for (let r = 0; r < vRows - 1; r++) pIdx.push(2 * r, 2 * r + 1, 2 * r + 2, 2 * r + 1, 2 * r + 3, 2 * r + 2);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vRows * 2 * 3), 3));
    pGeo.setAttribute('pk', new THREE.BufferAttribute(pk, 2));
    pGeo.setIndex(pIdx);
    const path = new THREE.Mesh(pGeo, new THREE.ShaderMaterial({
      vertexShader: pathVertex, fragmentShader: pathFragment, defines, side: THREE.DoubleSide, ...additive,
      uniforms: { ...common(), uLeadCol: { value: COL[F.lead] } },
    }));
    path.frustumCulled = false;

    // monoliths
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mGeo = new THREE.InstancedBufferGeometry();
    mGeo.index = box.index;
    mGeo.setAttribute('position', box.getAttribute('position'));
    const inst = new Float32Array(vRows * 2 * 2);
    for (let r = 0; r < vRows; r++) inst.set([r, -1, r, 1], r * 4);
    mGeo.setAttribute('inst', new THREE.InstancedBufferAttribute(inst, 2));
    mGeo.instanceCount = vRows * 2;
    const monos = new THREE.Mesh(mGeo, new THREE.ShaderMaterial({
      vertexShader: monoVertex, fragmentShader: monoFragment, defines, ...additive,
      uniforms: { ...common(), uHitsCol: { value: COL[F.hits] } },
    }));
    monos.frustumCulled = false;

    // dust
    const dk = new Float32Array(vRows * DUST_PER_ROW * 2);
    for (let r = 0; r < vRows; r++) for (let k = 0; k < DUST_PER_ROW; k++) dk.set([r, k], (r * DUST_PER_ROW + k) * 2);
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((dk.length / 2) * 3), 3));
    dGeo.setAttribute('dk', new THREE.BufferAttribute(dk, 2));
    const dust = new THREE.Points(dGeo, new THREE.ShaderMaterial({
      vertexShader: dustVertex, fragmentShader: dustFragment, defines, ...additive,
      uniforms: { ...common(), uHatsCol: { value: COL[F.hats] } },
    }));
    dust.frustumCulled = false;

    const group = new THREE.Group();
    group.add(sky, ground, ...curtains, monos, path, dust);
    const mats = [ground, ...curtains, path, monos, dust].map((m) => m.material as THREE.ShaderMaterial);
    return { group, ground, sky, curtains, path, monos, dust, mats, vertsTotal: gk.length / 2 };
  }, [tex]);

  useEffect(() => () => {
    scene.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    tex.dispose();
  }, [scene, tex]);

  const s = useRef({ t: 0, look: new THREE.Vector2(), kickAge: 9, kickStr: 0, lastKick: 0, fov: 62 });

  useEffect(() => {
    cameraOwner.world = true;
    perf.particles = scene.vertsTotal;
    perf.countLabel = 'Ground vertices';
    perf.worldLabel = 'Travel';
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
  }, [scene, clock]);

  useFrame((_, dt) => {
    const d = drives();
    const st = useStore.getState();
    const S = s.current;
    if (!st.frozen) {
      clock.update(dt, d);
      lastDrives.current = d;
    }
    S.t += dt;
    const dd = lastDrives.current ?? d;
    const base = Math.floor(clock.pos) - BEHIND_B;
    rows.fill(clock, dd, base);
    tex.needsUpdate = true;
    perf.worldValue = `${clock.mode === 'map' ? 'Song map' : clock.mode === 'live' ? 'Live' : 'Drifting'}, beat ${Math.floor(clock.pos)}`;

    // kick ring
    if (d.fam.events[F.kick] !== S.lastKick) {
      S.lastKick = d.fam.events[F.kick];
      S.kickAge = 0;
      S.kickStr = Math.min(1, 0.35 + d.fam.hit[F.kick]);
    }
    S.kickAge += dt;

    for (const m of scene.mats) {
      const u = m.uniforms;
      u.uPos.value = clock.pos;
      u.uBase.value = base;
      u.uTime.value = S.t;
    }
    const gu = (scene.ground.material as THREE.ShaderMaterial).uniforms;
    gu.uKickAge.value = S.kickAge;
    gu.uKickStr.value = S.kickStr;
    (scene.sky.material as THREE.ShaderMaterial).uniforms.uGlow.value = 0.35 * d.energy + 0.25 * d.fam.level[F.pads];
    // curtains on absolute beats, every CURTAIN_EVERY beats, recycled as you pass them
    const first = Math.ceil((clock.pos - 6) / CURTAIN_EVERY) * CURTAIN_EVERY;
    scene.curtains.forEach((c, i) => {
      const cb = first + i * CURTAIN_EVERY;
      const u = (c.material as THREE.ShaderMaterial).uniforms;
      u.uCb.value = cb;
      u.uSeed.value = ((cb / CURTAIN_EVERY) * 0.618) % 1;
    });

    // camera: fixed height and field of view, no roll; a slow drift, and the pointer looks around
    const lookT = pointer.over && !st.cinematic ? pointer.ndc : new THREE.Vector2(Math.sin(S.t * 0.05) * 0.12, Math.sin(S.t * 0.04) * 0.05);
    S.look.lerp(lookT, expCoef(dt, 0.6));
    const sway = Math.sin(S.t * 0.045) * 2.2;
    cam.position.set(sway, 7.2 + Math.sin(S.t * 0.06) * 0.4, 0);
    cam.up.set(0, 1, 0);
    cam.lookAt(sway * 0.6 + S.look.x * 40, 3 + S.look.y * 18, -70);
    const fov = size.width < size.height ? 74 : 62;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  });

  return <primitive object={scene.group} />;
}
