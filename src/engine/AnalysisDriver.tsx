import { useFrame } from '@react-three/fiber';
import { audioEngine } from '../audio/AudioEngine';
import { useStore } from '../store/useStore';
import { mapper } from './frameBus';

/** Runs first every frame (negative priority): audio analysis → feature mapping. */
export function AnalysisDriver() {
  useFrame((_, dt) => {
    const { gains, sensitivity } = useStore.getState();
    const f = audioEngine.analyse(dt);
    mapper.update(f, gains, sensitivity, dt);
  }, -10);
  return null;
}
