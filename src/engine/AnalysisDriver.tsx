import { useFrame } from '@react-three/fiber';
import { audioEngine } from '../audio/AudioEngine';
import { useStore } from '../store/useStore';
import { drives, mapper } from './frameBus';
import { conductor } from '../mapping/conductor';

const MOOD_WORLDS = ['valley', 'geometric', 'tunnel', 'ink'];

/** Runs first every frame (negative priority): audio analysis → feature mapping → conductor. */
export function AnalysisDriver() {
  useFrame((_, dt) => {
    const { gains, sensitivity, mood, world } = useStore.getState();
    const f = audioEngine.analyse(dt);
    mapper.update(f, gains, sensitivity, dt);
    conductor.update(dt, drives(), mood && MOOD_WORLDS.includes(world));
  }, -10);
  return null;
}
