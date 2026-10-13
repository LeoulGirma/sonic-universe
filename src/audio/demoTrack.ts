/**
 * A ~64 s Afro-house-style demo groove, synthesised sample-by-sample in plain TypeScript
 * (no Web Audio graph — thousands of nodes in an OfflineAudioContext is far too slow on phones).
 * Deliberate arrangement so every mapping can be seen:
 *   bars 0–3   intro      pad, shaker, congas
 *   bars 4–11  groove     + kick, off-beat bass, open hats, claps
 *   bars 12–15 groove     + plucked arp
 *   bars 16–23 breakdown  no kick or bass; arp opens up; riser + snare roll in bars 22–23
 *   bars 24–31 drop       everything back, brighter
 * It is genuine audio that goes through the same analyser as uploaded songs.
 */
export const DEMO_BPM = 122;
const BARS = 32;

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// A minor: Am9 – Fmaj7 – Cmaj7 – G6
const CHORDS = [
  { root: 45, notes: [57, 60, 64, 67, 71] },
  { root: 41, notes: [53, 57, 60, 64, 67] },
  { root: 48, notes: [55, 60, 64, 67, 71] },
  { root: 43, notes: [55, 59, 62, 64, 69] },
];

/** Topology-preserving state-variable filter (Zavalishin). */
class SVF {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  constructor(private sr: number) {}
  set(fc: number, q: number) {
    const g = Math.tan((Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** returns [low, band, high] packed via out params to stay allocation-free */
  run(x: number, mode: 0 | 1 | 2) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return mode === 0 ? v2 : mode === 1 ? v1 : x - this.k * v1 - v2;
  }
}

export interface DemoRender {
  sampleRate: number;
  data: Float32Array;
  kicks: number[]; // ground-truth kick times (s)
  breakdown: [number, number];
  dropAt: number;
}

export function synthDemo(sr = 44100): DemoRender {
  const step = 60 / DEMO_BPM / 4;
  const bar = step * 16;
  const start = 0.5;
  const dur = start + BARS * bar + 1.5;
  const N = Math.ceil(dur * sr);
  const out = new Float32Array(N);
  const send = new Float32Array(N); // delay send
  let seed = 22222;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  const kicks: number[] = [];

  const at = (t: number) => Math.floor(t * sr);

  // sidechain: bass and pad duck under every kick, as in a typical house mix
  const duck = new Float32Array(N).fill(1);
  for (let b = 0; b < BARS; b++) {
    const full = b >= 4 && !(b >= 16 && b < 24);
    if (!full) continue;
    for (let s = 0; s < 16; s += 4) {
      const i0 = at(start + b * bar + s * step);
      for (let i = 0; i < at(0.4) && i0 + i < N; i++) {
        const x = i / sr;
        duck[i0 + i] = Math.min(duck[i0 + i], 1 - 0.85 * Math.min(1, x / 0.003) * Math.exp(-x / 0.1));
      }
    }
  }

  const kick = (t: number, amp: number, long: boolean) => {
    kicks.push(t);
    const n = at(long ? 1.3 : 0.5);
    const i0 = at(t);
    let ph = 0;
    for (let i = 0; i < n && i0 + i < N; i++) {
      const x = i / sr;
      const f = 48 + 112 * Math.exp(-x / 0.025);
      ph += (2 * Math.PI * f) / sr;
      const env = Math.min(1, x / 0.002) * Math.exp(-x / (long ? 0.45 : 0.16));
      const click = x < 0.012 ? rnd() * 0.25 * (1 - x / 0.012) : 0;
      out[i0 + i] += amp * (Math.sin(ph) * env + click);
    }
  };

  const noise = (t: number, len: number, mode: 0 | 1 | 2, fc: number, q: number, amp: number, decay: number, toSend = 0) => {
    const f = new SVF(sr);
    f.set(fc, q);
    const n = at(len), i0 = at(t);
    for (let i = 0; i < n && i0 + i < N; i++) {
      const x = i / sr;
      const v = f.run(rnd(), mode) * amp * Math.min(1, x / 0.001) * Math.exp(-x / decay) * Math.min(1, (n - i) / 200);
      out[i0 + i] += v;
      if (toSend) send[i0 + i] += v * toSend;
    }
  };

  const bass = (t: number, note: number, len: number) => {
    const f = new SVF(sr);
    const n = at(len + 0.02), i0 = at(t);
    const hz = midi(note);
    let ph = 0;
    for (let i = 0; i < n && i0 + i < N; i++) {
      const x = i / sr;
      if (i % 16 === 0) f.set(140 + 760 * Math.exp(-x / (len * 0.35)), 1.6);
      ph = (ph + hz / sr) % 1;
      const saw = 2 * ph - 1;
      const env = Math.min(1, x / 0.006) * (x < len * 0.7 ? 1 : Math.max(0, 1 - (x - len * 0.7) / (len * 0.3)));
      out[i0 + i] += f.run(saw, 0) * 0.5 * env * duck[i0 + i];
    }
  };

  const conga = (t: number, f0: number, amp: number) => {
    const n = at(0.22), i0 = at(t);
    let ph = 0;
    for (let i = 0; i < n && i0 + i < N; i++) {
      const x = i / sr;
      ph += (2 * Math.PI * f0 * (1 + 0.6 * Math.exp(-x / 0.012))) / sr;
      out[i0 + i] += Math.sin(ph) * amp * Math.min(1, x / 0.002) * Math.exp(-x / 0.06);
    }
  };

  const pluck = (t: number, note: number, bright: number, amp: number) => {
    const f = new SVF(sr);
    const n = at(0.32), i0 = at(t);
    const hz = midi(note);
    let ph = 0;
    for (let i = 0; i < n && i0 + i < N; i++) {
      const x = i / sr;
      if (i % 16 === 0) f.set(400 + (500 + 4200 * bright) * Math.exp(-x / 0.06), 2.5);
      ph = (ph + hz / sr) % 1;
      const sq = ph < 0.5 ? 1 : -1;
      const v = f.run(sq, 0) * amp * Math.min(1, x / 0.003) * Math.exp(-x / 0.09) * Math.min(1, (n - i) / 200);
      out[i0 + i] += v;
      send[i0 + i] += v * 0.6;
    }
  };

  // ---- pad: continuous detuned saws through a slowly moving low-pass ---------------------
  {
    const f = new SVF(sr);
    const phases = new Float64Array(10);
    for (let i = 0; i < N; i++) {
      const t = i / sr - start;
      const b = Math.max(0, Math.min(BARS - 1, Math.floor(t / bar)));
      const ch = CHORDS[b % 4];
      const inBreak = b >= 16 && b < 24;
      if (i % 32 === 0) f.set(inBreak ? 700 + ((t - 16 * bar) / (8 * bar)) * 2400 : 1300, 0.8);
      let s = 0;
      for (let v = 0; v < 10; v++) {
        const hz = midi(ch.notes[v >> 1]) * (v & 1 ? 1.004 : 0.996);
        phases[v] = (phases[v] + hz / sr) % 1;
        s += 2 * phases[v] - 1;
      }
      // chord-change swell so changes don't click
      const inBar = ((t % bar) + bar) % bar;
      const swell = Math.min(1, inBar / 0.4) * Math.min(1, (bar - inBar) / 0.05 + 0.2);
      const fadeIn = Math.min(1, Math.max(0, t + start) / 1.5);
      out[i] += f.run(s, 0) * (inBreak ? 0.05 : 0.032) * swell * fadeIn * (0.4 + 0.6 * duck[i]);
    }
  }

  const BASS_STEPS = [3, 6, 10, 13];
  const PERC: Record<number, number> = { 3: 210, 7: 290, 10: 210, 11: 160, 14: 290 };
  const ARP = [0, 2, 4, 1, 3, 4, 2, 0, 1, 3, 4, 2, 4, 3, 1, 2];

  for (let b = 0; b < BARS; b++) {
    const t0 = start + b * bar;
    const ch = CHORDS[b % 4];
    const intro = b < 4;
    const breakdown = b >= 16 && b < 24;
    const drop = b >= 24;
    const full = !intro && !breakdown;
    for (let s = 0; s < 16; s++) {
      const t = t0 + s * step;
      if (!breakdown || b >= 22) noise(t, 0.06, 1, 7000, 1.1, s % 2 ? 0.16 : 0.08, 0.018);
      if (full && s % 4 === 0) kick(t, drop ? 0.95 : 0.85, b === 24 && s === 0);
      if (full && s % 4 === 2) noise(t, drop ? 0.3 : 0.18, 2, 8500, 0.7, 0.2, drop ? 0.07 : 0.04, 0.2);
      if (full && (s === 4 || s === 12)) noise(t, 0.2, 1, 1500, 0.8, 0.55, 0.05, 0.3);
      if ((full || intro) && PERC[s]) conga(t, PERC[s], 0.22);
      if (full && BASS_STEPS.includes(s)) bass(t, ch.root - 12 + (s === 13 ? 12 : 0), step * 2.2);
      const arpOn = (b >= 12 && b < 16) || breakdown || drop;
      if (arpOn && (drop || b >= 20 || s % 2 === 0)) {
        const bright = breakdown ? (b - 16) / 8 : drop ? 1 : 0.4;
        pluck(t, ch.notes[ARP[s] % ch.notes.length] + 12, bright, breakdown ? 0.1 : 0.08);
      }
    }
    if (b === 22) {
      // two-bar riser: band-passed noise sweeping 400 Hz → 9 kHz, swelling
      const f = new SVF(sr);
      const n = at(bar * 2), i0 = at(t0);
      for (let i = 0; i < n && i0 + i < N; i++) {
        const p = i / n;
        if (i % 16 === 0) f.set(400 * Math.pow(22, p), 1.6);
        out[i0 + i] += f.run(rnd(), 1) * 0.5 * p * p * Math.min(1, (n - i) / 400);
      }
    }
    if (b === 23) for (let s = 0; s < 16; s += s < 8 ? 2 : 1) noise(t0 + s * step, 0.12, 1, 2000, 0.9, 0.25 + s * 0.04, 0.03);
  }

  // dotted-eighth feedback delay on the send bus, damped
  {
    const d = at(step * 3);
    const lp = new SVF(sr);
    lp.set(3500, 0.7);
    for (let i = d; i < N; i++) send[i] += lp.run(send[i - d], 0) * 0.35;
    for (let i = 0; i < N; i++) out[i] += send[i] * 0.35;
  }

  // gentle saturation as a limiter, then normalise to -1 dBFS
  let peak = 0;
  for (let i = 0; i < N; i++) {
    out[i] = Math.tanh(out[i] * 1.4);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < N; i++) out[i] *= g;

  return { sampleRate: sr, data: out, kicks, breakdown: [start + 16 * bar, start + 24 * bar], dropAt: start + 24 * bar };
}

export function encodeWav(data: Float32Array, sampleRate: number): Blob {
  const out = new DataView(new ArrayBuffer(44 + data.length * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + data.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

export async function renderDemoTrack(): Promise<Blob> {
  // yield once so the "synthesising" state can paint before the CPU work starts
  await new Promise((r) => setTimeout(r, 30));
  const r = synthDemo(44100);
  return encodeWav(r.data, r.sampleRate);
}
