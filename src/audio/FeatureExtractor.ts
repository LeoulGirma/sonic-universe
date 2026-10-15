import { AdaptiveRange, Envelope, RunningStats, clamp01, expCoef } from './dsp';
import { BeatTracker } from './BeatTracker';
import type { MapHit, SongMap } from './songMap';
import { anticipationAt, beatIndexAt } from './songMap';
import { F as FAM, FamilyTracker, NF, famFrame } from './soundFamilies';
import { SPEC_BANDS, SpecLive, specFrame } from './spectrum';

/** Which kinds of sound are playing (see soundFamilies.ts). Index with F.kick … F.lead. */
export interface FamilyFeatures {
  level: number[]; // 0..1 smoothed presence per family
  hit: number[]; // onset impulse per family (jumps to the onset's strength, decays)
  count: number[]; // onsets so far per family (kick uses the confirmed low-hit detector)
  melody: number; // 0..1 height of the moving harmonic part (melody register), smoothed
  hue: number; // 0..1 harmony colour (circle of fifths)
  hueStrength: number; // 0..1 how clearly tonal the sustained part is
}
const createFam = (): FamilyFeatures => ({
  level: new Array(NF).fill(0), hit: new Array(NF).fill(0), count: new Array(NF).fill(0), melody: 0.3, hue: 0, hueStrength: 0,
});
// attack / release (s) per family: percussive families snap, harmonic ones breathe
const FAM_ENV: [number, number][] = [[0.01, 0.14], [0.01, 0.12], [0.005, 0.09], [0.03, 0.25], [0.15, 0.6], [0.03, 0.3]];
const FAM_HIT_TAU = [0.18, 0.14, 0.09, 0.2, 0.6, 0.25];

export type Section = 'silent' | 'groove' | 'breakdown' | 'build' | 'drop';

/**
 * Everything the rest of the app knows about the music, refreshed once per animation frame.
 * Normalised values are 0..1 after adaptive normalisation; impulses jump to ~1 on an event and decay.
 */
export interface MusicFeatures {
  time: number;
  active: boolean; // audio is playing and above the silence floor
  // band energies (normalised + smoothed)
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  // raw band levels in dB, before normalisation (for diagnostics)
  bassDb: number;
  midDb: number;
  highDb: number;
  loudness: number; // normalised RMS
  loudnessDb: number; // dBFS RMS
  centroid: number; // 0..1, log-frequency position of the spectral centroid (60 Hz → 16 kHz)
  centroidHz: number;
  flux: number; // normalised broadband spectral flux (z-score mapped to 0..1)
  // transient impulses
  onset: number; // broadband onset strength, decays ~120 ms
  kick: number; // low-frequency onset impulse, decays ~180 ms
  hat: number; // high-frequency onset impulse, decays ~90 ms
  kickCount: number; // increments on each kick; consumers diff it to detect events
  hatCount: number;
  onsetCount: number;
  // rhythm
  bpm: number;
  beatConfidence: number;
  beatPhase: number; // 0..1 within the current beat
  beat: boolean; // true on the frame a predicted beat lands
  beatCount: number;
  // structure
  intensity: number; // slow composite energy
  breakdown: number; // 0..1, kicks gone and energy below the song's running average
  build: number; // 0..1, rising brightness/density inside a breakdown
  drop: number; // impulse on the first strong kick after a breakdown (or a large energy jump)
  dropCount: number;
  section: Section;
  track: number; // increments every time a new source starts (reset)
  beatIndex: number; // with a song map: index of the last map beat (-1 before the first); live: beats counted so far
  map: SongMap | null; // the whole-song analysis, when one is loaded
  fam: FamilyFeatures;
  spec: Float32Array; // 32-band spectrum 0..1 (40 Hz – 10 kHz), from the song map when there is one
}

export const createFeatures = (): MusicFeatures => ({
  time: 0, active: false,
  bass: 0, lowMid: 0, mid: 0, high: 0, bassDb: -100, midDb: -100, highDb: -100,
  loudness: 0, loudnessDb: -100, centroid: 0.4, centroidHz: 1000, flux: 0,
  onset: 0, kick: 0, hat: 0, kickCount: 0, hatCount: 0, onsetCount: 0,
  bpm: 0, beatConfidence: 0, beatPhase: 0, beat: false, beatCount: 0,
  intensity: 0, breakdown: 0, build: 0, drop: 0, dropCount: 0, section: 'silent', track: 0, beatIndex: -1, map: null,
  fam: createFam(),
  spec: new Float32Array(SPEC_BANDS),
});

/** Frequency bands in Hz. */
const BANDS = {
  bass: [30, 140],
  lowMid: [140, 500],
  mid: [500, 2500],
  high: [2500, 16000],
  kick: [35, 150],
  air: [5000, 16000],
  all: [30, 16000],
} as const;

const SILENCE_DB = -58;

/**
 * Real-time feature extraction from an AnalyserNode-style magnitude spectrum (dB per bin)
 * and time-domain waveform. Pure TypeScript — no Web Audio dependency — so it is unit-tested
 * in Node against synthetic signals with known ground truth.
 */
export class FeatureExtractor {
  readonly f: MusicFeatures = createFeatures();
  private prevDb: Float32Array | null = null;
  private binHz = 1;

  // adaptive normalisers (dB domain)
  private nBass = new AdaptiveRange(-75, -30, 18);
  private nLowMid = new AdaptiveRange(-75, -30, 18);
  private nMid = new AdaptiveRange(-80, -35, 18);
  private nHigh = new AdaptiveRange(-90, -45, 18);
  private nLoud = new AdaptiveRange(-50, -12, 18);

  // smoothing envelopes (attack, release in seconds)
  private eBass = new Envelope(0.025, 0.22);
  private eLowMid = new Envelope(0.05, 0.3);
  private eMid = new Envelope(0.06, 0.35);
  private eHigh = new Envelope(0.02, 0.14);
  private eLoud = new Envelope(0.08, 0.45);
  private eCentroid = new Envelope(0.15, 0.3, 0.4);
  private eFlux = new Envelope(0.02, 0.12);

  // onset statistics
  private sAll = new RunningStats(1.5);
  private sKick = new RunningStats(1.5);
  private sAir = new RunningStats(1.2);
  private lastOnsetT = -1;
  private lastKickT = -10;
  private lastHatT = -1;
  private lastStrongKickT = -10;
  private hitPeaks: number[] = []; // recent confirmed low-hit peak levels (dB)

  private pushHitPeak(db: number) {
    this.hitPeaks.push(db);
    if (this.hitPeaks.length > 32) this.hitPeaks.shift();
  }

  /** 0..1 rank of a peak level among recent hits; neutral-high until there is enough history. */
  private hitRank(db: number) {
    const h = this.hitPeaks;
    if (h.length < 6) return 0.8;
    const sorted = [...h].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const lo = q(0.25);
    const hi = Math.max(q(0.9), lo + 3);
    return clamp01((db - lo) / (hi - lo));
  }
  private lowHist = new Float32Array(3).fill(-200); // last 3 frames of low-band level
  private lowHead = 0;
  /** running bass-minus-mid level (dB) of what is heard: speakers and mics thin the low end */
  private lowBal = 0;
  private lowBalPrimed = false;
  /** seconds the low end has been clearly present: the balance is only trusted after a while */
  private lowSeen = 0;
  private kickCand: { start: number; until: number; peak: number; z: number } | null = null;
  private onsetRate = new Envelope(0.6, 1.5);

  // structure
  private intensityShort = new Envelope(0.6, 0.8);
  private intensityLong = new Envelope(10, 10);
  private intensityMed = new Envelope(4, 4);
  private elapsed = 0;
  private brightShort = new Envelope(0.5, 0.5);
  private brightLong = new Envelope(4, 4);
  private eBreakdown = new Envelope(1.0, 0.35);
  private eBuild = new Envelope(0.8, 0.4);
  private breakdownHeld = 0;
  private dropArmedUntil = -1;
  private armedThisBreakdown = false;
  private lastDropT = -100;
  private silentFor = 0;
  private bassShort = new Envelope(0.3, 0.6);
  private started = false;

  readonly beats = new BeatTracker();
  private famTracker = new FamilyTracker();
  private specLive = new SpecLive();
  private famEnv = FAM_ENV.map(([a, r]) => new Envelope(a, r));
  private famEv = new Int32Array(NF); // next map event per family
  private lastKickCountForFam = 0;
  private kickIdx = -1; // next map kick

  /** Called for every confirmed low-end hit (used by the song-map builder). */
  onHit: ((h: MapHit) => void) | null = null;

  private map: SongMap | null = null;
  private beatIdx = -1;
  private mapBeatCount = 0;
  private lastT = -1;

  get hasMap() {
    return !!this.map && this.map.beats.length > 1;
  }

  /**
   * Hand over a whole-song analysis. Rhythm and structure come from it from now on; bands,
   * hits and hats stay live. The normalisers are primed with the song's real level range.
   */
  setMap(map: SongMap | null) {
    this.map = map;
    this.f.map = map;
    this.beatIdx = -1;
    if (!map) return;
    this.nBass.prime(map.levels.bass[0], map.levels.bass[1]);
    this.nMid.prime(map.levels.mid[0], map.levels.mid[1]);
    this.nHigh.prime(map.levels.high[0], map.levels.high[1]);
    this.nLoud.prime(map.levels.loud[0], map.levels.loud[1]);
  }

  /** Call on track change. Keeps nothing from the previous source. */
  reset() {
    this.map = null;
    this.beatIdx = -1;
    this.mapBeatCount = 0;
    this.lastT = -1;
    const track = this.f.track + 1;
    Object.assign(this.f, createFeatures());
    this.f.track = track;
    this.prevDb = null;
    for (const n of [this.nBass, this.nLowMid, this.nMid, this.nHigh, this.nLoud]) n.reset();
    for (const s of [this.sAll, this.sKick, this.sAir]) s.reset();
    for (const e of [this.eBass, this.eLowMid, this.eMid, this.eHigh, this.eLoud, this.eFlux, this.onsetRate,
      this.intensityShort, this.intensityLong, this.intensityMed, this.brightShort, this.brightLong, this.eBreakdown, this.eBuild, this.bassShort]) e.reset(0);
    this.eCentroid.reset(0.4);
    this.lastOnsetT = -1;
    this.lastKickT = -10;
    this.lastStrongKickT = -10;
    this.hitPeaks = [];
    this.lastHatT = -1;
    this.kickCand = null;
    this.lowBal = 0;
    this.lowBalPrimed = false;
    this.lowSeen = 0;
    this.breakdownHeld = 0;
    this.dropArmedUntil = -1;
    this.armedThisBreakdown = false;
    this.lastDropT = -100;
    this.started = false;
    this.elapsed = 0;
    this.beats.reset();
    this.famTracker.reset();
    this.specLive.reset();
    for (const e of this.famEnv) e.reset(0);
    this.famEv.fill(0);
    this.lastKickCountForFam = 0;
    this.kickIdx = -1;
  }

  /** Call on seek: transient history is invalid, normalisation is kept. */
  seek() {
    this.beatIdx = -1;
    this.prevDb = null;
    this.lowHist.fill(-200);
    this.kickCand = null;
    this.beats.reset();
    this.lastKickT = -10;
    this.famEv.fill(-1); // re-find on the next frame
    this.kickIdx = -1;
  }

  /** Sound families: exact from the song map when there is one, causal live analysis otherwise. */
  private families(freqDb: Float32Array, t: number, dt: number, silent: boolean, jumped: boolean) {
    const fam = this.f.fam;
    for (let k = 0; k < NF; k++) fam.hit[k] *= Math.exp(-dt / FAM_HIT_TAU[k]);
    const tr = this.map?.families;
    const raw: number[] = tr ? tr.level.map((l) => l[famFrame(tr, t)]) : Array.from(this.famTracker.level);
    // live, a causal median can't tell a new bass note's first frames from a kick; the confirmed
    // low-hit detector can (two-stage, low-end share, song ceiling), so it drives the kick family
    if (!tr) raw[FAM.kick] = this.f.kick;
    if (tr) {
      const i = famFrame(tr, t);
      if (tr.melody[i] >= 0) fam.melody += (tr.melody[i] - fam.melody) * expCoef(dt, 0.12);
      fam.hue = tr.hue[i];
      fam.hueStrength = tr.hueStrength[i];
      for (let k = 0; k < NF; k++) {
        const ev = tr.events[k];
        if (jumped || this.famEv[k] < 0) {
          // after a seek: skip to the first event after now, without firing
          let lo = 0, hi = ev.length;
          while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m] <= t) lo = m + 1; else hi = m; }
          this.famEv[k] = lo;
          continue;
        }
        while (this.famEv[k] < ev.length && ev[this.famEv[k]] <= t) {
          if (k !== FAM.kick) {
            fam.count[k]++;
            fam.hit[k] = Math.max(fam.hit[k], tr.eventStrength[k][this.famEv[k]]);
          }
          this.famEv[k]++;
        }
      }
    } else {
      this.famTracker.process(freqDb, this.binHz, t, dt, !silent);
      const m = this.famTracker.onsetMask;
      for (let k = 0; k < NF; k++) {
        if (k !== FAM.kick && m & (1 << k)) {
          fam.count[k]++;
          fam.hit[k] = Math.max(fam.hit[k], this.famTracker.onsetStrength[k]);
        }
      }
      if (this.famTracker.melody >= 0) fam.melody += (this.famTracker.melody - fam.melody) * expCoef(dt, 0.12);
      fam.hue = this.famTracker.hue;
      fam.hueStrength = this.famTracker.hueStrength;
    }
    // kick onsets: with a song map, its confirmed hits at their exact (latency-corrected) times;
    // live, the confirmed low-hit detector (it rejects bass-note attacks)
    const mk = this.map?.kicks;
    if (mk && mk.t.length) {
      if (jumped || this.kickIdx < 0) {
        let lo = 0, hi = mk.t.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (mk.t[m] <= t) lo = m + 1; else hi = m; }
        this.kickIdx = lo;
      } else {
        while (this.kickIdx < mk.t.length && mk.t[this.kickIdx] <= t) {
          fam.count[FAM.kick]++;
          fam.hit[FAM.kick] = Math.max(fam.hit[FAM.kick], mk.strength[this.kickIdx]);
          this.kickIdx++;
        }
      }
      this.lastKickCountForFam = this.f.kickCount;
    } else if (this.f.kickCount !== this.lastKickCountForFam) {
      if (this.f.kickCount > this.lastKickCountForFam) {
        fam.count[FAM.kick]++;
        fam.hit[FAM.kick] = Math.max(fam.hit[FAM.kick], this.f.kick);
      }
      this.lastKickCountForFam = this.f.kickCount;
    }
    for (let k = 0; k < NF; k++) fam.level[k] = this.famEnv[k].step(silent ? 0 : raw[k], dt);
  }

  private bandDb(db: Float32Array, lo: number, hi: number) {
    const i0 = Math.max(1, Math.floor(lo / this.binHz));
    const i1 = Math.min(db.length - 1, Math.ceil(hi / this.binHz));
    let p = 0;
    for (let i = i0; i <= i1; i++) p += Math.pow(10, db[i] / 10);
    return 10 * Math.log10(p / (i1 - i0 + 1) + 1e-12);
  }

  private bandFlux(db: Float32Array, prev: Float32Array, lo: number, hi: number) {
    const i0 = Math.max(1, Math.floor(lo / this.binHz));
    const i1 = Math.min(db.length - 1, Math.ceil(hi / this.binHz));
    let s = 0;
    for (let i = i0; i <= i1; i++) {
      // log-magnitude difference, half-wave rectified; floor at -100 dB to ignore numerical noise
      const d = Math.max(db[i], -100) - Math.max(prev[i], -100);
      if (d > 0) s += d;
    }
    return s / (i1 - i0 + 1) / 20; // in log10 units per bin
  }

  /**
   * @param freqDb   magnitude spectrum in dB, length fftSize/2 (AnalyserNode.getFloatFrequencyData)
   * @param timeData waveform in [-1, 1] (AnalyserNode.getFloatTimeDomainData)
   * @param t        playback time in seconds (monotonic within a track)
   * @param dt       seconds since the previous call
   */
  process(freqDb: Float32Array, timeData: Float32Array, sampleRate: number, t: number, dt: number) {
    const f = this.f;
    dt = Math.min(Math.max(dt, 1e-4), 0.1);
    this.binHz = sampleRate / (freqDb.length * 2);
    f.time = t;

    // --- loudness ---------------------------------------------------------
    let ss = 0;
    for (let i = 0; i < timeData.length; i++) ss += timeData[i] * timeData[i];
    const rms = Math.sqrt(ss / timeData.length);
    f.loudnessDb = 20 * Math.log10(rms + 1e-9);
    this.silentFor = f.loudnessDb < SILENCE_DB ? this.silentFor + dt : 0;
    const silent = this.silentFor > 0.4;
    f.active = !silent;

    // --- band energies ----------------------------------------------------
    f.bassDb = this.bandDb(freqDb, BANDS.bass[0], BANDS.bass[1]);
    const lowMidDb = this.bandDb(freqDb, BANDS.lowMid[0], BANDS.lowMid[1]);
    f.midDb = this.bandDb(freqDb, BANDS.mid[0], BANDS.mid[1]);
    f.highDb = this.bandDb(freqDb, BANDS.high[0], BANDS.high[1]);

    if (silent) {
      // let everything relax toward zero without corrupting the normalisers with silence
      f.bass = this.eBass.step(0, dt);
      f.lowMid = this.eLowMid.step(0, dt);
      f.mid = this.eMid.step(0, dt);
      f.high = this.eHigh.step(0, dt);
      f.loudness = this.eLoud.step(0, dt);
      f.flux = this.eFlux.step(0, dt);
    } else {
      this.started = true;
      f.bass = this.eBass.step(this.nBass.step(f.bassDb, dt), dt);
      f.lowMid = this.eLowMid.step(this.nLowMid.step(lowMidDb, dt), dt);
      f.mid = this.eMid.step(this.nMid.step(f.midDb, dt), dt);
      f.high = this.eHigh.step(this.nHigh.step(f.highDb, dt), dt);
      f.loudness = this.eLoud.step(this.nLoud.step(f.loudnessDb, dt), dt);
    }

    // --- spectral centroid (power-weighted, 60 Hz – 16 kHz) ---------------
    {
      const i0 = Math.max(1, Math.floor(60 / this.binHz));
      const i1 = Math.min(freqDb.length - 1, Math.ceil(16000 / this.binHz));
      let num = 0;
      let den = 0;
      for (let i = i0; i <= i1; i++) {
        const p = Math.pow(10, freqDb[i] / 10);
        num += p * i * this.binHz;
        den += p;
      }
      if (den > 1e-12 && !silent) {
        f.centroidHz = num / den;
        const pos = Math.log2(Math.max(f.centroidHz, 60) / 60) / Math.log2(16000 / 60);
        f.centroid = this.eCentroid.step(clamp01(pos), dt);
      }
    }

    // --- spectral flux & onsets ------------------------------------------
    const decay = (v: number, tau: number) => v * Math.exp(-dt / tau);
    f.onset = decay(f.onset, 0.12);
    f.kick = decay(f.kick, 0.18);
    f.hat = decay(f.hat, 0.09);
    f.drop = decay(f.drop, 1.6);

    if (this.prevDb && !silent) {
      const prev = this.prevDb;
      const all = this.bandFlux(freqDb, prev, BANDS.all[0], BANDS.all[1]);
      const kick = this.bandFlux(freqDb, prev, BANDS.kick[0], BANDS.kick[1]);
      const air = this.bandFlux(freqDb, prev, BANDS.air[0], BANDS.air[1]);

      const z = (x: number, s: RunningStats, minStd: number) => (x - s.mean) / Math.max(s.std, minStd);
      const zAll = z(all, this.sAll, 0.004);
      const zKick = z(kick, this.sKick, 0.01);
      const zAir = z(air, this.sAir, 0.004);

      f.flux = this.eFlux.step(clamp01(zAll / 4), dt);

      if (zAll > 2 && t - this.lastOnsetT > 0.09) {
        this.lastOnsetT = t;
        f.onset = Math.max(f.onset, clamp01(0.3 + (zAll - 2) / 5));
        f.onsetCount++;
        this.onsetRate.value += 0.25;
        this.beats.addOnset(t, false);
      }
      // Low-end hit detection (kicks, and bass notes that hit nearly as hard), two stages:
      //  1. a low-band (35–150 Hz) spectral-flux onset opens a ~55 ms candidate window;
      //  2. it is confirmed if the low-band level in that window peaks within 6 dB of the loudest
      //     low end this song has produced (the adaptive ceiling). Quiet rumble never qualifies.
      // Strength scales with how close the peak gets to the ceiling, so the loudest hits — almost
      // always the kick drum — drive the biggest shockwaves, and only those steer the beat grid.
      // onset = sharp low-band flux, or a ≥4.5 dB level rise over ~50 ms (the analyser window
      // overlaps between frames, which smears flux across frames but not the level rise)
      let minRecent = f.bassDb;
      for (let i = 0; i < this.lowHist.length; i++) minRecent = Math.min(minRecent, this.lowHist[i]);
      const rise = f.bassDb - minRecent;
      // live, the low end is judged against the room's own balance: through laptop speakers and a
      // mic a kick barely clears the mids, so a fixed "6 dB over the mids" never passes there
      const bal = f.bassDb - f.midDb;
      if (!this.lowBalPrimed) { this.lowBal = bal; this.lowBalPrimed = true; }
      else this.lowBal += (bal - this.lowBal) * (1 - Math.exp(-dt / 4));
      if (bal > -30) this.lowSeen += dt;
      const live = !this.map && this.lowSeen > 6;
      const shareMin = live ? Math.max(-3, Math.min(6, this.lowBal + 5)) : 6;
      const strongMin = live ? Math.max(3, Math.min(15, this.lowBal + 11)) : 15;
      if (!this.kickCand && (zKick > 2.0 || rise > 4.5) && t - this.lastKickT > 0.07) {
        this.kickCand = { start: t, until: t + 0.055, peak: -200, z: Math.max(zKick, rise / 2) };
      }
      if (this.kickCand) {
        const c = this.kickCand;
        c.peak = Math.max(c.peak, f.bassDb);
        const margin = c.peak - (this.nBass.ceil - 6); // 0..6 dB
        if (t >= c.until || margin >= 4.5) {
          // the low end must also dominate the mids (kicks do; pads, congas and leakage don't)
          const lowShare = c.peak - f.midDb;
          if (margin > 0 && lowShare > shareMin && c.peak > -75 && f.loudnessDb > SILENCE_DB) {
            // Strength is relative to this song's own recent hits (rank between its 25th and 90th
            // percentile peak levels), so dense real mixes don't saturate every hit at full size.
            const rel = this.hitRank(c.peak);
            this.pushHitPeak(c.peak);
            const strong = margin >= 3 && lowShare > strongMin; // structure + tempo; rank only shapes size
            const share = clamp01((lowShare - shareMin) / 20);
            this.lastKickT = c.start; // refractory counts from the onset, not the confirmation
            const strength = clamp01((0.2 + 0.8 * Math.pow(rel, 1.3)) * (0.5 + 0.5 * share));
            f.kick = Math.max(f.kick, strength);
            f.kickCount++;
            this.onHit?.({ start: c.start, strength: 0.3 + rel, strong, peak: c.peak });
            this.beats.addOnset(t, strong, 0.3 + rel);
            if (strong) {
              this.lastStrongKickT = c.start;
              this.onKick(t);
            }
          }
          this.kickCand = null;
        }
      }
      this.lowHist[this.lowHead] = f.bassDb;
      this.lowHead = (this.lowHead + 1) % this.lowHist.length;
      if (zAir > 2.2 && t - this.lastHatT > 0.07) {
        this.lastHatT = t;
        f.hat = Math.max(f.hat, clamp01(0.3 + (zAir - 2.2) / 5));
        f.hatCount++;
      }
      // update statistics after testing, with outliers clamped so peaks don't inflate the threshold
      // (the clamp uses the same std floor as the z-score, otherwise a tiny initial std starves the estimate)
      const upd = (x: number, s: RunningStats, minStd: number) => s.step(Math.min(x, s.mean + 3 * Math.max(s.std, minStd)), dt);
      upd(all, this.sAll, 0.004);
      upd(kick, this.sKick, 0.01);
      upd(air, this.sAir, 0.004);
    }
    if (!this.prevDb || this.prevDb.length !== freqDb.length) this.prevDb = new Float32Array(freqDb.length);
    this.prevDb.set(freqDb);

    // --- rhythm -------------------------------------------------------------
    this.beats.update(t);
    const map = this.map;
    const jumped = Math.abs(t - this.lastT) > 0.5; // a seek or a stall: don't fire crossings
    if (map && map.beats.length > 1) {
      // look-ahead grid from the song map: exact from the first beat, unaffected by seeks
      const b = map.beats;
      const i = beatIndexAt(b, t, this.beatIdx);
      f.beat = !jumped && i >= 0 && i !== this.beatIdx && i - this.beatIdx <= 2;
      if (f.beat) this.mapBeatCount++;
      this.beatIdx = i;
      const a = i >= 0 ? b[i] : b[0] - (b[1] - b[0]);
      const nx = i >= 0 ? (i + 1 < b.length ? b[i + 1] : b[i] + (b[i] - b[i - 1])) : b[0];
      f.beatPhase = clamp01((t - a) / Math.max(1e-3, nx - a));
      f.bpm = 60 / Math.max(1e-3, nx - a);
      f.beatConfidence = map.beatConfidence;
      f.beatCount = this.mapBeatCount;
      f.beatIndex = i;
    } else {
      f.bpm = this.beats.bpm;
      f.beatConfidence = this.beats.confidence;
      f.beatPhase = this.beats.phase;
      f.beat = this.beats.beat;
      f.beatCount = this.beats.beatCount;
      f.beatIndex = this.beats.beatCount;
    }

    // --- structure ------------------------------------------------------
    this.onsetRate.step(0, dt);
    const density = clamp01(this.onsetRate.value / 2);
    const inten = silent ? 0 : clamp01(0.5 * f.loudness + 0.3 * f.bass + 0.2 * density);
    f.intensity = this.intensityShort.step(inten, dt);
    if (!silent) this.elapsed += dt;
    // long-term average: time constant grows with elapsed time so it is meaningful from the start
    const long = this.elapsed < 10
      ? (this.intensityLong.value += (inten - this.intensityLong.value) * expCoef(dt, Math.max(0.5, this.elapsed)))
      : this.intensityLong.step(inten, dt);
    const med = this.elapsed < 4
      ? (this.intensityMed.value += (inten - this.intensityMed.value) * expCoef(dt, Math.max(0.5, this.elapsed)))
      : this.intensityMed.step(inten, dt);
    const bassS = this.bassShort.step(f.bass, dt);
    const sinceKick = t - this.lastStrongKickT;

    if (map) {
      // structure from the song map: whole-span breakdowns, a build that ramps BEFORE the drop,
      // and the drop fired on its beat (no "first kick after" latency)
      const inBrk = map.breakdowns.some(([a, b]) => t >= a && t < b);
      f.breakdown = this.eBreakdown.step(inBrk ? 1 : 0, dt);
      f.build = anticipationAt(map, t);
      if (!jumped) for (const d of map.drops) if (this.lastT < d.t && d.t <= t) this.triggerDrop(t, d.strength);
    } else {
      // entering a breakdown needs the kick gone AND energy/bass below the song's norm;
      // leaving it needs only the kick to come back (risers can be loud, they're still the breakdown)
      const kickGone = !silent && this.started && sinceKick > 1.8;
      const entering = f.intensity < long - 0.04 || bassS < 0.35;
      const breakdownTarget = kickGone && (entering || f.breakdown > 0.5) ? 1 : 0;
      f.breakdown = this.eBreakdown.step(breakdownTarget, dt);
      // arm the drop once per breakdown (held ≥ 2 s); re-arming needs the breakdown to end first
      if (f.breakdown > 0.6) {
        this.breakdownHeld += dt;
        if (this.breakdownHeld > 2 && !this.armedThisBreakdown) {
          this.dropArmedUntil = t + 12;
          this.armedThisBreakdown = true;
        }
        if (this.armedThisBreakdown && this.dropArmedUntil > 0) this.dropArmedUntil = Math.max(this.dropArmedUntil, t + 4);
      } else {
        this.breakdownHeld = 0;
        if (f.breakdown < 0.3) this.armedThisBreakdown = false;
      }

      const bright = 0.5 * f.high + 0.5 * f.centroid;
      const bs = this.brightShort.step(bright, dt);
      const bl = this.brightLong.step(bright, dt);
      f.build = this.eBuild.step(f.breakdown > 0.3 ? clamp01((bs - bl) * 6 + density * 0.5 - 0.15) : 0, dt);

      // energy-jump drop for songs without a clear breakdown: a fast rise relative to the last few seconds
      if (!silent && f.kick > 0.3 && f.intensity - med > 0.2 && t - this.lastDropT > 10 && this.elapsed > 8) this.triggerDrop(t, 0.7);
    }
    this.families(freqDb, t, dt, silent, jumped);
    const sp = this.map?.spectrum;
    if (sp) {
      const j = specFrame(sp, t) * SPEC_BANDS;
      for (let k = 0; k < SPEC_BANDS; k++) f.spec[k] = silent ? 0 : sp.data[j + k] / 255;
    } else {
      this.specLive.process(freqDb, this.binHz, dt, !silent);
      f.spec.set(this.specLive.level);
    }
    this.lastT = t;

    f.section = silent
      ? 'silent'
      : f.drop > 0.3
        ? 'drop'
        : f.build > 0.35
          ? 'build'
          : f.breakdown > 0.5
            ? 'breakdown'
            : 'groove';
    // keep the slow decay of the beat-confidence honest during silence
    if (silent) f.beatConfidence *= 1 - expCoef(dt, 2);
    return f;
  }

  private onKick(t: number) {
    if (this.map) return; // the song map places drops
    if (t < this.dropArmedUntil && t - this.lastDropT > 8) {
      this.dropArmedUntil = -1;
      this.triggerDrop(t, 1);
    }
  }

  private triggerDrop(t: number, strength: number) {
    this.lastDropT = t;
    this.f.drop = Math.max(this.f.drop, strength);
    this.f.dropCount++;
  }
}
