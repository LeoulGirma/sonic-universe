/**
 * Liquid Dimension renderer: a full-screen raymarch of the blob field.
 *
 * Surface: smooth union (polynomial smin) of spheres, then displaced by
 *  - band ripples, weighted by which kind of blob is nearest: bass regions undulate slowly and
 *    widely, mid regions ripple, high droplets shimmer finely
 *  - kick impact waves: rings travelling outward across the surface from the mass centre
 * Shading: mirror reflection of a procedural studio (soft boxes, a ring light and a palette
 * gradient), thin-film interference for the oil-slick iridescence, Fresnel rims.
 * Compile-time: MAXB (blob slots), STEPS (march steps).
 */

export const liquidVertex = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const liquidFragment = /* glsl */ `
  precision highp float;
  uniform mat4 uInvViewProj;
  uniform vec3 uCam;
  uniform vec4 uBlobs[MAXB];   // xyz, radius
  uniform float uBand[MAXB];   // 0 bass, 1 mid, 2 high
  uniform int uCount;
  uniform vec4 uWaves[4];      // xyz centre, age (s)
  uniform float uWaveAmp[4];
  uniform vec4 uBound;         // xyz centre, radius of the whole liquid
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uRipple;
  uniform float uIri;
  uniform float uEnergy;
  uniform vec3 uDeep;
  uniform vec3 uTint;
  uniform vec3 uBright;
  uniform vec3 uAccent;
  varying vec2 vNdc;

  float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
  }

  float h31(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }

  // returns distance; band weights (bass, mid, high) in wb
  float field(vec3 p, out vec3 wb) {
    float d = 1e5;
    wb = vec3(1e-4);
    for (int i = 0; i < MAXB; i++) {
      if (i >= uCount) break;
      vec4 b = uBlobs[i];
      float di = length(p - b.xyz) - b.w;
      d = smin(d, di, 2.4);
      float w = exp(-max(di, 0.0) * 0.9);
      int k = int(uBand[i] + 0.5);
      if (k == 0) wb.x += w; else if (k == 1) wb.y += w; else wb.z += w;
    }
    wb /= (wb.x + wb.y + wb.z);
    return d;
  }

  float sdf(vec3 p) {
    vec3 wb;
    float d = field(p, wb);
    if (d > 2.0) return d; // displacement only matters near the surface
    float t = uTime;
    float bassW = sin(0.42 * p.y + t * 1.3) * sin(0.36 * p.x - t * 0.9) * (0.25 + 0.9 * uBass);
    float midW = sin(1.35 * dot(p, vec3(0.6, 0.5, 0.62)) + t * 3.2) * (0.06 + 0.32 * uMid);
    float highW = (vnoise(p * 3.2 + t * 2.5) - 0.5) * (0.03 + 0.22 * uHigh);
    float disp = (wb.x * bassW + wb.y * midW + wb.z * highW) * uRipple;
    for (int i = 0; i < 4; i++) {
      float A = uWaveAmp[i];
      if (A <= 0.0) continue;
      float age = uWaves[i].w;
      float r = length(p - uWaves[i].xyz);
      float R = age * 14.0;
      float x = r - R;
      disp += A * exp(-age * 1.8) * sin(x * 1.1) * exp(-x * x * 0.08) * 0.22;
    }
    return d - disp;
  }

  vec3 calcNormal(vec3 p) {
    const vec2 e = vec2(0.02, -0.02);
    return normalize(e.xyy * sdf(p + e.xyy) + e.yyx * sdf(p + e.yyx) + e.yxy * sdf(p + e.yxy) + e.xxx * sdf(p + e.xxx));
  }

  // procedural studio: neutral grey room, white soft boxes (chrome reads as silver), plus a
  // palette-coloured strip and accent light, and a coloured floor bounce
  vec3 env(vec3 d) {
    float y = d.y;
    vec3 col = vec3(0.015) + vec3(0.16) * smoothstep(-0.2, 0.95, y);
    col += vec3(1.0) * 2.6 * pow(max(dot(d, normalize(vec3(0.55, 0.6, 0.45))), 0.0), 36.0);
    col += vec3(1.0) * 1.3 * smoothstep(0.84, 0.96, d.x) * smoothstep(-0.4, 0.7, y);
    col += uTint * 1.8 * smoothstep(0.8, 0.97, -d.x) * smoothstep(-0.5, 0.5, y);
    col += uAccent * 1.1 * smoothstep(0.85, 0.98, -d.z) * smoothstep(-0.2, 0.6, y);
    col += vec3(0.85) * exp(-pow((y - 0.4) * 9.0, 2.0)) * (0.5 + 0.5 * uEnergy);
    col += uDeep * 0.7 * smoothstep(0.2, -0.8, y);
    return col;
  }

  void main() {
    vec4 a = uInvViewProj * vec4(vNdc, -1.0, 1.0);
    vec4 b = uInvViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 ro = uCam;
    vec3 rd = normalize(b.xyz / b.w - a.xyz / a.w);

    // bounding sphere of the whole liquid: most pixels never march
    vec3 oc = ro - uBound.xyz;
    float bq = dot(oc, rd);
    float cq = dot(oc, oc) - uBound.w * uBound.w;
    float disc = bq * bq - cq;
    vec3 bg = vec3(0.0);
    if (disc < 0.0) { gl_FragColor = vec4(bg, 1.0); return; }
    float sq = sqrt(disc);
    float t = max(-bq - sq, 0.0);
    float tEnd = -bq + sq;
    bool hit = false;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * t;
      float d = sdf(p);
      if (d < 0.004 * t) { hit = true; break; }
      t += d * 0.75;
      if (t > tEnd) break;
    }
    if (!hit) { gl_FragColor = vec4(bg, 1.0); return; }

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 v = -rd;
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    vec3 r = reflect(rd, n);
    float fres = pow(1.0 - ndv, 3.0);

    // thin film: optical thickness varies in patches over the surface and drifts; the viewing
    // angle shifts the interference hue (oil-slick rainbow), strongest at grazing angles
    float thick = 0.3 + 0.7 * vnoise(p * 0.18 + uTime * 0.05) + 0.25 * uMid;
    vec3 film = 0.5 + 0.5 * cos(6.2831853 * (thick * 2.2 + ndv * 1.2 + vec3(0.0, 0.33, 0.67)));
    film = mix(film, film * (0.4 + 1.6 * uTint), 0.3);
    float slick = smoothstep(0.42, 0.78, vnoise(p * 0.27 - uTime * 0.04));
    float filmMix = clamp((0.12 + 0.75 * fres + 0.55 * slick) * uIri, 0.0, 1.0);
    vec3 metal = mix(vec3(0.95, 0.96, 1.0), film * 1.45, filmMix);
    vec3 col = env(r) * metal;
    col += film * fres * (0.25 + 0.6 * uHigh) * uIri;
    col += vec3(1.0) * pow(max(dot(r, normalize(vec3(-0.4, 0.8, 0.3))), 0.0), 140.0) * 3.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;
