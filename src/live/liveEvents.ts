import type { Drives } from '../mapping/drives';

/**
 * TikTok LIVE audience → the universe.
 *
 * Events arrive from TikFinity's local WebSocket (ws://localhost:21213/), which forwards TikTok LIVE
 * events in the TikTok-LIVE-Connector shape: { event: 'chat' | 'gift' | 'like' | 'follow' | 'share' |
 * 'social' | 'member', data: {...} }. The parser is tolerant of missing fields. The settings panel can
 * also fire test events, which go through the same path.
 *
 * Everything here is a mutable singleton, like the frame bus: the 3D layer and the HUD read it every
 * frame, and only the HUD's React parts subscribe to changes.
 */

export type LiveType = 'chat' | 'gift' | 'like' | 'follow' | 'share' | 'join';
export interface LiveEvent {
  id: number;
  type: LiveType;
  user: string; // unique handle, stable per viewer
  name: string; // display name
  text?: string;
  gift?: string;
  diamonds?: number; // total for this gift event (diamondCount × repeat)
  count?: number; // likes in this event, or gift repeat count
  at: number; // performance.now() / 1000
  test?: boolean;
}

export type LiveStatus = 'off' | 'connecting' | 'on' | 'error';

/** Tiers by diamonds: 1 (Rose) … 5000+ (Universe). Bigger tiers do more. */
export const giftTier = (diamonds: number) => (diamonds >= 1000 ? 3 : diamonds >= 100 ? 2 : diamonds >= 10 ? 1 : 0);

export const live = {
  status: 'off' as LiveStatus,
  url: 'ws://localhost:21213/',
  /** 0..1 likes toward the next drop */
  charge: 0,
  likeGoal: 500,
  likesTotal: 0,
  /** events for the 3D layer to consume (it drains this every frame) */
  queue: [] as LiveEvent[],
  /** pending effects on the drives, applied (and decayed) every frame */
  boost: { pulse: 0, release: 0, energy: 0, kicks: 0, drops: 0 },
  /** a viewer's colour word tints the world for a while: hue 0..1, until (s) */
  tint: { hue: 0, until: 0 },
  lastDropCmd: -99,
};

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
export const onLive = (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const statusListeners = new Set<(s: LiveStatus) => void>();
export const onLiveStatus = (fn: (s: LiveStatus) => void) => { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; };
const setStatus = (s: LiveStatus) => { live.status = s; statusListeners.forEach((f) => f(s)); };

let nextId = 1;
const now = () => performance.now() / 1000;

/** colour words viewers can type, as hues on the 0..1 wheel */
const COLOURS: [RegExp, number][] = [
  [/\b(red|ቀይ)\b/i, 0.0], [/\b(orange)\b/i, 0.07], [/\b(gold|yellow|ቢጫ)\b/i, 0.13], [/\b(green|አረንጓዴ)\b/i, 0.33],
  [/\b(cyan|teal)\b/i, 0.5], [/\b(blue|ሰማያዊ)\b/i, 0.62], [/\b(purple|violet)\b/i, 0.76], [/\b(pink)\b/i, 0.9],
];

/** Accept one event (from the socket or a test button): update state, schedule effects, notify the HUD. */
export function emitLive(raw: Omit<LiveEvent, 'id' | 'at'>) {
  const e: LiveEvent = { ...raw, id: nextId++, at: now() };
  const t = e.at, b = live.boost;
  switch (e.type) {
    case 'chat': {
      b.pulse = Math.max(b.pulse, 0.35);
      const txt = e.text ?? '';
      for (const [re, hue] of COLOURS) if (re.test(txt)) { live.tint = { hue, until: t + 8 }; break; }
      // "drop" from chat: at most one every 20 s, so a spamming chat can't strobe the stream
      if (/\bdrop\b/i.test(txt) && t - live.lastDropCmd > 20) { live.lastDropCmd = t; b.drops++; }
      break;
    }
    case 'gift': {
      const tier = giftTier(e.diamonds ?? 1);
      b.kicks += 1 + tier;
      b.pulse = Math.max(b.pulse, 0.6 + 0.15 * tier);
      b.energy = Math.max(b.energy, 0.3 + 0.2 * tier);
      if (tier >= 2) { b.drops++; b.release = 1; }
      break;
    }
    case 'like': {
      const n = Math.max(1, e.count ?? 1);
      live.likesTotal += n;
      live.charge += n / Math.max(10, live.likeGoal);
      if (live.charge >= 1) { live.charge = 0; b.drops++; b.release = 1; }
      break;
    }
    case 'follow': case 'share': b.kicks++; b.pulse = Math.max(b.pulse, 0.5); break;
    case 'join': break;
  }
  live.queue.push(e);
  if (live.queue.length > 200) live.queue.splice(0, live.queue.length - 200);
  listeners.forEach((f) => f(e));
}

/** Map a TikFinity / TikTok-LIVE-Connector message to our event, or null to ignore it. */
export function parseLive(msg: unknown): Omit<LiveEvent, 'id' | 'at'> | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { event?: string; data?: Record<string, unknown> };
  const d = (m.data ?? {}) as Record<string, any>;
  const user = String(d.uniqueId ?? d.user?.uniqueId ?? d.userId ?? 'viewer');
  const name = String(d.nickname || d.user?.nickname || user).slice(0, 32);
  switch (m.event) {
    case 'chat': return { type: 'chat', user, name, text: String(d.comment ?? '').slice(0, 120) };
    case 'gift': {
      // streakable gifts send an event per tap; count them once, when the streak ends
      if (d.giftType === 1 && d.repeatEnd === false) return null;
      const count = Math.max(1, Number(d.repeatCount) || 1);
      const each = Math.max(1, Number(d.diamondCount ?? d.gift?.diamond_count) || 1);
      return { type: 'gift', user, name, gift: String(d.giftName ?? d.gift?.name ?? 'a gift'), diamonds: each * count, count };
    }
    case 'like': return { type: 'like', user, name, count: Math.max(1, Number(d.likeCount) || 1) };
    case 'follow': return { type: 'follow', user, name };
    case 'share': return { type: 'share', user, name };
    case 'social': {
      const kind = String(d.displayType ?? d.label ?? '');
      if (/follow/i.test(kind)) return { type: 'follow', user, name };
      if (/share/i.test(kind)) return { type: 'share', user, name };
      return null;
    }
    case 'member': return { type: 'join', user, name };
    default: return null;
  }
}

let ws: WebSocket | null = null;
let wanted = false;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function connectLive(url = live.url) {
  live.url = url;
  wanted = true;
  if (timer) { clearTimeout(timer); timer = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  setStatus('connecting');
  let sock: WebSocket;
  try { sock = new WebSocket(url); } catch { setStatus('error'); schedule(); return; }
  ws = sock;
  sock.onopen = () => { retry = 0; setStatus('on'); };
  sock.onmessage = (ev) => {
    let msg: unknown;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    const e = parseLive(msg);
    if (e) emitLive(e);
  };
  sock.onerror = () => { /* onclose follows */ };
  sock.onclose = () => { if (ws === sock) ws = null; if (wanted) { setStatus('connecting'); schedule(); } else setStatus('off'); };
}

function schedule() {
  if (!wanted) return;
  const wait = Math.min(10, 1 + retry++ * 1.5) * 1000;
  timer = setTimeout(() => connectLive(live.url), wait);
}

export function disconnectLive() {
  wanted = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  setStatus('off');
}

/**
 * Called every frame after the music → drives mapping: audience effects raise the same drives the music
 * does (kick and drop counters, pulse, release, energy), so every world reacts in its own way.
 */
export function applyLive(d: Drives, dt: number) {
  const b = live.boost;
  if (b.kicks > 0) { d.kickEvents++; d.lastKick = Math.max(d.lastKick, 0.9); b.kicks--; }
  if (b.drops > 0) { d.dropEvents++; b.drops--; }
  d.pulse = Math.max(d.pulse, b.pulse);
  d.release = Math.max(d.release, b.release);
  d.energy = Math.min(1.3, Math.max(d.energy, b.energy));
  const k = Math.exp(-dt * 3.5);
  b.pulse *= k; b.release *= Math.exp(-dt * 1.2); b.energy *= Math.exp(-dt * 0.8);
  const t = now();
  if (t < live.tint.until) {
    const w = Math.min(1, (live.tint.until - t) / 1.5);
    let dh = live.tint.hue - d.hue; dh -= Math.round(dh);
    d.hue = (((d.hue + dh * w) % 1) + 1) % 1;
  }
}

/** the test buttons in settings: one example of each kind */
let testN = 0;
export function testLive(kind: 'chat' | 'gift' | 'bigGift' | 'likes' | 'follow') {
  const n = ++testN;
  const user = `test_viewer_${(n % 7) + 1}`, name = `Test viewer ${(n % 7) + 1}`;
  if (kind === 'chat') emitLive({ type: 'chat', user, name, text: ['this is fire', 'blue!', 'drop', 'hello from Addis', 'gold gold gold'][n % 5], test: true });
  if (kind === 'gift') emitLive({ type: 'gift', user, name, gift: 'Rose', diamonds: 5, count: 5, test: true });
  if (kind === 'bigGift') emitLive({ type: 'gift', user, name, gift: 'Galaxy', diamonds: 1000, count: 1, test: true });
  if (kind === 'likes') emitLive({ type: 'like', user, name, count: Math.ceil(live.likeGoal / 4), test: true });
  if (kind === 'follow') emitLive({ type: 'follow', user, name, test: true });
}
