/** Print the sections the song map finds: npx vite-node scripts/sections-file.ts <in.f32 | demo> */
import fs from 'node:fs';
import { buildSongMap } from '../src/audio/songMap';
import { BIOME_NAMES } from '../src/audio/sections';
import { synthDemo } from '../src/audio/demoTrack';
const [inFile] = process.argv.slice(2);
const sr = 22050;
let data: Float32Array;
if (inFile === 'demo') data = synthDemo(sr).data;
else { const raw = fs.readFileSync(inFile); data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4); }
const t0 = performance.now();
const map = buildSongMap(data, sr);
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
console.log(`${map.bpm.toFixed(1)} BPM, built in ${(performance.now() - t0).toFixed(0)} ms, ${map.kicks.t.length} kicks, drops ${map.drops.map((d) => fmt(d.t)).join(' ')}`);
for (const s of map.sections) console.log(`${fmt(s.start)}–${fmt(s.end)}  label ${String.fromCharCode(65 + s.label)}  ${BIOME_NAMES[s.biome].padEnd(9)} energy ${s.energy.toFixed(2)}`);
