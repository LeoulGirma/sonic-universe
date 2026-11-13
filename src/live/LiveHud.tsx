import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { connectLive, disconnectLive, giftTier, live, onLive, onLiveStatus, type LiveEvent, type LiveStatus } from './liveEvents';
import { starScreen } from './audience';

/**
 * What viewers see on top of the world during a TikTok LIVE: their name and message appear beside their
 * star, gifts get a banner, and the likes meter shows how close the audience is to the next drop.
 * Stays visible when the app's own controls hide (it's part of the show).
 */
interface Bubble { id: number; user: string; name: string; text: string; born: number }
interface Banner { id: number; tier: number; line: string; sub: string }

const MAX_BUBBLES = 6;

export function LiveHud() {
  const url = useStore((s) => s.liveUrl);
  const likeGoal = useStore((s) => s.likeGoal);
  const [status, setStatus] = useState<LiveStatus>(live.status);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [banner, setBanner] = useState<Banner | null>(null);
  const bannerQ = useRef<Banner[]>([]);
  const showing = useRef(false);
  const fill = useRef<HTMLDivElement>(null);
  const count = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLDivElement>(null);

  // connect to TikFinity while live mode is on
  useEffect(() => { live.likeGoal = likeGoal; }, [likeGoal]);
  useEffect(() => {
    const off = onLiveStatus(setStatus);
    connectLive(url);
    return () => { off(); disconnectLive(); };
  }, [url]);

  // the next gift banner, one at a time
  const showNext = useRef<() => void>(() => {});
  showNext.current = () => {
    const b = bannerQ.current.shift() ?? null;
    showing.current = !!b;
    setBanner(b);
    if (b) setTimeout(() => showNext.current(), b.tier >= 2 ? 4200 : 2600);
  };

  useEffect(() => onLive((e: LiveEvent) => {
    if (e.type === 'chat' && e.text) {
      setBubbles((bs) => [...bs.filter((b) => b.user !== e.user), { id: e.id, user: e.user, name: e.name, text: e.text!, born: e.at }].slice(-MAX_BUBBLES));
      setTimeout(() => setBubbles((bs) => bs.filter((b) => b.id !== e.id)), 5200);
    }
    let b: Banner | null = null;
    if (e.type === 'gift') {
      const tier = giftTier(e.diamonds ?? 1);
      b = { id: e.id, tier, line: `${e.name} sent ${e.gift}${(e.count ?? 1) > 1 ? ` ×${e.count}` : ''}`, sub: tier >= 2 ? 'Drop!' : 'Shockwave' };
    } else if (e.type === 'follow') b = { id: e.id, tier: 0, line: `${e.name} followed`, sub: 'Welcome to the universe' };
    else if (e.type === 'share') b = { id: e.id, tier: 0, line: `${e.name} shared the LIVE`, sub: 'Thank you' };
    if (b) {
      if (bannerQ.current.length > 8) bannerQ.current.shift();
      bannerQ.current.push(b);
      if (!showing.current) showNext.current();
    }
  }), []);

  // likes meter follows live.charge every frame
  useEffect(() => {
    let raf = 0, last = -1, flash = 0;
    const tick = () => {
      const c = live.charge;
      if (fill.current) fill.current.style.transform = `scaleY(${Math.max(0.02, c)})`;
      if (count.current && live.likesTotal !== last) { last = live.likesTotal; count.current.textContent = live.likesTotal.toLocaleString(); }
      if (meter.current) {
        if (live.boost.release > 0.99 && flash <= 0) flash = 60;
        if (flash > 0) flash--;
        meter.current.classList.toggle('livemeter--fired', flash > 0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="livehud" aria-live="polite">
      {bubbles.map((b) => {
        const [x, y] = starScreen(b.user);
        const left = Math.min(Math.max(x, 0.12), 0.78);
        return (
          <div key={b.id} className="livebubble" style={{ left: `${left * 100}%`, top: `calc(${y * 100}% + 14px)` }}>
            <b>{b.name}</b>
            <span>{b.text}</span>
          </div>
        );
      })}
      {banner && (
        <div key={banner.id} className={`livebanner livebanner--t${banner.tier}`}>
          <strong>{banner.line}</strong>
          <em>{banner.sub}</em>
        </div>
      )}
      <div className="livemeter" ref={meter}>
        <div className="livemeter__bar"><div className="livemeter__fill" ref={fill} /></div>
        <div className="livemeter__label">
          <span>Likes charge the next drop</span>
          <small><span ref={count}>0</span> likes</small>
        </div>
      </div>
      {status !== 'on' && <div className="livestatus">{status === 'connecting' ? 'Waiting for TikFinity…' : 'Live audience off'}</div>}
    </div>
  );
}
