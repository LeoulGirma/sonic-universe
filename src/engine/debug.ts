import type * as THREE from 'three';
import { audioEngine } from '../audio/AudioEngine';
import { renderDemoTrack } from '../audio/demoTrack';
import { useStore } from '../store/useStore';
import { driveOverride, drives, perf } from './frameBus';

/**
 * Opt-in inspection hook (`?debug` in the URL). Lets automated tests read real simulation
 * state off the GPU to verify that music — not a timer — is what moves the stars.
 */
export const debugEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

interface SimHandle {
  gl: THREE.WebGLRenderer;
  w: number;
  h: number;
  pos: () => THREE.WebGLRenderTarget;
  vel: () => THREE.WebGLRenderTarget;
}
let handle: SimHandle | null = null;

export function registerSim(h: SimHandle | null) {
  handle = h;
}

function readStats() {
  if (!handle) return null;
  const { gl, w, h } = handle;
  const n = w * h;
  const P = new Float32Array(n * 4);
  const V = new Float32Array(n * 4);
  gl.readRenderTargetPixels(handle.pos(), 0, 0, w, h, P);
  gl.readRenderTargetPixels(handle.vel(), 0, 0, w, h, V);
  let r = 0, vy = 0, heat = 0, maxHeat = 0, speed = 0, nan = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (!isFinite(P[k]) || !isFinite(V[k])) { nan++; continue; }
    r += Math.hypot(P[k], P[k + 1], P[k + 2]);
    vy += V[k + 1] * V[k + 1];
    speed += Math.hypot(V[k], V[k + 1], V[k + 2]);
    heat += V[k + 3];
    maxHeat = Math.max(maxHeat, V[k + 3]);
  }
  return { meanR: r / n, rmsVy: Math.sqrt(vy / n), meanSpeed: speed / n, meanHeat: heat / n, maxHeat, nan, n };
}

if (debugEnabled) {
  (window as unknown as Record<string, unknown>).__sonic = { audioEngine, drives, perf, store: useStore, readStats, renderDemoTrack };
}

// ---------------------------------------------------------------------------------------
// Offline, frame-accurate verification: analyse a waveform at exactly 60 fps with the real
// FeatureExtractor + DriveMapper and step the real GPU simulation with the result. Rendering
// speed doesn't matter, so this works even on a software GPU.
// ---------------------------------------------------------------------------------------
import { FeatureExtractor } from '../audio/FeatureExtractor';
import { DriveMapper, Drives } from '../mapping/drives';
import { fftMagDb } from '../audio/fft';
import { synthDemo } from '../audio/demoTrack';
import { buildSongMap } from '../audio/songMap';
import { MixEngine } from '../audio/mix/MixEngine';
import { planTransition } from '../audio/mix/transition';
import { conductor } from '../mapping/conductor';

let stepper: ((dt: number, d: Drives) => void) | null = null;
let extraStats: (() => Record<string, number>) | null = null;
let selfTest: (() => unknown) | null = null;
let worldInfo: (() => Record<string, unknown>) | null = null;
export function registerExtras(x: { stats?: () => Record<string, number>; selfTest?: () => unknown; info?: () => Record<string, unknown> } | null) {
  extraStats = x?.stats ?? null;
  selfTest = x?.selfTest ?? null;
  worldInfo = x?.info ?? null;
}
export function registerStepper(fn: ((dt: number, d: Drives) => void) | null) {
  stepper = fn;
}

let mapCache: { data: Float32Array; map: ReturnType<typeof buildSongMap> } | null = null;

/**
 * @param from start time (s): the analysis and the world are stepped from here, so a moment deep
 *             in a song can be checked without simulating everything before it (give worlds a
 *             few seconds of lead-in for their history)
 */
export function runOffline(data: Float32Array, sr: number, seconds: number, every = 15, withMap = false, from = 0) {
  if (!stepper) throw new Error('no simulation registered');
  useStore.getState().set({ frozen: true }); // stop the live loop from stepping the sim
  const fx = new FeatureExtractor();
  if (withMap) {
    if (mapCache?.data !== data) mapCache = { data, map: buildSongMap(data, sr) };
    fx.setMap(mapCache.map);
  }
  const mp = new DriveMapper();
  const N = 2048;
  const frame = new Float32Array(N);
  const freq = new Float32Array(N / 2);
  const dt = 1 / 60;
  const out: Record<string, number | string>[] = [];
  const { gains, sensitivity } = useStore.getState();
  let i = 0;
  for (let t = Math.max(N / sr, from); t < Math.min(seconds, data.length / sr); t += dt, i++) {
    const end = Math.floor(t * sr);
    frame.set(data.subarray(end - N, end));
    fftMagDb(frame, freq);
    const f = fx.process(freq, frame, sr, t, dt);
    const d = mp.update(f, gains, sensitivity, dt);
    conductor.update(dt, d, useStore.getState().mood && ['valley', 'geometric', 'tunnel', 'ink'].includes(useStore.getState().world));
    stepper(dt, d);
    if (i % every === 0) {
      const s = readStats();
      out.push({ t, section: f.section, fam: f.fam.level.map((v) => +v.toFixed(2)).join(' ') as unknown as number, bass: f.bass, kick: d.pulse, kicks: f.kickCount, drops: f.dropCount, energy: d.energy, gravity: d.gravity, ...(s ?? {}), ...(extraStats?.() ?? {}), ...((worldInfo?.() ?? {}) as Record<string, number | string>) });
    }
  }
  conductor.snap();
  driveOverride.d = mp.d; // what is on screen now matches the last offline frame
  return out;
}

/** A second, contrasting test song: 96 BPM half-time, sparse kicks, heavy sub bass, bright hats. */
export function synthContrast(sr = 44100, seconds = 40) {
  const N = Math.floor(sr * seconds);
  const data = new Float32Array(N);
  const beat = 60 / 96;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let b = 0; b * beat < seconds - 1; b++) {
    const t = b * beat;
    if (b % 4 === 0 || b % 8 === 5) {
      let ph = 0;
      const i0 = Math.floor(t * sr);
      for (let i = 0; i < sr * 0.9 && i0 + i < N; i++) {
        const x = i / sr;
        ph += (2 * Math.PI * (40 + 60 * Math.exp(-x / 0.04))) / sr;
        data[i0 + i] += 0.9 * Math.sin(ph) * Math.exp(-x / 0.5);
      }
    }
    for (let k = 0; k < 4; k++) {
      const i0 = Math.floor((t + (k * beat) / 4) * sr);
      let prev = 0;
      for (let i = 0; i < sr * 0.05 && i0 + i < N; i++) {
        const n = rnd();
        data[i0 + i] += 0.3 * (n - prev) * Math.exp(-(i / sr) / 0.015);
        prev = n;
      }
    }
  }
  for (let i = 0; i < N; i++) data[i] += 0.03 * Math.sin((2 * Math.PI * 523 * i) / sr) * (0.5 + 0.5 * Math.sin(i / sr));
  return data;
}

/**
 * Render a DJ transition offline with the real MixEngine on an OfflineAudioContext: the songs
 * are analysed, A starts `lead` seconds before its planned mix-out and `seconds` of audio are
 * rendered, ticking the engine every 250 ms. Returns 16-bit stereo WAV bytes and what happened.
 */
async function renderMix(urls: string[], seconds = 60, lead = 20, mixNowAt?: number) {
  const sr = 44100;
  const blobs = await Promise.all(urls.map(async (u) => (await fetch(u)).blob()));
  const maps = await Promise.all(blobs.map(async (b) => {
    const buf = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(await b.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const ch = buf.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels; }
    return buildSongMap(mono, buf.sampleRate);
  }));
  const ctx = new OfflineAudioContext(2, sr * seconds, sr);
  const log: string[] = [];
  const mix = new MixEngine(ctx as unknown as AudioContext, ctx.destination, {
    onSwap: (t) => log.push(`${ctx.currentTime.toFixed(2)}s swap -> ${t.name}`),
    onEnd: () => log.push(`${ctx.currentTime.toFixed(2)}s end`),
    onChange: () => {},
  });
  mix.tracks = blobs.map((blob, i) => ({ id: i + 1, name: urls[i], blob, map: maps[i], status: 'ready' as const }));
  const plan = planTransition(maps[0], maps[1], mixNowAt);
  for (const t of mix.tracks) await mix.preload(t);
  await mix.playTrack(mix.tracks[0], mixNowAt !== undefined ? Math.max(0, mixNowAt - lead) : Math.max(0, plan.outT - lead));
  if (mixNowAt !== undefined) mix.mixNow();
  for (let t = 0.1; t < seconds - 0.1; t += 0.25) {
    void ctx.suspend(t).then(() => { mix.tick(); void ctx.resume(); });
  }
  const out = await ctx.startRendering();
  const L = out.getChannelData(0), R = out.getChannelData(1);
  const wav = new DataView(new ArrayBuffer(44 + L.length * 4));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); wav.setUint32(4, 36 + L.length * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true); wav.setUint32(24, sr, true);
  wav.setUint32(28, sr * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); w(36, 'data'); wav.setUint32(40, L.length * 4, true);
  for (let i = 0; i < L.length; i++) {
    wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  let bin = '';
  const bytes = new Uint8Array(wav.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { wav: btoa(bin), plan: { ...plan, bpmA: maps[0].bpm, bpmB: maps[1].bpm }, log };
}

if (debugEnabled) {
  Object.assign((window as unknown as { __sonic: object }).__sonic, {
    runOffline, synthDemo, synthContrast, renderMix,
    selfTest: () => selfTest?.(),
    worldStats: () => ({ ...(extraStats?.() ?? {}), ...(worldInfo?.() ?? {}) }),
  });
}
