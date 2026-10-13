import * as THREE from 'three';
import { audioEngine } from '../audio/AudioEngine';
import { DriveMapper } from '../mapping/drives';

/**
 * Per-frame shared state. Mutable singletons (not React state) so 60 Hz data never
 * triggers re-renders. Written by <AnalysisDriver/> before any world reads it.
 */
export const mapper = new DriveMapper();
export const features = () => audioEngine.features;
/** debug only: the offline verification harness shows the drives it computed, not the live ones */
export const driveOverride: { d: import('../mapping/drives').Drives | null } = { d: null };
export const drives = () => driveOverride.d ?? mapper.d;

export const pointer = {
  ndc: new THREE.Vector2(),
  over: false,
  down: false,
  touch: false,
  downAt: 0,
  moved: 0,
  shift: false,
  world: new THREE.Vector3(),
};

export const perf = {
  fps: 60,
  frameMs: 16.7,
  calls: 0,
  points: 0,
  particles: 0,
  /** what `particles` counts, when not particles (e.g. liquid blobs) */
  countLabel: '',
  /** optional world-specific readout row, e.g. the active Particle Life ecosystem */
  worldLabel: '',
  worldValue: '',
};

/** A world that drives the camera itself (e.g. the tunnel) sets this; the shared rig stands down. */
export const cameraOwner = { world: false };

/** Camera events that worlds can raise (e.g. a drop punch). */
export const cameraFx = { punch: 0 };
