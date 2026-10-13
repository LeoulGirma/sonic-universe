import { TimeRing } from './dsp';

const BPM_MIN = 70;
const BPM_MAX = 180;
const BIN = 0.5; // bpm resolution
const NBINS = Math.round((BPM_MAX - BPM_MIN) / BIN) + 1;
const WINDOW = 8; // seconds of onset history considered

/**
 * Approximate beat tracker.
 *
 * 1. Tempo: every pair of recent onsets votes for the periods d/k (k = 1..8) into a
 *    Gaussian-smoothed BPM histogram, weighted by recency and 1/√k, then multiplied by a
 *    broad log-normal prior centred on 120 BPM to resolve octave ambiguity.
 * 2. Phase: a simple phase-locked loop nudges the predicted beat grid toward onsets that land
 *    within ±20 % of a period from a predicted beat.
 *
 * Kick onsets are preferred; if a passage has no kicks, broadband onsets are used instead.
 */
export class BeatTracker {
  bpm = 0;
  confidence = 0;
  phase = 0;
  beat = false;
  beatCount = 0;

  private kicks = new TimeRing(48);
  private kickW = new TimeRing(48); // strengths, pushed in lockstep with `kicks`
  private phaseVotes = 0;
  private onsets = new TimeRing(64);
  private hist = new Float64Array(NBINS);
  private lastEstimate = -1;
  private candidate = 0;
  private candidateHits = 0;
  private lastBeat = 0;
  private lastOnset = -10;
  private lastKickLock = -100;

  reset() {
    this.kicks.clear();
    this.kickW.clear();
    this.onsets.clear();
    this.phaseVotes = 0;
    this.bpm = 0;
    this.confidence = 0;
    this.phase = 0;
    this.beat = false;
    this.lastEstimate = -1;
    this.candidate = 0;
    this.candidateHits = 0;
    this.lastOnset = -10;
    this.lastKickLock = -100;
  }

  addOnset(t: number, isKick: boolean, strength = 1) {
    this.onsets.push(t);
    if (isKick) {
      this.kicks.push(t);
      this.kickW.push(strength);
    }
    this.lastOnset = t;
    if (this.bpm > 0) {
      const period = 60 / this.bpm;
      const n = Math.round((t - this.lastBeat) / period);
      const err = t - (this.lastBeat + n * period);
      // only strong (kick) onsets steer the grid once locked; others only before lock
      if (Math.abs(err) < 0.2 * period && (isKick || this.confidence < 0.3)) {
        this.lastBeat += err * 0.35;
      }
    }
  }

  update(t: number) {
    this.beat = false;
    if (t - this.lastEstimate > 0.25) {
      this.lastEstimate = t;
      this.estimate(t);
    }
    if (t - this.lastOnset > 4) this.confidence *= 0.98;
    if (this.bpm > 0) {
      const period = 60 / this.bpm;
      if (t < this.lastBeat) this.lastBeat = t; // after a seek backwards
      while (t >= this.lastBeat + period) {
        this.lastBeat += period;
        this.beat = true;
      }
      if (this.beat) this.beatCount++;
      this.phase = (t - this.lastBeat) / period;
    } else {
      this.phase = 0;
    }
  }

  private countRecent(ring: TimeRing, t: number) {
    let n = 0;
    ring.forEach((x) => {
      if (t - x < WINDOW) n++;
    });
    return n;
  }

  private estimate(t: number) {
    const kickDriven = this.countRecent(this.kicks, t) >= 6;
    if (kickDriven) this.lastKickLock = t;
    // Breakdowns: once a tempo was established from kicks, hold it (flywheel) rather than re-estimating
    // from sparse broadband onsets such as risers. Tempo rarely changes inside a breakdown.
    else if (this.bpm > 0 && t - this.lastKickLock < 30) return;
    const ring = kickDriven ? this.kicks : this.onsets;
    const times: number[] = [];
    ring.forEach((x) => {
      if (t - x < WINDOW) times.push(x);
    });
    if (times.length < 4) return;

    const h = this.hist;
    h.fill(0);
    for (let i = 0; i < times.length; i++) {
      const wi = Math.exp(-(t - times[i]) / 5);
      for (let j = i + 1; j < times.length; j++) {
        const d = times[j] - times[i];
        if (d < 0.25 || d > 4) continue;
        const w = wi * Math.exp(-(t - times[j]) / 5);
        for (let k = 1; k <= 8; k++) {
          const bpm = (60 * k) / d;
          if (bpm < BPM_MIN - 2) continue;
          if (bpm > BPM_MAX + 2) break;
          const c = (bpm - BPM_MIN) / BIN;
          const wk = w / Math.sqrt(k);
          // Gaussian splat, sigma ≈ 1 bpm (2 bins)
          const c0 = Math.max(0, Math.floor(c - 5));
          const c1 = Math.min(NBINS - 1, Math.ceil(c + 5));
          for (let b = c0; b <= c1; b++) {
            const x = (b - c) / 2;
            h[b] += wk * Math.exp(-0.5 * x * x);
          }
        }
      }
    }
    let best = -1;
    let bestScore = 0;
    let total = 0;
    for (let b = 0; b < NBINS; b++) {
      const bpm = BPM_MIN + b * BIN;
      const lg = Math.log2(bpm / 120) / 0.7;
      h[b] *= Math.exp(-0.5 * lg * lg);
      total += h[b];
      if (h[b] > bestScore) {
        bestScore = h[b];
        best = b;
      }
    }
    if (best < 0 || total <= 0) return;
    // parabolic interpolation around the peak for sub-bin accuracy
    let peak = best;
    if (best > 0 && best < NBINS - 1) {
      const a = h[best - 1];
      const b = h[best];
      const c = h[best + 1];
      const den = a - 2 * b + c;
      if (den !== 0) peak = best + (0.5 * (a - c)) / den;
    }
    const est = BPM_MIN + peak * BIN;
    // concentration: share of mass within ±3 bpm of the peak
    let near = 0;
    for (let b = Math.max(0, best - 6); b <= Math.min(NBINS - 1, best + 6); b++) near += h[b];
    const conf = Math.min(1, (near / total) * 2.2);

    if (this.bpm === 0) {
      this.bpm = est;
      this.lastBeat = times[times.length - 1];
    } else if (Math.abs(est - this.bpm) / this.bpm < 0.04) {
      this.bpm += (est - this.bpm) * 0.3;
    } else {
      // tempo change requires three consecutive agreeing estimates (hysteresis)
      if (Math.abs(est - this.candidate) / est < 0.04) this.candidateHits++;
      else {
        this.candidate = est;
        this.candidateHits = 1;
      }
      if (this.candidateHits >= 3) {
        this.bpm = est;
        this.candidateHits = 0;
      }
    }
    this.confidence += (conf - this.confidence) * 0.3;
    if (kickDriven) this.alignPhase(t);
  }

  /**
   * Phase from where the kicks actually land: the strength- and recency-weighted circular mean
   * of recent kick times modulo the beat period. The PLL alone only corrects small errors, so a
   * grid seeded on an off-beat (common with syncopated drums) would otherwise stay there.
   * Small differences are nudged; a large one must persist for three estimates (~0.75 s) before
   * the grid jumps, so a single syncopated bar can't flip it.
   */
  private alignPhase(t: number) {
    const T = 60 / this.bpm;
    const ts: number[] = [];
    const ws: number[] = [];
    this.kicks.forEach((x) => ts.push(x));
    this.kickW.forEach((w) => ws.push(w));
    let C = 0, S = 0, W = 0, n = 0;
    for (let i = 0; i < ts.length; i++) {
      const age = t - ts[i];
      if (age > WINDOW) continue;
      const w = (ws[i] ?? 1) * Math.exp(-age / 4);
      const th = (2 * Math.PI * (((ts[i] % T) + T) % T)) / T;
      C += w * Math.cos(th);
      S += w * Math.sin(th);
      W += w;
      n++;
    }
    if (n < 6 || W <= 0) return;
    if (Math.hypot(C, S) / W < 0.35) return; // kicks don't agree on a phase
    const anchor = ((Math.atan2(S, C) / (2 * Math.PI)) * T + T) % T;
    let err = anchor - (((this.lastBeat % T) + T) % T);
    if (err > T / 2) err -= T;
    if (err < -T / 2) err += T;
    if (Math.abs(err) > 0.2 * T) {
      if (++this.phaseVotes >= 3) {
        this.lastBeat += err;
        this.phaseVotes = 0;
      }
    } else {
      this.phaseVotes = 0;
      this.lastBeat += err * 0.25;
    }
    while (this.lastBeat > t) this.lastBeat -= T;
  }
}
