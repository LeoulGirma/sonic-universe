import { describe, expect, it, beforeEach } from 'vitest';
import { applyLive, emitLive, live, parseLive } from '../src/live/liveEvents';
import { createDrives } from '../src/mapping/drives';

const reset = () => {
  live.charge = 0; live.likesTotal = 0; live.likeGoal = 500; live.queue.length = 0; live.lastDropCmd = -99;
  Object.assign(live.boost, { pulse: 0, release: 0, energy: 0, kicks: 0, drops: 0 }); live.tint = { hue: 0, until: 0 };
};

describe('TikFinity / TikTok-LIVE-Connector parsing', () => {
  it('reads a comment', () => {
    expect(parseLive({ event: 'chat', data: { uniqueId: 'abebe', nickname: 'Abebe', comment: 'blue!' } }))
      .toMatchObject({ type: 'chat', user: 'abebe', name: 'Abebe', text: 'blue!' });
  });
  it('counts a gift streak once, when it ends', () => {
    expect(parseLive({ event: 'gift', data: { uniqueId: 'a', giftType: 1, repeatEnd: false, repeatCount: 3, diamondCount: 1, giftName: 'Rose' } })).toBeNull();
    expect(parseLive({ event: 'gift', data: { uniqueId: 'a', giftType: 1, repeatEnd: true, repeatCount: 5, diamondCount: 1, giftName: 'Rose' } }))
      .toMatchObject({ type: 'gift', gift: 'Rose', diamonds: 5, count: 5 });
  });
  it('reads follows from social events and ignores unknown ones', () => {
    expect(parseLive({ event: 'social', data: { uniqueId: 'b', displayType: 'pm_mt_msg_viewer_follow' } })).toMatchObject({ type: 'follow' });
    expect(parseLive({ event: 'roomUser', data: {} })).toBeNull();
    expect(parseLive('nonsense')).toBeNull();
  });
});

describe('audience effects on the drives', () => {
  beforeEach(reset);
  it('likes charge a drop at the goal', () => {
    emitLive({ type: 'like', user: 'v', name: 'v', count: 300 });
    expect(live.boost.drops).toBe(0);
    emitLive({ type: 'like', user: 'v', name: 'v', count: 250 });
    expect(live.boost.drops).toBe(1);
    expect(live.charge).toBe(0);
  });
  it('a big gift fires a drop and raises the drop counter worlds watch', () => {
    const d = createDrives();
    emitLive({ type: 'gift', user: 'g', name: 'g', gift: 'Galaxy', diamonds: 1000, count: 1 });
    applyLive(d, 1 / 60);
    expect(d.dropEvents).toBe(1);
    expect(d.kickEvents).toBe(1);
    expect(d.release).toBeGreaterThan(0.9);
  });
  it('"drop" in chat works at most once every 20 s', () => {
    emitLive({ type: 'chat', user: 'a', name: 'a', text: 'drop' });
    emitLive({ type: 'chat', user: 'b', name: 'b', text: 'DROP drop' });
    expect(live.boost.drops).toBe(1);
  });
  it('a colour word tints the hue', () => {
    const d = createDrives(); d.hue = 0.4;
    emitLive({ type: 'chat', user: 'a', name: 'a', text: 'make it red' });
    applyLive(d, 1 / 60);
    expect(Math.min(d.hue, 1 - d.hue)).toBeLessThan(0.01);
  });
});
