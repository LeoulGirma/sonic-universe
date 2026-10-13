/**
 * The Impossible Tunnel: one procedural tube, positioned entirely in the vertex shader.
 *
 * Rows are placed on a fixed grid of ROWS_PER_BEAT per beat, anchored to whole beats, so when
 * the camera passes a beat the grid shifts by exactly one beat of rows and nothing "swims".
 * Per-ring structure (chamber width, build-up squeeze, drop gates, polygon style, curvature)
 * comes in as uniform arrays indexed by ring and is interpolated between rings.
 * Compile-time: RINGS, ROWS_PER_BEAT.
 */

const shared = /* glsl */ `
  uniform float uPos;       // camera position along the tunnel, in beats
  uniform float uBase;      // whole beat of ring slot 0
  uniform float uWide[RINGS];
  uniform float uNarrow[RINGS];
  uniform float uGate[RINGS];
  uniform float uStyle[RINGS];
  uniform float uCurve[RINGS];

  float ringArr(int which, int j) {
    j = clamp(j, 0, RINGS - 1);
    if (which == 0) return uWide[j];
    if (which == 1) return uNarrow[j];
    if (which == 2) return uGate[j];
    if (which == 3) return uStyle[j];
    return uCurve[j];
  }
  float ring(int which, float b) {
    float x = b - uBase;
    int j = int(floor(x));
    return mix(ringArr(which, j), ringArr(which, j + 1), fract(x));
  }
`;

export const tunnelVertex = /* glsl */ `
  ${shared}
  uniform float uSpacing;   // scene units per beat
  uniform float uRadius;
  uniform float uTwist;     // radians per beat (mids)
  uniform float uTwistPhase;
  uniform float uBass;
  uniform float uTime;
  uniform float uCurveAmp;
  attribute vec2 tk;        // x: angle 0..1, y: row index
  varying float vB;
  varying float vTheta;
  varying float vSides;
  varying float vGate;
  varying float vWide;
  varying float vDepth;

  vec2 path(float b) {
    return vec2(sin(b * 0.13) * 7.0 + sin(b * 0.047 + 1.3) * 12.0, cos(b * 0.11) * 5.0 + sin(b * 0.061) * 6.0);
  }

  float polyR(float th, float n) {
    if (n < 2.5) return 1.0;
    float seg = 6.2831853 / n;
    return cos(3.14159265 / n) / cos(mod(th, seg) - 3.14159265 / n);
  }

  void main() {
    float b = uBase + tk.y / float(ROWS_PER_BEAT);
    float rel = b - uPos;
    // path relative to the camera, with the camera's own tangent removed: the tunnel is centred
    // and aligned where you are, and its curvature is visible ahead
    float camAmp = ring(4, uPos) * uCurveAmp;
    float amp = ring(4, b) * uCurveAmp;
    vec2 p0 = path(uPos) * camAmp;
    vec2 dp = (path(uPos + 0.05) - path(uPos - 0.05)) / 0.1 * camAmp;
    vec2 centre = path(b) * amp - p0 - dp * rel;

    float th = tk.x * 6.2831853 + uTwist * rel + uTwistPhase;
    // style: interpolate polygon shape between this ring and the next
    float x = b - uBase;
    int j = int(floor(x));
    float nA = ringArr(3, j), nB = ringArr(3, j + 1);
    float shape = mix(polyR(th, nA), polyR(th, nB), smoothstep(0.0, 1.0, fract(x)));
    float wide = ring(0, b);
    float narrow = ring(1, b);
    float gate = ring(2, b);
    float r = uRadius * shape * (1.0 + 1.7 * wide) * (1.0 - 0.45 * narrow);
    r *= 1.0 + 0.1 * uBass * sin(th * 3.0 + b * 0.9 + uTime * 2.0) + 0.12 * gate * (1.0 - abs(fract(x + 0.5) - 0.5) * 2.0);

    vec3 pos = vec3(centre + r * vec2(cos(th), sin(th)), -rel * uSpacing);
    vB = b;
    vTheta = th;
    vSides = mix(nA, nB, step(0.5, fract(x)));
    vGate = gate;
    vWide = wide;
    vDepth = rel;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

export const tunnelFragment = /* glsl */ `
  uniform float uPos;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uFlash;     // kick: flash on the ring being crossed
  uniform float uEnergy;
  uniform float uRelease;
  uniform vec3 uDeep;
  uniform vec3 uLine;
  uniform vec3 uBright;
  uniform vec3 uAccent;
  varying float vB;
  varying float vTheta;
  varying float vSides;
  varying float vGate;
  varying float vWide;
  varying float vDepth;

  float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
  float line(float x, float w) { float d = abs(fract(x + 0.5) - 0.5); return exp(-d * d / (w * w)); }

  void main() {
    float b = vB;
    // distance: walls dissolve into a glowing vanishing point (light at the end of the tunnel)
    float fog = vDepth > 0.0 ? exp(-vDepth / 16.0) : exp(vDepth * 1.5);
    float farGlow = vDepth > 0.0 ? (1.0 - exp(-vDepth / 16.0)) * exp(-vDepth / 60.0) : 0.0;

    // beat rings; every 4th (a bar) thicker and accent-tinted; dim quarter-beat sub-rings
    float bar = step(abs(mod(floor(b + 0.5), 4.0)), 0.5);
    float beatRing = line(b, 0.016 + 0.014 * bar + 0.02 * vGate);
    float sub = line(b * 4.0, 0.03) * 0.22;
    float n = vSides > 2.5 ? vSides : 16.0;
    float rib = line(vTheta / 6.2831853 * n, 0.025) * (vSides > 2.5 ? 0.9 : 0.35);

    // highs: light streaks rushing past along random lanes, faster than the walls
    float lane = floor(vTheta / 6.2831853 * 72.0);
    float hl = h11(lane);
    float sCoord = fract(b * 0.2 - uPos * 0.6 - uTime * 0.4 + hl * 13.0);
    float streak = step(hl, 0.12 + 0.6 * uHigh) * smoothstep(0.0, 0.05, sCoord) * smoothstep(0.35, 0.05, sCoord)
                 * line(vTheta / 6.2831853 * 72.0, 0.08) * (0.4 + 1.6 * uHigh);

    // data lights: a grid of dots on the wall panels that twinkle with the highs
    float gx = vTheta / 6.2831853 * n * 6.0, gy = b * 6.0;
    float cell = h11(floor(gx) * 31.7 + floor(gy) * 7.3);
    float dot = line(gx, 0.09) * line(gy, 0.09) * step(0.72 - 0.25 * uHigh, cell)
              * (0.5 + 0.5 * sin(uTime * (3.0 + cell * 9.0) + cell * 40.0));

    float panel = 0.05 + 0.2 * uBass + 0.08 * uEnergy;
    vec3 col = uDeep * panel * (1.0 - 0.4 * vWide);
    col += mix(uLine, uAccent, 0.55 * bar) * beatRing * (0.6 + 0.8 * uEnergy + 0.6 * bar);
    col += uLine * (sub + rib * (0.25 + 0.5 * uMid));
    col += uAccent * dot * (0.35 + 0.9 * uHigh);
    col += uBright * streak;
    float crossing = exp(-pow((b - uPos) * 3.0, 2.0));
    col += uBright * uFlash * crossing * (beatRing * 3.0 + 0.4);
    col += uAccent * vGate * beatRing * (2.0 + 4.0 * crossing + 3.0 * uRelease);
    col = col * fog + mix(uLine, uBright, 0.6) * farGlow * (0.35 + 0.4 * uEnergy);
    gl_FragColor = vec4(col, 1.0);
  }
`;
