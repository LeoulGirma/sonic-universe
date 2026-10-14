/**
 * The conductor: one shared, smoothed reading of what the music is doing, for every world.
 *
 * Worlds used to read raw drives and each smooth them their own way (or not). The conductor
 * eases everything with critically damped springs so motion glides between analysis frames,
 * and adds what a listener feels but a single frame can't show:
 * - the build before a drop (rising), the drop itself (an impulse that rings out), breakdowns;
 * - the song's sections: which one we're in, the moment a new one starts, how far through it is;
 * - the song's mood (song mood on): a palette and per-element gains every world can use, eased
 *   so a DJ mix morphs one song's world into the next.
 */
import * as THREE from 'three';
import type { Drives } from './drives';
import { Spring } from '../audio/dsp';
import { NF } from '../audio/soundFamilies';
import { songMood, type SongMood, type Trait } from '../audio/songMood';
import type { SongMap } from '../audio/songMap';

// song palettes, shadows → highlights, at the four corners of energy × brightness
export const P_LO = { calmDark: '#1b2a6b', calmBright: '#6a3d8f', hotDark: '#7a0f2a', hotBright: '#b0247a' };
export const P_HI = { calmDark: '#9fd8ff', calmBright: '#ffd2a6', hotDark: '#ff8a3c', hotBright: '#ffe066' };
export const P_BG = { calmDark: '#0a1a44', calmBright: '#3d2347', hotDark: '#3a0a16', hotBright: '#4a2a0a' };
type Corner = keyof typeof P_LO;
export const quad = (tab: Record<Corner, string>, e: number, b: number) => {
  const c = (k: Corner) => new THREE.Color(tab[k]);
  return c('calmDark').lerp(c('calmBright'), b).lerp(c('hotDark').lerp(c('hotBright'), b), e);
};

export interface Look {
  /** 0 = the world's own colours, ~0.8 = recoloured into the song's palette */
  amt: number;
  lo: THREE.Color;
  hi: THREE.Color;
  bg: THREE.Color;
  sat: number;
  energy: number;
  bright: number;
  /** how much each element should lead (1 = as designed) */
  gain: Record<Trait, number>;
}

const neutralLook = (): Look => ({
  amt: 0, lo: new THREE.Color(0x777777), hi: new THREE.Color(0xffffff), bg: new THREE.Color(0x05061a), sat: 1, energy: 0.5, bright: 0.5,
  gain: { bass: 1, groove: 1, melody: 1, space: 1, arc: 1 },
});

function lookOf(m: SongMood | null): Look {
  if (!m) return neutralLook();
  const { energy: e, bright: b, traits: t, lead } = m;
  const lb = (k: Trait) => (lead === k ? 0.35 : 0);
  return {
    amt: 0.75, lo: quad(P_LO, e, b), hi: quad(P_HI, e, b), bg: quad(P_BG, e, b).multiplyScalar(0.5), sat: 1 + 0.3 * e, energy: e, bright: b,
    gain: {
      bass: 0.55 + 0.9 * t.bass + lb('bass'), groove: 0.5 + 1.0 * t.groove + lb('groove'), melody: 0.5 + 1.1 * t.melody + lb('melody'),
      space: 0.5 + 0.9 * t.space + lb('space'), arc: 0.7 + 0.9 * t.arc + lb('arc'),
    },
  };
}

const lum = (c: THREE.Color) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

export class Conductor {
  // smoothed levels
  energy = 0;
  fam = new Array(NF).fill(0);
  bass = 0;
  mid = 0;
  high = 0;
  // structure
  /** 0..1 rising through the build before a drop (from the song map), eased */
  build = 0;
  /** 0..1 inside a breakdown, eased */
  calm = 0;
  /** rings out after each drop (1 → 0 over ~1.5 s) */
  drop = 0;
  /** rings out after a new section starts (1 → 0 over ~2 s) */
  sectionHit = 0;
  section = -1;
  sectionLabel = 0;
  /** 0..1 through the current section */
  sectionProgress = 0;
  // mood
  mood: SongMood | null = null;
  look: Look = neutralLook();
  private target: Look = neutralLook();
  private tau = 1.2;

  private sE = new Spring(); private sF = Array.from({ length: NF }, () => new Spring());
  private sB = new Spring(); private sM = new Spring(); private sH = new Spring();
  private sBuild = new Spring(); private sCalm = new Spring();
  private lastDrop = -1;
  private lastMap: SongMap | null = null;
  private wantMood = false;

  /** call once per frame after the drives are mapped */
  update(dt: number, d: Drives, moodOn: boolean) {
    dt = Math.min(dt, 0.1);
    this.energy = this.sE.step(d.energy, dt, 3);
    for (let k = 0; k < NF; k++) this.fam[k] = this.sF[k].step(d.fam.level[k], dt, k <= 2 ? 5 : 1.6);
    this.bass = this.sB.step(d.gravity, dt, 4);
    this.mid = this.sM.step(d.flow, dt, 3);
    this.high = this.sH.step(Math.min(1.5, d.shimmer + d.sparkle), dt, 5);
    this.build = this.sBuild.step(d.tension, dt, 1.5);
    this.calm = this.sCalm.step(d.calm, dt, 0.8);
    if (this.lastDrop < 0) this.lastDrop = d.dropEvents;
    if (d.dropEvents !== this.lastDrop) { this.lastDrop = d.dropEvents; this.drop = 1; }
    this.drop *= Math.exp(-dt / 0.6);

    // sections from the song map
    const secs = d.map?.sections ?? [];
    let si = -1;
    for (let i = 0; i < secs.length; i++) if (secs[i].start <= d.songTime) si = i;
    if (si !== this.section) {
      if (this.section >= 0 && si >= 0 && d.map === this.lastMap) this.sectionHit = 1;
      this.section = si;
      this.sectionLabel = si >= 0 ? secs[si].label : 0;
    }
    this.sectionHit *= Math.exp(-dt / 0.9);
    this.sectionProgress = si >= 0 ? Math.min(1, Math.max(0, (d.songTime - secs[si].start) / Math.max(1, secs[si].end - secs[si].start))) : 0;

    // mood: placed once per song map; between two songs (a mix) the world morphs slowly
    const map = d.map && d.map.profile ? d.map : null;
    if (map !== this.lastMap || moodOn !== this.wantMood) {
      const prev = this.mood;
      this.mood = map?.profile ? songMood(map.profile) : null;
      this.tau = prev && this.mood && map !== this.lastMap ? 5 : 1.2;
      this.target = lookOf(moodOn ? this.mood : null);
      this.lastMap = map;
      this.wantMood = moodOn;
    }
    const k = 1 - Math.exp(-dt / this.tau);
    const L = this.look, T = this.target;
    L.amt += (T.amt - L.amt) * k;
    L.lo.lerp(T.lo, k); L.hi.lerp(T.hi, k); L.bg.lerp(T.bg, k);
    L.sat += (T.sat - L.sat) * k;
    L.energy += (T.energy - L.energy) * k;
    L.bright += (T.bright - L.bright) * k;
    for (const g of Object.keys(L.gain) as Trait[]) L.gain[g] += (T.gain[g] - L.gain[g]) * k;
  }

  /** a colour recoloured into the song's palette by its brightness (identity when mood is off) */
  grade(src: THREE.Color, out: THREE.Color) {
    const L = this.look;
    out.copy(src);
    if (L.amt < 0.001 && Math.abs(L.sat - 1) < 0.001) return out;
    const l = lum(src);
    const p = new THREE.Color().copy(L.lo).lerp(L.hi, Math.min(1, Math.max(0, (l - 0.02) / 0.78)));
    const pl = Math.max(1e-3, lum(p));
    out.lerp(p.multiplyScalar(l / pl), L.amt);
    const l2 = lum(out);
    out.r = Math.max(0, l2 + (out.r - l2) * L.sat);
    out.g = Math.max(0, l2 + (out.g - l2) * L.sat);
    out.b = Math.max(0, l2 + (out.b - l2) * L.sat);
    return out;
  }

  /** debug harness: snap the mood look instead of easing */
  snap() {
    const T = this.target, L = this.look;
    L.amt = T.amt; L.lo.copy(T.lo); L.hi.copy(T.hi); L.bg.copy(T.bg); L.sat = T.sat; L.energy = T.energy; L.bright = T.bright;
    Object.assign(L.gain, T.gain);
  }
}

export const conductor = new Conductor();
