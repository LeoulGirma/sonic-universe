import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { audioEngine, AudioEngine, type MixState } from '../audio/AudioEngine';
import { renderDemoTrack } from '../audio/demoTrack';
import { PALETTES } from '../engine/palettes';
import { drives, features, perf } from '../engine/frameBus';
import { IS_MOBILE, LifeParams, LiquidParams, TunnelParams, MAX_DPR, Quality, QUALITY_SIDE, qualityLabel, SimParams, useStore } from '../store/useStore';
import { WORLDS } from '../worlds/registry';
import {
  ICamera, IClose, IExitFull, IFamilies, IFile, IFreeze, IFull, IMic, IMix, IPause, IPerf, IPlay, IPlus, IScreen, ISettings, ISkip, ISpark, IWorlds,
} from './icons';
import { FAMILY_INFO, NF } from '../audio/soundFamilies';
import type { SongMood } from '../audio/songMood';

const useTransport = () =>
  useSyncExternalStore(
    (cb) => audioEngine.subscribe(cb),
    () => audioEngine.state,
  );

const fmt = (t: number) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');

/** rAF-driven value without React re-render storms (updates at ~10 Hz). */
function useTicker<T>(read: () => T, hz = 10) {
  const [v, setV] = useState(read);
  useEffect(() => {
    let id = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 1000 / hz) {
        last = t;
        setV(read());
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hz]);
  return v;
}

let demoCache: Blob | null = null;
async function playDemo() {
  try {
    audioEngine.setLoading(true, 'Synthesising the demo groove…');
    demoCache ??= await renderDemoTrack();
    await audioEngine.loadBlob(demoCache, 'Demo groove, 122 BPM');
  } catch (e) {
    audioEngine.setError(`The demo track could not be synthesised: ${(e as Error).message}`);
  } finally {
    audioEngine.setLoading(false);
  }
}

function toggleFullscreen() {
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  const isFull = !!(document.fullscreenElement || doc.webkitFullscreenElement);
  if (isFull) (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
  else if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => useStore.getState().set({ uiHidden: true }));
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else useStore.getState().set({ uiHidden: true }); // iPhone Safari: no element fullscreen → immersive mode
}

export function Overlay() {
  const tr = useTransport();
  const st = useStore();
  const [dragging, setDragging] = useState(false);
  const [idle, setIdle] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);
  const [isFull, setIsFull] = useState(false);


  // drag & drop anywhere
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => { e.preventDefault(); depth++; setDragging(true); };
    const leave = (e: DragEvent) => { e.preventDefault(); if (--depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const fs = Array.from(e.dataTransfer?.files ?? []);
      if (fs.length > 1 || (fs.length && audioEngine.state.mix)) mixFiles(fs);
      else if (fs[0]) void audioEngine.loadFile(fs[0]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // `#mic` in the address (or a local "listen" copy of the page) starts listening on load;
  // the browser shows its own permission prompt
  useEffect(() => {
    const auto = location.hash === '#mic' || (window as unknown as { __SONIC_LISTEN?: boolean }).__SONIC_LISTEN;
    if (!auto) return;
    useStore.getState().set({ showPerf: true });
    void audioEngine.startMic();
  }, []);

  // unlock audio inside the very first gesture, whatever it is
  useEffect(() => {
    const unlock = () => audioEngine.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      switch (e.key.toLowerCase()) {
        case ' ': e.preventDefault(); audioEngine.toggle(); break;
        case 'f': toggleFullscreen(); break;
        case 'p': s.set({ showPerf: !s.showPerf }); break;
        case 'i': s.set({ showFamilies: !s.showFamilies }); break;
        case 'm': if (MOOD_WORLDS.includes(s.world)) setMood(!s.mood); break;
        case 'h': s.set({ uiHidden: !s.uiHidden }); break;
        case 'c': s.set({ cinematic: !s.cinematic }); break;
        case 'z': s.set({ frozen: !s.frozen }); break;
        case 'o': s.set({ panel: s.panel === 'none' ? 'settings' : 'none' }); break;
        case 'escape': s.set({ panel: 'none', uiHidden: false }); setWorldsOpen(false); break;
        case 'arrowleft': if (e.shiftKey) audioEngine.seek(audioEngine.currentTime - 5); break;
        case 'arrowright': if (e.shiftKey) audioEngine.seek(audioEngine.currentTime + 5); break;
      }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  // fade the chrome away while music plays and nobody touches anything
  useEffect(() => {
    let t = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), 3500);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  useEffect(() => {
    const on = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const accent = PALETTES[st.palette].accent;
  const world = WORLDS.find((w) => w.id === st.world)!;
  const empty = tr.source === 'none';
  const chromeHidden = st.uiHidden || (idle && tr.playing && st.panel === 'none' && !worldsOpen);

  return (
    <div className={`ui ${chromeHidden ? 'ui--hidden' : ''}`} style={{ ['--accent' as string]: accent }}>
      <header className="top chrome">
        <button className="brand" onClick={() => setWorldsOpen((v) => !v)} aria-expanded={worldsOpen}>
          <span className="brand__mark">Sonic Universe</span>
          <span className="brand__world"><IWorlds size={14} /> {world.name}</span>
        </button>
        <nav className="tools" aria-label="View controls">
          <Tool opt label={st.cinematic ? 'Cinematic camera on (C)' : 'Cinematic camera off (C)'} on={st.cinematic} onClick={() => st.set({ cinematic: !st.cinematic })}><ICamera /></Tool>
          <Tool opt label={st.frozen ? 'Resume simulation (Z)' : 'Freeze simulation (Z)'} on={st.frozen} onClick={() => st.set({ frozen: !st.frozen })}><IFreeze /></Tool>
          <Tool label="Sound families (I)" on={st.showFamilies} onClick={() => st.set({ showFamilies: !st.showFamilies })}><IFamilies /></Tool>
          {MOOD_WORLDS.includes(st.world) && (
            <Tool label={st.mood ? 'Song mood on: the world sets itself up for each song (M)' : 'Song mood off (M)'} on={st.mood} onClick={() => setMood(!st.mood)}><ISpark /></Tool>
          )}
          <Tool opt label="Performance (P)" on={st.showPerf} onClick={() => st.set({ showPerf: !st.showPerf })}><IPerf /></Tool>
          <Tool label="Settings (O)" on={st.panel !== 'none'} onClick={() => st.set({ panel: st.panel === 'none' ? 'settings' : 'none' })}><ISettings /></Tool>
          <Tool label={isFull ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={toggleFullscreen}>{isFull ? <IExitFull /> : <IFull />}</Tool>
        </nav>
      </header>

      {worldsOpen && (
        <div className="worlds glass chrome" role="menu">
          {WORLDS.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              className={`world ${w.id === st.world ? 'world--on' : ''}`}
              disabled={!w.Component}
              onClick={() => { st.set({ world: w.id }); setWorldsOpen(false); }}
            >
              <span className="world__name">{w.name}</span>
              <span className="world__tag">{w.Component ? w.tagline : 'In the next build'}</span>
            </button>
          ))}
        </div>
      )}

      {empty && !tr.loading && (
        <section className="welcome chrome">
          <h1 className="welcome__title">{world.headline ?? 'Play a song.'}</h1>
          <p className="welcome__lede">
            {world.lede}{' '}
            {st.world === 'tunnel' || st.world === 'valley' || st.world === 'ink' ? '' : st.world === 'geometric' ? (IS_MOBILE ? 'Drag to orbit.' : 'Drag the view to orbit.') : (() => {
              const thing = { cosmic: 'stars', life: 'particles', liquid: 'the liquid' }[st.world as 'cosmic' | 'life' | 'liquid'] ?? 'it';
              return IS_MOBILE ? `Drag to orbit; press and hold to pull ${thing} toward your finger.` : `Drag the view to orbit; hover to pull ${thing} toward your cursor.`;
            })()}
          </p>
          <div className="welcome__actions">
            <FilePick className="btn btn--primary" label="Choose a song"><IFile /> Choose a song</FilePick>
            <FilePick className="btn" label="Mix several songs" multi><IMix /> Mix several songs</FilePick>
            {AudioEngine.canListenToSystem && (
              <button className="btn" onClick={() => void audioEngine.startSystemAudio()}><IScreen /> Listen to this computer</button>
            )}
            <button className="btn" onClick={() => void audioEngine.startMic()}><IMic /> Listen to the room</button>
            <button className="btn btn--ghost" onClick={() => void playDemo()}><ISpark /> Demo groove</button>
          </div>
          <nav className="hub" aria-label="Worlds">
            <div className="hub__row">
              {WORLDS.filter((w) => w.Component).flatMap((w) => [(
                <a
                  key={w.id}
                  href={`#${w.id}${w.id === st.world && st.mood && MOOD_WORLDS.includes(w.id) ? '-mood' : ''}`}
                  className={`hub__card ${w.id === st.world ? 'is-on' : ''}`}
                  style={{ ['--w' as string]: WORLD_TINT[w.id] }}
                  aria-current={w.id === st.world ? 'page' : undefined}
                  ref={w.id === st.world ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
                  onClick={(e) => { e.preventDefault(); st.set({ world: w.id }); }}
                >
                  <span className="hub__name">{w.name}</span>
                  <span className="hub__tag">{w.tagline}</span>
                </a>
              ), ...(w.id === 'valley' ? [(
                <a key="valley-v4" href={`${import.meta.env.BASE_URL}versions/valley-v4.html`} className="hub__card" style={{ ['--w' as string]: '#9b8cff' }}>
                  <span className="hub__name">Sound Valley v4</span>
                  <span className="hub__tag">The earlier valley, kept as it was</span>
                </a>
              )] : [])])}
              <a key="dancer" href={`${import.meta.env.BASE_URL}dancer/`} className="hub__card" style={{ ['--w' as string]: '#ffb547' }}>
                <span className="hub__name">The Dancer</span>
                <span className="hub__tag">A body made of light that dances to the beat</span>
              </a>
            </div>
            {st.dev && (
              <div className="hub__dev">
                <div className="hub__devlabel">Earlier builds (frozen as they were)</div>
                <div className="hub__row hub__row--dev">
                  {BUILDS.map((b) => (
                    <a key={b.file} className="hub__card hub__card--dev" href={`${import.meta.env.BASE_URL}versions/${b.file}.html${b.hash}`} style={{ ['--w' as string]: WORLD_TINT[b.world] }}>
                      <span className="hub__name">{b.name}</span>
                      <span className="hub__tag">{b.when}{b.note ? ` · ${b.note}` : ''}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div className="hub__foot">
              {MOOD_WORLDS.includes(st.world) && (
                <button className={`hub__pill ${st.mood ? 'is-on' : ''}`} aria-pressed={st.mood} onClick={() => st.set({ mood: !st.mood })}>
                  <ISpark size={14} /> Song mood {st.mood ? 'on' : 'off'}
                </button>
              )}
            </div>
          </nav>
          {!IS_MOBILE && <p className="welcome__hint">Or drop audio files anywhere on this page. Several at once play as one continuous DJ mix.</p>}
        </section>
      )}
      {tr.loading && <div className="loading" role="status">{tr.loadingLabel || 'Loading…'}</div>}

      {!empty && <Transport />}
      {tr.mix && !st.uiHidden && <MixPanel mix={tr.mix} />}
      {!empty && st.showFamilies && !st.uiHidden && <FamilyLegend />}

      {st.panel !== 'none' && <SettingsPanel />}
      {st.showPerf && <PerfPanel />}

      {tr.error && (
        <div className="toast glass" role="alert">
          <span>{tr.error}</span>
          <button className="icon" aria-label="Dismiss" onClick={() => audioEngine.setError(null)}><IClose size={16} /></button>
        </div>
      )}
      {dragging && <div className="drop"><span>Release to play</span></div>}
      {st.uiHidden && <button className="unhide" onClick={() => st.set({ uiHidden: false })}>Show controls</button>}
    </div>
  );
}

/** song mood on/off (the link follows: #valley-mood) */
function setMood(on: boolean) {
  useStore.getState().set({ mood: on });
}

/** single-file snapshots kept for comparison (developer mode), newest first */
const BUILDS = [
  { file: 'valley-v7', name: 'Sound Valley v7', world: 'valley', hash: '', when: 'Oct 13, 18:26', note: '' },
  { file: 'ink', name: 'Ink in Water', world: 'ink', hash: '', when: 'Oct 13, 18:26', note: 'first Ink' },
  { file: 'valley-v6', name: 'Sound Valley v6', world: 'valley', hash: '', when: 'Oct 13, 18:03', note: '' },
  { file: 'valley-v5', name: 'Sound Valley v5', world: 'valley', hash: '', when: 'Oct 13, 17:59', note: '' },
  { file: 'valley-v4', name: 'Sound Valley v4', world: 'valley', hash: '', when: 'Oct 13, 17:54', note: '' },
  { file: 'valley-v3', name: 'Sound Valley v3', world: 'valley', hash: '', when: 'Oct 13, 17:46', note: '' },
  { file: 'valley-v2', name: 'Sound Valley v2', world: 'valley', hash: '', when: 'Oct 13, 17:32', note: '' },
  { file: 'valley', name: 'Sound Valley v1', world: 'valley', hash: '', when: 'Oct 13, 13:45', note: 'first valley' },
  { file: 'tunnel-v2', name: 'Tunnel v2', world: 'tunnel', hash: '', when: 'Oct 13, 13:26', note: 'sound families' },
  { file: 'app', name: 'Full app', world: 'cosmic', hash: '', when: 'Oct 13, 11:29', note: '' },
  { file: 'tunnel', name: 'Tunnel v1', world: 'tunnel', hash: '#tunnel', when: 'Oct 13, 10:56', note: '' },
  { file: 'liquid', name: 'Liquid Dimension', world: 'liquid', hash: '#liquid', when: 'Oct 13, 10:38', note: '' },
  { file: 'life', name: 'Particle Life', world: 'life', hash: '#life', when: 'Oct 13, 09:22', note: '' },
  { file: 'listen', name: 'Listening build', world: 'cosmic', hash: '', when: 'Oct 13, 09:21', note: 'first build' },
];

/** each world's own colour on the hub */
const WORLD_TINT: Record<string, string> = {
  cosmic: '#8f7bff', liquid: '#4fc3ff', geometric: '#ff6b5e', life: '#7bff9e', tunnel: '#ffb547', valley: '#c58bff', ink: '#ff5fa2',
};

// the link always says where you are, so it can be bookmarked or shared
useStore.subscribe((s, prev) => {
  if (s.world === prev.world && s.mood === prev.mood) return;
  const h = `#${s.world}${s.mood && MOOD_WORLDS.includes(s.world) ? '-mood' : ''}`;
  try { if (location.hash !== h && location.hash !== '#mic') history.replaceState(null, '', h); } catch { /* ignore */ }
});

function Tool(p: { label: string; on?: boolean; opt?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`icon ${p.on ? 'icon--on' : ''} ${p.opt ? 'tool--opt' : ''}`} aria-label={p.label} title={p.label} aria-pressed={p.on} onClick={p.onClick}>
      {p.children}
    </button>
  );
}

function BeatRing() {
  const ref = useRef<SVGCircleElement>(null);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const d = drives();
      const c = ref.current;
      if (c) {
        // ring brightness follows the tracked beat phase, scaled by tracker confidence
        const k = Math.pow(1 - d.beatPhase, 3) * Math.min(1, d.confidence * 1.4) * (1 - d.idle);
        c.style.opacity = String(0.15 + 0.85 * k);
        c.setAttribute('r', String(25 + 2.5 * k));
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <svg className="beatring" viewBox="0 0 60 60" aria-hidden="true">
      <circle ref={ref} cx="30" cy="30" r="25" />
    </svg>
  );
}

/**
 * A real file input stretched invisibly over its button, so the tap lands on the input itself.
 * Opening a hidden input from script is ignored by some in-app browsers and embedded pages.
 */
function FilePick(p: { className: string; label: string; children: React.ReactNode; multi?: boolean }) {
  return (
    <label className={`filepick ${p.className}`} title={p.label} onPointerDown={() => audioEngine.unlock()}>
      <input
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac,.opus"
        multiple={p.multi}
        aria-label={p.label}
        onClick={() => audioEngine.unlock()}
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          if (p.multi) mixFiles(fs);
          else if (fs[0]) void audioEngine.loadFile(fs[0]);
          e.target.value = '';
        }}
      />
      {p.children}
    </label>
  );
}

/** play several songs as a DJ mix (or add them to the one playing); the world mixes with them */
function mixFiles(files: File[]) {
  if (!files.length) return;
  if (!audioEngine.state.mix && MOOD_WORLDS.includes(useStore.getState().world)) setMood(true);
  void audioEngine.addToMix(files);
}

const LEAD_WORD = { bass: 'bass-led', groove: 'groove-led', melody: 'melody-led', space: 'spacious', arc: 'big swings' } as const;
function moodWord(m: SongMood) {
  return m.bright >= 0.5 ? (m.energy >= 0.5 ? 'Euphoric' : 'Glowing') : (m.energy >= 0.5 ? 'Fierce' : 'Brooding');
}
const MOOD_WORLDS = ['valley', 'geometric', 'tunnel', 'ink'];

function Transport() {
  const tr = useTransport();
  const moodOn = useStore((s) => s.mood && MOOD_WORLDS.includes(s.world));
  const time = useTicker(() => audioEngine.currentTime, 8);
  const [scrub, setScrub] = useState<number | null>(null);
  const mic = tr.source === 'mic' || tr.source === 'system';
  return (
    <footer className="transport glass chrome">
      <button className="play" aria-label={mic ? 'Stop listening' : tr.playing ? 'Pause' : 'Play'} onClick={() => audioEngine.toggle()}>
        <BeatRing />
        {tr.playing ? <IPause size={20} /> : <IPlay size={20} />}
      </button>
      <div className="transport__mid">
        <div className="transport__head">
          <div className="transport__title" title={tr.trackName}>{tr.trackName}</div>
          <div className="transport__metas">
          {tr.mapState === 'mapping' && <span className="transport__map">{tr.mapProgress > 0 ? `Mapping song ${Math.round(tr.mapProgress * 100)}%` : 'Reading the song…'}</span>}
          {tr.mapState === 'ready' && tr.mapInfo && tr.mapInfo.bpm > 0 && (
            <span className="transport__map transport__bpm" title="Beats, breakdowns and drops come from a whole-song analysis">
              {Math.round(tr.mapInfo.bpm)} BPM{tr.mapInfo.drops.length ? `, ${tr.mapInfo.drops.length} drop${tr.mapInfo.drops.length > 1 ? 's' : ''}` : ''}
            </span>
          )}
          {tr.mix && <MixNext mix={tr.mix} />}
          {moodOn && tr.mapState === 'ready' && tr.mapInfo?.mood && (
            <span className="transport__map transport__mood" title="Song mood: how this song sets up the world (energy and brightness against your library, and what it is built around)">
              {moodWord(tr.mapInfo.mood)}, {LEAD_WORD[tr.mapInfo.mood.lead]}
            </span>
          )}
          </div>
        </div>
        {mic ? (
          <div className="transport__live">{tr.source === 'system' ? 'Listening to what this computer plays' : 'Listening through the microphone'}</div>
        ) : (
          <div className="seek">
            <span className="seek__t">{fmt(scrub ?? time)}</span>
            <div className="seek__track">
              {tr.mapInfo && tr.duration > 0 && (
                <div className="seek__marks" aria-hidden="true">
                  {tr.mapInfo.sections.map((s, i) => (
                    <i key={`s${i}`} className={`mk mk--sec mk--b${s.biome}`} style={{ left: `${(s.start / tr.duration) * 100}%`, width: `${((s.end - s.start) / tr.duration) * 100}%` }} title={`Section ${String.fromCharCode(65 + s.label)}`} />
                  ))}
                  {tr.mapInfo.breakdowns.map(([a, b], i) => (
                    <i key={`b${i}`} className="mk mk--brk" style={{ left: `${(a / tr.duration) * 100}%`, width: `${((b - a) / tr.duration) * 100}%` }} />
                  ))}
                  {tr.mapInfo.drops.map((d, i) => (
                    <i key={`d${i}`} className="mk mk--drop" style={{ left: `${(d / tr.duration) * 100}%` }} />
                  ))}
                </div>
              )}
              <input
                type="range"
                min={0}
                max={tr.duration || 1}
                step={0.1}
                value={scrub ?? time}
                aria-label="Seek"
                onChange={(e) => setScrub(+e.target.value)}
                onPointerUp={() => { if (scrub !== null) audioEngine.seek(scrub); setScrub(null); }}
                onKeyUp={() => { if (scrub !== null) audioEngine.seek(scrub); setScrub(null); }}
                style={{ ['--p' as string]: `${((scrub ?? time) / (tr.duration || 1)) * 100}%` }}
              />
            </div>
            <span className="seek__t">{fmt(tr.duration)}</span>
          </div>
        )}
      </div>
      <div className="transport__src">
        <FilePick className="icon" label="Choose another song"><IFile /></FilePick>
        <FilePick className={`icon ${tr.mix ? 'icon--on' : ''}`} label={tr.mix ? 'Add songs to the mix' : 'Mix several songs'} multi><IMix /></FilePick>
        <button className="icon transport__opt" aria-label="Play the demo groove" title="Play the demo groove" onClick={() => void playDemo()}><ISpark /></button>
        {AudioEngine.canListenToSystem && (
          <button className={`icon transport__opt ${tr.source === 'system' ? 'icon--on' : ''}`} aria-label="Listen to this computer" title="Listen to this computer"
            onClick={() => (tr.source === 'system' ? audioEngine.stopMic() : void audioEngine.startSystemAudio())}><IScreen /></button>
        )}
        <button className={`icon transport__opt ${tr.source === 'mic' ? 'icon--on' : ''}`} aria-label="Use the microphone" title="Use the microphone" onClick={() => (tr.source === 'mic' ? audioEngine.stopMic() : void audioEngine.startMic())}><IMic /></button>
      </div>
    </footer>
  );
}

const KIND_WORD = { beatmatch: 'beatmatched', echo: 'echo out', fade: 'crossfade' } as const;

function MixNext(p: { mix: MixState }) {
  const m = p.mix;
  const next = m.tracks.find((t) => t.id === m.nextId);
  if (!next) return <span className="transport__map">Last song in the mix</span>;
  if (m.mixing) return <span className="transport__map transport__mood">Mixing into {next.name}</span>;
  if (m.nextIn !== null) return <span className="transport__map" title={next.name}>Next in {fmt(m.nextIn)}, {KIND_WORD[m.kind ?? 'beatmatch']}</span>;
  return <span className="transport__map" title={next.name}>{next.status === 'ready' ? 'Next song ready' : 'Reading the next song…'}</span>;
}

function nextLine(m: MixState) {
  if (!m.nextId) return '';
  if (m.mixing) return 'mixing now';
  return m.nextIn !== null ? `next in ${fmt(m.nextIn)}` : '';
}

function MixPanel(p: { mix: MixState }) {
  const m = p.mix;
  const ready = m.tracks.filter((t) => t.status === 'ready').length;
  // on a phone the queue starts folded to one line, so the world stays in view
  const [open, setOpen] = useState(() => !window.matchMedia?.('(max-width: 720px)').matches);
  return (
    <aside className={`mixq glass chrome ${open ? '' : 'mixq--folded'}`} aria-label="Mix queue">
      <header className="mixq__head">
        <button className="mixq__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <div className="mixq__title">Mix <span className="mixq__chev" aria-hidden="true">{open ? '▾' : '▸'}</span></div>
          <div className="mixq__sub">{m.tracks.length} {m.tracks.length === 1 ? 'song' : 'songs'}{ready < m.tracks.length ? `, reading ${m.tracks.length - ready}` : ''}{nextLine(m) ? ` · ${nextLine(m)}` : ''}</div>
        </button>
        <div className="mixq__acts">
          <button className="icon" title="Mix into the next song now" aria-label="Mix into the next song now" disabled={!m.nextId || m.mixing} onClick={() => audioEngine.mixNow()}><ISkip /></button>
          <FilePick className="icon" label="Add songs to the mix" multi><IPlus /></FilePick>
        </div>
      </header>
      {open && <ol className="mixq__list">
        {m.tracks.map((t) => {
          const cur = t.id === m.currentId, nxt = t.id === m.nextId;
          return (
            <li key={t.id} className={`mixq__row ${cur ? 'is-cur' : ''} ${nxt ? 'is-next' : ''}`}>
              <button className="mixq__name" title={`Play “${t.name}” now`} onClick={() => audioEngine.playFromMix(t.id)}>
                <span className="mixq__t">{t.name}</span>
                <span className="mixq__meta">
                  {t.status === 'ready' ? `${t.bpm > 0 ? `${Math.round(t.bpm)} BPM` : 'free time'}${t.mood ? `, ${moodWord(t.mood)}` : ''}` : t.status === 'analysing' ? 'Reading…' : t.status === 'error' ? 'Couldn’t read this file' : 'Waiting'}
                </span>
              </button>
              {!cur && !nxt && <button className="mixq__btn" title="Play next" aria-label={`Play “${t.name}” next`} onClick={() => audioEngine.playNext(t.id)}>Next</button>}
              {!cur && <button className="mixq__btn" title="Remove" aria-label={`Remove “${t.name}”`} onClick={() => audioEngine.removeFromMix(t.id)}><IClose size={14} /></button>}
            </li>
          );
        })}
      </ol>}
    </aside>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; tag?: string }) {
  return (
    <label className="slider">
      <span className="slider__row"><span>{p.label}{p.tag && <em className={`tag tag--${p.tag}`}>{p.tag}</em>}</span><span className="num">{p.format ? p.format(p.value) : p.value.toFixed(2)}</span></span>
      <input type="range" min={p.min} max={p.max} step={p.step ?? 0.01} value={p.value} onChange={(e) => p.onChange(+e.target.value)}
        style={{ ['--p' as string]: `${((p.value - p.min) / (p.max - p.min)) * 100}%` }} />
    </label>
  );
}

function Seg<T extends string>(p: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button key={o.v} role="radio" aria-checked={p.value === o.v} className={p.value === o.v ? 'on' : ''} onClick={() => p.onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

function Toggle(p: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{p.label}</span>
      <input type="checkbox" checked={p.on} onChange={(e) => p.onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

const TUNNEL_META: { k: keyof TunnelParams; label: string; min: number; max: number; note: string }[] = [
  { k: 'spacing', label: 'Distance per beat', min: 3, max: 20, note: 'artistic' },
  { k: 'radius', label: 'Tunnel radius', min: 3, max: 14, note: 'artistic' },
  { k: 'twist', label: 'Twist at full mids', min: 0, max: 1.5, note: 'artistic' },
  { k: 'curve', label: 'Curvature', min: 0, max: 2.5, note: 'artistic' },
  { k: 'bloom', label: 'Glow', min: 0, max: 3, note: 'render' },
];

const LIQUID_META: { k: keyof LiquidParams; label: string; min: number; max: number; note: string }[] = [
  { k: 'tension', label: 'Surface tension', min: 0.3, max: 6, note: 'physical' },
  { k: 'drag', label: 'Drag', min: 0.1, max: 3, note: 'physical' },
  { k: 'center', label: 'Pull to centre', min: 0, max: 0.4, note: 'physical' },
  { k: 'impact', label: 'Kick impact', min: 0, max: 20, note: 'artistic' },
  { k: 'swirl', label: 'Swirl at full mids', min: 0, max: 20, note: 'artistic' },
  { k: 'ripple', label: 'Surface ripples', min: 0, max: 3, note: 'render' },
  { k: 'iridescence', label: 'Iridescence', min: 0, max: 2, note: 'render' },
  { k: 'cursorStrength', label: 'Cursor force', min: 0, max: 3000, note: 'artistic' },
  { k: 'timeScale', label: 'Time scale', min: 0.1, max: 3, note: 'artistic' },
  { k: 'bloom', label: 'Glow', min: 0, max: 3, note: 'render' },
];

const LIFE_META: { k: keyof LifeParams; label: string; min: number; max: number; note: string }[] = [
  { k: 'rMax', label: 'Interaction radius', min: 3, max: 8, note: 'physical' },
  { k: 'beta', label: 'Repulsion core', min: 0.1, max: 0.6, note: 'physical' },
  { k: 'force', label: 'Force', min: 1, max: 30, note: 'physical' },
  { k: 'friction', label: 'Momentum half-life', min: 0.03, max: 0.5, note: 'physical' },
  { k: 'repel', label: 'Contact repulsion', min: 0.3, max: 4, note: 'physical' },
  { k: 'align', label: 'Flocking at full mids', min: 0, max: 8, note: 'artistic' },
  { k: 'jitter', label: 'Spark agitation', min: 0, max: 200, note: 'artistic' },
  { k: 'contain', label: 'Containment radius', min: 15, max: 42, note: 'artistic' },
  { k: 'cursorStrength', label: 'Cursor force', min: 0, max: 500, note: 'artistic' },
  { k: 'timeScale', label: 'Time scale', min: 0.1, max: 3, note: 'artistic' },
  { k: 'size', label: 'Particle size', min: 0.3, max: 3, note: 'render' },
  { k: 'bloom', label: 'Glow', min: 0, max: 3, note: 'render' },
];

const PARAM_META: { k: keyof SimParams; label: string; min: number; max: number; note: string }[] = [
  { k: 'G', label: 'Central mass (GM)', min: 10, max: 200, note: 'physical' },
  { k: 'softening', label: 'Softening length', min: 0.3, max: 5, note: 'physical' },
  { k: 'spiralAmp', label: 'Density-wave strength', min: 0, max: 4, note: 'physical' },
  { k: 'companionMass', label: 'Satellite mass', min: 0, max: 4, note: 'physical' },
  { k: 'cooling', label: 'Orbit relaxation', min: 0, max: 1.5, note: 'artistic' },
  { k: 'shockStrength', label: 'Shockwave push', min: 0, max: 10, note: 'artistic' },
  { k: 'shockSpeed', label: 'Shockwave speed', min: 5, max: 90, note: 'artistic' },
  { k: 'waveAmp', label: 'Bass ripple', min: 0, max: 4, note: 'artistic' },
  { k: 'cursorStrength', label: 'Cursor force', min: 0, max: 500, note: 'artistic' },
  { k: 'timeScale', label: 'Time scale', min: 0.1, max: 3, note: 'artistic' },
  { k: 'starSize', label: 'Star size', min: 0.3, max: 3, note: 'render' },
  { k: 'bloom', label: 'Glow', min: 0, max: 3, note: 'render' },
];

function SettingsPanel() {
  const st = useStore();
  const tab = st.panel;
  return (
    <aside className="panel glass chrome" aria-label="Settings">
      <div className="panel__head">
        <Seg label="Panel" value={tab as 'settings' | 'experiment'} onChange={(v) => st.set({ panel: v })}
          options={[{ v: 'settings', label: 'Settings' }, { v: 'experiment', label: 'Experiment' }]} />
        <button className="icon" aria-label="Close settings" onClick={() => st.set({ panel: 'none' })}><IClose size={16} /></button>
      </div>

      {tab === 'settings' ? (
        <div className="panel__body">
          <h3>Response</h3>
          <Slider label="Sensitivity" value={st.sensitivity} min={0.2} max={2.5} onChange={(v) => st.set({ sensitivity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Gravity" value={st.gravityScale} min={0.3} max={2.5} onChange={(v) => st.set({ gravityScale: v })} format={(v) => `${Math.round(v * 100)}%`} />

          <h3>Cursor</h3>
          <Seg label="Cursor field" value={st.cursor} onChange={(v) => st.set({ cursor: v })}
            options={[{ v: 'attract', label: 'Attract' }, { v: 'repel', label: 'Repel' }, { v: 'off', label: 'Off' }]} />
          <p className="hint">{IS_MOBILE ? 'Press and hold to use the field.' : 'Hover to use the field, hold Shift to strengthen it. Fly with W A S D, Q and E.'}</p>

          <h3>Colour</h3>
          <div className="swatches" role="radiogroup" aria-label="Palette">
            {(Object.keys(PALETTES) as (keyof typeof PALETTES)[]).map((id) => (
              <button key={id} role="radio" aria-checked={st.palette === id} className={`swatch ${st.palette === id ? 'on' : ''}`} onClick={() => st.set({ palette: id })} title={PALETTES[id].name}>
                <span style={{ background: `conic-gradient(${PALETTES[id].colors.join(',')},${PALETTES[id].accent},${PALETTES[id].colors[0]})` }} />
                <em>{PALETTES[id].name}</em>
              </button>
            ))}
          </div>

          <h3>Quality</h3>
          <Seg label="Particle count" value={st.quality} onChange={(v: Quality) => st.set({ quality: v })}
            options={(Object.keys(QUALITY_SIDE) as Quality[]).map((q) => ({ v: q, label: qualityLabel(st.world, q) }))} />
          <Slider label="Resolution limit" value={st.resolutionCap} min={0.35} max={1} onChange={(v) => st.set({ resolutionCap: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Toggle label="Adapt resolution to hold frame rate" on={st.autoQuality} onChange={(v) => st.set({ autoQuality: v })} />
          <Toggle label="Glow" on={st.bloom} onChange={(v) => st.set({ bloom: v })} />
          <Slider label="Audio delay (sync)" value={st.syncMs} min={-100} max={400} step={5}
            onChange={(v) => { st.set({ syncMs: v }); try { localStorage.setItem('sonic.syncMs', String(v)); } catch { /* private mode */ } }}
            format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`} />
          <p className="hint">For song files. Raise it if the visuals land before you hear the beat (TVs and Bluetooth speakers add delay); the browser's own reported delay is already included.</p>
          <Toggle label="Cinematic camera" on={st.cinematic} onChange={(v) => st.set({ cinematic: v })} />
          <Toggle label="Freeze simulation" on={st.frozen} onChange={(v) => st.set({ frozen: v })} />
          <Toggle label="Performance readout" on={st.showPerf} onChange={(v) => st.set({ showPerf: v })} />
          <Toggle label="Developer mode (earlier builds on the start screen)" on={st.dev} onChange={(v) => { st.set({ dev: v }); try { localStorage.setItem('sonic.dev', v ? '1' : '0'); } catch { /* private mode */ } }} />
        </div>
      ) : (
        <div className="panel__body">
          {st.world === 'geometric' || st.world === 'valley' || st.world === 'ink' ? (
            <>
              <p className="hint">The music is separated into six kinds of sound by how they behave, not by a trained instrument model: hits are short and broadband, held notes are steady in time, melodies move. Each builds its own structure.</p>
              <dl className="famlist">
                {FAMILY_INFO.map((f, k) => (
                  <div key={f.id}><dt><i style={{ background: f.color }} />{f.name}</dt><dd>{(st.world === 'valley' ? VALLEY_ROLE : st.world === 'ink' ? INK_ROLE : GEO_ROLE)[k]}<small>{f.examples}</small></dd></div>
                ))}
              </dl>
            </>
          ) : st.world === 'tunnel' ? (
            <>
              <p className="hint">The tunnel is pure geometry; travel is locked to the beat clock, one ring per beat.</p>
              {TUNNEL_META.map((m) => (
                <Slider key={m.k} label={m.label} value={st.tunnelParams[m.k]} min={m.min} max={m.max} step={(m.max - m.min) / 200}
                  onChange={(v) => st.setTunnelParam(m.k, v)} format={(v) => v.toFixed(v >= 10 ? 0 : 2)} tag={m.note} />
              ))}
            </>
          ) : st.world === 'liquid' ? (
            <>
              <p className="hint">Physical parameters drive the blob simulation; the surface itself is a raymarched approximation, not fluid dynamics.</p>
              {LIQUID_META.map((m) => (
                <Slider key={m.k} label={m.label} value={st.liquidParams[m.k]} min={m.min} max={m.max} step={(m.max - m.min) / 200}
                  onChange={(v) => st.setLiquidParam(m.k, v)} format={(v) => v.toFixed(v >= 10 ? 0 : 2)} tag={m.note} />
              ))}
            </>
          ) : st.world === 'life' ? (
            <>
              <p className="hint">The force law is the Particle Life model; dense cells are estimated by sampling. Artistic ones exist only to make the music visible.</p>
              {LIFE_META.map((m) => (
                <Slider key={m.k} label={m.label} value={st.lifeParams[m.k]} min={m.min} max={m.max} step={(m.max - m.min) / 200}
                  onChange={(v) => st.setLifeParam(m.k, v)} format={(v) => v.toFixed(v >= 10 ? 0 : 2)} tag={m.note} />
              ))}
            </>
          ) : (
            <>
              <p className="hint">Physical parameters are Newtonian gravity with softening. Artistic ones exist only to make the music visible.</p>
              {PARAM_META.map((m) => (
                <Slider key={m.k} label={m.label} value={st.params[m.k]} min={m.min} max={m.max} step={(m.max - m.min) / 200}
                  onChange={(v) => st.setParam(m.k, v)} format={(v) => v.toFixed(v >= 10 ? 0 : 2)} tag={m.note} />
              ))}
            </>
          )}
          {st.world !== 'geometric' && st.world !== 'valley' && st.world !== 'ink' && <h3>Music mapping</h3>}
          {st.world !== 'geometric' && st.world !== 'valley' && st.world !== 'ink' && (['bass', 'mid', 'high', 'kick'] as const).map((k) => (
            <Slider key={k} label={(st.world === 'tunnel'
              ? { bass: 'Bass → wall glow and breathing', mid: 'Mids → twist', high: 'Highs → light streaks', kick: 'Kicks → ring flashes' }
              : st.world === 'liquid'
              ? { bass: 'Bass → swell', mid: 'Mids → swirl and ripples', high: 'Highs → droplet shimmer', kick: 'Kicks → impact waves' }
              : st.world === 'life'
              ? { bass: 'Bass → attraction', mid: 'Mids → flocking', high: 'Highs → spark agitation', kick: 'Kicks → scatter' }
              : { bass: 'Bass → gravity', mid: 'Mids → spiral flow', high: 'Highs → star light', kick: 'Kicks → shockwaves' })[k]}
              value={st.gains[k]} min={0} max={3} onChange={(v) => st.setGain(k, v)} format={(v) => `${Math.round(v * 100)}%`} />
          ))}
          {st.world !== 'geometric' && st.world !== 'valley' && st.world !== 'ink' && <button className="btn btn--quiet" onClick={() => st.resetExperiment()}>Reset to defaults</button>}
          {st.world !== 'geometric' && st.world !== 'valley' && st.world !== 'ink' && <p className="hint">Changes apply live; the particle count lives under Settings.</p>}
        </div>
      )}
    </aside>
  );
}

const INK_ROLE = [
  'Pushes a red burst out from the centre on every kick.',
  'Darts of orange ink on every hit.',
  'Flecks of gold on every tick.',
  'Turns a slow violet whirlpool low in the water.',
  'Breathes teal clouds in from both sides while they hold.',
  'Draws a pink stream that rises and falls with the melody.',
];

const VALLEY_ROLE = [
  'Sends a soft ring across the ground on every kick.',
  'Raises light monoliths along the sides; louder hits stand taller.',
  'Makes the air glint; louder hats light more of it.',
  'Raises the hills under you; the ridgelines mark the beats.',
  'Hang aurora curtains in the sky, taller when louder, coloured by the chord.',
  'Draws the glowing path ahead at the melody\'s pitch.',
];

const GEO_ROLE = [
  'Pulses the core and sends a shell outward on every kick.',
  'Throws shards from the core on every hit.',
  'Lights points of the outer lattice on every tick.',
  'Raises the skyline: one column per sixteenth note, the last four bars of bass.',
  'Constructs the shells edge by edge while they hold; a new chord turns them.',
  'Draws the ribbon at the melody\'s pitch; each new note leaves a marker.',
];

/**
 * Which kinds of sound are playing right now. Rows light with each family's level; the dot
 * flashes on its onsets. Written straight to the DOM every frame (no React re-renders).
 */
function FamilyLegend() {
  const bars = useRef<(HTMLElement | null)[]>([]);
  const dots = useRef<(HTMLElement | null)[]>([]);
  const rows = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      const fam = drives().fam;
      for (let k = 0; k < NF; k++) {
        const v = Math.min(1, fam.level[k]);
        const b = bars.current[k], dt = dots.current[k], r = rows.current[k];
        if (b) b.style.transform = `scaleX(${v.toFixed(3)})`;
        if (dt) {
          const h = Math.min(1, fam.hit[k] * 1.4);
          dt.style.boxShadow = `0 0 ${(4 + 14 * h).toFixed(1)}px ${(1 + 4 * h).toFixed(1)}px ${FAMILY_INFO[k].color}${Math.round(40 + 200 * Math.max(h, v * 0.5)).toString(16).padStart(2, '0')}`;
        }
        if (r) r.style.opacity = (0.38 + 0.62 * Math.min(1, v * 1.8)).toFixed(2);
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <aside className="families" aria-label="Sound families playing now">
      {FAMILY_INFO.map((f, k) => (
        <div key={f.id} className="fam" ref={(el) => { rows.current[k] = el; }} title={f.examples}>
          <i className="fam__dot" ref={(el) => { dots.current[k] = el; }} style={{ background: f.color }} />
          <span className="fam__name">{f.name}</span>
          <span className="fam__bar"><b ref={(el) => { bars.current[k] = el; }} style={{ background: f.color }} /></span>
        </div>
      ))}
    </aside>
  );
}

function Meter({ label, v }: { label: string; v: number }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <i><b style={{ width: `${Math.min(100, v * 100)}%` }} /></i>
    </div>
  );
}

function PerfPanel() {
  const snap = useTicker(() => {
    const f = features();
    const st = useStore.getState();
    return {
      fps: perf.fps, ms: perf.frameMs, calls: perf.calls, particles: perf.particles, countLabel: perf.countLabel, worldLabel: perf.worldLabel, worldValue: perf.worldValue, dpr: st.dpr, float: st.floatType,
      bpm: f.bpm, conf: f.beatConfidence, section: f.section, mapped: audioEngine.extractor.hasMap, bass: f.bass, mid: f.mid, high: f.high, loud: f.loudness,
      flux: f.flux, onset: f.onset, kick: f.kick, centroid: f.centroidHz, db: f.loudnessDb,
    };
  }, 8);
  return (
    <aside className="perf glass" aria-label="Performance">
      <div className="perf__grid">
        <span>Frame rate</span><b className="num">{snap.fps.toFixed(0)} fps</b>
        <span>Frame time</span><b className="num">{snap.ms.toFixed(1)} ms</b>
        <span>{snap.countLabel || 'Particles simulated'}</span><b className="num">{snap.particles.toLocaleString()}</b>
        {snap.worldLabel && <><span>{snap.worldLabel}</span><b className="num">{snap.worldValue}</b></>}
        <span>Render scale</span><b className="num">{snap.dpr.toFixed(2)} of {MAX_DPR.toFixed(1)}</b>
        <span>Draw calls</span><b className="num">{snap.calls}</b>
        <span>Simulation textures</span><b>{snap.float === 'half' ? 'half float' : '32-bit float'}</b>
        <span>Tempo</span><b className="num">{snap.bpm ? `${snap.bpm.toFixed(1)} BPM` : '—'} <small>{snap.bpm ? `${Math.round(snap.conf * 100)}% sure` : ''}</small></b>
        <span>Beat grid</span><b>{snap.mapped ? 'Song map' : 'Live'}</b>
        <span>Section</span><b>{snap.section}</b>
        <span>Loudness</span><b className="num">{isFinite(snap.db) && snap.db > -100 ? `${snap.db.toFixed(0)} dBFS` : '—'}</b>
        <span>Centroid</span><b className="num">{Math.round(snap.centroid)} Hz</b>
      </div>
      <div className="perf__meters">
        <Meter label="Bass" v={snap.bass} />
        <Meter label="Mids" v={snap.mid} />
        <Meter label="Highs" v={snap.high} />
        <Meter label="Loudness" v={snap.loud} />
        <Meter label="Flux" v={snap.flux} />
        <Meter label="Kick" v={snap.kick} />
      </div>
    </aside>
  );
}
