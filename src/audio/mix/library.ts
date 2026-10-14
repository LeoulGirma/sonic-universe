/**
 * Song maps for a mix queue: built one at a time in a worker (decode at 22.05 kHz mono, then the
 * same buildSongMap as single songs), cached in IndexedDB by file name, size and date so a song
 * is only ever analysed once per browser.
 */
import type { SongMap } from '../songMap';
import MapWorker from '../songMap.worker?worker&inline';

const DB = 'sonic-universe';
const STORE = 'songMaps';
const VERSION = 1; // bump when the map format changes

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
let dbP: Promise<IDBDatabase | null> | null = null;
const db = () => (dbP ??= openDb());

export function fileKey(f: Blob & { name?: string; lastModified?: number }) {
  return `v${VERSION}|${f.name ?? ''}|${f.size}|${f.lastModified ?? 0}`;
}

async function cached(key: string): Promise<SongMap | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res((r.result as SongMap) ?? null);
      r.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}

async function store(key: string, map: SongMap) {
  const d = await db();
  if (!d) return;
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(map, key);
  } catch {
    /* quota or private mode: analysis still works, it just isn't remembered */
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (m: SongMap | null) => void>();
function getWorker() {
  if (worker) return worker;
  worker = new MapWorker();
  worker.onmessage = (e: MessageEvent<{ id: number; map?: SongMap; error?: string }>) => {
    const { id, map, error } = e.data;
    if (map || error) {
      pending.get(id)?.(map ?? null);
      pending.delete(id);
    }
  };
  return worker;
}

/** the song map for a file: from the cache, or analysed now */
export async function mapFor(blob: Blob & { name?: string; lastModified?: number }): Promise<SongMap | null> {
  const key = fileKey(blob);
  const hit = await cached(key);
  if (hit) return hit;
  try {
    const OAC = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    const buf = await new OAC(1, 1, 22050).decodeAudioData(await blob.arrayBuffer());
    if (buf.duration > 25 * 60) return null;
    const n = buf.length;
    const mono = new Float32Array(n);
    const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    for (const ch of chs) for (let i = 0; i < n; i++) mono[i] += ch[i] / chs.length;
    const id = ++seq;
    const map = await new Promise<SongMap | null>((res) => {
      pending.set(id, res);
      getWorker().postMessage({ id, pcm: mono, sr: buf.sampleRate }, [mono.buffer]);
    });
    if (map) void store(key, map);
    return map;
  } catch {
    return null;
  }
}
