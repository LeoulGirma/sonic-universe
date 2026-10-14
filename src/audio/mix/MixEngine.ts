/**
 * Plays a queue of songs as one continuous DJ mix on two decks.
 *
 * Each deck is a decoded buffer through its own low-shelf (bass swap), high-pass and low-pass
 * (sweeps), echo send and fader into the master input. Transitions are planned from the song
 * maps (transition.ts) and scheduled on the AudioContext clock, so the incoming song starts on
 * the exact sample its beat lines up with and every fade, swap and sweep lands on a downbeat.
 * Pausing suspends the context, which freezes the whole schedule with it.
 */
import type { SongMap } from '../songMap';
import { planTransition, type TransitionPlan } from './transition';

export interface MixTrack {
  id: number;
  name: string;
  blob: Blob;
  map: SongMap | null;
  status: 'queued' | 'analysing' | 'ready' | 'error';
}

const BASS_CUT = -26; // dB on the low shelf
const TARGET_LOUD = -9; // dB, median frame loudness every song is trimmed to
const GLIDE_S = 10; // after a transition the incoming song's tempo eases back to its own

class Deck {
  src: AudioBufferSourceNode | null = null;
  readonly low: BiquadFilterNode;
  readonly hp: BiquadFilterNode;
  readonly lp: BiquadFilterNode;
  readonly fader: GainNode;
  readonly trim: GainNode;
  readonly send: GainNode;
  readonly delay: DelayNode;
  readonly fb: GainNode;
  // playback clock: from `t0` (context time) at song position `p0`, rate `r` until `g0`, then a
  // linear glide to 1 by `g1`, then 1
  t0 = 0; p0 = 0; r = 1; g0 = Infinity; g1 = Infinity;
  playing = false;

  constructor(private ctx: AudioContext, out: AudioNode, readonly track: MixTrack, readonly buffer: AudioBuffer) {
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 180;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.lp.Q.value = 0.7;
    this.fader = ctx.createGain();
    // loudness matching: every song sits at the same level in the mix (from its profile)
    this.trim = ctx.createGain();
    this.trim.gain.value = trimOf(track);
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain();
    this.fb.gain.value = 0.45;
    this.trim.connect(this.low);
    this.low.connect(this.hp).connect(this.lp);
    this.lp.connect(this.fader).connect(out);
    this.lp.connect(this.send).connect(this.delay);
    this.delay.connect(this.fb).connect(this.delay);
    this.delay.connect(out);
  }

  /** song position at context time T */
  pos(T: number) {
    if (!this.playing) return this.p0;
    const { t0, p0, r, g0, g1 } = this;
    if (T <= g0) return p0 + (T - t0) * r;
    const a = p0 + (g0 - t0) * r;
    if (T <= g1) {
      const u = T - g0, D = g1 - g0;
      return a + u * (r + ((1 - r) * u) / (2 * D));
    }
    return a + (g1 - g0) * (r + 1) / 2 + (T - g1);
  }

  /** context time at which the song reaches position p (p ahead of now) */
  timeAt(p: number, now: number) {
    let lo = now, hi = now + (p - this.pos(now)) / Math.min(this.r, 1) + 30;
    for (let i = 0; i < 50; i++) {
      const m = (lo + hi) / 2;
      if (this.pos(m) < p) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }

  start(when: number, offset: number, rate = 1) {
    this.stop(when);
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.setValueAtTime(rate, Math.max(this.ctx.currentTime, when));
    s.connect(this.trim);
    s.start(when, Math.max(0, Math.min(offset, this.buffer.duration - 0.05)));
    this.src = s;
    this.t0 = when; this.p0 = offset; this.r = rate; this.g0 = Infinity; this.g1 = Infinity;
    this.playing = true;
  }

  glideToNormal(from: number) {
    if (!this.src || this.r === 1) return;
    this.g0 = from;
    this.g1 = from + GLIDE_S;
    const pr = this.src.playbackRate;
    pr.setValueAtTime(this.r, from);
    pr.linearRampToValueAtTime(1, this.g1);
  }

  stop(when?: number) {
    if (!this.src) return;
    try { this.src.stop(when ?? 0); } catch { /* already stopped */ }
    if (when === undefined || when <= this.ctx.currentTime) {
      this.src.disconnect();
      this.src = null;
      this.playing = false;
    }
  }

  /** clear every automation and return the strip to neutral */
  resetStrip(at: number) {
    for (const p of [this.low.gain, this.hp.frequency, this.lp.frequency, this.fader.gain, this.send.gain]) p.cancelScheduledValues(at);
    this.low.gain.setValueAtTime(0, at);
    this.hp.frequency.setValueAtTime(10, at);
    this.lp.frequency.setValueAtTime(22000, at);
    this.fader.gain.setValueAtTime(1, at);
    this.send.gain.setValueAtTime(0, at);
  }

  dispose() {
    this.stop();
    for (const n of [this.trim, this.low, this.hp, this.lp, this.fader, this.send, this.delay, this.fb]) n.disconnect();
  }
}

const trimOf = (t: MixTrack) => {
  const loud = t.map?.profile?.loud;
  return loud === undefined ? 1 : Math.pow(10, Math.max(-6, Math.min(3, TARGET_LOUD - loud)) / 20);
};

const curve = (n: number, f: (x: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i / (n - 1)));
const FADE_IN = curve(64, (x) => Math.sin((x * Math.PI) / 2));
const FADE_OUT = curve(64, (x) => Math.cos((x * Math.PI) / 2));

export interface MixEvents {
  /** the incoming song took over (the bass swap, or the start of an echo/fade's new song) */
  onSwap: (track: MixTrack) => void;
  /** the queue ran out and the last song ended */
  onEnd: () => void;
  /** something about the queue or the plan changed (for the UI) */
  onChange: () => void;
}

export class MixEngine {
  tracks: MixTrack[] = [];
  active: Deck | null = null;
  private incoming: Deck | null = null;
  plan: TransitionPlan | null = null;
  /** context times of the scheduled transition */
  private tOut = 0;
  private tSwap = 0;
  private tEnd = 0;
  private swapped = false;
  private decoding = new Map<number, Promise<AudioBuffer | null>>();
  private buffers = new Map<number, AudioBuffer>();
  private mixNowFrom: number | undefined;

  private out: AudioNode;
  private limiter: DynamicsCompressorNode;

  constructor(private ctx: AudioContext, dest: AudioNode, private ev: MixEvents) {
    // a brickwall-style limiter on the master: two full songs overlapping (and hot masters) never clip
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    const pre = ctx.createGain();
    pre.gain.value = 0.9;
    pre.connect(this.limiter).connect(dest);
    this.out = pre;
  }

  get current() {
    return this.active?.track ?? null;
  }

  get next(): MixTrack | null {
    const i = this.current ? this.tracks.indexOf(this.current) : -1;
    return this.tracks[i + 1] ?? null;
  }

  /** seconds until the transition starts (null when none is scheduled) */
  untilTransition() {
    if (!this.plan || this.swapped) return null;
    return Math.max(0, this.tOut - this.ctx.currentTime);
  }

  get position() {
    return this.active ? Math.min(this.active.pos(this.ctx.currentTime), this.active.buffer.duration) : 0;
  }

  get duration() {
    return this.active?.buffer.duration ?? 0;
  }

  /** decode a track's audio ahead of time */
  preload(t: MixTrack) {
    return this.decode(t);
  }

  private decode(t: MixTrack) {
    const have = this.buffers.get(t.id);
    if (have) return Promise.resolve(have);
    let p = this.decoding.get(t.id);
    if (!p) {
      p = t.blob.arrayBuffer().then((d) => this.ctx.decodeAudioData(d)).then((b) => {
        this.buffers.set(t.id, b);
        return b;
      }).catch(() => null).finally(() => this.decoding.delete(t.id));
      this.decoding.set(t.id, p);
    }
    return p;
  }

  /** keep only the decoded audio that can still be needed (memory: ~40 MB per song) */
  private trimBuffers() {
    const keep = new Set([this.current?.id, this.next?.id]);
    for (const id of [...this.buffers.keys()]) if (!keep.has(id)) this.buffers.delete(id);
  }

  /** start playing a queued track from `offset` (no transition) */
  async playTrack(t: MixTrack, offset = 0) {
    const buf = await this.decode(t);
    if (!buf) return false;
    this.cancelTransition();
    this.active?.dispose();
    this.active = new Deck(this.ctx, this.out, t, buf);
    this.active.start(this.ctx.currentTime + 0.05, offset);
    this.swapped = false;
    this.trimBuffers();
    this.ev.onSwap(t);
    this.ev.onChange();
    return true;
  }

  /** the playing song's map arrived after it started: bring it to the mix level gently */
  refreshTrim() {
    const a = this.active;
    if (a) a.trim.gain.setTargetAtTime(trimOf(a.track), this.ctx.currentTime, 0.8);
  }

  seek(t: number) {
    const a = this.active;
    if (!a) return;
    this.cancelTransition();
    a.resetStrip(this.ctx.currentTime);
    a.start(this.ctx.currentTime + 0.02, t);
    this.ev.onChange();
  }

  /** mix into the next song at the next phrase instead of waiting for the outro */
  mixNow() {
    if (!this.active || (this.plan && this.ctx.currentTime >= this.tOut)) return;
    this.cancelTransition();
    this.mixNowFrom = this.position + 1;
  }

  private cancelTransition() {
    const now = this.ctx.currentTime;
    if (this.incoming) {
      this.incoming.dispose();
      this.incoming = null;
    }
    if (this.plan && this.active && !this.swapped) this.active.resetStrip(now);
    this.plan = null;
    this.mixNowFrom = undefined;
  }

  /**
   * Call every frame. Prepares the next song's audio, schedules its transition once both maps
   * are known, fires the hand-over at the swap, and cleans up the outgoing deck.
   */
  tick() {
    const a = this.active;
    if (!a) return;
    const now = this.ctx.currentTime;
    const nxt = this.next;

    // the transition in progress: hand over at the swap, retire the old deck at the end
    if (this.plan && this.incoming) {
      if (!this.swapped && now >= this.tSwap) {
        this.swapped = true;
        const old = this.active!;
        this.active = this.incoming;
        this.incoming = old; // keep it until it has faded out
        this.ev.onSwap(this.active.track);
        this.ev.onChange();
      }
      if (this.swapped && now >= this.tEnd + 0.5) {
        this.incoming?.dispose();
        this.incoming = null;
        this.plan = null;
        this.swapped = false;
        this.trimBuffers();
        this.ev.onChange();
      }
      return;
    }

    // no next song: when this one ends, the mix ends
    const left = a.buffer.duration - a.pos(now);
    if (!nxt) {
      if (left <= 0.05) { a.stop(); this.ev.onEnd(); }
      return;
    }
    const buf = this.buffers.get(nxt.id);
    if (!buf) {
      void this.decode(nxt);
      // nothing to mix into yet and the song is over: go straight on when it's ready
      if (left <= 0.05) void this.decode(nxt).then(() => { if (this.active === a) void this.playTrack(nxt); });
      return;
    }
    if (!a.track.map || !nxt.map) {
      if (left <= 0.05) void this.playTrack(nxt);
      return;
    }
    // plan and schedule (once); needs a few seconds of lead time
    const plan = planTransition(a.track.map, nxt.map, this.mixNowFrom);
    const tOut = a.timeAt(plan.outT, now);
    if (tOut - now < 0.3) {
      // past the planned point (a late-arriving map or a seek into the outro): mix at the next phrase
      if (this.mixNowFrom === undefined && left > 8) { this.mixNowFrom = a.pos(now) + 0.5; return; }
      if (left <= 0.05) void this.playTrack(nxt);
      return;
    }
    if (tOut - now > 4 && this.mixNowFrom === undefined) return; // schedule a few seconds ahead
    this.schedule(plan, tOut, buf, nxt);
  }

  private schedule(plan: TransitionPlan, tOut: number, buf: AudioBuffer, nxt: MixTrack) {
    const a = this.active!;
    const b = new Deck(this.ctx, this.out, nxt, buf);
    this.plan = plan;
    this.incoming = b;
    this.swapped = false;
    this.mixNowFrom = undefined;
    // real time: A plays at rate ~1 here (its own glide has long finished)
    const rA = a.r === 1 || tOut > a.g1 ? 1 : a.r;
    const len = plan.len / rA, swap = plan.swap / rA;
    const T0 = tOut, Tm = tOut + swap, T1 = tOut + len;
    this.tOut = T0; this.tSwap = Tm; this.tEnd = T1;
    a.resetStrip(Math.max(this.ctx.currentTime, T0 - 0.01));

    if (plan.kind === 'beatmatch') {
      b.fader.gain.setValueAtTime(0, T0);
      b.fader.gain.setValueCurveAtTime(FADE_IN, T0, swap);
      // the incoming bass waits for the swap; on that downbeat the basslines trade places
      b.low.gain.setValueAtTime(BASS_CUT, T0);
      b.low.gain.setValueAtTime(BASS_CUT, Tm - 0.02);
      b.low.gain.linearRampToValueAtTime(0, Tm + 0.04);
      a.low.gain.setValueAtTime(0, Tm - 0.02);
      a.low.gain.linearRampToValueAtTime(BASS_CUT, Tm + 0.04);
      a.fader.gain.setValueAtTime(1, Tm);
      a.fader.gain.setValueCurveAtTime(FADE_OUT, Tm, T1 - Tm);
      a.hp.frequency.setValueAtTime(10, Tm + (T1 - Tm) * 0.4);
      a.hp.frequency.exponentialRampToValueAtTime(700, T1);
      b.start(T0, plan.inT, plan.rate);
      b.glideToNormal(T1);
      a.stop(T1 + 0.05);
    } else if (plan.kind === 'echo') {
      const beat = plan.swap / Math.max(1, plan.beats);
      a.delay.delayTime.setValueAtTime(Math.min(3.9, beat * 0.75), T0);
      a.send.gain.setValueAtTime(0, T0);
      a.send.gain.linearRampToValueAtTime(0.5, T0 + beat);
      a.fader.gain.setValueAtTime(1, T0);
      a.fader.gain.linearRampToValueAtTime(0.7, T0 + beat);
      a.hp.frequency.setValueAtTime(10, T0);
      a.hp.frequency.exponentialRampToValueAtTime(900, Tm);
      a.fader.gain.setValueAtTime(0.7, Tm - 0.03);
      a.fader.gain.linearRampToValueAtTime(0, Tm);
      a.send.gain.setValueAtTime(0.5, Tm - 0.03);
      a.send.gain.linearRampToValueAtTime(0, Tm); // the echoes ring on by themselves
      b.fader.gain.setValueAtTime(0, Tm);
      b.fader.gain.setValueCurveAtTime(FADE_IN, Tm, 1.2);
      b.start(Tm, plan.inT, 1);
      a.stop(T1 + 0.05);
    } else {
      a.lp.frequency.setValueAtTime(22000, T0);
      a.lp.frequency.exponentialRampToValueAtTime(500, T1);
      a.fader.gain.setValueCurveAtTime(FADE_OUT, T0, len);
      b.fader.gain.setValueAtTime(0, T0);
      b.fader.gain.setValueCurveAtTime(FADE_IN, T0, len);
      b.start(T0, plan.inT, 1);
      a.stop(T1 + 0.05);
    }
    this.ev.onChange();
  }

  dispose() {
    this.cancelTransition();
    this.active?.dispose();
    this.active = null;
    this.buffers.clear();
    this.out.disconnect();
    this.limiter.disconnect();
  }
}
