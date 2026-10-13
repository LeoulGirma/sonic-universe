import * as THREE from 'three';
import type { PaletteId } from '../store/useStore';

/** deep → mid → bright → core, plus a rare accent (gold dust in the reference image). */
export interface Palette {
  name: string;
  colors: [string, string, string, string];
  accent: string;
  nebula: [string, string];
}

export const PALETTES: Record<PaletteId, Palette> = {
  nebula: { name: 'Nebula', colors: ['#1b2a8f', '#4f5bd5', '#9b7bff', '#ffe9c7'], accent: '#ffb547', nebula: ['#0b1450', '#3a1670'] },
  solar: { name: 'Solar', colors: ['#5a0f1a', '#c2410c', '#ff9a3c', '#fff4d6'], accent: '#7dd3fc', nebula: ['#2a0710', '#4a1a08'] },
  aurora: { name: 'Aurora', colors: ['#06363a', '#0fa39b', '#7cf2c8', '#effff8'], accent: '#c084fc', nebula: ['#031f24', '#162a4a'] },
  rose: { name: 'Rose', colors: ['#4c0b3a', '#d6336c', '#ffb36b', '#fff1e6'], accent: '#5eead4', nebula: ['#250720', '#3b0d2e'] },
  mono: { name: 'Mono', colors: ['#1f2933', '#7b8794', '#cbd2d9', '#ffffff'], accent: '#e4c590', nebula: ['#0b0d10', '#16191d'] },
};

export const paletteVec3 = (id: PaletteId) => {
  const p = PALETTES[id];
  return {
    c: p.colors.map((c) => new THREE.Color(c)) as [THREE.Color, THREE.Color, THREE.Color, THREE.Color],
    accent: new THREE.Color(p.accent),
    nebula: p.nebula.map((c) => new THREE.Color(c)) as [THREE.Color, THREE.Color],
  };
};

/**
 * Six species colours derived from a palette: hues fanned around the palette's mid colour
 * (so every palette stays coherent, and Mono stays monochrome), with the accent as the
 * small, bright "spark" species 0.
 */
export function speciesColors(id: PaletteId): THREE.Color[] {
  const p = PALETTES[id];
  const mid = new THREE.Color(p.colors[2]);
  const hsl = { h: 0, s: 0, l: 0 };
  mid.getHSL(hsl);
  const out = [new THREE.Color(p.accent)];
  const spread = [-0.16, -0.06, 0.04, 0.12, 0.22];
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Color();
    c.setHSL((hsl.h + spread[i] + 1) % 1, Math.min(1, hsl.s * 1.05), 0.5 + 0.08 * ((i % 2) * 2 - 1) + 0.05);
    out.push(c);
  }
  return out;
}
