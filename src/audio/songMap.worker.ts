/// <reference lib="webworker" />
import { buildSongMap } from './songMap';

/** Builds the song map off the main thread so playback and rendering never stall. */
self.onmessage = (e: MessageEvent<{ id: number; pcm: Float32Array; sr: number }>) => {
  const { id, pcm, sr } = e.data;
  try {
    let last = 0;
    const map = buildSongMap(pcm, sr, (p) => {
      if (p - last >= 0.05 || p === 1) {
        last = p;
        self.postMessage({ id, progress: p });
      }
    });
    self.postMessage({ id, map }, [map.beats.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
