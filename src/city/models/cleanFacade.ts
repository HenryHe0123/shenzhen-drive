import * as THREE from 'three';
import { CONFIG } from '../../config';
import { STYLE, createFacadeMaterial } from '../buildings/facadeMaterial';

export type FacadeStyle = (typeof STYLE)[keyof typeof STYLE];

/** Style of a facade triangle from its height range (model space) and its face's average color (linear). */
export type FaceStyler = (yMin: number, yMax: number, faceColor: THREE.Color) => FacadeStyle;

/** How far the GLB swatch hue pulls the style palette (0 = untinted). */
const TINT_STRENGTH = 0.6;

/**
 * The procedural facade material (src/city/buildings/facadeMaterial.ts) with a
 * per-vertex hue tint, attribute aTint (linear RGB, 1 = untinted), applied to
 * its diffuse and specular colors: the clean GLBs' swatch colors pull the
 * style palette toward the real building's glass or cladding.
 */
export function createTintedFacadeMaterial(opts: { fogScale?: number; farTone?: boolean } = {}): THREE.MeshStandardMaterial {
  const mat = createFacadeMaterial(opts);
  const base = mat.onBeforeCompile.bind(mat);
  const F = CONFIG.cityModels.farTone;
  // Skyline towers kilometres away: their glass mirrors the bright horizon haze and the sunlit
  // steel matches it, so in fog they fade to an outline. Far off, the facade darkens toward the
  // tone of a tower seen against the haze (less mirror, darker cladding); fog still applies on top.
  const far = opts.farTone
    ? `
float fFar = smoothstep(${F.near.toFixed(1)}, ${F.far.toFixed(1)}, length(vViewPosition));
fSpec *= 1.0 - ${F.spec.toFixed(3)} * fFar;
fDiff *= 1.0 - ${F.diffuse.toFixed(3)} * fFar;`
    : '';
  const L = CONFIG.cityModels.civicLobby;
  // Civic Center glass halls (style 8) at street level: seen level, the vision glass mirrors the
  // dark skyline ring of the environment map and reads as black slabs between the wide mullions.
  // Adds finer mullions and transoms, a lighter coated-glass reflectance and a daylit lobby glow.
  const civic = `
if (int(vFac.y + 0.5) == ${STYLE.civic} && vLY < ${L.height.toFixed(1)}) {
  float cGlass = 1.0 - smoothstep(0.02, 0.08, dot(fDiff, vec3(0.3333)));
  float cBay = ${L.bay.toFixed(2)};
  float cM = fLine(vEdge.x, floor(vEdge.x / cBay + 0.5) * cBay, 0.04);
  cM = max(cM, max(fLine(vLY, ${L.transom.toFixed(2)}, 0.06), fLine(vLY, ${L.transom2.toFixed(2)}, 0.05)));
  cM *= cGlass;
  float cDay = 1.0 - smoothstep(0.0, 0.6, uNight);
  float cPane = fh13(vec3(floor(vEdge.x / cBay), floor(vLY / ${L.transom.toFixed(2)}), vFac.x * 31.0));
  vec3 cIn = vec3(${L.interior.map((v) => v.toFixed(3)).join(', ')}) * (0.4 + 0.6 * smoothstep(0.0, ${L.transom.toFixed(2)}, mod(vLY, ${L.transom.toFixed(2)})));
  cIn *= 0.45 + 1.1 * cPane * cPane;
  fEmis += cIn * cDay * cGlass * (1.0 - cM);
  fSpec = mix(fSpec, max(fSpec, vec3(${L.reflectance.toFixed(3)})), cGlass);
  fDiff = mix(fDiff, vec3(0.42, 0.43, 0.44), cM);
  fSpec = mix(fSpec, vec3(0.08), cM);
}`;
  mat.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aTint;\nvarying vec3 vTint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTint = aTint;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
      .replace('sdFacade(normal, fDiff, fSpec, fRough, fEmis);', `sdFacade(normal, fDiff, fSpec, fRough, fEmis);\nfDiff *= vTint;\nfSpec *= vTint;${civic}${far}`);
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => key() + '-tint-v2' + (opts.farTone ? '-far' : '');
  mat.name += 'Tinted';
  return mat;
}

const WHITE = new THREE.Color(1, 1, 1);

/** Hue-only tint from a surface color: luminance normalized, partly desaturated, clamped. */
function tintOf(color: THREE.Color, out: THREE.Color): THREE.Color {
  const l = Math.max(0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b, 0.02);
  out.setRGB(color.r / l, color.g / l, color.b / l).lerp(WHITE, 1 - TINT_STRENGTH);
  out.r = THREE.MathUtils.clamp(out.r, 0.55, 1.6);
  out.g = THREE.MathUtils.clamp(out.g, 0.55, 1.6);
  out.b = THREE.MathUtils.clamp(out.b, 0.55, 1.6);
  return out;
}

/** Facade faces: triangles with |normal.y| below this. */
export const VERTICAL = 0.45;
const ANGLE_BIN = THREE.MathUtils.degToRad(1);
const PLANE_BIN = 0.6;

interface Face {
  tx: number;
  tz: number;
  uMin: number;
  uMax: number;
  yMin: number;
  yMax: number;
  /** Area-weighted color sum (linear), then the average. */
  r: number;
  g: number;
  b: number;
  area: number;
  color: THREE.Color;
}

/**
 * Non-indexed geometry carrying the attributes of the procedural facade shader
 * (createFacadeMaterial in src/city/buildings/facadeMaterial.ts):
 *   aEdge = (meters along the facade face, face length)
 *   aFac  = (building seed, style id, podium height, face top y)
 * A "face" is the set of coplanar vertical triangles (normal direction and
 * plane offset binned, neighbouring bins merged), so bays and floors stay
 * aligned across the triangles of one wall. Styles come from `styler` per
 * triangle (default: from the face's area-weighted color; triColor is linear
 * RGB per triangle, e.g. sampled from the GLB atlas); with `tint` the face
 * color's hue also goes to aTint (createTintedFacadeMaterial). Upward and
 * downward faces become flat roof. pos / idx are in model space (y = 0 at
 * ground level).
 */
export function buildFacadeGeometry(
  pos: Float32Array,
  idx: Uint32Array,
  triColor: Float32Array,
  styler: FaceStyler = (_y0, _y1, color) => styleForColor(color),
  tint: boolean,
  seed: number,
  podium: number,
): THREE.BufferGeometry {
  const nTri = idx.length / 3;
  const faces = new Map<number, Face>();
  const list: Face[] = [];
  const triFace: (Face | null)[] = new Array(nTri).fill(null);
  const n = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normals = new Float32Array(nTri * 3);
  const keyOf = (ab: number, db: number) => ab * 1e7 + db;

  for (let t = 0; t < nTri; t++) {
    a.fromArray(pos, idx[t * 3] * 3);
    b.fromArray(pos, idx[t * 3 + 1] * 3);
    c.fromArray(pos, idx[t * 3 + 2] * 3);
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    const len = n.length();
    if (!(len > 1e-9)) {
      // Slivers can still cover a pixel center: a zero normal would shade NaN (and bloom spreads NaN).
      normals[t * 3 + 1] = 1;
      continue;
    }
    n.multiplyScalar(1 / len);
    normals[t * 3] = n.x;
    normals[t * 3 + 1] = n.y;
    normals[t * 3 + 2] = n.z;
    if (Math.abs(n.y) >= VERTICAL) continue;
    const h = Math.hypot(n.x, n.z);
    const nx = n.x / h;
    const nz = n.z / h;
    const ab = Math.round(Math.atan2(nz, nx) / ANGLE_BIN);
    const db = Math.round((nx * a.x + nz * a.z) / PLANE_BIN);
    let face: Face | undefined;
    for (let da = -1; da <= 1 && !face; da++)
      for (let dd = -1; dd <= 1 && !face; dd++) face = faces.get(keyOf(ab + da, db + dd));
    if (!face) {
      face = { tx: -nz, tz: nx, uMin: Infinity, uMax: -Infinity, yMin: Infinity, yMax: -Infinity, r: 0, g: 0, b: 0, area: 0, color: new THREE.Color() };
      faces.set(keyOf(ab, db), face);
      list.push(face);
    }
    for (const p of [a, b, c]) {
      const u = p.x * face.tx + p.z * face.tz;
      face.uMin = Math.min(face.uMin, u);
      face.uMax = Math.max(face.uMax, u);
      face.yMin = Math.min(face.yMin, p.y);
      face.yMax = Math.max(face.yMax, p.y);
    }
    const area = len / 2;
    face.r += triColor[t * 3] * area;
    face.g += triColor[t * 3 + 1] * area;
    face.b += triColor[t * 3 + 2] * area;
    face.area += area;
    triFace[t] = face;
  }
  for (const f of list) f.color.setRGB(f.r / f.area, f.g / f.area, f.b / f.area);

  const position = new Float32Array(nTri * 9);
  const normal = new Float32Array(nTri * 9);
  const aEdge = new Float32Array(nTri * 6);
  const aFac = new Float32Array(nTri * 12);
  const aTint = new Float32Array(nTri * 9).fill(1);
  const tc = new THREE.Color();
  for (let t = 0; t < nTri; t++) {
    const face = triFace[t];
    let style: number = STYLE.roof;
    if (face) {
      const y0 = pos[idx[t * 3] * 3 + 1];
      const y1 = pos[idx[t * 3 + 1] * 3 + 1];
      const y2 = pos[idx[t * 3 + 2] * 3 + 1];
      style = styler(Math.min(y0, y1, y2), Math.max(y0, y1, y2), face.color);
      if (tint) {
        tintOf(face.color, tc);
        for (let k = 0; k < 3; k++) tc.toArray(aTint, (t * 3 + k) * 3);
      }
    }
    for (let k = 0; k < 3; k++) {
      const vi = idx[t * 3 + k] * 3;
      const o = t * 3 + k;
      const x = pos[vi];
      const y = pos[vi + 1];
      const z = pos[vi + 2];
      position[o * 3] = x;
      position[o * 3 + 1] = y;
      position[o * 3 + 2] = z;
      normal[o * 3] = normals[t * 3];
      normal[o * 3 + 1] = normals[t * 3 + 1];
      normal[o * 3 + 2] = normals[t * 3 + 2];
      aFac[o * 4] = seed;
      if (face) {
        aEdge[o * 2] = x * face.tx + z * face.tz - face.uMin;
        aEdge[o * 2 + 1] = face.uMax - face.uMin;
        aFac[o * 4 + 1] = style;
        aFac[o * 4 + 2] = face.yMin < 1 ? podium : 0;
        aFac[o * 4 + 3] = face.yMax;
      } else {
        aFac[o * 4 + 1] = STYLE.roof;
        aFac[o * 4 + 3] = y;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('aEdge', new THREE.BufferAttribute(aEdge, 2));
  geo.setAttribute('aFac', new THREE.BufferAttribute(aFac, 4));
  geo.setAttribute('aBase', new THREE.BufferAttribute(new Float32Array(nTri * 3), 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(aTint, 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

const hsl = { h: 0, s: 0, l: 0 };

/** Facade style from a surface color (linear): glass tints by hue, light neutrals as stone or silver glass. */
export function styleForColor(color: THREE.Color): FacadeStyle {
  color.getHSL(hsl, THREE.SRGBColorSpace);
  if (hsl.l < 0.22) return hsl.s > 0.12 && (hsl.h < 0.15 || hsl.h > 0.9) ? STYLE.bronzeGlass : STYLE.blueGlass;
  if (hsl.h > 0.42 && hsl.h < 0.78 && hsl.s > 0.1) return hsl.h < 0.53 ? STYLE.tealGlass : hsl.l > 0.66 && hsl.s < 0.25 ? STYLE.silverGlass : STYLE.blueGlass;
  if (hsl.s < 0.12) return hsl.l > 0.7 ? STYLE.stone : STYLE.silverGlass;
  return hsl.h < 0.17 ? STYLE.stone : STYLE.mixed;
}
