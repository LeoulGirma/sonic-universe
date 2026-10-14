/**
 * Places a song's raw profile against the reference library (libraryRef.ts) and turns it into
 * the few numbers the worlds use to set themselves up for that song: energy and brightness
 * (0..1, evenly spread over the library) and what the song is built around.
 */
import { LIB, ENERGY_W, BRIGHT_W } from './libraryRef';
import type { RawProfile } from './songProfile';

export const TRAITS = ['bass', 'groove', 'melody', 'space', 'arc'] as const;
export type Trait = (typeof TRAITS)[number];

export interface SongMood {
  energy: number; // 0 calmest … 1 most intense, relative to the library
  bright: number; // 0 dark … 1 bright
  traits: Record<Trait, number>; // 0..1 percentiles
  lead: Trait; // the trait the song is most built around
}

/** percentile of v within a 21-point quantile table */
function place(t: number[] | undefined, v: number) {
  if (!t || !(t[t.length - 1] > t[0])) return 0.5;
  if (v <= t[0]) return 0;
  if (v >= t[t.length - 1]) return 1;
  let i = 1;
  while (t[i] < v) i++;
  const a = t[i - 1], b = t[i];
  return (i - 1 + (b > a ? (v - a) / (b - a) : 0.5)) / (t.length - 1);
}

function features(p: RawProfile): Record<string, number> {
  const s = p.share;
  return {
    loud: p.loud, dyn: p.dyn, cent: Math.log(Math.max(p.centroid, 1)), bpm: p.bpm, pulse: p.pulse,
    kick: p.kickRate, ons: p.onsetRate, notes: p.noteRate, mode: p.mode, keyc: p.keyClarity,
    mel: p.melody, chord: p.chordRate, drops: p.drops, brk: p.breakdown,
    low: s[0] + s[3], perc: s[0] + s[1] + s[2], lead: s[5], pads: s[4],
    third: p.third ?? 0, flat: p.flat ?? 0, hiShare: p.hiShare ?? 0,
  };
}

export function songMood(p: RawProfile): SongMood {
  const f = features(p);
  const P = (k: string) => place(LIB[k], f[k]);
  const comp = (W: Record<string, number>) => {
    let s = 0, w = 0;
    for (const k in W) { const x = P(k); s += (W[k] > 0 ? x : 1 - x) * Math.abs(W[k]); w += Math.abs(W[k]); }
    return w ? s / w : 0.5;
  };
  const traits: Record<Trait, number> = {
    bass: P('low'),
    groove: (P('pulse') + P('kick') + P('perc')) / 3,
    melody: (P('lead') + P('mel')) / 2,
    space: (P('pads') + 1 - P('ons')) / 2,
    arc: (P('dyn') + P('drops') + P('brk')) / 3,
  };
  let lead: Trait = 'bass';
  for (const t of TRAITS) if (traits[t] > traits[lead]) lead = t;
  return { energy: place(LIB._energy, comp(ENERGY_W)), bright: place(LIB._bright, comp(BRIGHT_W)), traits, lead };
}

/** a neutral mood (no song map yet, or live input) */
export const NEUTRAL_MOOD: SongMood = {
  energy: 0.5, bright: 0.5, traits: { bass: 0.5, groove: 0.5, melody: 0.5, space: 0.5, arc: 0.5 }, lead: 'bass',
};
