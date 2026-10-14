import type { ComponentType } from 'react';
import type { WorldId } from '../store/useStore';
import { CosmicGenesis } from './cosmic/CosmicGenesis';
import { ParticleLife } from './life/ParticleLife';
import { LiquidDimension } from './liquid/LiquidDimension';
import { Tunnel } from './tunnel/Tunnel';
import { Geometric } from './geometric/Geometric';
import { Valley } from './valley/Valley';
import { Ink } from './ink/Ink';

/**
 * Worlds are plug-ins: a component that reads `drives()` from the frame bus and renders.
 * They share the audio engine, mapping, camera rig, pointer, post-processing and UI.
 */
export interface WorldDef {
  id: WorldId;
  name: string;
  tagline: string;
  Component: ComponentType | null; // null = not built yet
  headline?: string;
  lede?: string; // what the music does here, shown on the welcome screen
}

export const WORLDS: WorldDef[] = [
  {
    id: 'valley', name: 'Sound Valley', tagline: 'Fly through a landscape each sound builds', Component: Valley,
    headline: 'Play a song. Fly through its landscape.',
    lede: 'Every kind of sound builds its own part of a wide night valley: the bass raises the hills under you, chords and strings hang aurora curtains in the sky, the melody is a glowing path ahead that rises and falls with the tune, snares and claps raise light monoliths along the sides, hi-hats glint in the air, and each kick sends a soft ring across the ground. With a song file, the land ahead is built from what is about to play. Move the pointer to look around.',
  },
  {
    id: 'geometric', name: 'Geometric Intelligence', tagline: 'Every instrument builds its own part', Component: Geometric,
    headline: 'Play a song. Watch each sound build its part.',
    lede: 'The music is split into six kinds of sound, each building its own structure in its own colour: kicks pulse the red core, snares and claps throw orange shards, hi-hats light the gold lattice, the bass raises a violet skyline, chords and strings construct the teal shells, and the melody draws a pink ribbon at its own pitch.',
  },
  {
    id: 'tunnel', name: 'The Impossible Tunnel', tagline: 'An infinite tunnel that transforms with every beat', Component: Tunnel,
    headline: 'Play a song. Fly through it.',
    lede: 'You pass one ring on every beat. With a song file, the tunnel ahead shows what is coming: chambers open for breakdowns, walls close in before drops, and every drop is a gate into a new shape. Steer with the arrow keys and look around with the pointer.',
  },
  {
    id: 'cosmic', name: 'Cosmic Genesis', tagline: 'Music creates galaxies and gravitational waves', Component: CosmicGenesis,
    headline: 'Play a song. Watch it build a galaxy.',
    lede: 'Bass bends gravity, kicks send shockwaves through the disk, hi-hats light individual stars.',
  },
  {
    id: 'liquid', name: 'Liquid Dimension', tagline: 'Reflective liquids flow and collide', Component: LiquidDimension,
    headline: 'Play a song. Watch it pour.',
    lede: 'The bass swells the heavy masses, the mids ripple and swirl the middle, the highs shimmer the droplets. Kicks send waves across the surface; drops tear it apart.',
  },
  {
    id: 'life', name: 'Particle Life', tagline: 'Each song grows its own organisms', Component: ParticleLife,
    headline: 'Play a song. Watch it grow organisms.',
    lede: 'Six species attract and repel each other by rules the song chooses. Bass binds them, kicks scatter them, every drop grows a new ecosystem.',
  },
  {
    id: 'ink', name: 'Ink in Water', tagline: 'Every sound pours its own colour into a living fluid', Component: Ink,
    headline: 'Play a song. Watch it pour.',
    lede: 'A real fluid where each kind of sound adds its own ink: kicks push red bursts from the centre, the bass turns a slow violet whirlpool, chords breathe teal clouds in from the sides, the melody draws a pink stream that rises and falls with the tune, snares dart orange and hi-hats fleck gold. New sections stir the whole tank. Drag to stir it yourself.',
  },
];
