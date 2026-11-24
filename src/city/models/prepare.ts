import * as THREE from 'three';
import { buildAtlas, drawableImage } from './atlas';
import { VERTICAL, buildFacadeGeometry, type FaceStyler } from './cleanFacade';
import { createPhotoFacadeMaterial } from './photoMaterial';

/** One GLB primitive baked into model space (y = 0 at ground level). */
interface Part {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array | null;
  idx: Uint32Array;
  mat: THREE.Material;
}

interface MatGroup {
  mat: THREE.Material;
  parts: Part[];
  map: THREE.Texture | null;
  color: THREE.Color;
  area: number;
  tris: number;
}

/** Whole-model triangle soup kept for accent placement (model space). */
export interface ModelGeometry {
  pos: Float32Array;
  idx: Uint32Array;
}

export interface PreparedModel {
  object: THREE.Group;
  meshes: THREE.Mesh[];
  /** Geometries, materials and textures owned by this model. */
  disposables: { dispose(): void }[];
  bounds: THREE.Box3;
  tris: number;
  drawCalls: number;
  atlas: [number, number] | null;
  geometry: ModelGeometry;
}

export interface PrepareOptions {
  photo: boolean;
  /** Max meshes (draw calls) for this model. */
  maxDrawCalls: number;
  atlasMax: number;
  atlasTile: number;
  seed: number;
  fogScale?: number;
  anisotropy: number;
  /** Clean-geometry path: shared procedural facade material and an optional per-face style rule. */
  facadeMaterial: () => THREE.Material;
  styler?: FaceStyler;
  podium: number;
}

type AnyAttr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

function readAttr(attr: AnyAttr, size: number): Float32Array {
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) {
    out[i * size] = attr.getX(i);
    if (size > 1) out[i * size + 1] = attr.getY(i);
    if (size > 2) out[i * size + 2] = attr.getZ(i);
  }
  return out;
}

function collectParts(root: THREE.Object3D): Part[] {
  const parts: Part[] = [];
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const g = mesh.geometry;
    const pa = g.getAttribute('position') as AnyAttr | undefined;
    if (!pa || pa.count < 3) return;
    const pos = readAttr(pa, 3);
    const m = mesh.matrixWorld;
    for (let i = 0; i < pos.length; i += 3) {
      v.fromArray(pos, i).applyMatrix4(m);
      v.toArray(pos, i);
    }
    const idx = g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : Uint32Array.from({ length: pa.count }, (_, i) => i);
    if (m.determinant() < 0) {
      for (let t = 0; t < idx.length; t += 3) {
        const s = idx[t + 1];
        idx[t + 1] = idx[t + 2];
        idx[t + 2] = s;
      }
    }
    let nor: Float32Array;
    const na = g.getAttribute('normal') as AnyAttr | undefined;
    if (na) {
      nor = readAttr(na, 3);
      nm.getNormalMatrix(m);
      for (let i = 0; i < nor.length; i += 3) {
        v.fromArray(nor, i).applyMatrix3(nm);
        const l = v.length();
        // Zero / NaN normals (common in SketchUp exports) would shade NaN, which bloom spreads into black blocks.
        if (l > 1e-8) v.multiplyScalar(1 / l);
        else v.set(0, 1, 0);
        v.toArray(nor, i);
      }
    } else {
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      tmp.setIndex(new THREE.BufferAttribute(idx, 1));
      tmp.computeVertexNormals();
      nor = tmp.getAttribute('normal').array as Float32Array;
    }
    const ua = g.getAttribute('uv') as AnyAttr | undefined;
    parts.push({ pos, nor, uv: ua ? readAttr(ua, 2) : null, idx, mat: mesh.material });
  });
  return parts;
}

function triArea(pos: Float32Array, idx: Uint32Array): number {
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return area;
}

function groupParts(parts: Part[]): MatGroup[] {
  const byMat = new Map<THREE.Material, MatGroup>();
  for (const p of parts) {
    let g = byMat.get(p.mat);
    if (!g) {
      const std = p.mat as THREE.MeshStandardMaterial;
      g = {
        mat: p.mat,
        parts: [],
        map: std.map ?? null,
        color: std.color ? std.color.clone() : new THREE.Color(1, 1, 1),
        area: 0,
        tris: 0,
      };
      byMat.set(p.mat, g);
    }
    g.parts.push(p);
    g.area += triArea(p.pos, p.idx);
    g.tris += p.idx.length / 3;
  }
  return [...byMat.values()].sort((a, b) => b.area - a.area);
}

/** The group restricted to its facade triangles (|normal.y| < VERTICAL; slivers count as walls) or to the rest. */
function filterTris(g: MatGroup, walls: boolean): MatGroup {
  let area = 0;
  let tris = 0;
  const parts: Part[] = [];
  for (const p of g.parts) {
    const { pos } = p;
    const keep: number[] = [];
    for (let t = 0; t < p.idx.length; t += 3) {
      const a = p.idx[t] * 3;
      const b = p.idx[t + 1] * 3;
      const c = p.idx[t + 2] * 3;
      const ux = pos[b] - pos[a];
      const uy = pos[b + 1] - pos[a + 1];
      const uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a];
      const vy = pos[c + 1] - pos[a + 1];
      const vz = pos[c + 2] - pos[a + 2];
      const ny = uz * vx - ux * vz;
      const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
      const wall = !(len > 1e-9) || Math.abs(ny) < VERTICAL * len;
      if (wall === walls) keep.push(p.idx[t], p.idx[t + 1], p.idx[t + 2]);
    }
    if (!keep.length) continue;
    const idx = Uint32Array.from(keep);
    parts.push({ ...p, idx });
    area += triArea(pos, idx);
    tris += idx.length / 3;
  }
  return { ...g, parts, area, tris };
}

/** UVs with the texture's offset / repeat / rotation (KHR_texture_transform) baked in. */
function bakedUv(uv: Float32Array, map: THREE.Texture | null): Float32Array {
  if (!map) return uv;
  map.updateMatrix();
  const e = map.matrix.elements;
  if (e[0] === 1 && e[1] === 0 && e[3] === 0 && e[4] === 1 && e[6] === 0 && e[7] === 0) return uv;
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i];
    const v = uv[i + 1];
    out[i] = e[0] * u + e[3] * v + e[6];
    out[i + 1] = e[1] * u + e[4] * v + e[7];
  }
  return out;
}

interface Merged {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
  /** Vertex range of each source group (for per-group attributes). */
  ranges: [number, number][];
}

function mergeGroups(groups: MatGroup[], withUv: boolean): Merged {
  let nv = 0;
  let ni = 0;
  for (const g of groups)
    for (const p of g.parts) {
      nv += p.pos.length / 3;
      ni += p.idx.length;
    }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(withUv ? nv * 2 : 0);
  const idx = new Uint32Array(ni);
  const ranges: [number, number][] = [];
  let v0 = 0;
  let i0 = 0;
  for (const g of groups) {
    const gStart = v0;
    for (const p of g.parts) {
      const n = p.pos.length / 3;
      pos.set(p.pos, v0 * 3);
      nor.set(p.nor, v0 * 3);
      if (withUv && p.uv) uv.set(bakedUv(p.uv, g.map), v0 * 2);
      for (let k = 0; k < p.idx.length; k++) idx[i0 + k] = p.idx[k] + v0;
      v0 += n;
      i0 += p.idx.length;
    }
    ranges.push([gStart, v0]);
  }
  return { pos, nor, uv, idx, ranges };
}

function toGeometry(m: Merged, withUv: boolean): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  if (withUv) geo.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Linear color per triangle: its material color times the texture at the
 * triangle's UV centroid (wrapped like the sampler). Clean-geometry GLBs come
 * as one atlas of color swatches and bands, so this recovers which faces are
 * glass, panels or stone.
 */
function triangleColors(groups: MatGroup[], nTri: number): Float32Array {
  const out = new Float32Array(nTri * 3);
  const col = new THREE.Color();
  const texel = new THREE.Color();
  const canvas = document.createElement('canvas');
  const g2d = canvas.getContext('2d', { willReadFrequently: true })!;
  let t = 0;
  for (const g of groups) {
    const img = g.parts.every((p) => p.uv) ? drawableImage(g.map) : null;
    let data: Uint8ClampedArray | null = null;
    const w = img ? Math.min(img.width, 256) : 0;
    const h = img ? Math.min(img.height, 256) : 0;
    if (img) {
      canvas.width = w;
      canvas.height = h;
      g2d.drawImage(img, 0, 0, w, h);
      data = g2d.getImageData(0, 0, w, h).data;
    }
    const wrap = (x: number, repeat: boolean) => (repeat ? x - Math.floor(x) : Math.min(1, Math.max(0, x)));
    const repeatU = g.map?.wrapS === THREE.RepeatWrapping;
    const repeatV = g.map?.wrapT === THREE.RepeatWrapping;
    for (const p of g.parts) {
      const uv = data && p.uv ? bakedUv(p.uv, g.map) : null;
      for (let k = 0; k < p.idx.length; k += 3, t++) {
        col.copy(g.color);
        if (data && uv) {
          const i0 = p.idx[k] * 2;
          const i1 = p.idx[k + 1] * 2;
          const i2 = p.idx[k + 2] * 2;
          const u = wrap((uv[i0] + uv[i1] + uv[i2]) / 3, repeatU);
          const v = wrap((uv[i0 + 1] + uv[i1 + 1] + uv[i2 + 1]) / 3, repeatV);
          const o = (Math.min(h - 1, Math.floor(v * h)) * w + Math.min(w - 1, Math.floor(u * w))) * 4;
          col.multiply(texel.setRGB(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, THREE.SRGBColorSpace));
        }
        out[t * 3] = col.r;
        out[t * 3 + 1] = col.g;
        out[t * 3 + 2] = col.b;
      }
    }
  }
  return out;
}

/**
 * Turns a loaded GLB scene into at most opts.maxDrawCalls meshes in model
 * space: transforms baked, primitives merged per material; photo models whose
 * material count still exceeds the budget get a runtime texture atlas (one
 * mesh). Clean-geometry models become one mesh with the procedural facade
 * attributes. The GLB's own geometries, materials and unused textures are
 * released.
 */
export function prepareModel(gltfScene: THREE.Object3D, opts: PrepareOptions): PreparedModel {
  const parts = collectParts(gltfScene);
  const groups = groupParts(parts);
  const disposables: { dispose(): void }[] = [];
  const meshes: THREE.Mesh[] = [];
  const object = new THREE.Group();
  const keepTextures = new Set<THREE.Texture>();
  let atlasSize: [number, number] | null = null;
  // The baked GLBs have outward faces, so only alpha cutouts (thin railings, lattices) need both sides.
  const isCutout = (g: MatGroup) => g.mat.alphaTest > 0 && !!g.map;

  const all = mergeGroups(groups, false);
  const geometry: ModelGeometry = { pos: all.pos, idx: all.idx };

  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, ownMaterial: boolean) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    object.add(mesh);
    meshes.push(mesh);
    disposables.push(geo);
    if (ownMaterial) disposables.push(mat);
  };

  /** One mesh per material group with the photo material (its own texture, alpha cutout kept). */
  const addPhotoGroup = (g: MatGroup) => {
    const hasUv = !!g.map && g.parts.every((p) => p.uv);
    const map = hasUv ? g.map : null;
    if (map) {
      map.anisotropy = opts.anisotropy;
      keepTextures.add(map);
    }
    const mat = createPhotoFacadeMaterial({
      map,
      atlas: false,
      vertexColors: false,
      doubleSided: isCutout(g),
      fogScale: opts.fogScale,
      seed: opts.seed,
    });
    mat.color.copy(g.color);
    mat.alphaTest = g.mat.alphaTest;
    addMesh(toGeometry(mergeGroups([g], hasUv), hasUv), mat, true);
  };

  /** Photo-material meshes for groups: one per group within budget, else one runtime atlas. */
  const addPhoto = (list: MatGroup[], budget: number) => {
    if (!list.length) return;
    if (list.length <= budget) for (const g of list) addPhotoGroup(g);
    else addAtlas(list);
  };

  const addAtlas = (groups: MatGroup[]) => {
    const tiles = groups.map((g) => {
      const img = g.parts.every((p) => p.uv) ? drawableImage(g.map) : null;
      return { image: img, weight: g.area };
    });
    const atlas = buildAtlas(tiles, opts.atlasMax, opts.atlasTile);
    atlas.texture.anisotropy = opts.anisotropy;
    atlasSize = atlas.size;
    disposables.push(atlas.texture);
    const m = mergeGroups(groups, true);
    const nv = m.pos.length / 3;
    const aAtlas = new Float32Array(nv * 4);
    const color = new Float32Array(nv * 3);
    groups.forEach((g, gi) => {
      const [v0, v1] = m.ranges[gi];
      const r = atlas.rects.subarray(gi * 4, gi * 4 + 4);
      for (let v = v0; v < v1; v++) {
        aAtlas.set(r, v * 4);
        color[v * 3] = g.color.r;
        color[v * 3 + 1] = g.color.g;
        color[v * 3 + 2] = g.color.b;
      }
    });
    const geo = toGeometry(m, true);
    geo.setAttribute('aAtlas', new THREE.BufferAttribute(aAtlas, 4));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    const mat = createPhotoFacadeMaterial({
      map: atlas.texture,
      atlas: true,
      vertexColors: true,
      doubleSided: groups.some(isCutout),
      fogScale: opts.fogScale,
      seed: opts.seed,
    });
    mat.alphaTest = Math.max(...groups.map((g) => (isCutout(g) ? g.mat.alphaTest : 0)));
    addMesh(geo, mat, true);
  };

  if (!opts.photo) {
    // Walls get the procedural facade. Roofs, canopy undersides and alpha cutouts (railings,
    // lattices) keep the GLB's own colors: the facade shader's flat roof is a dark fill.
    const solid = groups.filter((g) => !isCutout(g));
    const walls = solid.map((g) => filterTris(g, true)).filter((g) => g.tris > 0);
    const flats = solid.map((g) => filterTris(g, false)).filter((g) => g.tris > 0);
    const merged = mergeGroups(walls, false);
    if (merged.idx.length) {
      const colors = triangleColors(walls, merged.idx.length / 3);
      // A forced style is the hand-built landmark's look: keep its palette untinted.
      const geo = buildFacadeGeometry(merged.pos, merged.idx, colors, opts.styler, !opts.styler, opts.seed, opts.podium);
      addMesh(geo, opts.facadeMaterial(), false);
    }
    addPhoto([...flats, ...groups.filter(isCutout)], opts.maxDrawCalls - meshes.length);
  } else {
    addPhoto(groups, opts.maxDrawCalls);
  }

  // Release the GLB's own resources (never uploaded) except textures still in use.
  gltfScene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(mat)) {
        if (v instanceof THREE.Texture && !keepTextures.has(v)) {
          const img = v.image as { close?: () => void } | null;
          v.dispose();
          img?.close?.();
        }
      }
      mat.dispose();
    }
  });
  for (const tex of keepTextures) disposables.push(tex);

  return {
    object,
    meshes,
    disposables,
    bounds: new THREE.Box3().setFromArray(all.pos),
    tris: all.idx.length / 3,
    drawCalls: meshes.length,
    atlas: atlasSize,
    geometry,
  };
}
