/**
 * Sound-family timeline of a song, as the song map sees it.
 *   ffmpeg -i song.flac -ac 1 -ar 22050 -f f32le song.f32
 *   npx vite-node scripts/families-file.ts <in.f32> [windowSeconds]
 * Prints mean level (0..9) per family per window, and onset counts.
 */
import fs from 'node:fs';
import { buildSongMap } from '../src/audio/songMap';
import { FAMILY_INFO, NF } from '../src/audio/soundFamilies';
import { synthDemo } from '../src/audio/demoTrack';

const [inFile, winArg] = process.argv.slice(2);
const sr = 22050;
let data: Float32Array;
if (inFile === 'demo') data = synthDemo(sr).data;
else {
  const raw = fs.readFileSync(inFile);
  data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
const t0 = performance.now();
const map = buildSongMap(data, sr);
const ms = performance.now() - t0;
const fam = map.families!;
const W = Number(winArg ?? 8);
console.log(`${(data.length / sr).toFixed(0)} s analysed in ${ms.toFixed(0)} ms; bpm ${map.bpm.toFixed(1)}`);
console.log('ranges dB', fam.ranges.map((r, f) => `${FAMILY_INFO[f].id} ${r[0].toFixed(0)}..${r[1].toFixed(0)}`).join('  '));
console.log('   t  ' + FAMILY_INFO.map((f) => f.id.padStart(4)).join(' ') + '   | onsets ' + FAMILY_INFO.map((f) => f.id.padStart(4)).join(' ') + ' | mel  hue');
for (let a = 0; a < map.duration; a += W) {
  const i0 = Math.max(0, Math.round((a - fam.t0) * fam.fps));
  const i1 = Math.min(fam.n, Math.round((a + W - fam.t0) * fam.fps));
  if (i1 <= i0) break;
  const lv: string[] = [];
  for (let f = 0; f < NF; f++) {
    let s = 0;
    for (let i = i0; i < i1; i++) s += fam.level[f][i];
    lv.push(Math.round((9 * s) / (i1 - i0)).toString().padStart(4));
  }
  const ev = fam.events.map((e) => e.filter((t) => t >= a && t < a + W).length.toString().padStart(4));
  let ms2 = 0, mn = 0;
  for (let i = i0; i < i1; i++) if (fam.melody[i] >= 0) { ms2 += fam.melody[i]; mn++; }
  console.log(`${a.toFixed(0).padStart(4)}  ${lv.join(' ')}   |        ${ev.join(' ')} | ${mn ? (ms2 / mn).toFixed(2) : ' -- '} ${fam.hue[i1 - 1].toFixed(2)}`);
}
