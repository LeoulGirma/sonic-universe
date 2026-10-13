import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { Suspense } from 'react';
import { useStore } from '../store/useStore';
import { WORLDS } from '../worlds/registry';
import { AnalysisDriver } from './AnalysisDriver';
import { CameraRig } from './CameraRig';
import { PointerTracker } from './PointerTracker';
import { PerfMonitor } from './PerfMonitor';
import { PostFX } from './PostFX';

/** The 3D stage. Switching worlds swaps only the world component — audio keeps playing. */
export function Stage() {
  const worldId = useStore((s) => s.world);
  const dpr = useStore((s) => s.dpr);
  const World = WORLDS.find((w) => w.id === worldId)?.Component;
  return (
    <Canvas
      dpr={dpr}
      gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, preserveDrawingBuffer: false }}
      camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 34, 70] }}
      onCreated={({ gl }) => {
        gl.setClearColor('#000000');
        gl.toneMapping = THREE.NoToneMapping;
      }}
      style={{ position: 'fixed', inset: 0, touchAction: 'none' }}
    >
      <AnalysisDriver />
      <PointerTracker />
      <CameraRig />
      <PerfMonitor />
      <Suspense fallback={null}>{World ? <World key={worldId} /> : null}</Suspense>
      <PostFX />
    </Canvas>
  );
}
