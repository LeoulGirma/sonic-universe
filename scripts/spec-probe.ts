/** Spectrum and bass levels through a song: npx vite-node scripts/spec-probe.ts <in.f32> */
import fs from 'node:fs';
import { buildSongMap } from '../src/audio/songMap';
import { SPEC_BANDS, specFrame } from '../src/audio/spectrum';
const raw = fs.readFileSync(process.argv[2]);
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const map = buildSongMap(data, 22050);
const sp = map.spectrum!, fam = map.families!;
console.log('bpm', map.bpm.toFixed(1), 'drops', map.drops.map((d) => d.t.toFixed(1)).join(' '), 'kicks/s', (map.kicks.t.length / map.duration).toFixed(2));
console.log('ranges dB bass', fam.ranges[3].map((x) => x.toFixed(0)).join('..'), 'kick', fam.ranges[0].map((x) => x.toFixed(0)).join('..'));
for (let t = 10; t < map.duration; t += 20) {
  const j = specFrame(sp, t);
  let lo = 0, mid = 0, hi = 0;
  for (let k = 0; k < 6; k++) lo += sp.data[j * SPEC_BANDS + k] / 255 / 6;
  for (let k = 10; k < 20; k++) mid += sp.data[j * SPEC_BANDS + k] / 255 / 10;
  for (let k = 24; k < 32; k++) hi += sp.data[j * SPEC_BANDS + k] / 255 / 8;
  const i = Math.round((t - fam.t0) * fam.fps);
  console.log(`t ${t}s spec low ${lo.toFixed(2)} mid ${mid.toFixed(2)} high ${hi.toFixed(2)} | fam bass ${fam.level[3][i].toFixed(2)} kick ${fam.level[0][i].toFixed(2)}`);
}
