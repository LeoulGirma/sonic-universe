/**
 * Plans a DJ transition between two analysed songs, the way a DJ would read them:
 *
 * - **beatmatch**: tempos within ±6% (also at double / half time). The outgoing song is left at a
 *   phrase boundary near its end (the start of its outro), the incoming song is started so that
 *   its first main section lands exactly when the outgoing one has gone. Both overlap for
 *   32 beats with their downbeats locked; the basslines swap on the middle downbeat.
 * - **echo**: both have a beat but the tempos are too far apart to match without audible pitch
 *   shift. The outgoing song echoes out over a bar or two from a phrase boundary and the next
 *   one comes in from its start.
 * - **fade**: no usable beat on one side (film scores, ballads): a long filtered crossfade.
 *
 * Times are seconds on each song's own clock. Pure: no audio here, so it is tested directly.
 */
import type { SongMap } from '../songMap';

export type MixSong = Pick<SongMap, 'beats' | 'bpm' | 'duration' | 'sections' | 'beatConfidence'>;

export interface TransitionPlan {
  kind: 'beatmatch' | 'echo' | 'fade';
  /** A's time where the transition starts */
  outT: number;
  /** B's time it starts playing from */
  inT: number;
  /** B's playback rate during the transition (tempo matched to A); glides back to 1 after */
  rate: number;
  /** transition length, seconds of real time from outT */
  len: number;
  /** seconds after outT where the basslines swap and B takes over (visuals follow) */
  swap: number;
  /** A beats in the overlap (beatmatch) */
  beats: number;
  outBeat: number;
  inBeat: number;
  /** B beats per A beat (1, 2 or 0.5) */
  ratio: number;
}

export const MAX_STRETCH = 0.06;
const MIX_BEATS = 32;

const usable = (m: MixSong) => m.bpm > 0 && m.beats.length > 64 && m.beatConfidence >= 0.3;

/**
 * The beat index where the outgoing song is left: the start of its outro (a phrase boundary).
 * With `earliest` (mix now): the first section boundary or 16-beat phrase after that time.
 */
function outBeatOf(a: MixSong, L: number, earliest?: number) {
  const n = a.beats.length;
  const lastOk = n - 1 - L - 4; // room for the whole overlap before the grid runs out
  if (earliest !== undefined) {
    let i = 0;
    while (i < n - 1 && a.beats[i] < earliest) i++;
    const s0 = a.sections[0]?.startBeat ?? 0;
    const phrase = i + ((((s0 - i) % 16) + 16) % 16);
    const sec = a.sections.find((s) => s.startBeat >= i);
    const b = Math.min(phrase, sec ? sec.startBeat : phrase);
    return Math.max(0, Math.min(b, Math.max(i, lastOk)));
  }
  const minT = a.duration * 0.45;
  const secs = a.sections.filter((s) => s.startBeat > 0 && s.startBeat <= lastOk && a.beats[s.startBeat] >= minT);
  if (secs.length) {
    // the outro; if that last section is long (a final chorus played out), move on through it in
    // whole phrases so most of the song still plays before the mix
    let b = secs[secs.length - 1].startBeat;
    while (b + 16 <= lastOk && a.duration - a.beats[b] > 50) b += 16;
    return b;
  }
  // no section boundary late enough: a 16-beat phrase from the song's first section
  const s0 = a.sections[0]?.startBeat ?? 0;
  let b = lastOk - ((((lastOk - s0) % 16) + 16) % 16);
  if (a.beats[Math.max(0, b)] < minT) b = lastOk;
  return Math.max(0, b);
}

/** the incoming song's first main section (past its intro) */
function mainBeatOf(b: MixSong) {
  const s = b.sections;
  if (s.length < 2) return 0;
  const intro = s[0];
  // an intro is a quieter opening section; if the song starts at full energy, use its start
  if (intro.energy >= 0.6) return 0;
  const main = s.slice(1).find((x) => x.energy >= 0.45) ?? s[1];
  return main.startBeat;
}

export function planTransition(a: MixSong, b: MixSong, earliest?: number): TransitionPlan {
  if (usable(a) && usable(b)) {
    // B's tempo relative to A, allowing double / half time (m: B's tempo multiplier as counted
    // against A; ratio = B beats per A beat)
    let best = { ratio: 1, rate: a.bpm / b.bpm };
    for (const m of [2, 0.5]) {
      const rate = a.bpm / (b.bpm * m);
      if (Math.abs(rate - 1) < Math.abs(best.rate - 1)) best = { ratio: 1 / m, rate };
    }
    const L = MIX_BEATS;
    const outBeat = outBeatOf(a, L, earliest);
    const outT = a.beats[outBeat];
    if (Math.abs(best.rate - 1) <= MAX_STRETCH) {
      const bBeats = Math.round(L * best.ratio);
      const main = mainBeatOf(b);
      let inBeat = main - bBeats;
      const phrase = Math.max(1, Math.round(16 * best.ratio));
      while (inBeat < 0) inBeat += phrase;
      inBeat = Math.min(inBeat, Math.max(0, b.beats.length - 1 - bBeats));
      const end = a.beats[Math.min(a.beats.length - 1, outBeat + L)];
      const mid = a.beats[Math.min(a.beats.length - 1, outBeat + L / 2)];
      return { kind: 'beatmatch', outT, inT: b.beats[inBeat], rate: best.rate, len: end - outT, swap: mid - outT, beats: L, outBeat, inBeat, ratio: best.ratio };
    }
    // echo out over two bars from the phrase, the next song starts from its first beat as the
    // echoes die away
    const echoBeats = 8;
    const e = Math.max(0.5, a.beats[Math.min(a.beats.length - 1, outBeat + echoBeats)] - outT);
    return { kind: 'echo', outT, inT: Math.max(0, b.beats[0] - 0.02), rate: 1, len: e + 4, swap: e, beats: echoBeats, outBeat, inBeat: 0, ratio: 1 };
  }
  // no usable beat on one side: a long, filtered crossfade from the start of the last section
  const lastSec = a.sections.length ? a.sections[a.sections.length - 1] : null;
  let outT = earliest !== undefined ? earliest : lastSec && lastSec.start > a.duration * 0.5 ? lastSec.start : a.duration - 14;
  outT = Math.max(0, Math.min(outT, a.duration - 10));
  const len = Math.min(12, a.duration - outT);
  return { kind: 'fade', outT, inT: 0, rate: 1, len, swap: len * 0.5, beats: 0, outBeat: -1, inBeat: 0, ratio: 1 };
}
