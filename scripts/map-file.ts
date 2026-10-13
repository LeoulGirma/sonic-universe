/**
 * Build the song map for a raw mono float32 PCM file and write it as JSON.
 *   ffmpeg -i song.mp3 -ac 1 -ar 22050 -f f32le song22.f32
 *   npx vite-node scripts/map-file.ts song22.f32 map.json 22050
 */
import fs from 'node:fs';
import { buildSongMap } from '../src/audio/songMap';

const [inFile, outFile, srArg] = process.argv.slice(2);
const sr = Number(srArg ?? 22050);
const raw = fs.readFileSync(inFile);
const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const t0 = performance.now();
const m = buildSongMap(pcm, sr);
const ms = performance.now() - t0;
fs.writeFileSync(outFile, JSON.stringify({ ...m, beats: Array.from(m.beats) }));
const fmt = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
console.log(`built in ${(ms / 1000).toFixed(1)} s for ${fmt(m.duration)} · ${m.bpm.toFixed(2)} BPM · ${m.beats.length} beats · grid confidence ${m.beatConfidence.toFixed(2)}`);
console.log('breakdowns', m.breakdowns.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', '));
console.log('drops', m.drops.map((d) => `${fmt(d.t)}${d.strength < 1 ? ' (energy)' : ''}`).join(', '));
console.log('build-ups', m.anticipation.map(([a, b]) => `${(b - a).toFixed(1)} s`).join(', '));
