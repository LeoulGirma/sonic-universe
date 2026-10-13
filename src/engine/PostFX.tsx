import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import type { BloomEffect } from 'postprocessing';
import { useStore } from '../store/useStore';
import { drives } from './frameBus';

/** Bloom whose strength follows the music, ACES tone mapping, gentle vignette and film grain. */
export function PostFX() {
  const bloomOn = useStore((s) => s.bloom);
  const bloom = useRef<BloomEffect>(null);
  useFrame(() => {
    const b = bloom.current;
    if (!b) return;
    const d = drives();
    const st = useStore.getState();
    const k = st.world === 'life' ? st.lifeParams.bloom : st.world === 'liquid' ? st.liquidParams.bloom : st.world === 'tunnel' ? st.tunnelParams.bloom : st.world === 'valley' ? 0.8 : st.params.bloom;
    // chrome is bright everywhere: only its highlights should bloom
    b.luminanceMaterial.threshold = st.world === 'liquid' ? 0.55 : 0.12;
    b.intensity = k * (0.85 + 0.55 * d.energy + 0.35 * d.pulse + 0.9 * d.release + 0.25 * d.idle);
  });
  const tail = [
    <ToneMapping key="tm" mode={ToneMappingMode.ACES_FILMIC} />,
    <Vignette key="vg" offset={0.28} darkness={0.72} blendFunction={BlendFunction.NORMAL} />,
    <Noise key="nz" opacity={0.028} premultiply blendFunction={BlendFunction.ADD} />,
  ];
  // two composers rather than a conditional child: EffectComposer needs a stable effect list
  return bloomOn ? (
    <EffectComposer key="bloom" multisampling={0} enableNormalPass={false}>
      {[<Bloom key="bl" ref={bloom as never} mipmapBlur luminanceThreshold={0.12} luminanceSmoothing={0.35} radius={0.78} intensity={1} />, ...tail]}
    </EffectComposer>
  ) : (
    <EffectComposer key="plain" multisampling={0} enableNormalPass={false}>
      {tail}
    </EffectComposer>
  );
}
