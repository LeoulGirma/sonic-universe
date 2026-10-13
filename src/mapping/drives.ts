import type { MusicFeatures } from '../audio/FeatureExtractor';
import type { SongMap } from '../audio/songMap';
import type { MappingGains } from '../store/useStore';
import { Envelope, expCoef } from '../audio/dsp';
import { NF } from '../audio/soundFamilies';

/** Sound families as drives (index with F.kick … F.lead from soundFamilies). */
export interface FamilyDrives {
  level: number[]; // 0..~1.3 presence, sensitivity applied
  hit: number[]; // onset impulse per family
  events: number[]; // monotonically increasing onset counters per family
  melody: number; // 0..1 register of the moving part
  hue: number; // 0..1 harmony colour (circle of fifths)
  hueStrength: number;
}

/**
 * Layer 2 — music feature mapping.
 *
 * Translates measured features into world-agnostic "drives" (what the music is asking the
 * universe to do). Worlds consume drives, never raw audio, so a new world only has to decide
 * what gravity / pulse / shimmer / flow / calm / tension / release mean for it.
 */
export interface Drives {
  time: number;
  idle: number; // 1 when nothing is playing → ambient motion only
  gravity: number; // bass, fast attack: breathing gravitational pulse
  pulse: number; // kick impulse
  shimmer: number; // high-band energy
  sparkle: number; // hi-hat impulse
  flow: number; // midrange energy
  energy: number; // overall intensity
  calm: number; // breakdown amount
  tension: number; // build-up inside a breakdown
  release: number; // drop impulse
  hue: number; // spectral centroid 0..1 (dark ↔ bright timbre)
  beatPhase: number;
  bpm: number;
  confidence: number;
  // monotonically increasing event counters; consumers diff them to spawn discrete effects
  kickEvents: number;
  hatEvents: number;
  dropEvents: number;
  beatEvents: number;
  lastKick: number; // strength of the most recent kick
  // timbre (slow): used by worlds that derive identity from the song
  track: number; // changes when a new song / source starts
  centroidHz: number; // smoothed spectral centroid
  tilt: number; // smoothed bass-minus-treble level in dB (spectral balance)
  activeTime: number; // seconds of non-silent audio in this track so far
  // rhythm position, for worlds that place things on the beat grid
  beatIndex: number; // see MusicFeatures.beatIndex
  songTime: number; // playback time in seconds
  map: SongMap | null; // whole-song structure (beats, breakdowns, drops, build-ups) when available
  fam: FamilyDrives;
}

export const createDrives = (): Drives => ({
  time: 0, idle: 1, gravity: 0, pulse: 0, shimmer: 0, sparkle: 0, flow: 0, energy: 0, calm: 0, tension: 0,
  release: 0, hue: 0.4, beatPhase: 0, bpm: 0, confidence: 0, kickEvents: 0, hatEvents: 0, dropEvents: 0, beatEvents: 0, lastKick: 0,
  track: 0, centroidHz: 1000, tilt: 0, activeTime: 0, beatIndex: -1, songTime: 0, map: null,
  fam: { level: new Array(NF).fill(0), hit: new Array(NF).fill(0), events: new Array(NF).fill(0), melody: 0.3, hue: 0, hueStrength: 0 },
});

/** soft knee so high sensitivity saturates gracefully instead of clipping */
const soft = (x: number) => (x <= 0 ? 0 : x < 1 ? x : 1 + Math.tanh(x - 1) * 0.35);

export class DriveMapper {
  readonly d = createDrives();
  private idleEnv = new Envelope(1.2, 0.3, 1);

  update(f: MusicFeatures, g: MappingGains, sensitivity: number, dt: number): Drives {
    const d = this.d;
    const s = sensitivity;
    d.time += dt;
    d.idle = this.idleEnv.step(f.active ? 0 : 1, dt);
    const live = 1 - d.idle;
    // shape: bass is squared-ish so only real low-end drives big motion
    d.gravity = soft(Math.pow(f.bass, 1.4) * g.bass * s) * live;
    d.pulse = soft(f.kick * g.kick * s) * live;
    d.shimmer = soft(f.high * g.high * s) * live;
    d.sparkle = soft(f.hat * g.high * s) * live;
    d.flow = soft(f.mid * g.mid * s) * live;
    d.energy = soft(f.intensity * s) * live;
    d.calm = f.breakdown * live;
    d.tension = f.build * live;
    d.release = f.drop * live;
    d.hue += (f.centroid - d.hue) * expCoef(dt, 0.6);
    if (f.track !== d.track) {
      d.track = f.track;
      d.activeTime = 0;
      this.lk = this.lh = this.ld = 0;
      this.lf.fill(0);
    }
    if (f.active) {
      d.activeTime += dt;
      const k = expCoef(dt, Math.min(3, Math.max(0.3, d.activeTime)));
      d.centroidHz += (f.centroidHz - d.centroidHz) * k;
      d.tilt += (f.bassDb - f.highDb - d.tilt) * k;
    }
    d.beatPhase = f.beatPhase;
    d.beatIndex = f.beatIndex;
    d.songTime = f.time;
    d.map = f.map;
    d.bpm = f.bpm;
    d.confidence = f.beatConfidence;
    // counters reset to 0 when a new track loads, so only count increases as events
    if (f.kickCount > this.lk) { d.kickEvents++; d.lastKick = f.kick * g.kick * s; }
    if (f.hatCount > this.lh) d.hatEvents++;
    if (f.dropCount > this.ld) d.dropEvents++;
    if (f.beat) d.beatEvents++;
    this.lk = f.kickCount; this.lh = f.hatCount; this.ld = f.dropCount;
    const ff = f.fam, df = d.fam;
    for (let k = 0; k < NF; k++) {
      df.level[k] = soft(ff.level[k] * s) * live;
      df.hit[k] = ff.hit[k] * live;
      if (ff.count[k] > this.lf[k]) df.events[k]++;
      this.lf[k] = ff.count[k];
    }
    df.melody = ff.melody;
    df.hue = ff.hue;
    df.hueStrength = ff.hueStrength * live;
    return d;
  }
  private lf = new Array(NF).fill(0);
  private lk = 0;
  private lh = 0;
  private ld = 0;
}
