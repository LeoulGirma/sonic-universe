/**
 * Sound Valley shaders. Everything is anchored to ABSOLUTE beat positions (row r of the window
 * is beat uBase + r / RPB), so when the window advances by a beat nothing jumps or swims.
 * Family levels arrive per row (a 16th note) in uFamTex: (kick, hits, hats, bass), (pads, lead,
 * melody, hue). Compile-time: RPB, NROWS.
 */

export const valleyShared = /* glsl */ `
  uniform sampler2D uFamTex;
  uniform float uPos;      // camera position in beats
  uniform float uBase;     // whole beat of row 0
  uniform float uSpacing;  // scene units per beat
  uniform float uTime;

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
  // bass over about a beat, so the hills swell with the bass line rather than every note
  float bassAt(float row) {
    return (famA(row - 3.0).w + famA(row - 1.5).w + famA(row).w + famA(row + 1.5).w + famA(row + 3.0).w) * 0.2;
  }
  // the valley floor: a flat path in the middle, slopes rising to the sides, and hills the bass
  // raises (mostly on the slopes, so the path stays open)
  float terrain(float x, float b, float bass) {
    float ax = abs(x);
    float valley = 15.0 * smoothstep(10.0, 105.0, ax);
    float n = vnoise(vec2(x * 0.05, b * 0.3)) * 0.7 + vnoise(vec2(x * 0.13, b * 0.8)) * 0.3;
    float hills = bass * (0.5 + 13.0 * smoothstep(6.0, 85.0, ax)) * (0.3 + 0.95 * n);
    return -2.0 + valley + hills;
  }
`;

// ---- ground (bass + kick) ------------------------------------------------------------------
export const groundVertex = /* glsl */ `
  ${valleyShared}
  attribute vec2 gk;        // x: -1..1 across the valley, y: row
  varying float vB;
  varying float vX;
  varying float vRel;
  varying float vBass;
  varying float vH;
  void main() {
    float row = gk.y;
    float b = uBase + row / float(RPB);
    float rel = b - uPos;
    float x = gk.x * 115.0;
    float bass = bassAt(row);
    float y = terrain(x, b, bass);
    vB = b; vX = x; vRel = rel; vBass = bass; vH = y;
    gl_Position = projectionMatrix * viewMatrix * vec4(x, y, -rel * uSpacing, 1.0);
  }
`;

export const groundFragment = /* glsl */ `
  ${valleyShared}
  uniform vec3 uBassCol;
  uniform vec3 uKickCol;
  uniform vec3 uHorizon;
  uniform float uKickAge;
  uniform float uKickStr;
  varying float vB;
  varying float vX;
  varying float vRel;
  varying float vBass;
  varying float vH;
  void main() {
    float dist = length(vec2(vX, vRel * uSpacing));
    // ridgelines across the valley, one per beat, every fourth (a bar) brighter; antialiased
    float d = abs(fract(vB + 0.5) - 0.5);
    float w = fwidth(vB);
    float bar = step(abs(mod(floor(vB + 0.5), 4.0)), 0.5);
    float lineW = 0.018 + 0.012 * bar;
    float ridge = 1.0 - smoothstep(lineW, lineW + 1.5 * w, d);
    ridge *= 1.0 - smoothstep(0.25, 0.5, w);   // too dense to resolve far away: let them go
    // soft shading by height so the hills read as shapes
    vec3 col = vec3(0.012, 0.010, 0.030) + uBassCol * (0.02 + 0.05 * clamp(vH / 14.0, 0.0, 1.0)) * (0.5 + vBass);
    col += uBassCol * ridge * (0.16 + 0.75 * vBass) * (1.0 + 0.6 * bar);
    // kick: a soft ring spreading across the ground from where you are
    float ringR = uKickAge * 42.0;
    float ring = exp(-pow((dist - ringR) / 3.0, 2.0)) * pow(max(0.0, 1.0 - uKickAge / 1.3), 2.0) * uKickStr;
    col += uKickCol * ring * (0.08 + 0.5 * ridge);
    // fog toward the horizon
    float fog = 1.0 - exp(-max(vRel, 0.0) * uSpacing / 110.0);
    col = mix(col, uHorizon, fog);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- sky -----------------------------------------------------------------------------------
export const skyVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.9999, 1.0); }
`;
export const skyFragment = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uTop;
  uniform float uGlow;
  uniform vec2 uRes;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float y = vUv.y;
    vec3 col = mix(uHorizon * (1.0 + uGlow), uTop, smoothstep(0.38, 0.95, y));
    // a sparse, still starfield
    vec2 g = floor(gl_FragCoord.xy / 3.0);
    float s = h(g);
    col += vec3(0.75, 0.8, 1.0) * step(0.9975, s) * (0.25 + 0.5 * h(g + 7.0)) * smoothstep(0.45, 0.8, y);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- aurora curtains (pads) ----------------------------------------------------------------
export const auroraVertex = /* glsl */ `
  ${valleyShared}
  uniform float uCb;       // the curtain's beat
  uniform float uSeed;
  attribute vec2 ak;       // x: -1..1 across, y: 0 bottom .. 1 top
  varying vec2 vA;
  varying float vPads;
  varying float vHue;
  varying float vRel;
  void main() {
    float row = (uCb - uBase) * float(RPB);
    vec4 B = famB(row);
    float pads = row < 0.0 || row > float(NROWS) - 1.0 ? 0.0 : B.x;
    float x = ak.x * 140.0;
    // louder pads hang taller curtains: they take more of the sky
    float top = 14.0 + 14.0 * pads + 26.0 * pads * pads;
    float y = 16.0 + ak.y * top;
    float rel = uCb - uPos;
    float z = -rel * uSpacing + 9.0 * sin(x * 0.022 + uSeed * 6.0 + uTime * 0.12) + 5.0 * sin(x * 0.051 + uSeed);
    vA = ak; vPads = pads; vHue = B.w; vRel = rel;
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
  varying float vRel;
  vec3 hue2rgb(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
  void main() {
    float x = vA.x * 140.0;
    // vertical rays drifting slowly sideways
    float rays = vnoise(vec2(x * 0.11 + uTime * 0.06 + uSeed * 9.0, uSeed)) * 0.65 + vnoise(vec2(x * 0.31 - uTime * 0.04, uSeed * 3.0)) * 0.35;
    rays = pow(rays, 2.2);
    float v = vA.y;
    float shape = smoothstep(0.0, 0.08, v) * pow(1.0 - v, 1.6) * (0.35 + 0.65 * exp(-v * 3.0));
    float edge = smoothstep(1.0, 0.75, abs(vA.x));
    float near = smoothstep(2.0, 8.0, vRel);               // fade as you pass beneath
    float fog = exp(-max(vRel, 0.0) * uSpacing / 120.0);
    vec3 c = mix(uPadsCol, hue2rgb(vHue) * 0.85, 0.3);
    float a = vPads * shape * edge * near * fog * (0.25 + 1.3 * rays);
    gl_FragColor = vec4(c * a * 0.55, 1.0);
  }
`;

// ---- melody path (lead) --------------------------------------------------------------------
export const pathVertex = /* glsl */ `
  ${valleyShared}
  attribute vec2 pk;       // x: -1/+1 side of the ribbon, y: row
  varying float vSide;
  varying float vLead;
  varying float vRel;
  // the path stays below eye level (you look down on the tune), smoothed over a few rows
  float melodyY(float m) { return 0.6 + 5.2 * clamp((m - 0.12) / 0.45, 0.0, 1.0); }
  void main() {
    float row = pk.y;
    float b = uBase + row / float(RPB);
    float rel = b - uPos;
    vec4 B = famB(row);
    float lead = (famB(row - 2.0).y + B.y + famB(row + 2.0).y) / 3.0;
    float m = (famB(row - 3.0).z + famB(row - 1.5).z + B.z + famB(row + 1.5).z + famB(row + 3.0).z) * 0.2;
    float y = melodyY(m);
    float x = 3.0 * sin(b * 0.11);
    float w = 0.12 + 1.5 * lead;
    vSide = pk.x; vLead = lead; vRel = rel;
    gl_Position = projectionMatrix * viewMatrix * vec4(x + pk.x * w, y, -rel * uSpacing, 1.0);
  }
`;
export const pathFragment = /* glsl */ `
  uniform vec3 uLeadCol;
  uniform float uSpacing;
  varying float vSide;
  varying float vLead;
  varying float vRel;
  void main() {
    float core = exp(-vSide * vSide * 6.0);
    float near = smoothstep(0.5, 5.0, vRel);
    float fog = exp(-max(vRel, 0.0) * uSpacing / 140.0);
    float a = (0.03 + 0.9 * vLead) * core * near * fog;
    gl_FragColor = vec4(uLeadCol * a, 1.0);
  }
`;

// ---- light monoliths (hits) ----------------------------------------------------------------
export const monoVertex = /* glsl */ `
  ${valleyShared}
  attribute vec2 inst;     // x: row, y: side (-1 / +1)
  varying float vY;
  varying float vHits;
  varying float vRel;
  void main() {
    float row = inst.x;
    float b = uBase + row / float(RPB);
    float R = floor(uBase * float(RPB) + row + 0.5);   // absolute row: stable placement
    float rel = b - uPos;
    float hits = famA(row).y;
    // a monolith marks a hit's ONSET (a clear rise over the previous 16th), on one side only
    float rise = hits - max(famA(row - 1.0).y, famA(row - 2.0).y);
    float side = hash12(vec2(R, 1.7)) < 0.5 ? -1.0 : 1.0;
    float on = smoothstep(0.32, 0.5, hits) * smoothstep(0.12, 0.25, rise) * step(0.0, side * inst.y);
    float h = (1.5 + 11.0 * pow(hits, 1.5)) * on;
    float x = inst.y * (16.0 + 10.0 * hash12(vec2(R, inst.y)));
    float ground = terrain(x, b, bassAt(row));
    vec3 p = position;                                 // unit box, y 0..1
    vY = p.y; vHits = hits * on; vRel = rel;
    vec3 wp = vec3(x + p.x * 0.42, ground + p.y * h, -rel * uSpacing + p.z * 0.42);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;
export const monoFragment = /* glsl */ `
  uniform vec3 uHitsCol;
  uniform float uSpacing;
  varying float vY;
  varying float vHits;
  varying float vRel;
  void main() {
    if (vHits < 0.01) discard;
    float fog = exp(-max(vRel, 0.0) * uSpacing / 120.0);
    float near = smoothstep(0.0, 3.0, vRel);
    float g = 0.1 + 0.9 * pow(1.0 - vY, 2.0) + 0.6 * smoothstep(0.96, 1.0, vY);
    gl_FragColor = vec4(uHitsCol * g * vHits * fog * near * 0.75, 1.0);
  }
`;

// ---- dust and glints (hats) ----------------------------------------------------------------
export const dustVertex = /* glsl */ `
  ${valleyShared}
  attribute vec2 dk;       // x: row, y: slot within the row
  varying float vB;
  varying float vRel;
  void main() {
    float row = dk.x;
    float R = floor(uBase * float(RPB) + row + 0.5);
    float b = uBase + row / float(RPB);
    float rel = b - uPos;
    float hats = famA(row).z;
    float r1 = hash12(vec2(R, dk.y)), r2 = hash12(vec2(dk.y, R + 3.1)), r3 = hash12(vec2(R * 0.7, dk.y + 9.0));
    float x = (r1 * 2.0 - 1.0) * 46.0;
    float y = 0.8 + r2 * r2 * 22.0;
    // each glint is lit when the hats are loud enough for it: louder hats light more of the air
    float lit = step(r3, hats * 0.9) * hats;
    vB = 0.03 + 1.4 * lit * (0.6 + 0.4 * sin(uTime * 7.0 + r1 * 40.0));
    vRel = rel;
    vec4 mv = viewMatrix * vec4(x, y, -rel * uSpacing, 1.0);
    gl_PointSize = clamp((1.2 + 2.4 * lit) * (55.0 / -mv.z), 0.0, 4.5);
    gl_Position = projectionMatrix * mv;
  }
`;
export const dustFragment = /* glsl */ `
  uniform vec3 uHatsCol;
  uniform float uSpacing;
  varying float vB;
  varying float vRel;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float k = exp(-dot(c, c) * 16.0);
    float near = smoothstep(-0.3, 1.0, vRel);
    float fog = exp(-max(vRel, 0.0) * uSpacing / 90.0);
    gl_FragColor = vec4(uHatsCol * k * vB * near * fog, 1.0);
  }
`;
