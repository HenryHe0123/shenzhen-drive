/**
 * Lit-window grid in GLSL, written to be shared by every facade shader (the
 * real-building photo material now; src/city/buildings/facadeMaterial.ts can
 * switch to it later). Same scale, palette and occupancy model as the
 * procedural facade: floors of floorH, bays of bayW (1x or 2x), bays lit in
 * groups per floor with a per-floor occupancy, warm / neutral / cool tones.
 * Detail fades to its average once a cell gets sub-pixel, so distant towers
 * do not shimmer.
 *
 * Inputs are facade coordinates in meters: u along the face, y above ground.
 * All functions are prefixed `sw` to stay clear of three's and the facade's names.
 */
export const WINDOW_GLSL = /* glsl */ `
float swHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float swHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float swHash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// 1 inside [a, b] of a cell coordinate x in [0,1); fades to the duty cycle once a cell is sub-pixel.
float swPulse(float x, float a, float b, float fw) {
  float w = clamp(fw, 1e-4, 0.5);
  float p = smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
  return mix(p, b - a, smoothstep(0.2, 0.6, fw));
}

struct SwCell {
  float fx;     // position inside the bay 0..1
  float fy;     // position inside the floor 0..1
  float bay;    // bay index along the face
  float fl;     // floor index
  float fwx;    // screen-space width of one bay (cells)
  float fwy;    // screen-space height of one floor (cells)
  float bw;     // effective bay width (m)
  float fh;     // effective floor height (m)
  float win;    // vision-glass coverage 0..1 (mullions and spandrels excluded)
};

// Grid cell of a facade point; floor height and bay width vary a little per building seed.
SwCell swCell(float u, float y, float seed, float floorH, float bayW) {
  SwCell c;
  float r1 = swHash11(seed * 91.7 + 3.1);
  float r2 = swHash11(seed * 37.3 + 7.7);
  c.fh = floorH * (0.95 + 0.22 * r1);
  c.bw = bayW * (1.0 + floor(r2 * 2.0));
  float bx = u / c.bw;
  c.bay = floor(bx);
  c.fx = fract(bx);
  c.fwx = fwidth(bx);
  float fy0 = y / c.fh;
  c.fl = floor(fy0);
  c.fy = fract(fy0);
  c.fwy = fwidth(fy0);
  float mw = 0.065 / c.bw;
  c.win = swPulse(c.fx, mw, 1.0 - mw, c.fwx) * swPulse(c.fy, 0.85 / c.fh, 1.0 - 0.05 / c.fh, c.fwy);
  return c;
}

// Emission (linear HDR, before exposure) of the lit offices behind a cell's glass.
// litRatio: base lit fraction; litK: 0 in daylight ... 1 at night.
vec3 swWindowLight(SwCell c, float seed, float litRatio, float litK) {
  float r1 = swHash11(seed * 91.7 + 3.1);
  float gsize = 2.0 + floor(r1 * 5.0);
  float g = floor(c.bay / gsize);
  float floorOcc = swHash12(vec2(c.fl, seed * 113.0));
  float litBase = litRatio * litK;
  float litP = clamp(litBase * (0.3 + 1.4 * floorOcc), 0.0, 1.0);
  float cell = step(swHash13(vec3(c.fl, g, seed * 71.0)), litP);
  float kC = smoothstep(0.25, 0.7, max(c.fwx / gsize, c.fwy));
  float kFloor = smoothstep(0.25, 0.7, c.fwy);
  float lit = mix(mix(cell, litP, kC), clamp(litBase, 0.0, 1.0), kFloor);
  float tone = swHash13(vec3(g, c.fl, seed * 17.0));
  vec3 litCol = tone < 0.55 ? vec3(1.0, 0.7, 0.4) : tone < 0.85 ? vec3(0.95, 0.9, 0.8) : vec3(0.72, 0.86, 1.0);
  litCol = mix(litCol, vec3(0.95, 0.8, 0.6), kC);
  float bh = swHash13(vec3(c.bay, c.fl, seed * 29.0));
  float bright = mix(0.3 + 1.1 * bh * bh, 0.65, kC);
  float grad = mix(0.65 + 0.5 * c.fy, 0.9, kFloor);
  return litCol * lit * bright * grad * 0.95 * c.win;
}

// Thin grid lines (1 on a line), faded out before they alias: vertical mullions, slab edges, both.
float swMullions(SwCell c) {
  return (1.0 - swPulse(c.fx, 0.05 / c.bw, 1.0 - 0.05 / c.bw, c.fwx)) * (1.0 - smoothstep(0.03, 0.12, c.fwx));
}
float swSlabs(SwCell c) {
  return (1.0 - swPulse(c.fy, 0.14 / c.fh, 1.0, c.fwy)) * (1.0 - smoothstep(0.03, 0.12, c.fwy));
}
float swGridLines(SwCell c) {
  return max(swMullions(c), swSlabs(c));
}
`;
