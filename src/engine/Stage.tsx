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
        // a display change (TV, second monitor) or driver reset loses the GPU context, and with it
        // every simulation texture: offer a reload rather than a frozen black screen
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          if (document.getElementById('gl-lost')) return;
          const el = document.createElement('div');
          el.id = 'gl-lost';
          el.className = 'gllost glass';
          el.innerHTML = '<span>The graphics were reset (often after connecting a TV or monitor).</span>';
          const b = document.createElement('button');
          b.className = 'btn btn--primary';
          b.textContent = 'Reload';
          b.onclick = () => location.reload();
          el.appendChild(b);
          document.body.appendChild(el);
        });
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
