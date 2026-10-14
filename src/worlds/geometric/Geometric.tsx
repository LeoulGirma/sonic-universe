import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLUMNS, FLOOR_Y, GeoSim, LATTICE_R, NODES, NODE_LIFE, RING_R, SHARDS, SHELLS, SHELL_LIFE, TRAIL } from './geoState';
import { F, FAMILY_INFO } from '../../audio/soundFamilies';
import { useStore } from '../../store/useStore';
import { drives, perf } from '../../engine/frameBus';
import { debugEnabled, registerExtras, registerSim, registerStepper } from '../../engine/debug';
import { conductor } from '../../mapping/conductor';
import { Spring } from '../../audio/dsp';

// each kind of section gets its own formation: tilt of the whole architecture (x, z) and the
// lattice's reach; the same kind of section returns to the same formation
const FORMATIONS: [number, number, number][] = [[0, 0, 1], [0.38, 0.12, 1.16], [-0.3, 0.42, 0.9], [0.16, -0.4, 1.24], [0.5, 0.18, 1.06]];

const COL = FAMILY_INFO.map((f) => new THREE.Color(f.color));
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

/** Wire edges of a polyhedron with a per-segment "construction order" (a sweep around and up). */
function constructionEdges(geo: THREE.BufferGeometry, seed: number) {
  const edges = new THREE.EdgesGeometry(geo, 1);
  geo.dispose();
  const p = edges.getAttribute('position') as THREE.BufferAttribute;
  const nSeg = p.count / 2;
  const key: { i: number; k: number }[] = [];
  for (let s = 0; s < nSeg; s++) {
    const x = (p.getX(2 * s) + p.getX(2 * s + 1)) / 2, y = (p.getY(2 * s) + p.getY(2 * s + 1)) / 2, z = (p.getZ(2 * s) + p.getZ(2 * s + 1)) / 2;
    const r = Math.hypot(x, y, z) || 1;
    // built from the bottom up while sweeping around, like a structure rising
    const ang = (Math.atan2(z, x) / (2 * Math.PI) + 1 + seed) % 1;
    key.push({ i: s, k: (y / r + 1) / 2 + 0.35 * ang });
  }
  key.sort((a, b) => a.k - b.k);
  const order = new Float32Array(p.count);
  key.forEach(({ i }, rank) => { order[2 * i] = order[2 * i + 1] = (rank + 0.5) / nSeg; });
  edges.setAttribute('order', new THREE.BufferAttribute(order, 1));
  return edges;
}

const shellVertex = /* glsl */ `
  attribute float order;
  varying float vO;
  void main() { vO = order; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const shellFragment = /* glsl */ `
  uniform float uBuild;
  uniform vec3 uColor;
  uniform float uGain;
  varying float vO;
  void main() {
    float built = 1.0 - smoothstep(uBuild - 0.03, uBuild, vO);
    float front = exp(-pow((vO - uBuild) / 0.025, 2.0));      // the edges being laid right now glow
    float a = built * 0.55 + front * 2.2 * step(0.002, uBuild);
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * a * uGain, 1.0);
  }
`;

const latticeVertex = /* glsl */ `
  attribute float spark;
  uniform float uSize;
  varying float vS;
  void main() {
    vS = spark;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(uSize * (0.55 + 1.6 * spark) * (60.0 / -mv.z), 9.0 + 7.0 * spark);
    gl_Position = projectionMatrix * mv;
  }
`;
const latticeFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBase;
  varying float vS;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;
    float k = exp(-d * 14.0);
    gl_FragColor = vec4(uColor * k * (uBase + 1.8 * vS), 1.0);
  }
`;

/**
 * World C — Geometric Intelligence. Every sound family builds its own part of one architecture,
 * in the same colour the sound-family legend uses (see geoState.ts for the full mapping).
 */
export function Geometric() {
  const sim = useMemo(() => {
    const ico = mergeVertices(new THREE.IcosahedronGeometry(LATTICE_R, 3).deleteAttribute('normal').deleteAttribute('uv'));
    const n = ico.getAttribute('position').count;
    return { sim: new GeoSim(n), latticeGeo: ico };
  }, []);
  const S = sim.sim;

  const parts = useMemo(() => {
    // kick: core + shells
    const coreEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.3, 0));
    const coreLine = new THREE.LineSegments(coreEdges, new THREE.LineBasicMaterial({ color: COL[F.kick], ...additive }));
    const coreFill = new THREE.Mesh(new THREE.IcosahedronGeometry(1.22, 0), new THREE.MeshBasicMaterial({ color: COL[F.kick], opacity: 0.22, ...additive }));
    const shellEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 1));
    const shells = Array.from({ length: SHELLS }, () => {
      const l = new THREE.LineSegments(shellEdges, new THREE.LineBasicMaterial({ color: COL[F.kick].clone(), opacity: 0, ...additive }));
      l.visible = false;
      return l;
    });
    // pads: three constructed shells
    const shellDefs: [THREE.BufferGeometry, number][] = [
      [new THREE.DodecahedronGeometry(3.2, 0), 0.0],
      [new THREE.IcosahedronGeometry(4.5, 1), 0.33],
      [new THREE.OctahedronGeometry(6.2, 1), 0.66],
    ];
    const padShells = shellDefs.map(([g, seed]) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: shellVertex, fragmentShader: shellFragment, ...additive,
        uniforms: { uBuild: { value: 0 }, uColor: { value: COL[F.pads].clone() }, uGain: { value: 1 } },
      });
      return new THREE.LineSegments(constructionEdges(g, seed), mat);
    });
    // bass: foundation columns + floor ring
    const colGeo = new THREE.BoxGeometry(0.42, 1, 0.42).translate(0, 0.5, 0);
    const columns = new THREE.InstancedMesh(colGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.9, ...additive }), COLUMNS);
    columns.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COLUMNS * 3), 3);
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; ringPts.push(new THREE.Vector3(Math.cos(a) * RING_R, FLOOR_Y, Math.sin(a) * RING_R)); }
    const floorRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: COL[F.bass].clone().multiplyScalar(0.35), ...additive }));
    // lead: ribbon + head + nodes
    const ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3));
    ribbonGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL - 1; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    ribbonGeo.setIndex(idx);
    const ribbon = new THREE.Mesh(ribbonGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, ...additive }));
    ribbon.frustumCulled = false;
    const leadHead = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshBasicMaterial({ color: COL[F.lead], ...additive }));
    const nodes = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.32, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, ...additive }), NODES);
    nodes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NODES * 3), 3);
    // hits: shards
    const shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, ...additive }), SHARDS);
    shards.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHARDS * 3), 3);
    for (const m of [columns, nodes, shards]) m.frustumCulled = false;
    // hats: lattice
    const spark = new THREE.BufferAttribute(S.sparkle, 1);
    sim.latticeGeo.setAttribute('spark', spark);
    const lattice = new THREE.Points(sim.latticeGeo, new THREE.ShaderMaterial({
      vertexShader: latticeVertex, fragmentShader: latticeFragment, ...additive,
      uniforms: { uColor: { value: COL[F.hats].clone() }, uBase: { value: 0.06 }, uSize: { value: 3.5 } },
    }));
    // the architecture turns slowly as one; the lattice drifts on its own
    const arch = new THREE.Group();
    arch.add(coreLine, coreFill, ...shells, ...padShells, columns, floorRing, ribbon, leadHead, nodes, shards);
    const scene = new THREE.Group();
    scene.add(arch, lattice);
    return { scene, arch, coreLine, coreFill, shells, padShells, columns, floorRing, ribbon, leadHead, nodes, shards, lattice, spark };
  }, [S, sim.latticeGeo]);

  useEffect(() => () => {
    parts.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    perf.particles = S.latticeN + SHARDS + COLUMNS;
    perf.countLabel = 'Architecture elements';
    perf.worldLabel = 'Loudest families';
    if (debugEnabled) {
      registerSim(null);
      registerStepper((dt, d) => S.step(dt, d));
      registerExtras({ stats: () => S.stats() });
    }
    return () => {
      perf.countLabel = '';
      perf.worldLabel = '';
      registerStepper(null);
      registerExtras(null);
    };
  }, [S]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), v: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color(), axis: new THREE.Vector3() }), []);
  // the song's colours (song mood) and the slower, eased structure: formation per section,
  // contraction through a build, a release on the drop, opening out in a breakdown
  const look = useMemo(() => ({
    col: COL.map((c) => c.clone()),
    tiltX: new Spring(), tiltZ: new Spring(), reach: new Spring(1), scale: new Spring(1), spin: 0,
  }), []);

  useFrame((_, dt) => {
    const d = drives();
    const st = useStore.getState();
    if (!st.frozen) S.step(dt, d);
    const lv = d.fam.level;
    const P = parts;
    const C = conductor;
    const G = C.look.gain;
    const gc = look.col;
    for (let k = 0; k < gc.length; k++) C.grade(COL[k], gc[k]);
    const [fx, fz, reach] = FORMATIONS[C.section >= 0 ? C.sectionLabel % FORMATIONS.length : 0];
    look.spin += dt * (0.5 * C.build + 0.9 * C.drop * G.arc);
    P.arch.rotation.set(look.tiltX.step(fx, dt, 0.6), S.rotY + look.spin, look.tiltZ.step(fz, dt, 0.6));
    // a build draws everything in; the drop throws it out; a breakdown lets it open and drift
    const archS = look.scale.step(1 - 0.16 * C.build + 0.22 * C.drop * G.arc + 0.08 * C.calm, dt, 2.5);
    P.arch.scale.setScalar(archS);
    P.lattice.rotation.y = S.latticeRot;
    P.lattice.rotation.x = 0.25;

    // kick
    P.coreLine.scale.setScalar(S.core);
    P.coreFill.scale.setScalar(S.core);
    P.coreLine.rotation.y = S.t * 0.3;
    P.coreFill.rotation.y = S.t * 0.3;
    (P.coreLine.material as THREE.LineBasicMaterial).color.copy(gc[F.kick]);
    (P.coreFill.material as THREE.MeshBasicMaterial).color.copy(gc[F.kick]);
    (P.coreLine.material as THREE.LineBasicMaterial).opacity = 0.22 + 0.78 * Math.min(1, lv[F.kick] + S.coreFlash) + 0.3 * d.idle;
    (P.coreFill.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.5 * S.coreFlash + 0.25 * S.dropFlash;
    S.shells.forEach((sh, i) => {
      const l = P.shells[i];
      l.visible = sh.alive;
      if (!sh.alive) return;
      const x = sh.age / SHELL_LIFE;
      l.scale.setScalar(1.3 + 10 * Math.pow(x, 0.7));
      l.rotation.set(sh.strength * 3, i * 1.7, 0);
      (l.material as THREE.LineBasicMaterial).color.copy(gc[F.kick]);
      (l.material as THREE.LineBasicMaterial).opacity = Math.pow(1 - x, 2.5) * (0.25 + 0.5 * sh.strength) * Math.min(1.5, G.groove);
    });

    // pads
    const padCol = tmp.c.copy(gc[F.pads]);
    const hsl = { h: 0, s: 0, l: 0 };
    padCol.getHSL(hsl);
    // the harmony tints the teal a little (circle of fifths → ±0.08 hue), so chord changes show
    padCol.setHSL((hsl.h + 0.16 * (S.padHue - 0.5) * Math.min(1, d.fam.hueStrength * 2) + 1) % 1, hsl.s, hsl.l);
    P.padShells.forEach((l, i) => {
      const u = (l.material as THREE.ShaderMaterial).uniforms;
      u.uBuild.value = S.build[i] * 1.03;
      u.uColor.value.copy(padCol);
      u.uGain.value = (0.55 + 0.7 * C.fam[F.pads] + 0.6 * S.dropFlash) * G.space;
      l.rotation.set(S.shellRot[i] * 0.37, S.shellRot[i], S.shellRot[i] * 0.21 * (i - 1));
    });

    // bass
    for (let i = 0; i < COLUMNS; i++) {
      const a = (i / COLUMNS) * Math.PI * 2;
      const h = 0.12 + 7 * S.heights[i] * Math.min(1.6, G.bass);
      tmp.v.set(Math.cos(a) * RING_R, FLOOR_Y, Math.sin(a) * RING_R);
      tmp.q.setFromAxisAngle(tmp.axis.set(0, 1, 0), -a);
      tmp.s.set(1, h, 1);
      P.columns.setMatrixAt(i, tmp.m.compose(tmp.v, tmp.q, tmp.s));
      const b = 0.18 + 0.55 * S.heights[i] + 0.9 * S.fresh[i];
      P.columns.setColorAt(i, tmp.c.copy(gc[F.bass]).multiplyScalar(b * (1 - 0.35 * C.calm)));
    }
    P.columns.instanceMatrix.needsUpdate = true;
    P.columns.instanceColor!.needsUpdate = true;

    // lead: ribbon in age order, oldest first
    const pos = P.ribbon.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = P.ribbon.geometry.getAttribute('color') as THREE.BufferAttribute;
    const lc = tmp.c.copy(gc[F.lead]).multiplyScalar(Math.min(1.6, G.melody)).clone();
    for (let k = 0; k < TRAIL; k++) {
      const j = (S.trailHead + 1 + k) % TRAIL; // k = 0 oldest … TRAIL-1 newest
      const o = j * 4;
      const age = 1 - k / (TRAIL - 1);
      const l = S.trail[o + 3];
      const w = 0.04 + 0.42 * l;
      pos.setXYZ(2 * k, S.trail[o], S.trail[o + 1] - w, S.trail[o + 2]);
      pos.setXYZ(2 * k + 1, S.trail[o], S.trail[o + 1] + w, S.trail[o + 2]);
      const br = Math.pow(1 - age, 1.6) * (0.015 + 1.15 * l);
      col.setXYZ(2 * k, lc.r * br, lc.g * br, lc.b * br);
      col.setXYZ(2 * k + 1, lc.r * br, lc.g * br, lc.b * br);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    const ho = S.trailHead * 4;
    P.leadHead.position.set(S.trail[ho], S.trail[ho + 1], S.trail[ho + 2]);
    (P.leadHead.material as THREE.MeshBasicMaterial).color.copy(lc);
    P.leadHead.scale.setScalar(0.6 + 1.4 * lv[F.lead] + 1.2 * d.fam.hit[F.lead]);
    P.leadHead.rotation.y = S.t * 2;
    S.nodes.forEach((n, i) => {
      const k = n.alive ? 1 - n.age / NODE_LIFE : 0;
      tmp.v.set(n.x, n.y, n.z);
      tmp.q.setFromAxisAngle(tmp.axis.set(0, 1, 0), S.t + i);
      tmp.s.setScalar(n.alive ? 0.5 + 0.7 * k : 0);
      P.nodes.setMatrixAt(i, tmp.m.compose(tmp.v, tmp.q, tmp.s));
      P.nodes.setColorAt(i, tmp.c.copy(lc).multiplyScalar(k * k));
    });
    P.nodes.instanceMatrix.needsUpdate = true;
    P.nodes.instanceColor!.needsUpdate = true;

    // hits
    const hc = tmp.c.copy(gc[F.hits]).multiplyScalar(Math.min(1.6, G.groove)).clone();
    S.shards.forEach((s, i) => {
      const k = s.alive ? 1 - s.age / s.life : 0;
      tmp.v.set(s.x, s.y, s.z);
      tmp.q.setFromAxisAngle(tmp.axis.set(s.ax, s.ay, s.az).normalize(), s.angle);
      tmp.s.setScalar(s.alive ? s.size * (0.4 + 0.6 * k) : 0);
      P.shards.setMatrixAt(i, tmp.m.compose(tmp.v, tmp.q, tmp.s));
      P.shards.setColorAt(i, tmp.c.copy(hc).multiplyScalar(k));
    });
    P.shards.instanceMatrix.needsUpdate = true;
    P.shards.instanceColor!.needsUpdate = true;

    // hats
    P.spark.needsUpdate = true;
    const lu = (P.lattice.material as THREE.ShaderMaterial).uniforms;
    lu.uColor.value.copy(gc[F.hats]);
    lu.uBase.value = (0.045 + 0.3 * C.fam[F.hats] + 0.05 * d.idle) * Math.min(1.5, G.groove) + 0.25 * C.sectionHit;
    P.lattice.scale.setScalar(look.reach.step(reach, dt, 0.5) * (1 - 0.12 * C.build + 0.07 * S.dropFlash));

    // perf readout: the two most present families right now
    const top = lv.map((v, k) => [v, k] as const).sort((a, b) => b[0] - a[0]).filter(([v]) => v > 0.15).slice(0, 2);
    perf.worldValue = top.length ? top.map(([, k]) => FAMILY_INFO[k].name).join(', ') : 'Quiet';
  });

  return <primitive object={parts.scene} />;
}
