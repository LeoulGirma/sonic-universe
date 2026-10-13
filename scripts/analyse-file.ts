/**
 * Offline calibration: run the real FeatureExtractor over a raw mono float32 PCM file
 * (e.g. `ffmpeg -i song.mp3 -ac 1 -ar 44100 -f f32le song.f32`) at a fixed frame rate,
 * exactly as the browser would, and write a JSON timeline.
 *   npx vite-node scripts/analyse-file.ts <in.f32> <out.json> [fps]
 */
import fs from 'node:fs';
import { FeatureExtractor } from '../src/audio/FeatureExtractor';
import { fftMagDb } from '../src/audio/fft';

const [inFile, outFile, fpsArg] = process.argv.slice(2);
const sr = 44100;
const fps = Number(fpsArg ?? 60);
const raw = fs.readFileSync(inFile);
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const N = 2048;
const frame = new Float32Array(N);
const freq = new Float32Array(N / 2);
const fx = new FeatureExtractor();
const dt = 1 / fps;
const hits: { t: number; s: number }[] = [];
const hats: number[] = [];
const drops: number[] = [];
const beats: number[] = [];
const rows: Record<string, number | string>[] = [];
let lk = 0, lh = 0, ld = 0, i = 0;
for (let t = N / sr; t < data.length / sr; t += dt, i++) {
  const end = Math.floor(t * sr);
  frame.set(data.subarray(end - N, end));
  fftMagDb(frame, freq);
  const f = fx.process(freq, frame, sr, t, dt);
  if (f.kickCount > lk) hits.push({ t, s: f.kick });
  if (f.hatCount > lh) hats.push(t);
  if (f.dropCount > ld) drops.push(t);
  if (f.beat) beats.push(t);
  lk = f.kickCount; lh = f.hatCount; ld = f.dropCount;
  if (i % Math.round(fps / 4) === 0)
    rows.push({ t: +t.toFixed(2), bpm: +f.bpm.toFixed(1), conf: +f.beatConfidence.toFixed(2), bass: +f.bass.toFixed(2), mid: +f.mid.toFixed(2), high: +f.high.toFixed(2), loud: +f.loudness.toFixed(2), db: +f.loudnessDb.toFixed(1), cen: Math.round(f.centroidHz), inten: +f.intensity.toFixed(2), brk: +f.breakdown.toFixed(2), build: +f.build.toFixed(2), section: f.section });
}
fs.writeFileSync(outFile, JSON.stringify({ fps, hits, hats, drops, beats, rows }));
console.log(`frames ${i}, hits ${hits.length}, hats ${hats.length}, beats ${beats.length}, drops ${drops.map((x) => x.toFixed(1)).join(',')}`);
