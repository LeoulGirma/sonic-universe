import type { Drives } from '../../mapping/drives';
import { anticipationAt } from '../../audio/songMap';

/**
 * The Impossible Tunnel — clock and structure (pure TypeScript, tested).
 *
 * The camera's position along the tunnel is measured in BEATS. Ring k sits at beat k, so the
 * camera crosses a ring exactly when a beat lands:
 *  - with a song map, position = mapBeatIndex + beatPhase, exact (a lookup, so seeks are safe)
 *  - live, it advances at the tracked tempo and phase-locks to the beat tracker
 *  - with nothing playing it drifts slowly; when music starts the drift is rounded to a whole
 *    number of beats so ring crossings stay on the beat
 * With a map, every ring ahead also knows the music at ITS time, so the shape of the tunnel
 * ahead previews the song: breakdown chambers, build-up narrowing, drop gates, new styles.
 */

export interface TunnelParams {
  spacing: number; // scene units per beat
  radius: number;
  twist: number; // radians per beat at full mids
  curve: number; // path curvature
  bloom: number;
}
export const DEFAULT_TUNNEL: TunnelParams = { spacing: 9, radius: 7, twist: 0.35, curve: 1, bloom: 1 };

export const BEHIND = 2; // beats of tunnel kept behind the camera
export const AHEAD = 40; // beats of tunnel ahead
export const RINGS = BEHIND + AHEAD + 2; // per-ring uniform slots
export const STYLES = [6, 0, 4, 8, 3, 5]; // polygon sides per style (0 = circle)

export interface RingParams {
  wide: Float32Array; // 0..1 breakdown chamber
  narrow: Float32Array; // 0..1 build-up squeeze
  gate: Float32Array; // 1 on a drop's ring
  style: Float32Array; // polygon sides
  curve: Float32Array; // path curvature amount
}

export const createRingParams = (): RingParams => ({
  wide: new Float32Array(RINGS),
  narrow: new Float32Array(RINGS),
  gate: new Float32Array(RINGS),
  style: new Float32Array(RINGS),
  curve: new Float32Array(RINGS),
});

export class TunnelClock {
  /** continuous position in beats */
  pos = 0;
  /** whole-beat offset accumulated while idle (keeps crossings on the beat once music starts) */
  private drift = 0;
  private wasIdle = true;
  private liveStyle = 0;
  private lastDrop = 0;
  private track = -1;
  mode: 'map' | 'live' | 'idle' = 'idle';

  update(dt: number, d: Drives) {
    if (d.track !== this.track) {
      this.track = d.track;
      this.lastDrop = d.dropEvents;
      this.liveStyle = 0;
    }
    const idle = d.idle > 0.5;
    if (idle) {
      this.mode = 'idle';
      this.drift += dt * 0.35;
      this.pos += dt * 0.35;
      this.wasIdle = true;
      return;
    }
    if (this.wasIdle) {
      this.drift = Math.round(this.drift);
      this.wasIdle = false;
    }
    if (d.dropEvents !== this.lastDrop) {
      this.lastDrop = d.dropEvents;
      this.liveStyle++;
    }
    if (d.map && d.map.beats.length > 1) {
      this.mode = 'map';
      this.pos = d.beatIndex + d.beatPhase + this.drift;
      return;
    }
    this.mode = 'live';
    if (d.bpm > 0) {
      // follow the tracked tempo even while the tracker is unsure (noisy rooms, laptop mics);
      // the pull toward its beat phase strengthens as its confidence grows
      this.pos += (dt * d.bpm) / 60;
      let err = d.beatPhase - (this.pos - Math.floor(this.pos));
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      const trust = Math.min(1, Math.max(0.15, d.confidence * 2.5));
      this.pos += err * Math.min(1, dt * 4 * trust);
    } else {
      this.pos += dt * (1.6 + 0.8 * d.energy);
    }
  }

  /** whole beat of ring slot 0 */
  base() {
    return Math.floor(this.pos) - BEHIND;
  }

  /**
   * Per-ring structure for the visible span. With a map, ring k looks up the song at the time of
   * map beat (k - drift); live, every ring takes the current state, with styles changing ahead.
   */
  rings(d: Drives, out: RingParams) {
    const base = this.base();
    const map = d.map;
    for (let j = 0; j < RINGS; j++) {
      const k = base + j;
      if (this.mode === 'map' && map) {
        const bi = k - this.drift;
        const n = map.beats.length;
        const period = n > 1 ? map.beats[1] - map.beats[0] : 0.5;
        const t = bi < 0 ? map.beats[0] + bi * period : bi < n ? map.beats[bi] : map.beats[n - 1] + (bi - n + 1) * period;
        out.wide[j] = map.breakdowns.some(([a, b]) => t >= a && t < b) ? 1 : 0;
        out.narrow[j] = anticipationAt(map, t);
        let drops = 0;
        let gate = 0;
        for (const dr of map.drops) {
          if (dr.t <= t + 1e-3) drops++;
          if (Math.abs(dr.t - t) < period * 0.5) gate = 1;
        }
        out.gate[j] = gate;
        out.style[j] = STYLES[drops % STYLES.length];
        out.curve[j] = out.wide[j] ? 0.2 : 1;
      } else {
        out.wide[j] = d.calm;
        out.narrow[j] = d.tension;
        out.gate[j] = 0;
        // live drops restyle the tunnel from a few beats ahead (you fly into the new shape)
        const ahead = k > this.pos + 3;
        out.style[j] = STYLES[(ahead ? this.liveStyle : Math.max(0, this.liveStyle - 1)) % STYLES.length];
        if (this.liveStyle === 0) out.style[j] = STYLES[0];
        out.curve[j] = 1 - 0.8 * d.calm;
      }
    }
    // smooth chamber walls over neighbouring rings so they open and close gradually
    smooth(out.wide, 2);
    smooth(out.narrow, 1);
    smooth(out.curve, 2);
  }
}

function smooth(a: Float32Array, passes: number) {
  for (let p = 0; p < passes; p++) {
    let prev = a[0];
    for (let i = 1; i < a.length - 1; i++) {
      const cur = a[i];
      a[i] = 0.25 * prev + 0.5 * cur + 0.25 * a[i + 1];
      prev = cur;
    }
  }
}
