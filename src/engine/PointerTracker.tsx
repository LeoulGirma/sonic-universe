import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pointer } from './frameBus';
import { useStore } from '../store/useStore';

/**
 * Tracks the pointer over the canvas and projects it onto the plane through the origin that
 * faces the camera — the point stars are pulled toward (or pushed from).
 * Mouse: hovering applies the field, dragging orbits. Touch: press and hold still.
 * Shift boosts the field.
 */
export function PointerTracker() {
  const { gl, camera } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const setNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    let sx = 0, sy = 0;
    const move = (e: PointerEvent) => {
      setNdc(e);
      pointer.over = true;
      pointer.shift = e.shiftKey;
      if (pointer.down) {
        pointer.moved = Math.max(pointer.moved, Math.hypot(e.clientX - sx, e.clientY - sy));
        if (pointer.moved > 8 && useStore.getState().cinematic) useStore.getState().set({ cinematic: false });
      }
    };
    const down = (e: PointerEvent) => {
      setNdc(e);
      pointer.down = true;
      pointer.touch = e.pointerType !== 'mouse';
      pointer.downAt = performance.now();
      pointer.moved = 0;
      pointer.over = true;
      sx = e.clientX; sy = e.clientY;
    };
    const up = () => { pointer.down = false; if (pointer.touch) pointer.over = false; };
    const leave = () => { pointer.over = false; pointer.down = false; };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', leave);
    };
  }, [gl]);

  const tmp = useMemo(() => ({ ray: new THREE.Raycaster(), plane: new THREE.Plane(), n: new THREE.Vector3() }), []);
  useFrame(() => {
    camera.getWorldDirection(tmp.n);
    tmp.plane.setFromNormalAndCoplanarPoint(tmp.n, new THREE.Vector3(0, 0, 0));
    tmp.ray.setFromCamera(pointer.ndc, camera);
    tmp.ray.ray.intersectPlane(tmp.plane, pointer.world);
  }, -4);
  return null;
}

/** Is the cursor field active this frame, and how strongly? */
export function cursorState() {
  const mode = useStore.getState().cursor;
  if (mode === 'off' || !pointer.over) return { active: false, sign: 0, boost: 0 };
  const held = pointer.touch && pointer.down && pointer.moved < 10 && performance.now() - pointer.downAt > 180;
  const hover = !pointer.touch && !pointer.down;
  if (!(held || hover || pointer.shift)) return { active: false, sign: 0, boost: 0 };
  return { active: true, sign: mode === 'attract' ? 1 : -1, boost: pointer.shift ? 2.2 : held ? 1.6 : 1 };
}
