import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode single` inlines every asset into one HTML file (used for the hosted preview).
// PAGES_BASE is set by the GitHub Pages workflow (the site is served from /<repo>/)
export default defineConfig(({ mode }) => ({
  base: process.env.PAGES_BASE ?? '/',
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  build: { target: 'es2020', chunkSizeWarningLimit: 2000, outDir: mode === 'single' ? 'dist-single' : 'dist' },
  test: { environment: 'node' },
}));
