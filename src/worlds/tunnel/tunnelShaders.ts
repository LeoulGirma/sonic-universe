/**
 * The Impossible Tunnel: one procedural tube, positioned entirely in the vertex shader.
 *
 * Rows are placed on a fixed grid of ROWS_PER_BEAT per beat, anchored to whole beats, so when
 * the camera passes a beat the grid shifts by exactly one beat of rows and nothing "swims".
 * Per-ring structure (chamber width, build-up squeeze, drop gates, polygon style, curvature)
 * comes in as uniform arrays indexed by ring and is interpolated between rings.
 *
 * SOUND FAMILIES OWN THE WALLS. Around the tube, each kind of sound holds a band of wall, from
 * the floor counter-clockwise: bass (floor), kick, pads, lead (ceiling), hats, hits. A band's
 * width grows with that sound's loudness (loud sounds take more of the tunnel) and it pushes
 * into the tunnel by its loudness too, each with its own shape: bass a smooth rising floor,
 * pads broad walls, hits jagged teeth, hats a fine studded strip, kick a solid red slab, and the
 * melody a bright line along the ceiling that follows its pitch. The levels come per row (a 32nd
 * note) from a texture, so individual hits arrive exactly when they sound.
 * Compile-time: RINGS, ROWS_PER_BEAT, FAM_ROWS.
 */

const ringShared = /* glsl */ `
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

// the fragment shader only needs this part (the ring arrays would crowd its uniform budget)
const famShared = /* glsl */ `
  uniform float uPos;       // camera position along the tunnel, in beats
  uniform float uBase;      // whole beat of ring slot 0
  uniform sampler2D uFamTex; // FAM_ROWS × 2: (kick, hits, hats, bass), (pads, lead, melody, hue)

  // family ids: 0 kick, 1 hits, 2 hats, 3 bass, 4 pads, 5 lead
  // order around the wall from the floor, counter-clockwise: bass, kick, pads, lead, hats, hits
  int ordAt(int i) {
    if (i == 0) return 3;
    if (i == 1) return 0;
    if (i == 2) return 4;
    if (i == 3) return 5;
    if (i == 4) return 2;
    return 1;
  }

  void famRow(float row, out float L[6], out float mel, out float hue) {
    row = clamp(row, 0.0, float(FAM_ROWS) - 1.001);
    int r0 = int(floor(row));
    float f = row - float(r0);
    vec4 A = mix(texelFetch(uFamTex, ivec2(r0, 0), 0), texelFetch(uFamTex, ivec2(r0 + 1, 0), 0), f);
    vec4 B = mix(texelFetch(uFamTex, ivec2(r0, 1), 0), texelFetch(uFamTex, ivec2(r0 + 1, 1), 0), f);
    L[0] = A.x; L[1] = A.y; L[2] = A.z; L[3] = A.w; L[4] = B.x; L[5] = B.y;
    mel = B.z;
    hue = B.w;
  }

  // Which sound owns this angle of wall, where across its band (0..1), and how loud it is.
  // Band widths grow faster than loudness, so a loud sound visibly crowds out the quiet ones.
  void sector(float th, float L[6], out int fam, out float frac, out float lev) {
    float w[6];
    float tot = 0.0;
    for (int i = 0; i < 6; i++) {
      w[i] = 0.05 + pow(clamp(L[ordAt(i)], 0.0, 1.4), 1.7);
      tot += w[i];
    }
    float start = -1.5707963 - 3.14159265 * w[0] / tot; // bass centred on the floor
    float a = fract((th - start) / 6.2831853) * tot;
    float acc = 0.0;
    fam = ordAt(5);
    frac = 0.5;
    for (int i = 0; i < 6; i++) {
      if (a < acc + w[i]) { fam = ordAt(i); frac = (a - acc) / w[i]; break; }
      acc += w[i];
    }
    lev = L[fam];
  }
`;

export const tunnelVertex = /* glsl */ `
  ${famShared}
  ${ringShared}
  uniform float uSpacing;   // scene units per beat
  uniform float uRadius;
  uniform float uTwist;     // radians per beat (mids)
  uniform float uTwistPhase;
  uniform float uTime;
  uniform float uCurveAmp;
  uniform float uFamDepth;  // how far sounds push into the tunnel
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
    r *= 1.0 + 0.12 * gate * (1.0 - abs(fract(x + 0.5) - 0.5) * 2.0);

    // sound families push the wall inward in their own band, each with its own shape
    float L[6];
    float mel, hue;
    famRow(tk.y, L, mel, hue);
    int fam;
    float frac, lev;
    sector(th, L, fam, frac, lev);
    float bump = pow(sin(3.14159265 * clamp(frac, 0.0, 1.0)), 0.7);
    float push;
    if (fam == 3) push = 0.42 * bump;                                            // bass: a broad rising floor
    else if (fam == 0) push = 0.32 * smoothstep(0.0, 0.25, bump);                 // kick: a solid slab
    else if (fam == 4) push = 0.30 * bump;                                        // pads: broad walls
    else if (fam == 5) push = 0.20 * bump;                                        // lead: the ceiling
    else if (fam == 2) push = 0.10 * bump + 0.06 * step(0.5, fract(frac * 9.0)) * bump; // hats: studs
    else push = (0.10 + 0.34 * abs(fract(frac * 4.0) - 0.5) * 2.0) * bump;        // hits: teeth
    r *= 1.0 - uFamDepth * min(0.45, push * clamp(lev, 0.0, 1.3));

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
  ${famShared}
  uniform float uTime;
  uniform float uMid;
  uniform float uHigh;
  uniform float uFlash;     // kick: flash on the ring being crossed
  uniform float uEnergy;
  uniform float uRelease;
  uniform float uFamGlow;
  uniform vec3 uLine;
  uniform vec3 uBright;
  uniform vec3 uAccent;
  uniform vec3 uFam[6];
  varying float vB;
  varying float vTheta;
  varying float vSides;
  varying float vGate;
  varying float vWide;
  varying float vDepth;

  float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
  float line(float x, float w) { float d = abs(fract(x + 0.5) - 0.5); return exp(-d * d / (w * w)); }
  vec3 hue2rgb(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }

  void main() {
    float b = vB;
    // distance: walls dissolve into a glowing vanishing point (light at the end of the tunnel)
    float fog = vDepth > 0.0 ? exp(-vDepth / 16.0) : exp(vDepth * 1.5);
    float farGlow = vDepth > 0.0 ? (1.0 - exp(-vDepth / 16.0)) * exp(-vDepth / 60.0) : 0.0;

    // ---- which sound owns this piece of wall ------------------------------------------
    float L[6];
    float mel, hue;
    famRow((b - uBase) * float(ROWS_PER_BEAT), L, mel, hue);
    int fam;
    float frac, lev;
    sector(vTheta, L, fam, frac, lev);
    vec3 fc = uFam[fam];
    if (fam == 4) fc = mix(fc, hue2rgb(hue) * 0.9, 0.22); // the harmony tints the pads
    float seam = smoothstep(0.0, 0.035, frac) * smoothstep(1.0, 0.965, frac); // dark seams between sounds
    float body = 0.02 + 0.42 * pow(clamp(lev, 0.0, 1.3), 1.5);
    float pat = 1.0;
    float extra = 0.0;
    if (fam == 3) pat = 0.7 + 0.3 * sin(b * 3.0 - uTime * 2.0 + frac * 4.0);           // bass: slow waves
    else if (fam == 0) pat = 1.2;                                                     // kick: solid
    else if (fam == 4) pat = 0.75 + 0.35 * line(frac * 5.0, 0.08);                   // pads: ribs
    else if (fam == 1) pat = 0.55 + 0.9 * line(frac * 4.0 + 0.5, 0.12);              // hits: ridge crests
    else if (fam == 2) {                                                             // hats: studs that twinkle
      float cell = h11(floor(frac * 9.0) * 31.7 + floor(b * 8.0) * 7.3);
      pat = 0.35 + 1.6 * line(frac * 9.0, 0.16) * line(b * 8.0, 0.2) * (0.6 + 0.4 * sin(uTime * 9.0 + cell * 40.0));
    } else {                                                                         // lead: the melody line
      pat = 0.3;
      float p = 0.12 + 0.76 * clamp((mel - 0.12) / 0.45, 0.0, 1.0);
      extra = 1.6 * exp(-pow((frac - p) / 0.04, 2.0)) * clamp(lev * 1.4, 0.0, 1.0);
    }
    vec3 col = fc * (body * pat * seam + extra) * uFamGlow;

    // ---- the beat grid, over everything ----------------------------------------------
    float bar = step(abs(mod(floor(b + 0.5), 4.0)), 0.5);
    float beatRing = line(b, 0.016 + 0.014 * bar + 0.02 * vGate);
    float sub = line(b * 4.0, 0.03) * 0.12;
    col += mix(uLine, uAccent, 0.55 * bar) * beatRing * (0.45 + 0.6 * uEnergy + 0.5 * bar);
    col += uLine * sub;

    // highs: light streaks rushing past along random lanes, faster than the walls
    float lane = floor(vTheta / 6.2831853 * 72.0);
    float hl = h11(lane);
    float sCoord = fract(b * 0.2 - uPos * 0.6 - uTime * 0.4 + hl * 13.0);
    float streak = step(hl, 0.04 + 0.16 * uHigh) * smoothstep(0.0, 0.05, sCoord) * smoothstep(0.35, 0.05, sCoord)
                 * line(vTheta / 6.2831853 * 72.0, 0.08) * (0.3 + 1.0 * uHigh);
    col += uBright * streak * 0.4;

    float crossing = exp(-pow((b - uPos) * 3.0, 2.0));
    col += uBright * uFlash * crossing * (beatRing * 3.0 + 0.3);
    col += uAccent * vGate * beatRing * (2.0 + 4.0 * crossing + 3.0 * uRelease);
    col = col * fog + mix(uLine, uBright, 0.6) * farGlow * (0.35 + 0.4 * uEnergy);
    gl_FragColor = vec4(col, 1.0);
  }
`;
