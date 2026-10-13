/**
 * Cosmic Genesis GLSL.
 *
 * PHYSICAL (Newtonian, softened):
 *   - central mass and two satellite wells: a = -GM·r / (r² + ε²)^{3/2}  (Plummer softening)
 *   - m = 2 logarithmic-spiral density-wave potential rotating at a fixed pattern speed
 *     (Lin–Shu style): stars orbit through it and bunch up in its troughs, which is why the
 *     arms persist instead of winding up.
 * ARTISTIC (clearly not physics):
 *   - "cooling": relaxation of each star toward its local circular velocity so the disk
 *     re-forms after a disturbance (real galaxies take ~10⁸ years)
 *   - bass "gravitational waves": a travelling quadrupolar vertical ripple through the disk
 *   - kick shockwaves: an expanding spherical shell that pushes stars outward as it passes
 *   - cursor attractor / repeller
 *   - respawning stars that leave the system or fall into the core
 */

const common = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uG;
  uniform float uSoft;
  uniform float uPatternSpeed;
  uniform float uSpiralA;

  #define PITCH_K 4.0      // 2 / tan(pitch ≈ 26.5°)
  #define R_OUT 78.0
  #define R_IN 0.55

  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }

  // m=2 log-spiral potential. r-envelope peaks mid-disk and vanishes at the centre and edge.
  float spiralPot(vec2 xz) {
    float r = length(xz) + 1e-3;
    float th = atan(xz.y, xz.x);
    float env = (r / (r + 5.0)) * exp(-r / 26.0);
    return -uSpiralA * env * cos(2.0 * (th - uPatternSpeed * uTime) - PITCH_K * log(r));
  }

  vec3 spiralAcc(vec3 p) {
    const float e = 0.06;
    float dx = spiralPot(p.xz + vec2(e, 0.0)) - spiralPot(p.xz - vec2(e, 0.0));
    float dz = spiralPot(p.xz + vec2(0.0, e)) - spiralPot(p.xz - vec2(0.0, e));
    return -vec3(dx, 0.0, dz) / (2.0 * e);
  }

  // circular-orbit velocity around the softened central mass (counter-clockwise seen from +y)
  vec3 circularVel(vec3 p) {
    float r2 = dot(p.xz, p.xz);
    float r = sqrt(r2) + 1e-4;
    float s = r2 + uSoft * uSoft;
    float vc = sqrt(uG * r2 / (s * sqrt(s)));
    return vec3(-p.z, 0.0, p.x) / r * vc;
  }

  // a new star in the disk, placed on one of the two arms (mirrors the CPU initialiser)
  vec3 spawnPos(vec2 uv) {
    vec3 h = hash33(vec3(uv * 4096.0, uSeed));
    vec3 h2 = hash33(h * 91.7 + uSeed);
    float r = 4.0 - 9.0 * log(1.0 - h.x * 0.985);
    r = min(r, 44.0);
    float arm = floor(h.y * 2.0) * 3.14159265;
    float th = (PITCH_K * log(r)) / 2.0 + uPatternSpeed * uTime + arm + (h.z - 0.5) * 0.7;
    float y = (h2.x - 0.5) * 0.6 * (1.0 + r / 18.0);
    return vec3(cos(th) * r, y, sin(th) * r);
  }

  bool needsRespawn(vec3 p) {
    float r = length(p);
    return !(r < R_OUT) || r < R_IN; // !(r<R) also catches NaN
  }
`;

export const velocityShader = /* glsl */ `
  ${common}
  uniform float uDt;
  uniform vec4 uWells[2];        // xyz position, w = GM
  uniform vec4 uShock[12];       // x previous radius, y radius, z strength (Δv), w width
  uniform vec3 uShockC[12];
  uniform vec3 uCursor;
  uniform float uCursorK;        // >0 attract, <0 repel, 0 off
  uniform float uCooling;
  uniform float uWaveA;
  uniform float uWavePhase;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 P = texture2D(texturePosition, uv);
    vec4 V = texture2D(textureVelocity, uv);
    vec3 p = P.xyz;
    vec3 v = V.xyz;
    float heat = V.w;

    if (needsRespawn(p)) {
      vec3 np = spawnPos(uv);
      gl_FragColor = vec4(circularVel(np), 0.0);
      return;
    }

    // --- Newtonian gravity (softened) -------------------------------------
    float s2 = dot(p, p) + uSoft * uSoft;
    vec3 a = -uG * p / (s2 * sqrt(s2));
    for (int i = 0; i < 2; i++) {
      vec3 d = p - uWells[i].xyz;
      float w2 = dot(d, d) + 2.25;
      a += -uWells[i].w * d / (w2 * sqrt(w2));
    }
    // --- density wave --------------------------------------------------------
    a += spiralAcc(p);

    // --- artistic: travelling quadrupolar ripple (bass) -----------------------
    float r = length(p.xz);
    float th = atan(p.z, p.x);
    a.y += uWaveA * sin(0.32 * r - uWavePhase) * (0.65 + 0.35 * cos(2.0 * th - uWavePhase * 0.5)) * exp(-r / 48.0);

    // --- artistic: shockwave shells (kicks / drops) ----------------------------
    // A pressure pulse. The star's radial velocity follows v = K·S(x), x = (r − R)/w, with
    // S(x) = 2.33·x·e^{−x²}: outward as the shell approaches, inward once it has passed.
    // S is odd, so both the net momentum AND the net displacement are zero — stars ripple
    // and return, and orbit relaxation can't ratchet the disk outward kick after kick.
    // Applied as Δv = K·(S(x1) − S(x0)) between the shell radii at the start and end of the
    // step, which is exact at any frame rate.
    vec3 dvShock = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      vec4 sh = uShock[i];               // x R0, y R1, z K (velocity), w width
      if (sh.z <= 0.0) continue;
      vec3 d = p - uShockC[i];
      float dl = length(d) + 1e-3;
      float x0 = (dl - sh.x) / sh.w;
      float x1 = (dl - sh.y) / sh.w;
      // falloff uses the star's own distance (≈ constant while the shell passes) so it cancels too
      float dv = sh.z * 2.33 * (x1 * exp(-x1 * x1) - x0 * exp(-x0 * x0)) * exp(-dl / 45.0);
      dvShock += d / dl * dv;
      heat += abs(dv) * 0.2;
    }
    // --- artistic: cursor field -------------------------------------------
    if (uCursorK != 0.0) {
      vec3 d = uCursor - p;
      float c2 = dot(d, d) + 4.0;
      float k = uCursorK / (c2 * sqrt(c2));
      a += d * k * 4.0;
      heat += abs(k) * 54.0 * uDt / (1.0 + c2 * 0.02);
    }

    v += a * uDt + dvShock;

    // --- artistic: dynamical "cooling" toward circular orbits ---------------
    vec3 vt = circularVel(p);
    v += (vt - v) * (1.0 - exp(-uCooling * uDt));
    v.y -= p.y * uCooling * 0.6 * uDt; // settle back toward the disk plane

    heat *= exp(-uDt * 2.6);
    gl_FragColor = vec4(v, min(heat, 2.0));
  }
`;

export const positionShader = /* glsl */ `
  ${common}
  uniform float uDt;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 P = texture2D(texturePosition, uv);
    vec4 V = texture2D(textureVelocity, uv);
    if (needsRespawn(P.xyz)) {
      gl_FragColor = vec4(spawnPos(uv), P.w);
      return;
    }
    gl_FragColor = vec4(P.xyz + V.xyz * uDt, P.w);
  }
`;

export const starVertex = /* glsl */ `
  uniform sampler2D tPos;
  uniform sampler2D tVel;
  uniform float uSize;
  uniform float uScale;      // viewport height / 2 in device pixels
  uniform float uTime;
  uniform float uShimmer;
  uniform float uSparkle;
  uniform float uSparkleSeed;
  uniform float uEnergy;
  uniform float uHue;
  uniform vec3 uC0;
  uniform vec3 uC1;
  uniform vec3 uC2;
  uniform vec3 uC3;
  uniform vec3 uAccent;
  uniform float uSimTime;
  uniform float uPatternSpeed;
  uniform float uArmBoost;
  attribute vec2 reference;
  varying vec3 vColor;
  varying float vAlpha;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    vec4 P = texture2D(tPos, reference);
    vec4 V = texture2D(tVel, reference);
    float seed = P.w;
    float heat = V.w;
    float r = length(P.xyz);

    float tr = clamp(r / 36.0, 0.0, 1.0);
    vec3 col = mix(uC3, uC2, smoothstep(0.0, 0.16, tr));
    col = mix(col, uC1, smoothstep(0.14, 0.5, tr));
    col = mix(col, uC0, smoothstep(0.45, 1.0, tr));
    col = mix(col, uC2, uHue * 0.3 * (1.0 - tr));          // brighter timbre warms the disk
    float accent = step(0.962, seed);
    col = mix(col, uAccent, accent * 0.92);
    col = mix(col, uC3 * 1.15, clamp(heat * 0.55, 0.0, 0.85)); // shock / cursor heating

    // treble: every hi-hat re-rolls which ~6 % of stars flare, so flares are tied to the music
    float pick = step(0.94, hash(seed * 917.31 + uSparkleSeed * 13.73));
    float sparkle = pick * uSparkle;
    float twinkle = 0.78 + 0.22 * sin(uTime * (2.5 + seed * 9.0) + seed * 61.0) * (0.3 + uShimmer);

    vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSize * (0.55 + 1.7 * pow(seed, 7.0)) * (1.0 + heat * 0.7 + sparkle * 2.4 + accent * 0.5);
    gl_PointSize = clamp(size * uScale / max(-mv.z, 0.5), 0.6, 40.0);

    // render-only emphasis of the density-wave crest so the arms read clearly (dynamics untouched)
    float rr = length(P.xz) + 1e-3;
    float arm = 0.5 + 0.5 * cos(2.0 * (atan(P.z, P.x) - uPatternSpeed * uSimTime) - 4.0 * log(rr));
    float armLift = mix(1.0, 0.45 + 1.1 * arm * arm, uArmBoost * smoothstep(3.0, 9.0, rr));
    vAlpha = twinkle * (0.55 + 0.55 * uEnergy) * armLift + sparkle * 1.6 + heat * 0.45;
    vAlpha *= mix(0.35, 1.0, smoothstep(0.5, 7.0, r)); // the dense bulge would otherwise saturate
    // fade stars very close to the camera so fly-throughs don't flash
    vAlpha *= smoothstep(0.6, 3.5, -mv.z);
    vColor = col;
  }
`;

export const starFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c) * 4.0;
    if (d > 1.0) discard;
    float a = exp(-d * 5.0) + 0.3 * exp(-d * 22.0);
    gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
  }
`;

/** Painterly gas disk: same spiral as the density wave, warped by noise, lit by mids. */
export const gasVertex = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const noise = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }
`;

export const gasFragment = /* glsl */ `
  ${noise}
  uniform float uTime;
  uniform float uPatternSpeed;
  uniform float uFlow;
  uniform float uEnergy;
  uniform float uGravity;
  uniform float uLayer;
  uniform vec3 uC0;
  uniform vec3 uC1;
  uniform vec3 uC2;
  uniform vec3 uC3;
  varying vec2 vXZ;
  void main() {
    float r = length(vXZ) + 1e-3;
    float th = atan(vXZ.y, vXZ.x);
    vec2 q = vXZ * 0.07;
    float warp = fbm(q * 1.4 + vec2(uTime * 0.02 * (0.5 + uFlow), uLayer * 3.1));
    float phase = 2.0 * (th - uPatternSpeed * uTime) - 4.0 * log(r) + warp * 2.6;
    float arms = pow(0.5 + 0.5 * cos(phase), 4.0);
    float fil = fbm(q * 3.5 + warp * 2.0 - uTime * 0.015);
    float radial = smoothstep(44.0, 6.0, r) * smoothstep(0.0, 3.0, r);
    float core = exp(-r * r / 30.0) * (1.0 + uGravity * 0.8);
    vec3 col = mix(uC1, uC0, smoothstep(6.0, 40.0, r));
    col = mix(col, uC2, arms * fil * 0.6);
    float a = (arms * (0.45 + 0.9 * fil) * radial * (0.16 + 0.26 * uFlow + 0.12 * uEnergy)) + core * 0.22;
    gl_FragColor = vec4(col * a + uC3 * core * 0.25, 1.0);
  }
`;

/** Faint deep-space backdrop on a large sphere. */
export const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

export const skyFragment = /* glsl */ `
  ${noise}
  uniform float uTime;
  uniform float uEnergy;
  uniform float uCalm;
  uniform vec3 uN0;
  uniform vec3 uN1;
  varying vec3 vDir;
  void main() {
    vec2 p = vec2(atan(vDir.z, vDir.x) * 1.6, vDir.y * 3.0);
    float n = fbm(p * 1.3 + uTime * 0.004);
    float n2 = fbm(p * 2.7 - n * 1.5);
    float band = exp(-vDir.y * vDir.y * 9.0);
    vec3 col = mix(uN0, uN1, n2);
    float a = (0.18 + 0.5 * band) * smoothstep(0.35, 0.95, n * 0.6 + n2 * 0.6) * (0.55 + 0.35 * uEnergy + 0.25 * uCalm);
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

export const fieldVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uShimmer;
  uniform float uPixelRatio;
  varying float vA;
  varying float vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.6 + 0.4 * sin(uTime * (0.7 + aSeed * 3.0) + aSeed * 40.0);
    vA = tw * (0.45 + 0.55 * uShimmer) * (0.4 + aSeed);
    vSeed = aSeed;
    gl_PointSize = (1.0 + 2.2 * pow(aSeed, 4.0)) * uPixelRatio;
  }
`;

export const fieldFragment = /* glsl */ `
  varying float vA;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c) * 4.0;
    if (d > 1.0) discard;
    vec3 col = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), step(0.8, vSeed));
    gl_FragColor = vec4(col * exp(-d * 4.0) * vA, 1.0);
  }
`;

/** One horizontal quad that draws every active shockwave ring in a single pass. */
export const ringFragment = /* glsl */ `
  uniform vec4 uShock[12];
  uniform vec3 uShockC[12];
  uniform vec3 uColor;
  varying vec2 vXZ;
  void main() {
    float a = 0.0;
    for (int i = 0; i < 12; i++) {
      vec4 sh = uShock[i];
      if (sh.z <= 0.0) continue;
      float d = length(vXZ - uShockC[i].xz);
      float x = (d - sh.y) / (sh.w * 0.22);
      a += exp(-x * x) * sh.z * 0.016 * exp(-d / 30.0) * smoothstep(0.0, 6.0, sh.y);
    }
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

/** Camera-facing glow for the core and the satellite wells. */
export const glowVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 6.0) + 0.25 * exp(-d * 2.5);
    a *= smoothstep(1.0, 0.7, d);
    gl_FragColor = vec4(uColor * a * uIntensity, 1.0);
  }
`;
