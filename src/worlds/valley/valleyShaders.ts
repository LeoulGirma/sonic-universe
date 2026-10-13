/**
 * Sound Valley shaders.
 *
 * TIME ON THE GROUND. Row r of the window is beat uBase + r / RPB, anchored to absolute beats so
 * nothing swims. The camera sits at beat uCam; the music's present, beat uPos, is the NOW LINE a
 * few beats ahead of it (with a song map), so every event visibly happens on time in front of
 * you: ridges, monoliths and the melody orb light as they cross it, and the land beyond shows
 * what is about to play. Live, the now line sits near the horizon and the land is built there
 * and flows toward you.
 *
 * THE GROUND IS THE SPECTRUM. Every 16th note is one ridgeline whose profile is the music's
 * spectrum at that moment, mirrored: bass beside the path, highs far out. A groove draws its own
 * repeating pattern across the land.
 *
 * Textures: uFamTex (NROWS × 2: kick, hits, hats, bass / pads, lead, melody, hue),
 * uSpecTex (NROWS × 32 bands). Compile-time: RPB, NROWS.
 */

export const valleyShared = /* glsl */ `
  uniform sampler2D uFamTex;
  uniform sampler2D uSpecTex;
  uniform sampler2D uSectTex; // NROWS × 2: biome weights (dunes, mountains, lake, spires) / (seed, beats into section, -, -)
  uniform float uPos;      // the music's present, in beats (the now line)
  uniform float uCam;      // the camera's beat
  uniform float uBase;     // whole beat of row 0
  uniform float uSpacing;  // scene units per beat
  uniform float uTime;
  uniform float uNowSpec[32]; // the spectrum at the exact moment you hear

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec4 famA(float row) {
    row = clamp(row, 0.0, float(NROWS) - 1.001);
    int r = int(floor(row));
    return mix(texelFetch(uFamTex, ivec2(r, 0), 0), texelFetch(uFamTex, ivec2(r + 1, 0), 0), fract(row));
  }
  vec4 famB(float row) {
    row = clamp(row, 0.0, float(NROWS) - 1.001);
    int r = int(floor(row));
    return mix(texelFetch(uFamTex, ivec2(r, 1), 0), texelFetch(uFamTex, ivec2(r + 1, 1), 0), fract(row));
  }
  // spectrum of a row at u across the bands (0 = 40 Hz … 1 = 10 kHz)
  float specAt(float row, float u) {
    int r = int(clamp(floor(row + 0.5), 0.0, float(NROWS) - 1.0));
    float bf = clamp(u, 0.0, 1.0) * 31.0;
    int k = int(floor(bf));
    return mix(texelFetch(uSpecTex, ivec2(r, k), 0).r, texelFetch(uSpecTex, ivec2(r, min(k + 1, 31)), 0).r, fract(bf));
  }
  // the winding route through the valley (absolute beats → stable); the camera follows it
  float pathX(float b) { return 9.0 * sin(b * 0.045) + 4.0 * sin(b * 0.017 + 1.0); }
  float zOf(float b) { return -(b - uCam) * uSpacing; }
  float uAcross(float ax) { return clamp((ax - 7.0) / 72.0, 0.0, 1.0); }
  float nowSpec(float u) {
    float bf = clamp(pow(u, 0.85), 0.0, 1.0) * 31.0;
    int k = int(floor(bf));
    return mix(uNowSpec[k], uNowSpec[min(k + 1, 31)], fract(bf));
  }
  // land is DORMANT ahead of the now line (a low preview) and comes alive as the music reaches it
  float activation(float b) { return smoothstep(uPos + 0.25, uPos - 1.5, b); }
  vec4 sectW(float row) {
    row = clamp(row, 0.0, float(NROWS) - 1.001);
    int r = int(floor(row));
    return mix(texelFetch(uSectTex, ivec2(r, 0), 0), texelFetch(uSectTex, ivec2(r + 1, 0), 0), fract(row));
  }
  vec4 sectI(float row) { return texelFetch(uSectTex, ivec2(int(clamp(floor(row + 0.5), 0.0, float(NROWS) - 1.0)), 1), 0); }
  // Landforms per kind of section. Noise is keyed to the section's LABEL and position within it,
  // so when a chorus returns, its mountains return; the spectrum still shapes every ridge.
  float terrain(float x, float b, float row) {
    float cx = x - pathX(b);
    float ax = abs(cx);
    float u = uAcross(ax);
    vec4 W = sectW(row);
    vec4 I = sectI(row);
    float seed = I.x, lb = I.y;
    float s = specAt(row, pow(u, 0.85));
    float edge = smoothstep(6.0, 16.0, ax);                 // the route itself stays flat and open
    float amp = (1.6 + 3.2 * (1.0 - u) + 2.5 * smoothstep(0.3, 1.0, u)) * edge;
    float n = vnoise(vec2(cx * 0.07 + seed * 37.0, lb * 0.5 + seed * 11.0));
    // dunes: broad swells, the spectrum riding on them
    float swell = vnoise(vec2(cx * 0.025 + seed * 7.0, lb * 0.12 + seed * 3.0));
    float dunes = (swell * 5.0 * smoothstep(8.0, 40.0, ax) + s * amp * (0.6 + 0.5 * n)) * edge;
    // mountains: sharp ridged peaks rising toward the sides
    float rn = 1.0 - abs(vnoise(vec2(cx * 0.05 + seed * 13.0, lb * 0.18 + seed * 5.0)) * 2.0 - 1.0);
    float mountains = (pow(rn, 3.0) * (3.0 + 30.0 * smoothstep(14.0, 95.0, ax)) + s * amp * 0.8) * edge;
    // lake: almost flat; the kick ripples do the talking
    float lake = s * 0.35 * edge * (0.4 + 0.6 * n);
    // spires: a city of towers, each one a frequency band's level over an 8th note
    float cw = 3.2;
    float cxi = (floor(cx / cw) + 0.5) * cw;
    float rcell = (floor(row / 2.0) + 0.5) * 2.0;
    float lot = hash12(vec2(floor(cx / cw) + seed * 17.0, floor((lb * 4.0) / 2.0)));
    float tower = specAt(rcell, pow(uAcross(abs(cxi)), 0.85)) * (6.0 + 12.0 * smoothstep(10.0, 70.0, ax)) * step(0.3, lot);
    float spires = tower * smoothstep(9.0, 14.0, ax);
    float form = dot(W, vec4(dunes, mountains, lake, spires));
    // dormant ahead, alive behind the now line, and breathing with the sound right around it
    float act = activation(b);
    float breathe = act * exp(-max(uPos - b, 0.0) / 2.5) * nowSpec(u) * amp * 0.6;
    float valley = 14.0 * smoothstep(16.0, 115.0, ax) * (1.0 - 0.7 * W.z);
    return -2.0 + valley + form * mix(0.18, 1.0, act) + breathe;
  }
  float nowGlow(float b) { float d = (b - uPos) * float(RPB) * 1.1; return exp(-d * d); }
`;

// ---- ground ----------------------------------------------------------------------------------
export const groundVertex = /* glsl */ `
  ${valleyShared}
  uniform float uKickAge;
  uniform float uKickStr;
  uniform float uNowZ;
  attribute vec2 gk;        // x: -1..1 across the valley, y: row
  varying float vB;
  varying float vU;
  varying float vS;
  varying float vZ;
  varying float vRing;
  varying vec4 vW;
  varying float vH;
  void main() {
    float row = gk.y;
    float b = uBase + row / float(RPB);
    float x = pathX(b) + gk.x * 120.0;
    float ax = abs(gk.x * 120.0);
    float y = terrain(x, b, row);
    float z = zOf(b);
    // each kick rolls a real wave out across the ground from the now line
    float d = length(vec2(x - pathX(uPos), z - uNowZ));
    float R = uKickAge * 38.0;
    float wave = exp(-pow((d - R) / 5.0, 2.0)) * pow(max(0.0, 1.0 - uKickAge / 1.4), 2.0) * uKickStr;
    y += wave * (1.4 + 1.6 * sectW(row).z) * smoothstep(2.0, 10.0, ax);
    vB = b; vU = uAcross(ax); vS = specAt(row, pow(vU, 0.85)); vZ = -z; vRing = wave; vW = sectW(row); vH = y;
    gl_Position = projectionMatrix * viewMatrix * vec4(x, y, z, 1.0);
  }
`;

export const groundFragment = /* glsl */ `
  ${valleyShared}
  uniform vec3 uBassCol;
  uniform vec3 uPadsCol;
  uniform vec3 uHatsCol;
  uniform vec3 uKickCol;
  uniform vec3 uHorizon;
  varying float vB;
  varying float vU;
  varying float vS;
  varying float vZ;
  varying float vRing;
  varying vec4 vW;
  varying float vH;
  void main() {
    // a ridgeline every 16th note, the beats stronger; antialiased, let go where too dense
    float rb = vB * float(RPB);
    float d = abs(fract(rb + 0.5) - 0.5);
    float w = fwidth(rb);
    float beat = step(abs(mod(floor(rb + 0.5), float(RPB))), 0.5);
    float bar = beat * step(abs(mod(floor(vB + 0.5), 4.0)), 0.5);
    float lw = 0.05 + 0.04 * beat;
    float ridge = (1.0 - smoothstep(lw, lw + 1.5 * w, d)) * (1.0 - smoothstep(0.3, 0.55, w));
    // colour across the valley follows the spectrum: bass violet by the path, mids teal, highs gold
    vec3 tint = vU < 0.4 ? mix(uBassCol, uPadsCol, smoothstep(0.1, 0.4, vU)) : mix(uPadsCol, uHatsCol, smoothstep(0.45, 0.85, vU));
    // each landscape has its own light: dunes violet-rose, mountains ice, lake deep blue, spires gold
    vec3 biomeTint = vW.x * vec3(0.75, 0.45, 1.0) + vW.y * vec3(0.75, 1.0, 0.98) + vW.z * vec3(0.3, 0.55, 1.0) + vW.w * vec3(1.0, 0.72, 0.3);
    tint = mix(tint, biomeTint, 0.45);
    // ahead: a dim preview sketch; behind the now line: alive, fading slowly back toward you
    float act = activation(vB);
    float past = mix(0.32, 0.55 + 0.6 * exp(-max(uPos - vB, 0.0) / 10.0), act);
    float energy = 0.08 + 1.25 * vS * vS;
    // landscapes: a lake is calm and mirror-like, mountains catch light on their crests,
    // spires glow along their terraces
    float lineK = 1.0 - 0.55 * vW.z;
    vec3 col = vec3(0.010, 0.008, 0.026) + tint * 0.05 * vS + vec3(0.02, 0.05, 0.09) * vW.z * (0.6 + 0.4 * sin(vB * 2.0 + uTime));
    col += tint * ridge * energy * (0.55 + 0.45 * beat + 0.4 * bar) * past * lineK;
    col += vec3(0.85, 0.95, 1.0) * vW.y * smoothstep(9.0, 26.0, vH) * (0.05 + 0.35 * ridge) * past;
    col += uHatsCol * vW.w * smoothstep(0.85, 1.0, fract(vH / 1.4)) * 0.25 * past;
    // the now line: what is sounding at this exact moment lights up as it crosses
    col += mix(tint, vec3(1.0), 0.35) * nowGlow(vB) * (0.2 + 1.7 * nowSpec(vU)) * (0.4 + ridge);
    col += uKickCol * vRing * (0.1 + 0.6 * ridge) * (1.0 + 1.5 * vW.z);
    // where one landscape gives way to the next, the ground glows softly across the valley
    float mixing = 1.0 - max(max(vW.x, vW.y), max(vW.z, vW.w));
    col += biomeTint * ridge * mixing * 1.2;
    float fog = 1.0 - exp(-max(vZ, 0.0) / 115.0);
    col = mix(col, uHorizon, fog);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- sky -------------------------------------------------------------------------------------
export const skyVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.9999, 1.0); }
`;
export const skyFragment = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uTop;
  uniform float uGlow;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float y = vUv.y;
    vec3 col = mix(uHorizon * (1.0 + uGlow), uTop, smoothstep(0.38, 0.95, y));
    vec2 g = floor(gl_FragCoord.xy / 3.0);
    col += vec3(0.75, 0.8, 1.0) * step(0.9975, h(g)) * (0.25 + 0.5 * h(g + 7.0)) * smoothstep(0.45, 0.8, y);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- aurora curtains (pads) ------------------------------------------------------------------
export const auroraVertex = /* glsl */ `
  ${valleyShared}
  uniform float uCb;       // the curtain's beat
  uniform float uSeed;
  attribute vec2 ak;       // x: -1..1 across, y: 0 bottom .. 1 top
  varying vec2 vA;
  varying float vPads;
  varying float vHue;
  varying float vZ;
  void main() {
    float row = (uCb - uBase) * float(RPB);
    vec4 B = famB(row);
    float pads = row < 0.0 || row > float(NROWS) - 1.0 ? 0.0 : B.x;
    float x = pathX(uCb) + ak.x * 140.0;
    float top = 14.0 + 14.0 * pads + 26.0 * pads * pads;   // louder pads take more of the sky
    float y = 16.0 + ak.y * top;
    float z = zOf(uCb) + 9.0 * sin(ak.x * 3.1 + uSeed * 6.0 + uTime * 0.12) + 5.0 * sin(ak.x * 7.1 + uSeed);
    vA = ak; vPads = pads; vHue = B.w; vZ = -z;
    gl_Position = projectionMatrix * viewMatrix * vec4(x, y, z, 1.0);
  }
`;
export const auroraFragment = /* glsl */ `
  ${valleyShared}
  uniform vec3 uPadsCol;
  uniform float uSeed;
  varying vec2 vA;
  varying float vPads;
  varying float vHue;
  varying float vZ;
  vec3 hue2rgb(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
  void main() {
    float x = vA.x * 140.0;
    float rays = vnoise(vec2(x * 0.11 + uTime * 0.06 + uSeed * 9.0, uSeed)) * 0.65 + vnoise(vec2(x * 0.31 - uTime * 0.04, uSeed * 3.0)) * 0.35;
    rays = pow(rays, 2.2);
    float v = vA.y;
    float shape = smoothstep(0.0, 0.08, v) * pow(1.0 - v, 1.6) * (0.35 + 0.65 * exp(-v * 3.0));
    float edge = smoothstep(1.0, 0.75, abs(vA.x));
    float near = smoothstep(5.0, 20.0, vZ);
    float fog = exp(-max(vZ, 0.0) / 120.0);
    vec3 c = mix(uPadsCol, hue2rgb(vHue) * 0.85, 0.3);
    gl_FragColor = vec4(c * vPads * shape * edge * near * fog * (0.25 + 1.3 * rays) * 0.5, 1.0);
  }
`;

// ---- melody path (lead) ----------------------------------------------------------------------
export const pathVertex = /* glsl */ `
  ${valleyShared}
  attribute vec2 pk;       // x: -1/+1 side of the ribbon, y: row
  varying float vSide;
  varying float vLead;
  varying float vB;
  varying float vZ;
  // the melody lies along the ground, rising only a little with pitch (tall jumps read as clutter)
  float melodyY(float m) { return -1.7 + 1.2 * clamp((m - 0.12) / 0.45, 0.0, 1.0); }
  void main() {
    float row = pk.y;
    float b = uBase + row / float(RPB);
    float lead = famB(row).y;
    // the path is the melody's contour, smoothed over a beat (the orb carries every note)
    float m = (famB(row - 4.0).z + famB(row - 2.0).z + 2.0 * famB(row).z + famB(row + 2.0).z + famB(row + 4.0).z) / 6.0;
    float y = melodyY(m) + 0.15;
    float w = 0.04 + 0.3 * lead;
    float z = zOf(b);
    vSide = pk.x; vLead = lead; vB = b; vZ = -z;
    gl_Position = projectionMatrix * viewMatrix * vec4(pathX(b) + pk.x * w, y, z, 1.0);
  }
`;
export const pathFragment = /* glsl */ `
  ${valleyShared}
  uniform vec3 uLeadCol;
  varying float vSide;
  varying float vLead;
  varying float vB;
  varying float vZ;
  void main() {
    float core = exp(-vSide * vSide * 5.0);
    float near = smoothstep(1.0, 5.0, vZ);
    float fog = exp(-max(vZ, 0.0) / 130.0);
    float past = vB < uPos ? 0.35 : 0.8;
    float a = (0.02 + 0.6 * vLead) * core * near * fog * past + nowGlow(vB) * vLead * 0.8;
    gl_FragColor = vec4(uLeadCol * a, 1.0);
  }
`;

// ---- light monoliths (hits) ------------------------------------------------------------------
// one instance per hit at its EXACT beat position (not the 16th-note row), so it flares on time
export const monoVertex = /* glsl */ `
  ${valleyShared}
  attribute vec3 inst;     // x: exact beat, y: side (-1 / +1), z: strength (0 = unused slot)
  varying float vY;
  varying float vHits;
  varying float vB;
  varying float vZ;
  void main() {
    float b = inst.x;
    float row = (b - uBase) * float(RPB);
    float st = inst.z;
    float flash = nowGlow(b);
    float h = (1.0 + 6.0 * pow(st, 2.0)) * step(0.01, st) * (1.0 + 0.2 * flash);
    float R = floor(b * float(RPB) + 0.5);
    float x = pathX(b) + inst.y * (24.0 + 14.0 * hash12(vec2(R, inst.y)));
    float ground = terrain(x, b, row);
    vec3 p = position;                                 // unit box, y 0..1
    vY = p.y; vHits = st; vB = b;
    float z = zOf(b) + p.z * 0.42;
    vZ = -z;
    gl_Position = projectionMatrix * viewMatrix * vec4(x + p.x * 0.42, ground + p.y * h, z, 1.0);
  }
`;
export const monoFragment = /* glsl */ `
  ${valleyShared}
  uniform vec3 uHitsCol;
  varying float vY;
  varying float vHits;
  varying float vB;
  varying float vZ;
  void main() {
    if (vHits < 0.01) discard;
    float fog = exp(-max(vZ, 0.0) / 120.0);
    float near = smoothstep(1.0, 6.0, vZ);
    float past = vB < uPos ? 0.35 : 0.6;
    float g = 0.1 + 0.9 * pow(1.0 - vY, 2.0) + 0.6 * smoothstep(0.96, 1.0, vY);
    float k = 0.5 * past + 1.2 * nowGlow(vB);          // a hit flares exactly as it sounds
    gl_FragColor = vec4(uHitsCol * g * vHits * fog * near * k, 1.0);
  }
`;

// ---- dust and glints (hats) ------------------------------------------------------------------
export const dustVertex = /* glsl */ `
  ${valleyShared}
  attribute vec2 dk;       // x: row, y: slot within the row
  varying float vBr;
  varying float vZ;
  void main() {
    float row = dk.x;
    float R = floor(uBase * float(RPB) + row + 0.5);
    float b = uBase + row / float(RPB);
    float hats = famA(row).z;
    float r1 = hash12(vec2(R, dk.y)), r2 = hash12(vec2(dk.y, R + 3.1)), r3 = hash12(vec2(R * 0.7, dk.y + 9.0));
    float x = pathX(b) + (r1 * 2.0 - 1.0) * 46.0;
    float y = 0.8 + r2 * r2 * 22.0;
    float lit = step(r3, hats * 0.9) * hats;          // louder hats light more of the air
    float past = b < uPos ? 0.4 : 0.75;
    vBr = 0.03 + lit * (past + 2.0 * nowGlow(b)) * (0.7 + 0.3 * sin(uTime * 7.0 + r1 * 40.0));
    float z = zOf(b);
    vZ = -z;
    vec4 mv = viewMatrix * vec4(x, y, z, 1.0);
    gl_PointSize = clamp((1.2 + 2.4 * lit) * (55.0 / -mv.z), 0.0, 4.5);
    gl_Position = projectionMatrix * mv;
  }
`;
export const dustFragment = /* glsl */ `
  uniform vec3 uHatsCol;
  varying float vBr;
  varying float vZ;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float k = exp(-dot(c, c) * 16.0);
    float near = smoothstep(1.0, 4.0, vZ);
    float fog = exp(-max(vZ, 0.0) / 90.0);
    gl_FragColor = vec4(uHatsCol * k * vBr * near * fog, 1.0);
  }
`;
