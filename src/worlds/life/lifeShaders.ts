/**
 * Particle Life GPU passes (WebGL2, GLSL ES 3.00 via three's ShaderMaterial).
 *
 * Neighbour search uses a sorted spatial hash, all in fragment shaders:
 *   1. key pass     — each particle writes (cell index, particle index)
 *   2. bitonic sort — log2(N)·(log2(N)+1)/2 compare-and-swap passes order the keys by cell
 *   3. cell pass    — each cell binary-searches the sorted keys for its [start, end) range
 *   4. force pass   — each particle visits the 27 surrounding cells
 *   5. move pass    — integrate positions
 * Compile-time sizes come in as #defines (W, H, N, LOG2N, G, CW, CELL, B, CAP, S).
 *
 * Dense cells: a particle reads at most CAP neighbours per cell, spread evenly across the cell
 * with a per-frame random offset, each weighted by count/CAP. That is an unbiased stochastic
 * estimate of the full sum (exact whenever a cell holds ≤ CAP particles). It is the one
 * approximation in the force law; everything else is the CPU reference law in lifeRules.ts.
 */

const header = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  ivec2 texelOf(int i) { return ivec2(i % W, i / W); }
  int cellOf(vec3 p) {
    ivec3 c = clamp(ivec3(floor((p + B) / CELL)), ivec3(0), ivec3(G - 1));
    return c.x + G * (c.y + G * c.z);
  }
`;

export const quadVertex = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const copyFragment = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D tSrc;
  void main() { gl_FragColor = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }
`;

export const keyFragment = /* glsl */ `
  ${header}
  uniform sampler2D tPos;
  void main() {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec3 p = texelFetch(tPos, ip, 0).xyz;
    gl_FragColor = vec4(float(cellOf(p)), float(ip.y * W + ip.x), 0.0, 1.0);
  }
`;

export const sortFragment = /* glsl */ `
  ${header}
  uniform sampler2D tKeys;
  uniform int uBlock; // k: size of the bitonic sequences being merged
  uniform int uDist;  // j: compare distance
  void main() {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    int i = ip.y * W + ip.x;
    int l = i ^ uDist;
    vec2 a = texelFetch(tKeys, ip, 0).xy;
    vec2 b = texelFetch(tKeys, texelOf(l), 0).xy;
    bool aLess = a.x < b.x || (a.x == b.x && a.y < b.y);
    bool ascending = (i & uBlock) == 0;
    bool keepMin = (l > i) == ascending;
    vec2 r = keepMin ? (aLess ? a : b) : (aLess ? b : a);
    gl_FragColor = vec4(r, 0.0, 1.0);
  }
`;

export const cellFragment = /* glsl */ `
  ${header}
  uniform sampler2D tKeys;
  int lowerBound(float key) {
    int lo = 0;
    int hi = N;
    for (int it = 0; it <= LOG2N + 1; it++) {
      if (lo >= hi) break;
      int mid = (lo + hi) >> 1;
      if (texelFetch(tKeys, texelOf(mid), 0).x < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  void main() {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    int c = ip.y * CW + ip.x;
    if (c >= G * G * G) { gl_FragColor = vec4(0.0); return; }
    gl_FragColor = vec4(float(lowerBound(float(c))), float(lowerBound(float(c) + 1.0)), 0.0, 1.0);
  }
`;

export const forceFragment = /* glsl */ `
  ${header}
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform sampler2D tKeys;
  uniform sampler2D tCells;
  uniform float uK[S * S];
  uniform float uRMax;
  uniform float uBeta;
  uniform float uRepel;
  uniform float uForce;
  uniform float uFriction; // velocity half-life, seconds
  uniform float uAlign;    // 1/s, steer toward neighbours' mean velocity (same species)
  uniform float uJitter;   // random acceleration on species 0
  uniform float uContain;
  uniform float uDt;
  uniform float uSeed;
  uniform vec3 uCursor;
  uniform float uCursorK;
  uniform int uDebug;      // 1: write the pair + containment acceleration only (self-test)

  float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec4 P = texelFetch(tPos, ip, 0);
    vec4 V = texelFetch(tVel, ip, 0);
    int sp = int(P.w + 0.5);
    ivec3 c = clamp(ivec3(floor((P.xyz + B) / CELL)), ivec3(0), ivec3(G - 1));

    vec3 F = vec3(0.0);
    vec3 vSum = vec3(0.0);
    float wSame = 0.0;
    float crowd = 0.0;
    float rnd = hash(vec3(vec2(ip), uSeed));

    for (int dz = -1; dz <= 1; dz++)
    for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      ivec3 cc = c + ivec3(dx, dy, dz);
      if (any(lessThan(cc, ivec3(0))) || any(greaterThanEqual(cc, ivec3(G)))) continue;
      int ci = cc.x + G * (cc.y + G * cc.z);
      vec2 se = texelFetch(tCells, ivec2(ci % CW, ci / CW), 0).xy;
      int start = int(se.x + 0.5);
      int cnt = int(se.y + 0.5) - start;
      if (cnt <= 0) continue;
      int k = min(cnt, CAP);
      float stride = float(cnt) / float(k);
      float offs = cnt > CAP ? fract(rnd + float(ci) * 0.618034) * stride : 0.0;
      for (int s = 0; s < CAP; s++) {
        if (s >= k) break;
        int m = start + int(float(s) * stride + offs);
        int j = int(texelFetch(tKeys, texelOf(m), 0).y + 0.5);
        ivec2 jp = texelOf(j);
        if (jp == ip) continue;
        vec4 Q = texelFetch(tPos, jp, 0);
        vec3 d = Q.xyz - P.xyz;
        float r = length(d);
        if (r <= 1e-4 || r >= uRMax) continue;
        float rn = r / uRMax;
        int sq = int(Q.w + 0.5);
        float f = rn < uBeta
          ? (rn / uBeta - 1.0) * uRepel
          : uK[sp * S + sq] * (1.0 - abs(2.0 * rn - 1.0 - uBeta) / (1.0 - uBeta));
        F += d / r * f * stride;
        crowd += stride;
        if (sq == sp) {
          vSum += texelFetch(tVel, jp, 0).xyz * stride;
          wSame += stride;
        }
      }
    }

    vec3 acc = F * uForce;
    float rp = length(P.xyz);
    if (rp > uContain) acc -= P.xyz / rp * (rp - uContain) * 10.0;
    if (uDebug == 1) { gl_FragColor = vec4(acc, crowd); return; }

    if (wSame > 0.0) acc += (vSum / wSame - V.xyz) * uAlign;
    if (sp == 0) acc += (vec3(hash(vec3(vec2(ip), uSeed + 1.0)), hash(vec3(vec2(ip), uSeed + 2.0)), hash(vec3(vec2(ip), uSeed + 3.0))) - 0.5) * 2.0 * uJitter;
    if (uCursorK != 0.0) {
      vec3 d = uCursor - P.xyz;
      float c2 = dot(d, d) + 4.0;
      acc += d * uCursorK * 4.0 / (c2 * sqrt(c2));
    }

    vec3 v = V.xyz * exp2(-uDt / uFriction) + acc * uDt;
    float sp2 = length(v);
    if (sp2 > 60.0) v *= 60.0 / sp2;
    // w: smoothed crowding (rendering only)
    float w = mix(V.w, crowd, 1.0 - exp2(-uDt / 0.15));
    gl_FragColor = vec4(v, w);
  }
`;

export const moveFragment = /* glsl */ `
  ${header}
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform float uDt;
  void main() {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec4 P = texelFetch(tPos, ip, 0);
    vec3 v = texelFetch(tVel, ip, 0).xyz;
    gl_FragColor = vec4(clamp(P.xyz + v * uDt, vec3(-B + 0.01), vec3(B - 0.01)), P.w);
  }
`;

export const pointVertex = /* glsl */ `
  precision highp sampler2D;
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform vec3 uCol[6];
  uniform float uSizes[6];
  uniform float uScale;
  uniform float uEnergy;
  uniform float uPulse;
  attribute vec2 ref;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    ivec2 t = ivec2(ref);
    vec4 P = texelFetch(tPos, t, 0);
    vec4 V = texelFetch(tVel, t, 0);
    int s = int(P.w + 0.5);
    float speed = length(V.xyz);
    float crowd = V.w;
    vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSizes[s] * (1.0 + 0.25 * uPulse);
    gl_PointSize = clamp(size * uScale / max(-mv.z, 0.5), 0.8, 36.0);
    // bodies glow from their density, swimmers from their speed
    float lit = 0.5 + 0.45 * smoothstep(10.0, 90.0, crowd) + 0.5 * smoothstep(2.0, 14.0, speed);
    vColor = mix(uCol[s], vec3(1.0), 0.25 * smoothstep(10.0, 30.0, speed));
    // dense nuclei overlap heavily under additive blending: dim them so they read as bodies, not white-outs
    vAlpha = lit * (0.6 + 0.5 * uEnergy) * mix(1.0, 0.5, smoothstep(60.0, 260.0, crowd)) * smoothstep(0.6, 3.0, -mv.z);
  }
`;

export const pointFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c) * 4.0;
    if (d > 1.0) discard;
    float a = exp(-d * 4.0) + 0.35 * exp(-d * 18.0);
    gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
  }
`;
