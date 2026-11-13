// Writes a 40 s, 120 BPM test beat (kick on every beat, clap on 2 and 4, eighth-note hats, a bass line)
// to e2e/.out/beat120.wav. The tests load it as a song file and play it through Chrome's fake microphone,
// so the expected tempo is known exactly.
import fs from 'node:fs';
import path from 'node:path';

export const BEAT_BPM = 120;
export const BEAT_WAV = path.resolve(path.dirname(new URL(import.meta.url).pathname), '.out', 'beat120.wav');

export function makeBeat(file = BEAT_WAV, bpm = BEAT_BPM, seconds = 40, sr = 44100) {
  const n = Math.floor(seconds * sr), x = new Float32Array(n), beat = 60 / bpm;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t0, len, fn) => { const a = Math.floor(t0 * sr), b = Math.min(n, a + Math.floor(len * sr)); for (let i = a; i < b; i++) x[i] += fn((i - a) / sr); };
  const roots = [55, 43.65, 65.41, 49]; // A1 F1 C2 G1
  for (let k = 0; k * beat < seconds; k++) {
    const t = k * beat;
    let ph = 0; add(t, 0.4, s => { const f = 45 + 110 * Math.exp(-s * 28); ph += 2 * Math.PI * f / sr; return 0.9 * Math.sin(ph) * Math.exp(-s * 9); });
    if (k % 2 === 1) add(t, 0.2, s => 0.35 * rnd() * Math.exp(-s * 22));
    for (const h of [0, 0.5]) add(t + h * beat, 0.05, s => 0.12 * rnd() * Math.exp(-s * 90));
    const f = roots[Math.floor(k / 4) % 4]; let bp = 0;
    add(t + 0.5 * beat, beat * 0.45, s => { bp += 2 * Math.PI * f / sr; return 0.25 * Math.sign(Math.sin(bp)) * Math.exp(-s * 5); });
  }
  let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(x[i] / pk * 0.9 * 32767), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pcm);
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) console.log(makeBeat());
