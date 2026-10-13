/**
 * AnalyserNode emulation: Blackman window → radix-2 FFT → |X|/N → dB (smoothing 0).
 * Used by the Node tests and by the offline verification harness (?debug), so the exact same
 * FeatureExtractor can be driven frame-accurately without real-time playback.
 */
const cache = new Map<number, { win: Float64Array; re: Float64Array; im: Float64Array }>();

export function fftMagDb(frame: Float32Array, out: Float32Array) {
  const N = frame.length;
  let c = cache.get(N);
  if (!c) {
    const win = new Float64Array(N);
    const a0 = 0.42, a1 = 0.5, a2 = 0.08; // Blackman, as specified for AnalyserNode
    for (let n = 0; n < N; n++) win[n] = a0 - a1 * Math.cos((2 * Math.PI * n) / N) + a2 * Math.cos((4 * Math.PI * n) / N);
    c = { win, re: new Float64Array(N), im: new Float64Array(N) };
    cache.set(N, c);
  }
  const { win, re, im } = c;
  im.fill(0);
  for (let n = 0; n < N; n++) re[n] = frame[n] * win[n];
  // bit reversal
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  for (let k = 0; k < N / 2; k++) {
    const m = Math.hypot(re[k], im[k]) / N;
    out[k] = 20 * Math.log10(m + 1e-12);
  }
}

