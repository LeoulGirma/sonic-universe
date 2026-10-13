import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../store/useStore';
import { cameraOwner, drives, pointer } from './frameBus';
import { expCoef } from '../audio/dsp';

const BASE_FOV = 55;
/** how far the camera sits, per world (the liquid is a single object, the galaxy a whole disk) */
const WORLD_SCALE: Record<string, number> = { cosmic: 1, life: 1, liquid: 0.62, geometric: 0.42 };
/** on portrait screens the horizontal view is narrow: compact worlds need the camera further out */
const portrait = (world: string) => {
  if (world !== 'geometric' || typeof window === 'undefined') return 1;
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  return aspect < 1 ? Math.min(1.9, Math.pow(1 / aspect, 0.6)) : 1;
};
const scaleOf = (world: string) => (WORLD_SCALE[world] ?? 1) * portrait(world);
const worldScale = () => scaleOf(useStore.getState().world);
/** keys currently held (shared with worlds that steer the camera themselves) */
export const keys = new Set<string>();

/**
 * Camera: orbit (drag / pinch), fly (WASD + QE, Shift = fast), and an automatic cinematic
 * path whose speed, distance and framing follow the music. Any manual drag hands control
 * back to the user smoothly — the camera is never teleported.
 */
export function CameraRig() {
  const { camera, gl } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const controls = useMemo(() => {
    const c = new OrbitControls(cam, gl.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.06;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 0.8;
    c.minDistance = 3;
    c.maxDistance = 260;
    c.enablePan = true;
    return c;
  }, [cam, gl]);

  const s = useRef({ path: 0, fovKick: BASE_FOV, look: new THREE.Vector3() });

  useEffect(() => {
    const onStart = () => {
      if (useStore.getState().cinematic) useStore.getState().set({ cinematic: false });
    };
    controls.addEventListener('start', onStart);
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      keys.add(e.key.toLowerCase());
      pointer.shift = e.shiftKey;
    };
    const ku = (e: KeyboardEvent) => {
      keys.delete(e.key.toLowerCase());
      pointer.shift = e.shiftKey;
    };
    const blur = () => keys.clear();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    cam.position.set(0, 34, 70).multiplyScalar(worldScale());
    controls.target.set(0, 0, 0);
    return () => {
      controls.removeEventListener('start', onStart);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      controls.dispose();
    };
  }, [controls, cam]);

  // switching worlds reframes the camera for the new world's scale, keeping the view direction
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.world === prev.world) return;
        if (prev.world === 'tunnel' || s.world === 'tunnel') {
          // leaving the tunnel: restore the orbit view; entering it: the world takes over
          controls.target.set(0, 0, 0);
          cam.up.set(0, 1, 0);
          cam.position.set(0, 34, 70).multiplyScalar(scaleOf(s.world));
          return;
        }
        const k = scaleOf(s.world) / scaleOf(prev.world);
        cam.position.sub(controls.target).multiplyScalar(k).add(controls.target);
      }),
    [cam, controls],
  );

  const tmp = useMemo(() => ({ fwd: new THREE.Vector3(), right: new THREE.Vector3(), move: new THREE.Vector3(), goal: new THREE.Vector3() }), []);

  useFrame((_, dt) => {
    if (cameraOwner.world) {
      controls.enabled = false;
      return;
    }
    const d = drives();
    const { cinematic } = useStore.getState();
    const st = s.current;

    // --- fly (keyboard) ------------------------------------------------------
    const fast = keys.has('shift') ? 3 : 1;
    const speed = 14 * fast * dt;
    cam.getWorldDirection(tmp.fwd);
    tmp.right.crossVectors(tmp.fwd, cam.up).normalize();
    tmp.move.set(0, 0, 0);
    if (keys.has('w') || keys.has('arrowup')) tmp.move.add(tmp.fwd);
    if (keys.has('s') || keys.has('arrowdown')) tmp.move.sub(tmp.fwd);
    if (keys.has('d') || keys.has('arrowright')) tmp.move.add(tmp.right);
    if (keys.has('a') || keys.has('arrowleft')) tmp.move.sub(tmp.right);
    if (keys.has('e')) tmp.move.y += 1;
    if (keys.has('q')) tmp.move.y -= 1;
    if (tmp.move.lengthSq() > 0) {
      if (cinematic) useStore.getState().set({ cinematic: false });
      tmp.move.normalize().multiplyScalar(speed);
      cam.position.add(tmp.move);
      controls.target.add(tmp.move);
    }

    // --- cinematic path ------------------------------------------------------
    controls.enabled = !cinematic;
    if (cinematic) {
      st.path += dt * (0.03 + 0.05 * d.energy + 0.04 * d.release) * (1 - 0.55 * d.calm);
      const p = st.path;
      const radius = (62 + 24 * Math.sin(p * 0.61) - 14 * d.release - 18 * d.tension + 8 * d.calm) * worldScale();
      // elevation sweeps from top-down to almost edge-on, occasionally skimming the disk
      // build-ups rise toward a top-down view of the tightening spiral; the drop then punches in
      const elev = 0.08 + 0.55 * (0.5 + 0.5 * Math.sin(p * 0.37 + 1.2)) * (0.5 + 0.5 * Math.cos(p * 0.21)) + 0.5 * d.tension;
      const az = p * 0.9;
      tmp.goal.set(Math.cos(az) * Math.cos(elev) * radius, Math.sin(elev) * radius, Math.sin(az) * Math.cos(elev) * radius);
      cam.position.lerp(tmp.goal, expCoef(dt, 1.6));
      st.look.set(Math.sin(p * 0.5) * 4, 0, Math.cos(p * 0.4) * 4);
      controls.target.lerp(st.look, expCoef(dt, 2));
      cam.lookAt(controls.target);
    } else {
      controls.update();
    }

    // --- lens: kicks punch in slightly, drops punch harder, breakdowns widen -----------
    const target = BASE_FOV - 2.0 * d.pulse - 7 * d.release + 3 * d.calm - 2 * d.tension;
    st.fovKick += (target - st.fovKick) * expCoef(dt, d.pulse > 0.4 ? 0.05 : 0.35);
    const fov = THREE.MathUtils.clamp(st.fovKick, 38, 70);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }, -5);

  return null;
}
