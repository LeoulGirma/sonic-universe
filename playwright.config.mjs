// End-to-end tests for The Dancer (public/dancer). Run: npm run e2e
// Chrome gets a fake microphone that plays e2e/.out/beat120.wav and a fake camera, and renders with SwiftShader.
import { defineConfig } from '@playwright/test';
import { makeBeat, BEAT_WAV } from './e2e/make-beat.mjs';

makeBeat();

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.mjs',
  timeout: 150_000,
  expect: { timeout: 60_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 900, height: 700 },
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${BEAT_WAV}`,
        '--autoplay-policy=no-user-gesture-required',
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      ],
    },
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory public',
    url: 'http://127.0.0.1:4173/dancer/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
