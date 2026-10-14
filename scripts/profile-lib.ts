/**
 * Profile a music library: decodes every audio file under <dir> (ffmpeg → mono 22.05 kHz),
 * builds the song map and appends {file, duration, bpm, profile} to <out.jsonl>.
 * With --watch it keeps polling for new files (and --consume deletes each source after use)
 * until <dir>/.done exists.
 *   npx vite-node scripts/profile-lib.ts <dir> <out.jsonl> [--watch] [--consume]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSongMap } from '../src/audio/songMap';

const [dir, out] = process.argv.slice(2);
const watch = process.argv.includes('--watch');
const consume = process.argv.includes('--consume');
const SR = 22050;
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('--only');
const skip = arg('--skip');
const pick = (rel: string) => (!only || rel.includes(only)) && (!skip || !rel.includes(skip));
const done = new Set<string>();
if (fs.existsSync(out)) for (const l of fs.readFileSync(out, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).file);

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(mp3|flac|wav|m4a|ogg)$/i.test(e.name) ? [p] : [];
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = out + '.tmp.f32';

async function main() {
  for (;;) {
    const files = walk(dir).filter((f) => !done.has(path.relative(dir, f)) && pick(path.relative(dir, f)));
    for (const f of files) {
      const rel = path.relative(dir, f);
      // a staged file may still be arriving: wait until its size settles
      let sz = -1;
      while (fs.statSync(f).size !== sz) { sz = fs.statSync(f).size; await sleep(400); }
      const t0 = performance.now();
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 'f32le', tmp]);
        const raw = fs.readFileSync(tmp);
        const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        const m = buildSongMap(pcm, SR);
        fs.appendFileSync(out, JSON.stringify({ file: rel, duration: m.duration, bpm: m.bpm, profile: m.profile }) + '\n');
        console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s ${rel}`);
      } catch (e) {
        fs.appendFileSync(out, JSON.stringify({ file: rel, error: String(e).slice(0, 200) }) + '\n');
        console.log('ERR', rel);
      }
      done.add(rel);
      if (consume) fs.rmSync(f);
    }
    if (!watch || (fs.existsSync(path.join(dir, '.done')) && !walk(dir).some((f) => !done.has(path.relative(dir, f)) && pick(path.relative(dir, f))))) break;
    await sleep(3000);
  }
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
}
main();
