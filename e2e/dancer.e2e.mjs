// The Dancer, end to end: boots, plays the demo, finds the tempo of a known 120 BPM song file,
// locks onto the same beat through the microphone, loads the genre model and the body-tracking model.
// E2E_OFFLINE=1 serves three.js from node_modules and skips the two tests that need Google's model files
// (for sandboxes without internet); CI runs everything.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { BEAT_WAV, BEAT_BPM } from './make-beat.mjs';

const OFFLINE = !!process.env.E2E_OFFLINE;
const URL_ = '/dancer/index.html?debug';
const near = (v, target, pct) => Math.abs(v / target - 1) <= pct;

const pageErrors = new Map();
test.beforeEach(async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  pageErrors.set(info.testId, errors);
  if (OFFLINE) {
    await page.route('https://cdn.jsdelivr.net/npm/three@*/**', route => {
      const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
      return route.fulfill({ path: path.resolve('node_modules/three', rel), contentType: 'application/javascript' });
    });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  }
  await page.goto(URL_);
  await expect(page.locator('#demoBtn')).toBeEnabled({ timeout: 90_000 });
});

test.afterEach(async ({}, info) => {
  expect(pageErrors.get(info.testId), 'uncaught page errors').toEqual([]);
});

test('boots with the model and moves loaded, and plays the demo', async ({ page }) => {
  const moves = await page.evaluate(() => Object.keys(window.__dancer.D.acts).length);
  expect(moves).toBeGreaterThan(10);
  await page.click('#demoBtn');
  await expect(page.locator('#transport')).toBeVisible();
  await expect(page.locator('#nowMeta')).toContainText(/bar \d+/, { timeout: 20_000 });
  const t = await page.evaluate(() => window.__dancer.audio.ctx.currentTime);
  expect(t).toBeGreaterThan(0.5);
});

test('song file: finds 120 BPM', async ({ page }) => {
  await page.setInputFiles('#file', BEAT_WAV);
  await expect.poll(() => page.evaluate(() => window.__dancer.audio.mode), { timeout: 90_000 }).toBe('file');
  const bpm = await page.evaluate(() => window.__dancer.audio.analysis.bpm);
  expect(near(bpm, BEAT_BPM, 0.02), `file tempo ${bpm}`).toBe(true);
  await expect(page.locator('#nowMeta')).toContainText(/\d+ BPM/);
});

test('microphone: locks onto 120 BPM', async ({ page }) => {
  await page.click('#micBtn');
  await expect.poll(() => page.evaluate(() => window.__dancer.audio.mode)).toBe('mic');
  await expect.poll(() => page.evaluate(() => window.__dancer.audio.locked), { timeout: 60_000, intervals: [1000] }).toBe(true);
  // give the estimate a few more seconds to settle, then check it
  await page.waitForTimeout(6000);
  const bpm = await page.evaluate(() => window.__dancer.audio.bpm);
  expect(near(bpm, BEAT_BPM, 0.03), `mic tempo ${bpm}`).toBe(true);
});

test('genre model (YAMNet) loads for live audio', async ({ page }) => {
  test.skip(OFFLINE, 'needs storage.googleapis.com');
  await page.click('#micBtn');
  await expect.poll(() => page.evaluate(() => window.__genre.state), { timeout: 90_000, intervals: [2000] }).toBe('ready');
});

test('mirror mode: camera opens and body tracking loads', async ({ page }) => {
  test.skip(OFFLINE, 'needs storage.googleapis.com');
  await page.click('#mirrorBtn');
  await expect(page.locator('#nowTitle')).toHaveText('Mirror mode', { timeout: 90_000 });
  await expect(page.locator('#mirrorBtn2')).toHaveClass(/icon--on/);
  await expect(page.locator('#cam')).toBeVisible();
  await expect(page.locator('#toast')).not.toContainText('could not load');
});
