import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MAX_DPR, useStore } from '../store/useStore';
import { perf } from './frameBus';

/**
 * Measures frame time and adapts render resolution (DPR) to hold the frame rate.
 * Particle count is never changed automatically — that would visibly reset the simulation.
 */
export function PerfMonitor() {
  const { gl } = useThree();
  const s = useRef({ acc: 0, frames: 0, ema: 16.7, lastAdjust: 0, t: 0 });
  useFrame((_, dt) => {
    const st = s.current;
    const ms = dt * 1000;
    st.ema += (ms - st.ema) * 0.05;
    st.acc += dt;
    st.frames++;
    st.t += dt;
    perf.frameMs = st.ema;
    perf.calls = gl.info.render.calls;
    if (st.acc >= 0.5) {
      perf.fps = st.frames / st.acc;
      st.acc = 0;
      st.frames = 0;
      const { autoQuality, dpr, resolutionCap, set } = useStore.getState();
      const cap = Math.max(0.5, MAX_DPR * resolutionCap);
      if (autoQuality && st.t - st.lastAdjust > 2 && document.visibilityState === 'visible') {
        if (perf.fps < 45 && dpr > 0.5) {
          set({ dpr: Math.max(0.5, +(dpr * 0.85).toFixed(2)) });
          st.lastAdjust = st.t;
        } else if (perf.fps > 57 && dpr < cap && st.t - st.lastAdjust > 5) {
          set({ dpr: Math.min(cap, +(dpr * 1.1).toFixed(2)) });
          st.lastAdjust = st.t;
        }
      }
      if ((!autoQuality && Math.abs(dpr - cap) > 0.01) || dpr > cap + 0.01) set({ dpr: cap });
    }
  });
  return null;
}
