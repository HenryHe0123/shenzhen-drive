/**
 * Whole-city scenery data written by scripts/build_metro_data.py into public/data/metro/.
 * Same local frame as route.json (x east, z south, origin = route start); game y = 0 at road level.
 */

/** Cell-centred grid: value (i, j) sits at (x0 + (i + 0.5) cell, z0 + (j + 0.5) cell); row 0 is the north edge. */
export interface GridMeta {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
}

export interface TerrainGridMeta extends GridMeta {
  /** Int16 decimetres, each row delta-coded, gzip. */
  file: string;
  bytes: number;
  /** Sentinel-2 albedo (sRGB JPEG) covering exactly this grid's extent; image row 0 = north. */
  albedo: { file: string; width: number; height: number };
}

export interface MetroMeta {
  version: number;
  generatedAt: string;
  origin: { lon: number; lat: number };
  terrain: {
    /** Game y of mean sea level (= -routeElevation). */
    seaLevel: number;
    routeElevation: number;
    /** Height of the flattened route corridor (the old ground plane). */
    groundY: number;
    flatInner: number;
    flatOuter: number;
    /** The inner grid fades into the outer one over this many metres inside its edge. */
    innerBlend: number;
    inner: TerrainGridMeta;
    outer: TerrainGridMeta;
    /** Corridor weight (uint8, 255 = flattened route corridor) on its own grid, gzip. */
    corridor?: GridMeta & { file: string };
    min: number;
    max: number;
  };
  water: { file: string; tile: number; tiles: number; vertices: number; triangles: number; bytes: number };
  buildings?: {
    detailTile: number;
    massTile: number;
    /** Detail tiles present: [i, j, count, bytes]; file bld/<i>_<j>.bin.gz. */
    detail: [number, number, number, number][];
    /** Mass tiles present: [i, j, count, bytes]; file mass/<i>_<j>.bin.gz. */
    mass: [number, number, number, number][];
    /** Tall buildings drawn at any distance (mass format). */
    skyline: { file: string; count: number; minHeight: number };
    count: number;
    heightSources: Record<string, number>;
    footprintSources: Record<string, number>;
  };
  roads?: {
    tile: number;
    /** [i, j, ways, bytes]; file roads/<i>_<j>.bin.gz. */
    tiles: [number, number, number, number][];
    count: number;
  };
  places?: { name: string; en?: string; kind: string; x: number; z: number }[];
}
