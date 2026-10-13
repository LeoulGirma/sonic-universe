import { FeatureExtractor, MusicFeatures } from './FeatureExtractor';
import type { SongMap } from './songMap';
import { useStore } from '../store/useStore';
import MapWorker from './songMap.worker?worker&inline';

export type SourceKind = 'none' | 'file' | 'mic' | 'system';

export interface TransportState {
  source: SourceKind;
  trackName: string;
  playing: boolean;
  duration: number;
  loading: boolean;
  loadingLabel: string;
  error: string | null;
  /** whole-song analysis for files: 'mapping' while it runs in the background */
  mapState: 'none' | 'mapping' | 'ready' | 'off';
  mapProgress: number;
  mapInfo: { bpm: number; drops: number[]; breakdowns: [number, number][]; duration: number; confidence: number; sections: { start: number; end: number; label: number; biome: number }[] } | null;
}

/** How a file is being played: a media element (streams, low memory) or a decoded buffer. */
type Backend = 'element' | 'buffer';

type Listener = (s: TransportState) => void;

/**
 * Layer 1 — audio acquisition and analysis.
 *
 * Owns the AudioContext, the media element / microphone sources and a single AnalyserNode.
 * Each animation frame `analyse(dt)` pulls the spectrum + waveform and runs the pure
 * FeatureExtractor. Nothing visual lives here.
 */
export class AudioEngine {
  readonly extractor = new FeatureExtractor();
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private out: GainNode | null = null;
  private el: HTMLAudioElement;
  private elSource: MediaElementAudioSourceNode | null = null;
  private mic: { stream: MediaStream; node: MediaStreamAudioSourceNode } | null = null;
  private freq = new Float32Array(1024);
  private wave = new Float32Array(2048);
  private objectUrl: string | null = null;
  private listeners = new Set<Listener>();
  private clock = 0;
  private backend: Backend = 'element';
  private blob: Blob | null = null;
  private loadToken = 0;
  private buf: { buffer: AudioBuffer; node: AudioBufferSourceNode | null; startAt: number; offset: number } | null = null;
  private unlocked = false;

  state: TransportState = {
    source: 'none', trackName: '', playing: false, duration: 0, loading: false, loadingLabel: '', error: null,
    mapState: 'none', mapProgress: 0, mapInfo: null,
  };
  private worker: Worker | null = null;

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    const el = () => this.backend === 'element' && this.state.source === 'file';
    this.el.addEventListener('play', () => el() && this.set({ playing: true }));
    this.el.addEventListener('pause', () => el() && this.set({ playing: false }));
    this.el.addEventListener('ended', () => el() && this.set({ playing: false }));
    this.el.addEventListener('loadedmetadata', () => el() && this.set({ duration: this.el.duration || 0 }));
    this.el.addEventListener('seeked', () => el() && this.extractor.seek());
    // the element can refuse a source (an embedding page's media policy, an unusual codec):
    // fall back to decoding the file ourselves
    this.el.addEventListener('error', () => {
      if (el() && this.blob) void this.useBufferBackend(this.loadToken);
    });
  }

  get features(): MusicFeatures {
    return this.extractor.f;
  }

  get currentTime() {
    if (this.state.source !== 'file') return 0;
    if (this.backend === 'element') return this.el.currentTime;
    const b = this.buf;
    if (!b) return 0;
    const t = b.node && this.ctx ? this.ctx.currentTime - b.startAt : b.offset;
    return Math.min(Math.max(t, 0), b.buffer.duration);
  }

  /**
   * Call synchronously inside a user gesture (tap, click, key). Mobile browsers only let audio
   * start from a gesture, and a file picker's result arrives outside it.
   */
  unlock() {
    const ctx = this.ensureContext();
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const n = ctx.createBufferSource();
      n.buffer = b;
      n.connect(ctx.destination);
      n.start(0);
    } catch {
      /* best effort */
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<TransportState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l(this.state));
  }

  /** Must be called from a user gesture the first time (autoplay policy). */
  private ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0; // smoothing is done per-feature in the extractor
      this.analyser.minDecibels = -120;
      this.analyser.maxDecibels = 0;
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private attachElement() {
    const ctx = this.ensureContext();
    if (!this.elSource) {
      this.elSource = ctx.createMediaElementSource(this.el);
    }
    this.elSource.disconnect();
    this.elSource.connect(this.analyser!);
    this.analyser!.disconnect();
    this.analyser!.connect(this.out!);
  }

  private stopBuffer(keepOffset = true) {
    const b = this.buf;
    if (!b?.node) return;
    if (keepOffset && this.ctx) b.offset = Math.min(this.ctx.currentTime - b.startAt, b.buffer.duration);
    b.node.onended = null;
    try {
      b.node.stop();
    } catch {
      /* already stopped */
    }
    b.node.disconnect();
    b.node = null;
  }

  private startBuffer() {
    const ctx = this.ensureContext();
    const b = this.buf;
    if (!b || b.node) return;
    if (b.offset >= b.buffer.duration - 0.05) b.offset = 0;
    const node = ctx.createBufferSource();
    node.buffer = b.buffer;
    node.connect(this.analyser!);
    this.analyser!.disconnect();
    this.analyser!.connect(this.out!);
    node.onended = () => {
      if (this.buf?.node !== node) return;
      this.buf.node = null;
      this.buf.offset = 0;
      this.set({ playing: false });
    };
    node.start(0, b.offset);
    b.node = node;
    b.startAt = ctx.currentTime - b.offset;
    this.set({ playing: true });
  }

  private getWorker() {
    if (this.worker) return this.worker;
    const w = new MapWorker();
    w.onmessage = (e: MessageEvent<{ id: number; progress?: number; map?: SongMap; error?: string }>) => {
      const { id, progress, map, error } = e.data;
      if (id !== this.loadToken || this.state.source !== 'file') return; // a newer track took over
      if (progress !== undefined) this.set({ mapProgress: progress });
      if (error) this.set({ mapState: 'off' });
      if (map) {
        this.extractor.setMap(map);
        this.set({
          mapState: 'ready',
          mapProgress: 1,
          mapInfo: { bpm: map.bpm, drops: map.drops.map((d) => d.t), breakdowns: map.breakdowns, duration: map.duration, confidence: map.beatConfidence, sections: map.sections.map(({ start, end, label, biome }) => ({ start, end, label, biome })) },
        });
      }
    };
    w.onerror = () => this.set({ mapState: 'off' });
    this.worker = w;
    return w;
  }

  /**
   * Whole-song analysis in the background: decode at 22.05 kHz (half the memory, same frequency
   * resolution with a 1024-point FFT), downmix, and build the map in a worker. The song plays on
   * live analysis meanwhile; when the map lands, rhythm and structure switch over seamlessly.
   */
  private async mapSong(blob: Blob, token: number) {
    if (blob.size > 80 * 1024 * 1024) return this.set({ mapState: 'off' });
    this.set({ mapState: 'mapping', mapProgress: 0 });
    try {
      const OAC = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      const oc = new OAC(1, 1, 22050);
      const buf = await oc.decodeAudioData(await blob.arrayBuffer());
      if (token !== this.loadToken) return;
      if (buf.duration > 25 * 60) return this.set({ mapState: 'off' }); // long DJ mixes: live analysis only
      const n = buf.length;
      const mono = new Float32Array(n);
      const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
      const g = 1 / chs.length;
      for (const ch of chs) for (let i = 0; i < n; i++) mono[i] += ch[i] * g;
      this.getWorker().postMessage({ id: token, pcm: mono, sr: buf.sampleRate }, [mono.buffer]);
    } catch {
      if (token === this.loadToken) this.set({ mapState: 'off' });
    }
  }

  /** Decode the whole file with Web Audio and play it from memory. */
  private async useBufferBackend(token: number) {
    const blob = this.blob;
    if (!blob || token !== this.loadToken || this.backend === 'buffer') return;
    this.backend = 'buffer';
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.set({ loading: true, loadingLabel: `Decoding “${this.state.trackName}”…`, error: null });
    try {
      const ctx = this.ensureContext();
      const data = await blob.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      if (token !== this.loadToken) return;
      this.buf = { buffer, node: null, startAt: 0, offset: 0 };
      this.set({ loading: false, loadingLabel: '', duration: buffer.duration });
      this.startBuffer();
    } catch {
      if (token !== this.loadToken) return;
      this.set({
        loading: false,
        loadingLabel: '',
        error: 'This browser couldn’t decode that file. Try an MP3, WAV, M4A or OGG file.',
      });
    }
  }

  async loadBlob(blob: Blob, name: string, autoplay = true) {
    ++this.loadToken;
    this.stopMic();
    this.stopBuffer(false);
    this.buf = null;
    this.blob = blob;
    this.backend = 'element';
    this.attachElement();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    this.extractor.reset();
    this.clock = 0;
    this.set({ source: 'file', trackName: name, error: null, loading: false, loadingLabel: '', duration: 0, playing: false, mapState: 'none', mapProgress: 0, mapInfo: null });
    this.el.src = this.objectUrl;
    this.el.load();
    void this.mapSong(blob, this.loadToken);
    if (autoplay) await this.play();
  }

  async loadFile(file: File) {
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i.test(file.name)) {
      this.set({ error: `“${file.name}” doesn’t look like an audio file.` });
      return;
    }
    await this.loadBlob(file, file.name.replace(/\.[^.]+$/, ''));
  }

  async play() {
    if (this.state.source !== 'file') return;
    this.ensureContext();
    if (this.backend === 'buffer') {
      this.startBuffer();
      return;
    }
    const token = this.loadToken;
    try {
      await this.el.play();
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError') {
        // autoplay refused outside a gesture: leave it paused; the play button starts it
        this.set({ playing: false });
      } else if (name !== 'AbortError') {
        void this.useBufferBackend(token);
      }
    }
  }

  pause() {
    if (this.backend === 'buffer') {
      this.stopBuffer(true);
      this.set({ playing: false });
    } else this.el.pause();
  }

  toggle() {
    if (this.state.source === 'mic' || this.state.source === 'system') return this.stopMic();
    if (this.state.playing) this.pause();
    else void this.play();
  }

  seek(t: number) {
    if (this.state.source !== 'file' || !isFinite(t)) return;
    if (this.backend === 'buffer') {
      const b = this.buf;
      if (!b) return;
      const was = !!b.node;
      this.stopBuffer(false);
      b.offset = Math.max(0, Math.min(t, b.buffer.duration - 0.05));
      this.extractor.seek();
      if (was) this.startBuffer();
      return;
    }
    this.el.currentTime = Math.max(0, Math.min(t, (this.el.duration || 0) - 0.05));
  }

  /** Analyse a live stream (microphone or system audio); it is never routed to the speakers. */
  private attachLive(stream: MediaStream, kind: 'mic' | 'system', name: string) {
    const ctx = this.ensureContext();
    this.stopMic();
    this.el.pause();
    this.stopBuffer(true);
    this.elSource?.disconnect();
    const node = ctx.createMediaStreamSource(stream);
    this.analyser!.disconnect();
    node.connect(this.analyser!);
    this.mic = { stream, node };
    // the person can end sharing from the browser's own "Stop sharing" bar
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (this.mic?.stream === stream) this.stopMic(); }));
    this.extractor.reset();
    this.set({ source: kind, trackName: name, playing: true, error: null, duration: 0, mapState: 'none', mapInfo: null });
  }

  async startMic() {
    this.ensureContext();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.attachLive(stream, 'mic', 'Microphone');
    } catch (e) {
      const name = (e as DOMException).name;
      this.set({
        error:
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'This page isn’t allowed to use the microphone here. Choose a song file instead, or run the app on its own site to listen to the room.'
            : name === 'NotFoundError'
              ? 'No microphone was found. Connect one, or choose a song file instead.'
              : `The microphone couldn’t start: ${(e as Error).message || name}.`,
      });
    }
  }

  /** Whether this browser can capture system audio (desktop Chrome / Edge; not phones, not Safari). */
  static get canListenToSystem() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  /**
   * Hear exactly what this computer plays (Spotify, YouTube, anything), digitally, through the
   * browser's screen-share picker with "Share system audio" on. Browsers only offer audio as
   * part of a screen share, so the video track is stopped immediately and never looked at.
   * Must be called from a click.
   */
  async startSystemAudio() {
    this.ensureContext();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // Chrome / Edge hints: offer the whole-system audio option and don't mute local playback
        systemAudio: 'include',
        suppressLocalAudioPlayback: false,
        selfBrowserSurface: 'exclude',
      } as DisplayMediaStreamOptions);
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) {
        this.set({ error: 'No sound was shared. Choose “Entire screen” and turn on “Also share system audio”, then try again.' });
        return;
      }
      this.attachLive(stream, 'system', 'This computer');
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' && !/denied by user|Permission denied$/i.test((e as Error).message)) {
        this.set({ error: 'This page isn’t allowed to capture system audio here. Open the app on its own site or as a local file to use this.' });
      } else if (name !== 'NotAllowedError' && name !== 'AbortError') {
        this.set({ error: `System audio couldn’t start: ${(e as Error).message || name}.` });
      }
      // cancelling the picker is not an error
    }
  }

  stopMic() {
    if (!this.mic) return;
    this.mic.node.disconnect();
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.set({ source: 'none', trackName: '', playing: false });
  }

  setError(msg: string | null) {
    this.set({ error: msg });
  }

  setLoading(loading: boolean, label = '') {
    this.set({ loading, loadingLabel: loading ? label : '' });
  }

  /** seconds between the playback clock and the sound leaving the speakers */
  outputDelay() {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    const browser = (c?.outputLatency ?? 0) + (c?.baseLatency ?? 0);
    return Math.min(0.5, Math.max(0, browser + useStore.getState().syncMs / 1000));
  }

  /** Pull one analysis frame. Call once per rendered frame, before the worlds update. */
  analyse(dt: number): MusicFeatures {
    const a = this.analyser;
    if (!a || this.state.source === 'none' || !this.state.playing) {
      // feed silence so envelopes relax naturally while paused
      this.freq.fill(-120);
      this.wave.fill(0);
      return this.extractor.process(this.freq, this.wave, this.ctx?.sampleRate ?? 48000, this.extractor.f.time, dt);
    }
    a.getFloatFrequencyData(this.freq);
    a.getFloatTimeDomainData(this.wave);
    // media-element clocks can update coarsely; advance a smooth clock by dt and re-sync on drift
    const ref = this.state.source === 'file' ? this.currentTime : this.ctx!.currentTime;
    this.clock += dt;
    if (Math.abs(this.clock - ref) > 0.12) this.clock = ref;
    let t = this.clock;
    // With a song map the visuals come from the map, so they can be shown at the time you HEAR:
    // the analyser and the playback clock run ahead of the speakers by the output latency the
    // browser reports, plus whatever the user dialled in for a TV or Bluetooth speakers.
    if (this.state.source === 'file' && this.extractor.hasMap) t = Math.max(0, t - this.outputDelay());
    return this.extractor.process(this.freq, this.wave, this.ctx!.sampleRate, t, dt);
  }

  dispose() {
    this.worker?.terminate();
    this.stopMic();
    this.stopBuffer(false);
    this.el.pause();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    void this.ctx?.close();
  }
}

export const audioEngine = new AudioEngine();
