import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FamilyRows, TunnelClock, beatTime } from '../tunnel/tunnelState';
import { F, FAMILY_INFO } from '../../audio/soundFamilies';
import { SPEC_BANDS, specFrame } from '../../audio/spectrum';
import { useStore } from '../../store/useStore';
import { cameraOwner, drives, perf, pointer } from '../../engine/frameBus';
import { Envelope, expCoef } from '../../audio/dsp';
import type { Drives } from '../../mapping/drives';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';
import {
  auroraFragment, auroraVertex, dustFragment, dustVertex, groundFragment, groundVertex, monoFragment, monoVertex,
  pathFragment, pathVertex, skyFragment, skyVertex,
} from './valleyShaders';

/**
 * World F — Sound Valley. You travel through the song over a wide night valley whose ground IS
 * the music: every 16th note is a ridgeline shaped like the spectrum at that moment (bass by the
 * path, highs far out). The music's present is a NOW LINE a few beats ahead of you: ridges flare,
 * hit monoliths flash and the melody orb bounces exactly as each sound plays, with the song still
 * to come laid out beyond. Kicks roll a wave across the ground; pads hang aurora in the sky; the
 * melody leaves a glowing path; hats glint in the air. The route winds, and the camera follows it.
 *
 * Built for comfort (the tunnel gave headaches): open space with a horizon, slow travel, a fixed
 * field of view, no roll, light on darkness, no full-screen flashes.
 */
const RPB = 4; // rows per beat (16th notes)
const BEHIND_B = 2; // rows kept behind the camera
const AHEAD_B = 74; // visible ahead of the camera
const NROWS = (BEHIND_B + AHEAD_B) * RPB + 2;
const SPACING = 2.4;
const X_SEG = 180;
const CURTAINS = 6;
const CURTAIN_EVERY = 16;
const DUST_PER_ROW = 6;
const NOW_MAP = 5.5; // beats between the camera and the now line, with a song map
const NOW_LIVE = 50; // live: the land is made near the horizon and flows toward you

const COL = FAMILY_INFO.map((f) => new THREE.Color(f.color));
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
const pathX = (b: number) => 9 * Math.sin(b * 0.045) + 4 * Math.sin(b * 0.017 + 1);
const melodyY = (m: number) => 0.6 + 5.2 * Math.min(1, Math.max(0, (m - 0.12) / 0.45));

/** spectrum per row: from the song map at each row's own time, or recorded live at the now line */
class SpecRows {
  readonly data = new Float32Array(NROWS * SPEC_BANDS);
  private hist = new Map<number, Float32Array>();
  fill(clock: TunnelClock, d: Drives, base: number) {
    const out = this.data;
    const map = d.map;
    const sp = map?.spectrum;
    if (clock.mode === 'map' && map && sp && map.beats.length > 1) {
      for (let r = 0; r < NROWS; r++) {
        const bi = base + r / RPB - clock.drift;
        const t0 = beatTime(map.beats, bi), t1 = beatTime(map.beats, bi + 1 / RPB);
        const j0 = specFrame(sp, t0), j1 = Math.max(j0 + 1, specFrame(sp, t1));
        const off = t0 > map.duration ? 0 : 1;
        for (let k = 0; k < SPEC_BANDS; k++) {
          let v = 0;
          for (let j = j0; j < j1; j++) v = Math.max(v, sp.data[j * SPEC_BANDS + k]);
          out[k * NROWS + r] = (off * v) / 255;
        }
      }
      return;
    }
    const nowRow = Math.floor(clock.pos * RPB);
    let rec = this.hist.get(nowRow);
    if (!rec) { rec = new Float32Array(SPEC_BANDS); this.hist.set(nowRow, rec); }
    for (let k = 0; k < SPEC_BANDS; k++) rec[k] = Math.max(rec[k], d.spec[k]);
    for (const key of this.hist.keys()) if (key < base * RPB - 4) this.hist.delete(key);
    for (let r = 0; r < NROWS; r++) {
      const h = this.hist.get(base * RPB + r);
      for (let k = 0; k < SPEC_BANDS; k++) out[k * NROWS + r] = h ? h[k] : 0;
    }
  }
}

export function Valley() {
  const { camera, size } = useThree();
  const cam = camera as THREE.PerspectiveCamera;

  const rows = useMemo(() => new FamilyRows(RPB, NROWS, true), []);
  const spec = useMemo(() => new SpecRows(), []);
  const tex = useMemo(() => {
    const t = new THREE.DataTexture(rows.data, NROWS, 2, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }, [rows]);
  const specTex = useMemo(() => {
    const t = new THREE.DataTexture(spec.data, NROWS, SPEC_BANDS, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }, [spec]);
  const clock = useMemo(() => new TunnelClock(), []);
  const lastDrives = useRef<Drives | null>(null);

  const scene = useMemo(() => {
    const defines = { RPB, NROWS };
    const common = () => ({
      uFamTex: { value: tex }, uSpecTex: { value: specTex }, uPos: { value: 0 }, uCam: { value: 0 }, uBase: { value: 0 },
      uSpacing: { value: SPACING }, uTime: { value: 0 },
    });
    const horizon = new THREE.Color('#120d2a');
    const vRows = (BEHIND_B + AHEAD_B) * RPB + 1;

    // ground
    const gk = new Float32Array((X_SEG + 1) * vRows * 2);
    for (let r = 0; r < vRows; r++) for (let c = 0; c <= X_SEG; c++) {
      const i = r * (X_SEG + 1) + c;
      const u = (c / X_SEG) * 2 - 1;
      gk[i * 2] = Math.sign(u) * Math.pow(Math.abs(u), 1.3); // denser near the path
      gk[i * 2 + 1] = r;
    }
    const gIdx: number[] = [];
    for (let r = 0; r < vRows - 1; r++) for (let c = 0; c < X_SEG; c++) {
      const a = r * (X_SEG + 1) + c, b = a + 1, d = a + X_SEG + 1, e = d + 1;
      gIdx.push(a, b, d, b, e, d);
    }
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((gk.length / 2) * 3), 3));
    gGeo.setAttribute('gk', new THREE.BufferAttribute(gk, 2));
    gGeo.setIndex(gIdx);
    const ground = new THREE.Mesh(gGeo, new THREE.ShaderMaterial({
      vertexShader: groundVertex, fragmentShader: groundFragment, defines, side: THREE.DoubleSide,
      uniforms: {
        ...common(), uBassCol: { value: COL[F.bass] }, uPadsCol: { value: COL[F.pads] }, uHatsCol: { value: COL[F.hats] },
        uKickCol: { value: COL[F.kick] }, uHorizon: { value: horizon }, uKickAge: { value: 9 }, uKickStr: { value: 0 }, uNowZ: { value: 0 },
      },
    }));
    ground.frustumCulled = false;

    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: skyVertex, fragmentShader: skyFragment, depthWrite: false,
      uniforms: { uHorizon: { value: horizon }, uTop: { value: new THREE.Color('#010104') }, uGlow: { value: 0 } },
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -10;

    // aurora curtains
    const aGeo = new THREE.BufferGeometry();
    {
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

    // melody path + the orb that rides the now line
    const pk = new Float32Array(vRows * 4);
    for (let r = 0; r < vRows; r++) pk.set([-1, r, 1, r], r * 4);
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
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14), new THREE.MeshBasicMaterial({ color: COL[F.lead].clone(), ...additive }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 14), new THREE.MeshBasicMaterial({ color: COL[F.lead].clone(), opacity: 0.25, ...additive }));
    orb.add(halo);

    // monoliths
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mGeo = new THREE.InstancedBufferGeometry();
    mGeo.index = box.index;
    mGeo.setAttribute('position', box.getAttribute('position'));
    const inst = new Float32Array(vRows * 4);
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
    group.add(sky, ground, ...curtains, monos, path, dust, orb);
    const mats = [ground, ...curtains, path, monos, dust].map((m) => m.material as THREE.ShaderMaterial);
    return { group, ground, sky, curtains, path, orb, halo, monos, dust, mats, vertsTotal: gk.length / 2 };
  }, [tex, specTex]);

  useEffect(() => () => {
    scene.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    tex.dispose();
    specTex.dispose();
  }, [scene, tex, specTex]);

  const s = useRef({
    t: 0, look: new THREE.Vector3(0, 2, -40), camX: 0, kickAge: 9, kickStr: 0, lastKick: -1, nowB: NOW_MAP, orbY: 2,
    lift: new Envelope(2.5, 4), leadHit: 0,
  });

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

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const d = drives();
    const st = useStore.getState();
    const S = s.current;
    if (!st.frozen) {
      clock.update(dt, d);
      lastDrives.current = d;
    }
    S.t += dt;
    const dd = lastDrives.current ?? d;
    // with a song map the now line sits just ahead; live it sits near the horizon
    S.nowB += ((clock.mode === 'map' ? NOW_MAP : NOW_LIVE) - S.nowB) * expCoef(dt, 1.5);
    const camB = clock.pos - S.nowB;
    const base = Math.floor(camB) - BEHIND_B;
    rows.fill(clock, dd, base);
    spec.fill(clock, dd, base);
    tex.needsUpdate = true;
    specTex.needsUpdate = true;
    perf.worldValue = `${clock.mode === 'map' ? 'Song map' : clock.mode === 'live' ? 'Live' : 'Drifting'}, beat ${Math.floor(clock.pos)}`;

    if (S.lastKick < 0) S.lastKick = d.fam.events[F.kick];
    if (d.fam.events[F.kick] !== S.lastKick) {
      S.lastKick = d.fam.events[F.kick];
      S.kickAge = 0;
      S.kickStr = Math.min(1, 0.35 + d.fam.hit[F.kick]);
    }
    S.kickAge += dt;

    for (const m of scene.mats) {
      const u = m.uniforms;
      u.uPos.value = clock.pos;
      u.uCam.value = camB;
      u.uBase.value = base;
      u.uTime.value = S.t;
    }
    const gu = (scene.ground.material as THREE.ShaderMaterial).uniforms;
    gu.uKickAge.value = S.kickAge;
    gu.uKickStr.value = S.kickStr;
    gu.uNowZ.value = -S.nowB * SPACING;
    (scene.sky.material as THREE.ShaderMaterial).uniforms.uGlow.value = 0.3 * d.energy + 0.25 * d.fam.level[F.pads];
    const first = Math.ceil((camB - 2) / CURTAIN_EVERY) * CURTAIN_EVERY;
    scene.curtains.forEach((c, i) => {
      const cb = first + i * CURTAIN_EVERY;
      const u = (c.material as THREE.ShaderMaterial).uniforms;
      u.uCb.value = cb;
      u.uSeed.value = ((cb / CURTAIN_EVERY) * 0.618) % 1;
    });

    // the melody orb rides the now line at the melody's pitch, flaring on each new note
    const lead = d.fam.level[F.lead];
    S.leadHit = Math.max(S.leadHit * Math.exp(-dt / 0.18), d.fam.hit[F.lead]);
    S.orbY += (melodyY(d.fam.melody) + 0.15 - S.orbY) * expCoef(dt, 0.06);
    scene.orb.position.set(pathX(clock.pos), S.orbY, -S.nowB * SPACING);
    scene.orb.scale.setScalar(0.5 + 1.1 * lead + 0.9 * S.leadHit);
    (scene.orb.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.15 + 1.2 * lead);
    (scene.halo.material as THREE.MeshBasicMaterial).opacity = 0.08 + 0.3 * lead + 0.3 * S.leadHit;

    // camera: follows the winding route, looks along it toward the now line and beyond;
    // fixed field of view, no roll, height rising gently with the song's energy
    const lift = S.lift.step(d.energy, dt);
    S.camX += (pathX(camB) - S.camX) * expCoef(dt, 0.8);
    const ahead = camB + S.nowB + 10;
    const tgt = new THREE.Vector3(
      pathX(ahead) * 0.8 + S.camX * 0.2 + (pointer.over && !st.cinematic ? pointer.ndc.x * 30 : 0),
      1.5 + (pointer.over && !st.cinematic ? pointer.ndc.y * 14 : 0),
      -(S.nowB + 10) * SPACING,
    );
    S.look.lerp(tgt, expCoef(dt, 0.7));
    cam.position.set(S.camX, 6.2 + 2.2 * lift, 0);
    cam.up.set(0, 1, 0);
    cam.lookAt(S.look);
    const fov = size.width < size.height ? 76 : 64;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  });

  return <primitive object={scene.group} />;
}
