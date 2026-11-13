/** A viewer's place in the sky and colour, derived from their handle so they keep it all stream long. */
function hash(s: string, seed: number) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** u: 0..1 across the view, v: 0..1 from low to high in the upper band (see AudienceLayer) */
export const starUV = (user: string): [number, number] => [hash(user, 1), Math.pow(hash(user, 2), 0.8)];
export const starHue = (user: string) => hash(user, 3);
/** where a viewer's star sits on screen, as fractions of the viewport (0,0 top-left) */
export const starScreen = (user: string): [number, number] => {
  const [u, v] = starUV(user);
  return [0.5 + (u - 0.5) * 0.92, 0.5 - (0.12 + 0.74 * v) / 2];
};
