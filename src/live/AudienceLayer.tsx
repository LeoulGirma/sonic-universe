import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { giftTier, live, type LiveEvent } from './liveEvents';
import { starUV, starHue } from './audience';

/**
 * The audience as part of the sky, in front of whatever world is showing: every viewer who comments,
 * gifts or follows becomes a star in a constellation across the top of the view (the same viewer always
 * gets the same spot), flaring when they speak. Gifts burst sparks out of the gifter's star and make
 * it bigger for the rest of the stream; the biggest gifts and a full likes bar ring out across the
 * whole screen. The layer rides on the camera, so it looks the same in every world.
 */
const MAX_STARS = 320;
const MAX_SPARKS = 2400;
const DEPTH = 60;

const STAR_VERT = /* glsl */`
uniform float uTime, uPx; uniform vec2 uHalf;
attribute vec2 aUV; attribute vec3 aColor; attribute float aBirth, aHeat, aSize;
varying vec3 vColor; varying float vA;
void main(){
  float age = uTime - aBirth;
  if (aBirth < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  // new viewers arrive as a comet rising from the bottom centre to their spot
  float k = clamp(age / 1.4, 0.0, 1.0); k = 1.0 - pow(1.0 - k, 3.0);
  vec2 target = vec2((aUV.x - 0.5) * 1.84, mix(0.12, 0.86, aUV.y)) * uHalf;
  vec2 start = vec2(0.0, -0.9) * uHalf;
  vec2 p = mix(start, target, k);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, -${DEPTH}.0, 1.0);
  float flare = exp(-(uTime - aHeat) * 1.6);
  float tw = 0.85 + 0.15 * sin(uTime * (1.3 + fract(aUV.x * 17.0) * 2.0) + aUV.y * 40.0);
  gl_PointSize = uPx * aSize * (1.0 + 2.4 * flare + (1.0 - k) * 1.5) * tw;
  vColor = aColor * (0.9 + 1.8 * flare + (1.0 - k) * 1.4);
  vA = smoothstep(0.0, 0.25, age);
}`;
const SPRITE_FRAG = /* glsl */`
varying vec3 vColor; varying float vA;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = length(d);
  if (r > 0.5) discard;
  float glow = smoothstep(0.5, 0.0, r);
  float core = smoothstep(0.16, 0.0, r);
  float cross = max(0.0, 1.0 - abs(d.x) * 12.0) * max(0.0, 1.0 - abs(d.y) * 2.0) + max(0.0, 1.0 - abs(d.y) * 12.0) * max(0.0, 1.0 - abs(d.x) * 2.0);
  gl_FragColor = vec4(vColor * (0.45 * glow * glow + 1.6 * core + 0.6 * cross) * vA, 1.0);
}`;
const SPARK_VERT = /* glsl */`
uniform float uPx;
attribute vec3 aColor; attribute float aLife, aSize;
varying vec3 vColor; varying float vA;
void main(){
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aLife > 0.0 ? uPx * aSize * sqrt(aLife) : 0.0;
  vColor = aColor; vA = aLife;
}`;

const TIER_COLOURS = ['#ffd6f0', '#ffb547', '#7cf0ff', '#ffffff'].map((c) => new THREE.Color(c));

export function AudienceLayer() {
  const { camera, gl } = useThree();
  const group = useRef<THREE.Group>(null);
  const slots = useRef(new Map<string, number>());
  const order = useRef<string[]>([]);

  const stars = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_STARS * 3), 3));
    g.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(MAX_STARS * 2), 2));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_STARS * 3), 3));
    g.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(MAX_STARS).fill(-1), 1));
    g.setAttribute('aHeat', new THREE.BufferAttribute(new Float32Array(MAX_STARS).fill(-99), 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_STARS).fill(24), 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uHalf: { value: new THREE.Vector2(1, 1) } },
      vertexShader: STAR_VERT, fragmentShader: SPRITE_FRAG,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = 50;
    return p;
  }, []);

  const sparks = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS), 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 1 } },
      vertexShader: SPARK_VERT, fragmentShader: SPRITE_FRAG,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = 51;
    return { points: p, vel: new Float32Array(MAX_SPARKS * 3), life: new Float32Array(MAX_SPARKS), max: new Float32Array(MAX_SPARKS), head: 0 };
  }, []);

  const half = useRef(new THREE.Vector2(1, 1));
  const colour = useMemo(() => new THREE.Color(), []);

  /** this viewer's star: index into the buffers, created (replacing the quietest viewer) if new */
  const star = (user: string, t: number): number => {
    const map = slots.current, ord = order.current;
    let i = map.get(user);
    if (i === undefined) {
      if (map.size < MAX_STARS) i = map.size;
      else { const old = ord.shift()!; i = map.get(old)!; map.delete(old); }
      map.set(user, i);
      const g = stars.geometry, [u, v] = starUV(user);
      (g.attributes.aUV.array as Float32Array).set([u, v], i * 2);
      colour.setHSL(starHue(user), 0.55, 0.72);
      (g.attributes.aColor.array as Float32Array).set([colour.r, colour.g, colour.b], i * 3);
      (g.attributes.aBirth.array as Float32Array)[i] = t;
      (g.attributes.aSize.array as Float32Array)[i] = 24;
      g.attributes.aUV.needsUpdate = g.attributes.aColor.needsUpdate = g.attributes.aBirth.needsUpdate = g.attributes.aSize.needsUpdate = true;
    } else {
      const k = ord.indexOf(user); if (k >= 0) ord.splice(k, 1);
    }
    ord.push(user);
    return i;
  };

  const starPos = (user: string, out: THREE.Vector3) => {
    const [u, v] = starUV(user), h = half.current;
    return out.set((u - 0.5) * 1.84 * h.x, (0.12 + 0.74 * v) * h.y, -DEPTH);
  };

  const burst = (at: THREE.Vector3, n: number, speed: number, col: THREE.Color, ring = false) => {
    const s = sparks, pos = s.points.geometry.attributes.position.array as Float32Array;
    const ca = s.points.geometry.attributes.aColor.array as Float32Array, sa = s.points.geometry.attributes.aSize.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = s.head; s.head = (s.head + 1) % MAX_SPARKS;
      const a = ring ? (k / n) * Math.PI * 2 : Math.random() * Math.PI * 2;
      const sp = ring ? speed : speed * (0.25 + Math.random() * 0.9);
      pos[i * 3] = at.x; pos[i * 3 + 1] = at.y; pos[i * 3 + 2] = at.z;
      s.vel[i * 3] = Math.cos(a) * sp; s.vel[i * 3 + 1] = Math.sin(a) * sp; s.vel[i * 3 + 2] = 0;
      const l = (ring ? 1.6 : 0.9) + Math.random() * 0.9; s.life[i] = l; s.max[i] = l;
      const j = 0.75 + Math.random() * 0.5;
      ca[i * 3] = col.r * j; ca[i * 3 + 1] = col.g * j; ca[i * 3 + 2] = col.b * j;
      sa[i] = ring ? 14 : 6 + Math.random() * 8;
    }
  };

  const tmp = useMemo(() => new THREE.Vector3(), []);
  const centre = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const grp = group.current; if (!grp) return;
    // ride on the camera (the rig has already moved it this frame)
    grp.position.copy(camera.position); grp.quaternion.copy(camera.quaternion);
    const cam = camera as THREE.PerspectiveCamera;
    const hy = DEPTH * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    half.current.set(hy * cam.aspect, hy);
    const t = performance.now() / 1000;
    const px = gl.getDrawingBufferSize(new THREE.Vector2()).y / 900;
    const su = (stars.material as THREE.ShaderMaterial).uniforms;
    su.uTime.value = t; su.uPx.value = px; su.uHalf.value.copy(half.current);
    (sparks.points.material as THREE.ShaderMaterial).uniforms.uPx.value = px;

    // take in what the audience did since the last frame
    const g = stars.geometry, heat = g.attributes.aHeat.array as Float32Array, size = g.attributes.aSize.array as Float32Array;
    let touched = false;
    while (live.queue.length) {
      const e: LiveEvent = live.queue.shift()!;
      if (e.type === 'like') { if (Math.random() < 0.3) { const i = star(e.user, t); heat[i] = Math.max(heat[i], t - 1.2); touched = true; } continue; }
      const i = star(e.user, t); heat[i] = t; touched = true;
      starPos(e.user, tmp);
      if (e.type === 'gift') {
        const tier = giftTier(e.diamonds ?? 1);
        size[i] = Math.min(64, size[i] + 6 + tier * 8); // supporters shine brighter for the rest of the stream
        burst(tmp, 60 + tier * 120, 9 + tier * 5, TIER_COLOURS[tier]);
        if (tier >= 2) { centre.set(0, 0, -DEPTH); burst(centre, 180, 34, TIER_COLOURS[tier], true); burst(centre, 160, 26, colour.setHSL(starHue(e.user), 0.7, 0.65)); }
      } else if (e.type === 'follow' || e.type === 'share') {
        burst(tmp, 50, 8, TIER_COLOURS[0]);
      } else if (e.type === 'chat') {
        burst(tmp, 12, 4, colour.setHSL(starHue(e.user), 0.6, 0.75));
      }
    }
    if (live.boost.release > 0.99 && !grp.userData.rang) { centre.set(0, 0, -DEPTH); burst(centre, 220, 38, TIER_COLOURS[3], true); grp.userData.rang = true; }
    if (live.boost.release < 0.9) grp.userData.rang = false;
    if (touched) { g.attributes.aHeat.needsUpdate = true; g.attributes.aSize.needsUpdate = true; }

    // sparks
    const s = sparks, pos = s.points.geometry.attributes.position.array as Float32Array, la = s.points.geometry.attributes.aLife.array as Float32Array;
    const drag = Math.exp(-dt * 1.9);
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (s.life[i] <= 0) { la[i] = 0; continue; }
      s.life[i] -= dt;
      s.vel[i * 3] *= drag; s.vel[i * 3 + 1] = s.vel[i * 3 + 1] * drag - 2.5 * dt;
      pos[i * 3] += s.vel[i * 3] * dt; pos[i * 3 + 1] += s.vel[i * 3 + 1] * dt;
      la[i] = Math.max(0, s.life[i] / s.max[i]);
    }
    const sg = s.points.geometry.attributes;
    sg.position.needsUpdate = sg.aLife.needsUpdate = sg.aColor.needsUpdate = sg.aSize.needsUpdate = true;
    void state;
  });

  return (
    <group ref={group}>
      <primitive object={stars} />
      <primitive object={sparks.points} />
    </group>
  );
}
