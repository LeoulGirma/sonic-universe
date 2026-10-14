/** How often the valley's bass punch fires: npx vite-node scripts/punch-probe.ts <in.f32> */
import fs from 'node:fs';
import { buildSongMap } from '../src/audio/songMap';
import { SPEC_BANDS } from '../src/audio/spectrum';
import { Spring } from '../src/audio/dsp';
const raw = fs.readFileSync(process.argv[2]);
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const sp = buildSongMap(data, 22050).spectrum!;
const dt = 1 / sp.fps, slowS = new Spring(), hv = new Spring();
let punch = 0, big = 0, sum = 0, mx = 0, n = 0, lowVar = 0, lowPrev = 0;
for (let j = 0; j < sp.n; j++) {
  let low = 0;
  for (let k = 0; k < 7; k++) low += sp.data[j * SPEC_BANDS + k] / 255 / 7;
  const slow = slowS.step(low, dt, 0.8);
  const prev = punch;
  punch = Math.max(punch * Math.exp(-dt / 0.28), Math.max(0, low - slow - 0.04) * 3.2);
  if (punch > 0.3 && prev <= 0.3) big++;
  const h = hv.step(Math.min(1.6, punch + 0.25 * low), dt, 3.5);
  sum += h; mx = Math.max(mx, h); n++;
  lowVar += Math.abs(low - lowPrev); lowPrev = low;
}
console.log(`punches >0.3: ${(big / (sp.n * dt)).toFixed(2)}/s, mean heave ${(sum / n).toFixed(2)}, max ${mx.toFixed(2)}, mean |Δlow| per frame ${(lowVar / n).toFixed(3)}`);
