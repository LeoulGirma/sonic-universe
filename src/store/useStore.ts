import { create } from 'zustand';
import { DEFAULT_LIFE, LifeParams } from '../worlds/life/LifeSim';
import { DEFAULT_LIQUID, LiquidParams } from '../worlds/liquid/liquidSim';
import { DEFAULT_TUNNEL, TunnelParams } from '../worlds/tunnel/tunnelState';
export type { LifeParams, LiquidParams, TunnelParams };

export type WorldId = 'cosmic' | 'liquid' | 'geometric' | 'life' | 'tunnel';
export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type CursorMode = 'attract' | 'repel' | 'off';
export type PaletteId = 'nebula' | 'solar' | 'aurora' | 'rose' | 'mono';

/** Simulation constants exposed in experiment mode. Units are scene units and seconds. */
export interface SimParams {
  G: number; // central GM (scene units³/s²)
  softening: number; // Plummer softening length
  cooling: number; // 1/s relaxation toward circular orbits (artistic)
  shockStrength: number; // peak outward velocity of a kick's compression wave
  shockSpeed: number; // scene units/s
  cursorStrength: number;
  spiralAmp: number; // m=2 density-wave potential amplitude
  waveAmp: number; // vertical ripple from bass
  companionMass: number; // GM of the two satellite wells at full energy
  timeScale: number;
  starSize: number;
  bloom: number;
}

/** Feature → drive gains (layer 2). */
export interface MappingGains {
  bass: number;
  mid: number;
  high: number;
  kick: number;
}

export const DEFAULT_PARAMS: SimParams = {
  G: 70,
  softening: 1.6,
  cooling: 0.22,
  shockStrength: 3,
  shockSpeed: 24,
  cursorStrength: 120,
  spiralAmp: 1,
  waveAmp: 1,
  companionMass: 1,
  timeScale: 1,
  starSize: 1,
  bloom: 1,
};

export const DEFAULT_GAINS: MappingGains = { bass: 1, mid: 1, high: 1, kick: 1 };

export const QUALITY_SIDE: Record<Quality, number> = { low: 96, medium: 144, high: 192, ultra: 256 };

/** Particle Life texture sizes (powers of two for the bitonic sort) and per-cell sample caps. */
export const LIFE_DIMS: Record<Quality, { w: number; h: number; cap: number }> = {
  low: { w: 64, h: 64, cap: 32 },
  medium: { w: 128, h: 64, cap: 32 },
  high: { w: 128, h: 128, cap: 24 },
  ultra: { w: 256, h: 128, cap: 16 },
};

/** Liquid Dimension: blob count and raymarch steps per quality. */
export const LIQUID_Q: Record<Quality, { blobs: number; steps: number }> = {
  low: { blobs: 10, steps: 48 },
  medium: { blobs: 14, steps: 64 },
  high: { blobs: 18, steps: 80 },
  ultra: { blobs: 22, steps: 100 },
};

/** The Impossible Tunnel: segments around the circumference. */
export const TUNNEL_Q: Record<Quality, { segments: number }> = {
  low: { segments: 64 }, medium: { segments: 96 }, high: { segments: 128 }, ultra: { segments: 192 },
};

export function qualityLabel(world: WorldId, q: Quality) {
  if (world === 'liquid' || world === 'tunnel') return { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' }[q];
  return `${Math.round(particleCount(world, q) / 1000)}k`;
}

export function particleCount(world: WorldId, q: Quality) {
  if (world === 'life') return LIFE_DIMS[q].w * LIFE_DIMS[q].h;
  return QUALITY_SIDE[q] ** 2;
}

const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

export interface AppState {
  world: WorldId;
  palette: PaletteId;
  sensitivity: number;
  gravityScale: number;
  quality: Quality;
  autoQuality: boolean;
  resolutionCap: number; // max fraction of devicePixelRatio
  dpr: number; // live render DPR (adaptive)
  bloom: boolean;
  cinematic: boolean;
  frozen: boolean;
  showPerf: boolean;
  panel: 'none' | 'settings' | 'experiment';
  cursor: CursorMode;
  uiHidden: boolean;
  params: SimParams;
  lifeParams: LifeParams;
  liquidParams: LiquidParams;
  tunnelParams: TunnelParams;
  gains: MappingGains;
  floatType: 'float' | 'half' | 'unknown';
  set: (p: Partial<AppState>) => void;
  setParam: <K extends keyof SimParams>(k: K, v: SimParams[K]) => void;
  setLifeParam: <K extends keyof LifeParams>(k: K, v: LifeParams[K]) => void;
  setLiquidParam: <K extends keyof LiquidParams>(k: K, v: LiquidParams[K]) => void;
  setTunnelParam: <K extends keyof TunnelParams>(k: K, v: TunnelParams[K]) => void;
  setGain: <K extends keyof MappingGains>(k: K, v: number) => void;
  resetExperiment: () => void;
}

const maxDpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

const WORLD_IDS: WorldId[] = ['cosmic', 'liquid', 'geometric', 'life', 'tunnel'];
const linked = (() => {
  if (typeof window === 'undefined') return null;
  const w = (window as unknown as { __SONIC_WORLD?: string }).__SONIC_WORLD ?? location.hash.replace('#', '');
  return WORLD_IDS.includes(w as WorldId) && w !== 'geometric' ? (w as WorldId) : null;
})();

export const useStore = create<AppState>((set) => ({
  world: linked ?? 'cosmic',
  palette: 'nebula',
  sensitivity: 1,
  gravityScale: 1,
  quality: isMobile ? 'medium' : 'high',
  autoQuality: true,
  resolutionCap: 1,
  dpr: isMobile ? Math.min(maxDpr, 1.5) : maxDpr,
  bloom: true,
  cinematic: typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  frozen: false,
  showPerf: false,
  panel: 'none',
  cursor: 'attract',
  uiHidden: false,
  params: { ...DEFAULT_PARAMS },
  lifeParams: { ...DEFAULT_LIFE },
  liquidParams: { ...DEFAULT_LIQUID },
  tunnelParams: { ...DEFAULT_TUNNEL },
  gains: { ...DEFAULT_GAINS },
  floatType: 'unknown',
  set: (p) => set(p),
  setParam: (k, v) => set((s) => ({ params: { ...s.params, [k]: v } })),
  setLifeParam: (k, v) => set((s) => ({ lifeParams: { ...s.lifeParams, [k]: v } })),
  setLiquidParam: (k, v) => set((s) => ({ liquidParams: { ...s.liquidParams, [k]: v } })),
  setTunnelParam: (k, v) => set((s) => ({ tunnelParams: { ...s.tunnelParams, [k]: v } })),
  setGain: (k, v) => set((s) => ({ gains: { ...s.gains, [k]: v } })),
  resetExperiment: () => set({ params: { ...DEFAULT_PARAMS }, lifeParams: { ...DEFAULT_LIFE }, liquidParams: { ...DEFAULT_LIQUID }, tunnelParams: { ...DEFAULT_TUNNEL }, gains: { ...DEFAULT_GAINS } }),
}));

export const MAX_DPR = maxDpr;
export const IS_MOBILE = isMobile;
