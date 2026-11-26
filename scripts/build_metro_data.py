#!/usr/bin/env python3
"""Whole-city scenery pipeline for SHENZHEN DRIVE (v0.6.0): everything beyond the route corridor.

Runs after scripts/build_city_data.py (reads public/data/route.json for the local frame and the corridor,
buildings.json / city_models.json for what the corridor already draws) and writes public/data/metro/:

  metro.json            frame, grids, tile index, sources and counts (MetroMeta in src/city/metro/types.ts)
  terrain_inner.bin.gz  30 m height grid over 深圳市 (Int16 dm, row-delta coded), game y (route = 0)
  terrain_outer.bin.gz  120 m height grid over the horizon window (Hong Kong, Dongguan, Huizhou)
  albedo_inner.jpg      Sentinel-2 true colour over 深圳市, albedo_outer.jpg over the horizon window
  water.bin.gz          sea, reservoirs, lakes and rivers as flat triangle meshes per 8 km tile
  bld/<i>_<j>.bin.gz    detail tiles (2 km): building footprints, heights, base elevation, style
  mass/<i>_<j>.bin.gz   mass tiles (8 km): one oriented box per building, for distant views
  roads/<i>_<j>.bin.gz  road / rail centrelines with width, class and baked 3D heights (2 km)

Inputs (never shipped): Geofabrik Guangdong OSM extract, Overture buildings / land / water, CMAB, WSF3D,
FABDEM (or Copernicus GLO-30), Sentinel-2 composite (scripts/fetch_*.py, data-raw/download.sh metro).

Usage: .venv/bin/python scripts/build_metro_data.py [--rebuild] [--only terrain|water|buildings|roads] [--no-plot]
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import pickle
import re
import struct
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium
import shapely
import shapely.ops
from shapely.geometry import LineString, MultiPolygon, Polygon, box

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_city_data import OPEN_TAGS, Proj, hash01, parse_height, parse_levels  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CFG_PATH = ROOT / "scripts" / "city_config.json"
OUT = ROOT / "public" / "data" / "metro"
CACHE_VERSION = 3

# ----------------------------------------------------------------------------
# OSM: extract + parse (cached)
# ----------------------------------------------------------------------------

ROAD_CLASSES = {
    "motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4, "unclassified": 5, "residential": 5,
    "living_street": 6, "service": 6,
    "motorway_link": 0, "trunk_link": 1, "primary_link": 2, "secondary_link": 3, "tertiary_link": 4,
}
RAIL_TYPES = {"rail", "light_rail", "subway", "monorail", "narrow_gauge", "tram"}
WATER_LINES = {"river", "canal", "stream", "drain"}
BLD_TAGS = ("building", "height", "building:levels", "min_height", "building:min_level", "name", "name:en", "location",
            "layer", "wikidata", "start_date", "building:part", "roof:height", "man_made")
WAY_TAGS = ("highway", "railway", "waterway", "name", "lanes", "width", "bridge", "tunnel", "layer", "oneway", "ref",
            "junction", "area", "covered", "service", "usage", "level", "intermittent")


def make_extract(src: Path, dst: Path, bbox):
    """bbox cut of the Guangdong extract with every relation (multipolygons, boundaries) touching it."""
    W, S, E, N = bbox
    t0 = time.time()
    print(f"[osm] cutting {bbox} from {src.name} -> {dst.name} (one-time, a few minutes)")
    node_ids, way_ids = set(), set()
    tmp = dst.with_suffix(".tmp.pbf")
    with osmium.BackReferenceWriter(str(tmp), ref_src=str(src), overwrite=True, remove_tags=False) as wr:
        for o in osmium.FileProcessor(str(src)):
            if o.is_node():
                loc = o.location
                if loc.valid() and W <= loc.lon <= E and S <= loc.lat <= N:
                    node_ids.add(o.id)
                    wr.add_node(o)
            elif o.is_way():
                if any(n.ref in node_ids for n in o.nodes):
                    way_ids.add(o.id)
                    wr.add_way(o)
            elif o.is_relation():
                if o.tags.get("type") in ("multipolygon", "building", "boundary") and any(m.type == "w" and m.ref in way_ids for m in o.members):
                    wr.add_relation(o)
    tmp.replace(dst)
    print(f"[osm] {len(node_ids)} nodes, {len(way_ids)} ways in {time.time() - t0:.0f}s")


def area_kind(t):
    """Category of a non-building area: water / green / sand / wetland / aero / boundary or None."""
    if t.get("boundary") == "administrative":
        return "boundary"
    if t.get("natural") == "water" or t.get("waterway") == "riverbank" or t.get("landuse") in ("reservoir", "basin") or "water" in t and t.get("natural") is None and t.get("landuse") is None and t.get("leisure") is None and t.get("amenity") is None:
        return "water"
    if t.get("natural") in ("beach", "sand"):
        return "sand"
    if t.get("natural") == "wetland":
        return "wetland"
    if t.get("aeroway") in ("aerodrome", "apron", "runway", "taxiway"):
        return "aero"
    if t.get("leisure") in ("park", "garden", "golf_course", "nature_reserve", "pitch", "stadium") or t.get("landuse") in (
            "forest", "grass", "meadow", "recreation_ground", "village_green", "cemetery", "orchard", "farmland") or t.get("natural") in ("wood", "scrub", "grassland", "heath"):
        return "green"
    return None


def parse_osm(extract: Path):
    t0 = time.time()
    out = dict(buildings=[], parts=[], ways=[], coast=[], areas=[], places=[], open=[])
    for o in osmium.FileProcessor(str(extract)).with_areas():
        t = o.tags
        if o.is_node():
            if t.get("place") in ("city", "town", "suburb", "quarter", "neighbourhood", "village", "island"):
                out["places"].append(dict(id=o.id, tags={k: t.get(k) for k in ("place", "name", "name:en", "population") if k in t},
                                          ll=(o.location.lon, o.location.lat)))
        elif o.is_way():
            hw, rw, ww = t.get("highway"), t.get("railway"), t.get("waterway")
            coast = t.get("natural") == "coastline"
            if not (hw in ROAD_CLASSES or rw in RAIL_TYPES or ww in WATER_LINES or coast):
                continue
            try:
                ll = [(n.lon, n.lat) for n in o.nodes]
            except osmium.InvalidLocationError:
                continue
            if coast:
                out["coast"].append(ll)
            if hw in ROAD_CLASSES or rw in RAIL_TYPES or ww in WATER_LINES:
                out["ways"].append(dict(id=o.id, tags={k: t.get(k) for k in WAY_TAGS if k in t}, refs=[n.ref for n in o.nodes], ll=ll))
        elif o.is_area():
            is_bld = "building" in t and t.get("building") != "no"
            is_part = "building:part" in t and t.get("building:part") != "no" and not is_bld
            kind = None if is_bld or is_part else area_kind(t)
            is_open = not is_bld and not is_part and OPEN_TAGS and any(t.get(k) in v for k, v in OPEN_TAGS.items())
            if not (is_bld or is_part or kind or is_open):
                continue
            try:
                polys = []
                for outer in o.outer_rings():
                    holes = [[(n.lon, n.lat) for n in inner] for inner in o.inner_rings(outer)]
                    polys.append(([(n.lon, n.lat) for n in outer], holes))
            except osmium.InvalidLocationError:
                continue
            if not polys:
                continue
            tags = {k: t.get(k) for k in BLD_TAGS if k in t} if (is_bld or is_part) else dict(t)
            rec = dict(kind="w" if o.from_way() else "r", id=o.orig_id(), tags=tags, polys=polys)
            if is_bld:
                out["buildings"].append(rec)
            elif is_part:
                out["parts"].append(rec)
            else:
                if kind:
                    rec["cat"] = kind
                    out["areas"].append(rec)
                if is_open:
                    out["open"].append([p[0] for p in polys])
    print(f"[osm] parsed {len(out['buildings'])} buildings, {len(out['parts'])} parts, {len(out['ways'])} ways, "
          f"{len(out['coast'])} coastline ways, {len(out['areas'])} areas, {len(out['places'])} places in {time.time() - t0:.0f}s")
    return out


def load_osm(cfg, rebuild=False):
    mc = cfg["metro"]
    src, ext, cache = ROOT / cfg["osm"]["pbf"], ROOT / mc["extract"], ROOT / mc["cache"]
    if rebuild or not ext.exists():
        if not src.exists():
            sys.exit(f"missing {src}; run sh data-raw/download.sh")
        make_extract(src, ext, mc["bbox"])
    if not rebuild and cache.exists() and cache.stat().st_mtime > ext.stat().st_mtime:
        with open(cache, "rb") as f:
            d = pickle.load(f)
        if d.get("version") == CACHE_VERSION:
            return d
    d = parse_osm(ext)
    d["version"] = CACHE_VERSION
    with open(cache, "wb") as f:
        pickle.dump(d, f, protocol=pickle.HIGHEST_PROTOCOL)
    return d


# ----------------------------------------------------------------------------
# frame and grids
# ----------------------------------------------------------------------------


class Frame:
    """The game's local frame (route start = origin, x east, z south) and the route polyline in it."""

    def __init__(self):
        route = json.loads((ROOT / "public" / "data" / "route.json").read_text())
        o = route["meta"]["origin"]
        self.proj = Proj(o["lon"], o["lat"])
        self.route = route
        self.line = LineString(np.asarray(route["centerline"], float))
        bpath = ROOT / "public" / "data" / "buildings.json"
        self.corridor_ids = {b["id"] for b in json.loads(bpath.read_text())["buildings"]} if bpath.exists() else set()
        mpath = ROOT / "public" / "data" / "city_models.json"
        self.models = json.loads(mpath.read_text())["models"] if mpath.exists() else []

    def xz(self, lon, lat):
        return self.proj.fwd(np.stack([np.asarray(lon, float), np.asarray(lat, float)], axis=-1))

    def ll(self, x, z):
        return self.proj.inv(np.stack([np.asarray(x, float), np.asarray(z, float)], axis=-1))


class Grid:
    """Square cells of `cell` m; values live at cell centres (x0 + (i + 0.5) cell, z0 + (j + 0.5) cell), row 0 = north."""

    def __init__(self, x0, z0, cell, nx, nz):
        self.x0, self.z0, self.cell, self.nx, self.nz = float(x0), float(z0), float(cell), int(nx), int(nz)

    @classmethod
    def covering(cls, frame, bbox, cell, align, pad=0.0):
        W, S, E, N = bbox
        a = frame.xz([W, E], [N, S])
        x0 = math.floor((a[0, 0] - pad) / align) * align
        z0 = math.floor((a[0, 1] - pad) / align) * align
        x1, z1 = a[1, 0] + pad, a[1, 1] + pad
        return cls(x0, z0, cell, math.ceil((x1 - x0) / cell), math.ceil((z1 - z0) / cell))

    @property
    def x1(self):
        return self.x0 + self.nx * self.cell

    @property
    def z1(self):
        return self.z0 + self.nz * self.cell

    def centers(self):
        xs = self.x0 + (np.arange(self.nx) + 0.5) * self.cell
        zs = self.z0 + (np.arange(self.nz) + 0.5) * self.cell
        return np.meshgrid(xs, zs)

    def transform(self):
        from rasterio.transform import Affine
        return Affine(self.cell, 0, self.x0, 0, self.cell, self.z0)

    def meta(self):
        return dict(x0=round(self.x0, 3), z0=round(self.z0, 3), cell=self.cell, nx=self.nx, nz=self.nz)


def bilinear(arr, grid, x, z):
    """Bilinear sample of a cell-centred grid at local points (clamped at the edges), like GPU linear filtering."""
    fx = np.clip((np.asarray(x, float) - grid.x0) / grid.cell - 0.5, 0, grid.nx - 1.0001)
    fz = np.clip((np.asarray(z, float) - grid.z0) / grid.cell - 0.5, 0, grid.nz - 1.0001)
    i, j = np.floor(fx).astype(int), np.floor(fz).astype(int)
    tx, tz = fx - i, fz - j
    a = arr[j, i] * (1 - tx) + arr[j, i + 1] * tx
    b = arr[j + 1, i] * (1 - tx) + arr[j + 1, i + 1] * tx
    return a * (1 - tz) + b * tz


def sample_lonlat_raster(path, frame, grid, band=1, order=1):
    """Resample an EPSG:4326 raster onto the cell centres of a local grid."""
    import rasterio
    from scipy.ndimage import map_coordinates

    gx, gz = grid.centers()
    ll = frame.ll(gx, gz)
    with rasterio.open(path) as ds:
        a = ds.read(band).astype(np.float32)
        t = ds.transform
        nodata = ds.nodata
    if nodata is not None and not np.isnan(nodata):
        a[a == nodata] = np.nan
    col = (ll[..., 0] - t.c) / t.a - 0.5
    row = (ll[..., 1] - t.f) / t.e - 0.5
    return map_coordinates(a, [row.ravel(), col.ravel()], order=order, mode="nearest").reshape(gx.shape).astype(np.float32)


def rasterize(geoms, grid, values=None, all_touched=False, dtype=np.uint8, fill=0, merge="replace"):
    from rasterio.features import MergeAlg
    from rasterio.features import rasterize as rio_rasterize

    geoms = [g for g in geoms if g is not None and not g.is_empty]
    if not geoms:
        return np.full((grid.nz, grid.nx), fill, dtype)
    shapes = zip(geoms, values if values is not None else [1] * len(geoms))
    return rio_rasterize(shapes, out_shape=(grid.nz, grid.nx), transform=grid.transform(), fill=fill, all_touched=all_touched,
                         dtype=dtype, merge_alg=MergeAlg.add if merge == "add" else MergeAlg.replace)


def to_local(frame, geoms):
    return shapely.transform(np.asarray(geoms, dtype=object), lambda ll: frame.proj.fwd(ll))


def osm_polygon(frame, polys, holes=True):
    out = []
    for outer, inners in polys:
        if len(outer) < 4:
            continue
        p = Polygon(frame.proj.fwd(outer), [frame.proj.fwd(h) for h in inners if len(h) >= 4] if holes else None)
        if not p.is_valid:
            p = shapely.make_valid(p)
        out.extend([g for g in getattr(p, "geoms", [p]) if g.geom_type == "Polygon" and not g.is_empty])
    return out


# ----------------------------------------------------------------------------
# terrain
# ----------------------------------------------------------------------------


def load_overture_water(cfg, frame):
    """Overture base water in the terrain window: ocean polygons, inland water polygons with their class,
    river / canal centrelines; all in local metres."""
    import pyarrow.parquet as pq

    tb = pq.read_table(ROOT / cfg["metro"]["overtureWater"])
    sub = np.array(tb.column("subtype").to_pylist(), dtype=object)
    cls = np.array(tb.column("class").to_pylist(), dtype=object)
    g = to_local(frame, shapely.from_wkb(tb.column("geometry").to_numpy(zero_copy_only=False)))
    sea, inland, lines = [], [], []
    wc = cfg["metro"]["water"]
    for gg, s, c in zip(g, sub, cls):
        if gg is None or gg.is_empty:
            continue
        gg = gg if gg.is_valid else shapely.make_valid(gg)
        polys = [p for p in getattr(gg, "geoms", [gg]) if p.geom_type == "Polygon"]
        if s == "ocean":
            sea.extend(polys)
        elif polys and (s in wc["polygonSubtypes"] or c in wc["polygonClasses"]) and c not in wc["skipClasses"]:
            inland.extend((p, "lake" if s in ("lake", "reservoir", "pond") or c in ("lake", "reservoir", "pond", "basin") else "river")
                          for p in polys if p.area >= wc["minArea"])
        elif gg.geom_type in ("LineString", "MultiLineString") and c in wc["lineWidths"]:
            lines.append((gg, wc["lineWidths"][c]))
    return sea, inland, lines


def bare_earth(dsm, grid, built, fp_mask, tc):
    """DSM -> ground: building footprints and built-up land are lowered to the surrounding ground. Footprints
    (dilated) are filled by normalised convolution from the cells around them (growing sigma until filled), then
    built-up land gets a grey opening (removes anything narrower than 2 x radius: towers, tree clumps) and a blur.
    Open country keeps the DSM, canopy included (that is the silhouette one sees)."""
    from scipy.ndimage import binary_dilation, gaussian_filter, maximum_filter, minimum_filter

    c = grid.cell
    m = binary_dilation(fp_mask, iterations=max(1, int(round(tc["footprintDilate"] / c))))
    g = dsm.copy()
    hole = m.copy()
    for sigma_m in tc["fillSigmas"]:
        if not hole.any():
            break
        s = sigma_m / c
        wsum = gaussian_filter((~hole).astype(np.float32), s)
        vsum = gaussian_filter(np.where(hole, 0, g), s)
        est = np.where(wsum > 1e-3, vsum / np.maximum(wsum, 1e-6), np.nan)
        upd = hole & np.isfinite(est)
        g[upd] = np.minimum(g[upd], est[upd])
        hole &= ~upd
    if hole.any():
        g[hole] = np.nanmedian(g)
    k = 2 * int(round(tc["openRadius"] / c)) + 1
    opened = maximum_filter(minimum_filter(g, size=k), size=k)
    opened = gaussian_filter(opened, tc["openBlur"] / c)
    urb = gaussian_filter(((built >= tc["builtFraction"]) | m).astype(np.float32), tc["urbanBlend"] / c)
    urb = np.clip(urb * 2.0, 0, 1)
    return g * (1 - urb) + np.minimum(g, opened) * urb, urb


def water_levels(inland, dsm, grid, frame):
    """Flat water level (m ASL) per inland water piece: lakes / reservoirs whole, rivers cut into 300 m
    pieces; level = 20th percentile of the DSM at the piece's cells (the DEM is edited flat over water)."""
    pieces = []
    cut = 300.0
    for poly, kind in inland:
        if kind == "river" and max(poly.bounds[2] - poly.bounds[0], poly.bounds[3] - poly.bounds[1]) > cut:
            x0, z0, x1, z1 = poly.bounds
            for gx in np.arange(math.floor(x0 / cut) * cut, x1, cut):
                for gz in np.arange(math.floor(z0 / cut) * cut, z1, cut):
                    q = poly.intersection(box(gx, gz, gx + cut, gz + cut))
                    for p in getattr(q, "geoms", [q]):
                        if p.geom_type == "Polygon" and p.area > 50:
                            pieces.append((p, kind))
        else:
            pieces.append((poly, kind))
    levels = []
    for p, kind in pieces:
        minx, minz, maxx, maxz = p.bounds
        st = min(grid.cell, max(4.0, math.sqrt(p.area) / 6))
        xs, zs = np.meshgrid(np.arange(minx + st / 2, maxx, st), np.arange(minz + st / 2, maxz, st))
        pts = np.column_stack([xs.ravel(), zs.ravel()])
        if len(pts):
            pts = pts[shapely.contains_xy(p, pts[:, 0], pts[:, 1])]
        if not len(pts):
            pts = np.array(p.representative_point().coords)
        v = bilinear(dsm, grid, pts[:, 0], pts[:, 1])
        levels.append(float(np.percentile(v, 20)) if kind == "river" else float(np.percentile(v, 30)))
    return pieces, levels


def corridor_weight(frame, grid, tc):
    """1 within flatInner m of the route, 0 beyond flatOuter (smoothstep), per cell."""
    from scipy.ndimage import distance_transform_edt

    line = rasterize([frame.line.buffer(grid.cell * 0.75)], grid, all_touched=True).astype(bool)
    dist = distance_transform_edt(~line) * grid.cell
    r0, r1 = tc["flatInner"], tc["flatOuter"]
    t = np.clip((dist - r0) / (r1 - r0), 0, 1)
    return (1 - t * t * (3 - 2 * t)).astype(np.float32), dist


def build_terrain(cfg, frame, fp_polys, report):
    """30 m terrain over the horizon window -> (inner grid + heights, outer grid + heights, water pieces, extras)."""
    mc, tc = cfg["metro"], cfg["metro"]["terrain"]
    t0 = time.time()
    full = Grid.covering(frame, mc["terrainBbox"], tc["cell"], tc["outerCell"])
    print(f"[terrain] grid {full.nx} x {full.nz} cells of {full.cell:.0f} m ({full.nx * full.cell / 1000:.1f} x {full.nz * full.cell / 1000:.1f} km)")
    src = ROOT / mc["fabdem"] if (ROOT / mc["fabdem"]).exists() else ROOT / mc["cop30"]
    dsm = sample_lonlat_raster(src, frame, full)
    print(f"[terrain] {src.name}: {np.nanmin(dsm):.1f} .. {np.nanmax(dsm):.1f} m in {time.time() - t0:.0f}s")
    wc_path = ROOT / mc["worldcover"]
    built = np.zeros_like(dsm)
    if wc_path.exists():
        import rasterio
        from scipy.ndimage import uniform_filter

        with rasterio.open(wc_path) as ds:
            cls = ds.read(1)
            t = ds.transform
        frac = uniform_filter((cls == 50).astype(np.float32), size=3)
        gx, gz = full.centers()
        ll = frame.ll(gx, gz)
        col = np.clip(((ll[..., 0] - t.c) / t.a).astype(int), 0, cls.shape[1] - 1)
        row = np.clip(((ll[..., 1] - t.f) / t.e).astype(int), 0, cls.shape[0] - 1)
        built = frac[row, col]
        del cls, frac
    fp_mask = rasterize(fp_polys, full).astype(bool) if fp_polys else np.zeros(dsm.shape, bool)
    ground, urban = bare_earth(dsm, full, built, fp_mask, tc)
    lowered = dsm - ground
    report["terrain"] = dict(source=src.name, built=float((built >= tc["builtFraction"]).mean()), footprintCells=int(fp_mask.sum()),
                             loweredMedianUrban=float(np.median(lowered[urban > 0.5])) if (urban > 0.5).any() else 0.0)
    print(f"[terrain] bare earth: {fp_mask.mean():.1%} footprint cells, built-up {(built >= tc['builtFraction']).mean():.1%}; "
          f"urban cells lowered by median {report['terrain']['loweredMedianUrban']:.1f} m ({time.time() - t0:.0f}s)")

    # water
    sea, inland, lines = load_overture_water(cfg, frame)
    for g, w in lines:
        inland.append((g.buffer(w / 2, cap_style="flat"), "river"))
    win = box(full.x0, full.z0, full.x1, full.z1)
    sea = [p.intersection(win) for p in sea if p.intersects(win)]
    sea = [q for p in sea for q in getattr(p, "geoms", [p]) if q.geom_type == "Polygon" and q.area > 100]
    sea_mask = rasterize(sea, full).astype(bool)
    pieces, levels = water_levels(inland, ground, full, frame)
    print(f"[water] {len(sea)} sea polygons ({sea_mask.mean():.1%} of the window), {len(inland)} inland water bodies -> {len(pieces)} pieces "
          f"({time.time() - t0:.0f}s)")

    # route corridor: flat at the old ground-plane height, blending into the real terrain
    w, dist = corridor_weight(frame, full, tc)
    on_route = bilinear(ground, full, *np.asarray(frame.route["centerline"], float)[::10].T)
    e0 = float(np.median(on_route))
    report["terrain"].update(routeElevation=dict(median=e0, p5=float(np.percentile(on_route, 5)), p95=float(np.percentile(on_route, 95))))
    print(f"[terrain] route elevation (bare earth) median {e0:.1f} m, 5-95% {np.percentile(on_route, 5):.1f}-{np.percentile(on_route, 95):.1f} m")

    h = ground - e0
    # sea floor below the water plane; land next to the sea kept above it
    sea_y = -e0
    h = np.where(sea_mask, np.minimum(h, sea_y - tc["seaDepth"]), np.maximum(h, sea_y + tc["shoreMin"]) if tc["shoreMin"] else h)
    # inland water: carve below each piece's level (outside the flat corridor)
    lvl_vals = np.array([lv - e0 - tc["waterCarve"] for lv in levels], np.float32)
    if pieces:
        order = np.argsort(-lvl_vals)  # lower pieces last so they win where pieces touch
        carve = rasterize([pieces[i][0] for i in order], full, values=[float(lvl_vals[i]) for i in order], dtype=np.float32, fill=np.inf)
        h = np.where(np.isfinite(carve), np.minimum(h, carve), h)
    h = w * tc["groundY"] + (1 - w) * h
    keep = []
    for (p, kind), lv in zip(pieces, levels):
        c = p.representative_point()
        dd = frame.line.distance(c)
        if dd < (tc["flatInner"] + tc["flatOuter"]) / 2:
            continue
        keep.append(dict(poly=p, kind=kind, y=lv - e0))
    report["water"] = dict(sea=len(sea), inland=len(inland), pieces=len(keep))
    return full, h.astype(np.float32), e0, sea, keep, w, ground


# ----------------------------------------------------------------------------
# buildings
# ----------------------------------------------------------------------------

USE_CODE = {None: 0, "residential": 1, "office": 2, "commercial": 3, "public": 4, "industrial": 5}
AGE_CODE = {None: 0, "1980s": 1, "1990s": 2, "2000s": 3, "2010s": 4, "2020s": 5}
HSRC = ["tag", "levels", "parts", "tall", "overture", "cmab", "wsf3d", "estimated", "model"]


def boundary(osm, frame, name="深圳市"):
    for a in osm["areas"]:
        t = a["tags"]
        if a.get("cat") == "boundary" and t.get("name") == name:
            return shapely.union_all(osm_polygon(frame, a["polys"], holes=True))
    return None


def districts(osm, frame):
    out = []
    for a in osm["areas"]:
        t = a["tags"]
        if a.get("cat") == "boundary" and t.get("admin_level") == "6" and (t.get("name") or "").endswith("区"):
            g = shapely.union_all(osm_polygon(frame, a["polys"]))
            out.append((t["name"], t.get("name:en"), g))
    return out


def osm_buildings(cfg, osm, frame):
    """OSM building outlines (each outer ring with its holes) as local polygons + tags; building:part heights
    folded into outlines without height / levels."""
    hc = cfg["heights"]
    recs = []
    for b in osm["buildings"]:
        t = b["tags"]
        if t.get("location") == "underground" or ((t.get("layer") or "").startswith("-") and (parse_levels(t.get("building:levels")) or 0) == 0):
            continue
        for k, p in enumerate(osm_polygon(frame, b["polys"], holes=True)):
            if p.area >= cfg["buildings"]["minArea"]:
                recs.append(dict(id=b["id"], sub=k, tags=t, poly=p, src="osm"))
    parts = []
    for pr in osm["parts"]:
        t = pr["tags"]
        h = parse_height(t.get("height"))
        lv = parse_levels(t.get("building:levels"))
        h = h or (lv * hc["levelHeight"] if lv else None)
        if h:
            for p in osm_polygon(frame, pr["polys"], holes=False):
                parts.append((p, h))
    if parts:
        tree = shapely.STRtree([p for p, _ in parts])
        pts = shapely.point_on_surface(np.asarray([p for p, _ in parts], dtype=object))
        n = 0
        for r in recs:
            t = r["tags"]
            if parse_height(t.get("height")) or parse_levels(t.get("building:levels")):
                continue
            hit = [parts[i][1] for i in tree.query(r["poly"], predicate="intersects") if r["poly"].contains(pts[i])]
            if hit:
                r["partHeight"] = max(hit)
                n += 1
        print(f"[bld] {len(parts)} building:parts with a height; {n} outlines take their tallest part")
    return recs


def overture_buildings(cfg, frame, osm_recs, opens):
    """Overture machine-learned rooftops (sources not OSM) that overlap no OSM outline by maxOsmOverlap and lie
    outside OSM open space (parks, water, plazas, construction sites)."""
    import pyarrow.parquet as pq

    from build_city_data import overture_id

    t0 = time.time()
    oc = cfg["overture"]
    tb = pq.read_table(ROOT / cfg["metro"]["overture"], columns=["id", "sources", "height", "num_floors", "geometry"])
    ml = np.array([not any(s["dataset"] == "OpenStreetMap" for s in (ss or [])) for ss in tb.column("sources").to_pylist()])
    g = shapely.from_wkb(np.asarray(tb.column("geometry").to_numpy(zero_copy_only=False))[ml])
    g = to_local(frame, g)
    ok = ~shapely.is_valid(g)
    if ok.any():
        g[ok] = shapely.make_valid(g[ok])
    polys = np.array([gg if gg.geom_type == "Polygon" else max((p for p in getattr(gg, "geoms", []) if p.geom_type == "Polygon"), key=lambda p: p.area, default=None)
                      for gg in g], dtype=object)
    keep = np.array([p is not None and p.area >= cfg["buildings"]["minArea"] for p in polys])
    ids = np.asarray(tb.column("id").to_pylist(), dtype=object)[ml][keep]
    hts = np.asarray(tb.column("height").to_pylist(), dtype=object)[ml][keep]
    fls = np.asarray(tb.column("num_floors").to_pylist(), dtype=object)[ml][keep]
    polys = polys[keep]
    area = shapely.area(polys)
    # overlap with OSM outlines
    tree = shapely.STRtree([r["poly"] for r in osm_recs])
    a, b = tree.query(polys, predicate="intersects")
    inter = shapely.area(shapely.intersection(polys[a], np.asarray([osm_recs[i]["poly"] for i in b], dtype=object)))
    ov = np.zeros(len(polys))
    np.add.at(ov, a, inter)
    drop_osm = ov >= oc["maxOsmOverlap"] * area
    # open space
    otree = shapely.STRtree(opens)
    a, b = otree.query(polys, predicate="intersects")
    inter = shapely.area(shapely.intersection(polys[a], np.asarray(opens, dtype=object)[b]))
    oo = np.zeros(len(polys))
    np.add.at(oo, a, inter)
    cent = shapely.centroid(polys)
    ci, cj = otree.query(cent, predicate="within")
    inside = np.zeros(len(polys), bool)
    inside[ci] = True
    drop_open = (oo > oc["maxOpenOverlap"] * area) | inside
    sel = ~drop_osm & ~drop_open
    out = [dict(id=overture_id(i), sub=0, tags={}, poly=p, src="overture",
                ovHeight=float(h) if h is not None and h > 0 else None, ovFloors=float(f) if f is not None and f > 0 else None)
           for i, p, h, f in zip(ids[sel], polys[sel], hts[sel], fls[sel])]
    print(f"[overture] {ml.sum()} non-OSM rooftops: {int(drop_osm.sum())} overlap OSM, {int((drop_open & ~drop_osm).sum())} in open space, "
          f"{len(out)} kept ({time.time() - t0:.0f}s)")
    return out


def load_open_space(osm, frame):
    out = []
    for rings in osm["open"]:
        for r in rings:
            if len(r) >= 4:
                p = Polygon(frame.proj.fwd(r))
                p = p if p.is_valid else shapely.make_valid(p)
                out.extend(q for q in getattr(p, "geoms", [p]) if q.geom_type == "Polygon" and q.area > 20)
    return out


def tall_overrides(recs, frame, tall_path, report, manual=()):
    """Heights from Wikipedia's tallest-building list (rows with coordinates) and the hand-entered
    metro.heightOverrides (feedback: {lon, lat, height, note}): the building containing the point, else the
    largest footprint within 45 m. Manual entries win over the list."""
    rows = [r for r in json.loads(tall_path.read_text()) if r.get("status") == "completed"] if tall_path.exists() else []
    rows += [dict(name=m.get("note", "override"), height=m["height"], lat=m["lat"], lon=m["lon"], manual=True) for m in manual]
    polys = [r["poly"] for r in recs]
    tree = shapely.STRtree(polys)
    hits = []
    for row in rows:
        x, z = frame.xz(row["lon"], row["lat"])
        pt = shapely.Point(x, z)
        cand = [i for i in tree.query(pt.buffer(45), predicate="intersects") if polys[i].area >= 300]
        inside = [i for i in cand if polys[i].contains(pt)]
        pick = max(inside or cand, key=lambda i: polys[i].area, default=None)
        if pick is None:
            continue
        r = recs[pick]
        if row.get("manual"):
            r["tall"], r["tallManual"] = row["height"], True
        elif not r.get("tallManual"):
            r["tall"] = max(r.get("tall", 0), row["height"])
        hits.append((row["name"], row["height"]))
    report["tallMatched"] = len(hits)
    print(f"[bld] tall-building list + {len(manual)} manual overrides: {len(hits)} of {len(rows)} rows matched a footprint")


def load_cmab_metro(cfg, frame):
    import pyarrow.parquet as pq

    path = ROOT / cfg["metro"]["cmab"]
    if not path.exists():
        return None
    t = pq.read_table(path)
    g = to_local(frame, shapely.from_wkb(t.column("wkb").to_numpy(zero_copy_only=False)))
    g = shapely.make_valid(g)
    keep = ~shapely.is_empty(g) & (shapely.area(g) >= 4)
    col = lambda k: np.asarray(t.column(k).to_numpy(zero_copy_only=False))[keep]  # noqa: E731
    return dict(polys=g[keep], h=col("height").astype(float), use=col("function"), age=col("age"))


def cmab_heights(recs, cm, min_overlap):
    """Per record: CMAB height / use / age of the rooftop with the largest overlap (> min_overlap of the footprint
    or rooftop centroid inside), vectorised."""
    n = len(recs)
    h = np.full(n, np.nan)
    idx = np.full(n, -1)
    if cm is None:
        return h, idx
    polys = np.asarray([r["poly"] for r in recs], dtype=object)
    tree = shapely.STRtree(cm["polys"])
    a, b = tree.query(polys, predicate="intersects")
    inter = shapely.area(shapely.intersection(polys[a], cm["polys"][b]))
    cent_in = shapely.contains(polys[a], shapely.centroid(cm["polys"][b]))
    ok = (inter > min_overlap * shapely.area(polys[a])) | cent_in
    a, b, inter = a[ok], b[ok], inter[ok]
    order = np.lexsort((inter, a))
    a, b = a[order], b[order]
    last = np.r_[a[1:] != a[:-1], True]
    idx[a[last]] = b[last]
    good = idx >= 0
    h[good] = cm["h"][idx[good]]
    h[h <= 0] = np.nan
    return h, idx


def wsf_heights(cfg, frame, recs):
    """Mean WSF3D cell height (> 0) under each footprint's vertices and centroid (90 m cells)."""
    import rasterio

    path = ROOT / cfg["metro"]["wsf3d"]
    if not path.exists():
        return np.full(len(recs), np.nan)
    with rasterio.open(path) as ds:
        arr = ds.read(1).astype(float) * cfg["wsf3d"]["gain"]
        inv = ~ds.transform
    polys = [r["poly"] for r in recs]
    xy, ix = shapely.get_coordinates(shapely.get_exterior_ring(polys), return_index=True)
    cen = shapely.get_coordinates(shapely.centroid(polys))
    xy = np.vstack([xy, cen])
    ix = np.r_[ix, np.arange(len(polys))]
    ll = frame.proj.inv(xy)
    col, row = inv * (ll[:, 0], ll[:, 1])
    r, c = np.floor(row).astype(int), np.floor(col).astype(int)
    okp = (r >= 0) & (r < arr.shape[0]) & (c >= 0) & (c < arr.shape[1])
    v = np.zeros(len(xy))
    v[okp] = arr[r[okp], c[okp]]
    pos = v > 0
    s = np.bincount(ix[pos], weights=v[pos], minlength=len(polys))
    n = np.bincount(ix[pos], minlength=len(polys))
    out = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    return out


OSM_TYPE_CODE = {t: k for k, t in enumerate(["house", "yes", "apartments", "industrial", "residential", "commercial", "school", "retail",
                                              "detached", "semidetached_house", "dormitory", "office", "terrace", "warehouse", "hotel",
                                              "university", "hospital", "kindergarten", "roof", "construction", "train_station", "service"])}


def osm_truth(r, hc):
    t = r["tags"]
    h = parse_height(t.get("height"))
    if h:
        return h
    lv = parse_levels(t.get("building:levels"))
    return lv * hc["levelHeight"] + hc.get("roofAllowance", 0.0) if lv else np.nan


def height_features(recs, wh, ch, truth, wsf_max):
    """Per-building features: footprint shape, WSF3D / CMAB, OSM type, position, neighbourhood pattern and the
    heights of tagged neighbours (excluding the building itself)."""
    from scipy.spatial import cKDTree

    polys = [r["poly"] for r in recs]
    area = shapely.area(polys)
    per = shapely.length(polys)
    cen = shapely.get_coordinates(shapely.centroid(polys))
    nv = shapely.get_num_coordinates(polys)
    with np.errstate(divide="ignore", invalid="ignore"):
        env = shapely.oriented_envelope(np.asarray(polys, dtype=object))
    ea = np.maximum(shapely.area(env), 1e-3)
    ec = [np.asarray(e.exterior.coords) if e.geom_type == "Polygon" else np.zeros((5, 2)) for e in env]
    l1 = np.array([math.hypot(*(c[1] - c[0])) for c in ec])
    l2 = np.array([math.hypot(*(c[2] - c[1])) for c in ec])
    aspect = np.maximum(l1, l2) / np.maximum(np.minimum(l1, l2), 0.5)
    tree = cKDTree(cen)
    la = np.log(np.maximum(area, 1))
    n50 = np.array([len(x) for x in tree.query_ball_point(cen, 50)]) - 1
    nb100 = tree.query_ball_point(cen, 100)
    nb200 = tree.query_ball_point(cen, 200)
    n250 = np.array([len(x) for x in tree.query_ball_point(cen, 250)]) - 1
    dnn, _ = tree.query(cen, k=2)
    med100 = np.array([np.median(la[x]) if len(x) > 1 else la[i] for i, x in enumerate(nb100)])
    has_t = np.isfinite(truth)
    t_mean = np.full(len(recs), np.nan)
    t_sim = np.full(len(recs), np.nan)
    t_dist = np.full(len(recs), np.nan)
    sim150 = np.zeros(len(recs))
    for i, x in enumerate(nb200):
        x = np.asarray(x)
        x = x[x != i]
        if not len(x):
            continue
        close = x[np.hypot(*(cen[x] - cen[i]).T) <= 150]
        if len(close):
            sim150[i] = np.mean(np.abs(la[close] - la[i]) < 0.25)
        tx = x[has_t[x]]
        if len(tx):
            t_mean[i] = np.mean(truth[tx])
            j = tx[np.argmin(np.abs(la[tx] - la[i]) + np.hypot(*(cen[tx] - cen[i]).T) / 400)]
            t_sim[i] = truth[j]
            t_dist[i] = math.hypot(*(cen[j] - cen[i]))
    otype = np.array([OSM_TYPE_CODE.get(r["tags"].get("building"), len(OSM_TYPE_CODE)) if r["src"] == "osm" else np.nan for r in recs], float)
    X = np.column_stack([la, 4 * math.pi * area / np.maximum(per, 1) ** 2, aspect, area / ea, np.log(nv), wh, wsf_max, ch, otype,
                         cen[:, 0] / 1000, cen[:, 1] / 1000, n50, np.log1p(n250), dnn[:, 1], med100, sim150, t_mean, t_sim, t_dist])
    return X


HF_NAMES = ["log area", "compactness", "aspect", "box fill", "log vertices", "wsf3d", "wsf3d max 3x3", "cmab", "osm type", "x km", "z km",
            "n 50 m", "log n 250 m", "nearest", "neighbour log area", "similar neighbours", "tagged mean", "tagged similar", "tagged dist"]


def wsf_max3(cfg, frame, recs):
    import rasterio
    from scipy.ndimage import maximum_filter

    path = ROOT / cfg["metro"]["wsf3d"]
    with rasterio.open(path) as ds:
        arr = maximum_filter(ds.read(1).astype(float) * cfg["wsf3d"]["gain"], size=3)
        inv = ~ds.transform
    cen = shapely.get_coordinates(shapely.centroid([r["poly"] for r in recs]))
    ll = frame.proj.inv(cen)
    col, row = inv * (ll[:, 0], ll[:, 1])
    r, c = np.clip(np.floor(row).astype(int), 0, arr.shape[0] - 1), np.clip(np.floor(col).astype(int), 0, arr.shape[1] - 1)
    v = arr[r, c]
    return np.where(v > 0, v, np.nan)


def train_height_model(cfg, frame, recs, report):
    """Gradient-boosted model of log height trained on the buildings with an OSM height / levels tag, evaluated
    on spatial 2 km blocks held out; predicts a height for every building (used where no tag exists)."""
    from sklearn.ensemble import HistGradientBoostingRegressor

    t0 = time.time()
    hc = cfg["heights"]
    mcfg = cfg["metro"]["heightModel"]
    truth = np.array([osm_truth(r, hc) for r in recs])
    cm = load_cmab_metro(cfg, frame)
    ch, _ = cmab_heights(recs, cm, cfg["cmab"]["minOverlap"])
    wh = wsf_heights(cfg, frame, recs)
    wm = wsf_max3(cfg, frame, recs)
    X = height_features(recs, wh, ch, truth, wm)
    tr = np.isfinite(truth) & (truth >= hc["min"]) & (truth <= hc["max"])
    y = np.log(truth[tr])
    Xt = X[tr].copy()
    rng = np.random.default_rng(7)
    # Overture rooftops have no OSM type, and many areas no tagged neighbours: train for both.
    Xt[rng.random(len(Xt)) < 0.5, HF_NAMES.index("osm type")] = np.nan
    tag_cols = [HF_NAMES.index(k) for k in ("tagged mean", "tagged similar", "tagged dist")]
    no_tags = rng.random(len(Xt)) < 0.35
    Xt[np.ix_(no_tags, tag_cols)] = np.nan
    cen = shapely.get_coordinates(shapely.centroid([r["poly"] for r, k in zip(recs, tr) if k]))
    block = (np.floor(cen[:, 0] / 2000) * 7919 + np.floor(cen[:, 1] / 2000)).astype(int)
    test = (np.abs(block * 2654435761) % 5) == 0
    params = dict(loss="absolute_error", max_iter=mcfg["iterations"], learning_rate=mcfg["learningRate"], max_leaf_nodes=mcfg["leaves"],
                  min_samples_leaf=mcfg["minLeaf"], l2_regularization=1.0, random_state=0)
    model = HistGradientBoostingRegressor(**params).fit(Xt[~test], y[~test])
    Xtest = X[tr][test]
    pred = np.exp(model.predict(Xtest))
    Xn = Xtest.copy()
    Xn[:, tag_cols] = np.nan
    Xn[:, HF_NAMES.index("osm type")] = np.nan
    pred_bare = np.exp(model.predict(Xn))
    truth_t = np.exp(y[test])
    wh_t = wh[tr][test]
    rows = []
    for lo, hi in ((0, 15), (15, 30), (30, 60), (60, 100), (100, 1e9)):
        m = (truth_t >= lo) & (truth_t < hi)
        mw = m & np.isfinite(wh_t)
        med = lambda p, mm: float(np.median(np.abs(p[mm] - truth_t[mm]))) if mm.any() else None  # noqa: E731
        rows.append(dict(band=f"{lo}-{hi if hi < 1e9 else ''}", n=int(m.sum()), model=med(pred, m), modelNoTags=med(pred_bare, m), wsf3d=med(wh_t, mw)))
    allw = np.isfinite(wh_t)
    rep = dict(trained=int((~test).sum()), heldOut=int(test.sum()), medianAbsError=float(np.median(np.abs(pred - truth_t))),
               medianAbsErrorNoTags=float(np.median(np.abs(pred_bare - truth_t))),
               medianAbsErrorWsf3d=float(np.median(np.abs(wh_t[allw] - truth_t[allw]))), bias=float(np.median(pred - truth_t)), bands=rows)
    print(f"[height model] {rep['trained']} training buildings, held-out 2 km blocks {rep['heldOut']}: median |error| {rep['medianAbsError']:.1f} m "
          f"({rep['medianAbsErrorNoTags']:.1f} m without tagged neighbours or OSM type; WSF3D {rep['medianAbsErrorWsf3d']:.1f} m), bias {rep['bias']:+.1f} m")
    nan = float("nan")
    for r in rows:
        print(f"[height model]   truth {r['band']:>8} m: n {r['n']:5d}, model {r['model'] or nan:5.1f} m, untagged area {r['modelNoTags'] or nan:5.1f} m, "
              f"WSF3D {r['wsf3d'] or nan:5.1f} m")
    model = HistGradientBoostingRegressor(**params).fit(Xt, y)
    pred_all = np.exp(model.predict(X))
    # The tagged sample over-represents towers; keep estimates within what tagged buildings of the same
    # footprint size reach (99th percentile per area band, interpolated in log area) and a slenderness limit.
    area = shapely.area([r["poly"] for r in recs])
    ta, tt = np.log(shapely.area([r["poly"] for r, k in zip(recs, tr) if k])), truth[tr]
    edges = np.log(np.array(mcfg["capBands"], float))
    mids, caps = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (ta >= lo) & (ta < hi)
        if m.sum() >= 30:
            mids.append((lo + hi) / 2)
            caps.append(np.percentile(tt[m], mcfg["capPercentile"]))
    cap = np.interp(np.log(area), mids, np.maximum.accumulate(caps))
    cap = np.minimum(cap, mcfg["maxSlenderness"] * np.sqrt(area))
    capped = pred_all > cap
    pred_all = np.minimum(pred_all, cap)
    rep["capped"] = int(capped.sum())
    rep["caps"] = [dict(area=round(float(np.exp(m))), height=round(float(c), 1)) for m, c in zip(mids, np.maximum.accumulate(caps))]
    print(f"[height model] {capped.sum()} estimates capped to the tagged {mcfg['capPercentile']}th percentile of their footprint size / slenderness "
          f"{mcfg['maxSlenderness']}")
    for r, p in zip(recs, pred_all):
        r["modelHeight"] = float(p)
    report["heightModel"] = rep
    print(f"[height model] predicted {len(recs)} buildings ({time.time() - t0:.0f}s)")


def estimate_height(tags, area, oid, hc):
    btype = tags.get("building", "yes")
    r = hash01(oid)
    if btype in hc["lowTypes"]:
        lo, hi = hc["lowRange"]
    elif btype in hc["midTypes"]:
        lo, hi = hc["midRange"]
    else:
        lo, hi = next(rng for amax, rng in hc["metroEstimate"] if area < amax)
    return lo + (hi - lo) * r ** 1.3


def assign_heights(cfg, frame, recs, report):
    from build_city_data import CMAB_AGE, CMAB_USE, OSM_USE, data_height

    hc = cfg["heights"]
    t0 = time.time()
    cm = load_cmab_metro(cfg, frame)
    ch, ci = cmab_heights(recs, cm, cfg["cmab"]["minOverlap"])
    wh = wsf_heights(cfg, frame, recs)
    srcs = defaultdict(int)
    for k, r in enumerate(recs):
        t = r["tags"]
        area = r["poly"].area
        h = parse_height(t.get("height"))
        src = "tag"
        if r.get("tall"):
            h, src = r["tall"], "tall"
        if not h:
            lv = parse_levels(t.get("building:levels"))
            if lv:
                h, src = lv * hc["levelHeight"] + hc.get("roofAllowance", 0.0), "levels"
        if not h and r.get("partHeight"):
            h, src = r["partHeight"], "parts"
        if not h and r.get("ovHeight"):
            h, src = r["ovHeight"], "overture"
        if not h and r.get("ovFloors"):
            h, src = r["ovFloors"] * hc["levelHeight"], "overture"
        if not h and r.get("modelHeight"):
            h, src = r["modelHeight"], "model"
        if not h:
            alt_h, alt_src = data_height(cfg, area, None if np.isnan(ch[k]) else float(ch[k]), None if np.isnan(wh[k]) else float(wh[k]))
            if alt_h:
                h, src = alt_h, alt_src
        if not h:
            h, src = estimate_height(t, area, r["id"] + r["sub"], hc), "estimated"
        r["h"] = float(np.clip(h, hc["min"], hc["max"]))
        r["hsrc"] = src
        srcs[src] += 1
        u = OSM_USE.get(t.get("building", ""))
        if not u and ci[k] >= 0:
            u = CMAB_USE.get(str(cm["use"][ci[k]]))
        r["use"] = u
        m = re.search(r"(1[89]\d\d|20\d\d)", t.get("start_date", "") or "")
        age = f"{int(m.group(1)) // 10 * 10}s" if m else (CMAB_AGE.get(str(cm["age"][ci[k]])) if ci[k] >= 0 else None)
        r["age"] = age if age in AGE_CODE else ("1980s" if age and age < "1980s" else None)
    report["heightSources"] = dict(srcs)
    print(f"[bld] heights for {len(recs)} buildings: " + ", ".join(f"{k} {v}" for k, v in sorted(srcs.items(), key=lambda kv: -kv[1]))
          + f" ({time.time() - t0:.0f}s)")


def obbs(polys):
    """Oriented boxes (cx, cz, half length, half width, angle in [0, pi)) of footprints, vectorised."""
    with np.errstate(divide="ignore", invalid="ignore"):
        env = shapely.oriented_envelope(np.asarray(polys, dtype=object))
    out = []
    for p, r in zip(polys, env):
        if r.geom_type != "Polygon":
            r = p.envelope if p.envelope.geom_type == "Polygon" else p.buffer(0.5).envelope
        c = np.asarray(r.exterior.coords)[:4]
        e1, e2 = c[1] - c[0], c[2] - c[1]
        l1, l2 = math.hypot(*e1), math.hypot(*e2)
        e, hl, hw = (e1, l1 / 2, l2 / 2) if l1 >= l2 else (e2, l2 / 2, l1 / 2)
        cx, cz = c.mean(0)
        out.append((float(cx), float(cz), max(hl, 0.5), max(hw, 0.5), math.atan2(e[1], e[0]) % math.pi))
    return out


def write_buildings(cfg, frame, recs, report):
    """Detail tiles (footprints) and mass tiles (oriented boxes), assigned by the box centre so both agree."""
    mc = cfg["metro"]
    dt, mt = mc["detailTile"], mc["massTile"]
    sky_h = mc["skylineHeight"]
    t0 = time.time()
    for d in ("bld", "mass"):
        for f in (OUT / d).glob("*.bin.gz"):
            f.unlink()
    det = defaultdict(list)
    mass = defaultdict(list)
    sky = []
    for r in recs:
        cx, cz, hl, hw, ang = r["box"]
        det[(math.floor(cx / dt), math.floor(cz / dt))].append(r)
        (sky if r["h"] >= sky_h else mass[(math.floor(cx / mt), math.floor(cz / mt))]).append(r)
    detail_index = []
    tot = 0
    for (i, j), rs in sorted(det.items()):
        ox, oz = (i + 0.5) * dt, (j + 0.5) * dt
        hb, ringc, vc, verts = [], [], [], []
        for r in rs:
            rings = [r["fp"]] + r["holes"]
            hb.append(struct.pack("<HhBBBBI", int(round(r["h"] * 10)), int(round(r["base"] * 10)), len(rings),
                                  USE_CODE.get(r["use"], 0), AGE_CODE.get(r["age"], 0),
                                  (1 if r["src"] == "overture" else 0) | (HSRC.index(r["hsrc"]) << 1), (int(r["id"]) * 2654435761 + r["sub"]) & 0xFFFFFFFF))
            for ring in rings:
                q = np.round((np.asarray(ring) - [ox, oz]) * 10).astype(np.int64)
                d = np.diff(q, axis=0, prepend=np.zeros((1, 2), np.int64))
                if np.abs(q).max() > 32767 or np.abs(d).max() > 32767:
                    raise ValueError(f"building {r['id']} exceeds the detail tile range")
                ringc.append(len(ring))
                verts.append(d.astype("<i2"))
        nb, nr = len(rs), len(ringc)
        v = np.vstack(verts) if verts else np.zeros((0, 2), "<i2")
        head = b"SZD1" + struct.pack("<IIIff", nb, nr, len(v), ox, oz)
        body = b"".join(hb) + np.asarray(ringc, "<u2").tobytes()
        if nr % 2:
            body += b"\0\0"
        size = write_gz(OUT / "bld" / f"{i}_{j}.bin.gz", head + body + v.tobytes())
        detail_index.append([i, j, nb, size])
        tot += size

    def mass_bytes(rs, ox, oz, span):
        q = 65535 / span
        out = bytearray()
        for r in rs:
            cx, cz, hl, hw, ang = r["box"]
            seed = (int(r["id"]) * 2654435761 + r["sub"]) & 0xFFFFFFFF
            out += struct.pack("<HHHHHhBBHB", int(round((cx - ox) * q)), int(round((cz - oz) * q)), min(65535, int(round(hl * 10))),
                               min(65535, int(round(hw * 10))), int(round(r["h"] * 10)), int(round(r["base"] * 10)),
                               int(round(ang / math.pi * 255)) & 255, USE_CODE.get(r["use"], 0) | (AGE_CODE.get(r["age"], 0) << 3),
                               min(65535, int(round(r["poly"].area))), seed >> 24)
        return bytes(out)

    mass_index = []
    pad = mc["massPad"]
    for (i, j), rs in sorted(mass.items()):
        ox, oz = i * mt - pad, j * mt - pad
        data = b"SZM1" + struct.pack("<Ifff", len(rs), ox, oz, mt + 2 * pad) + mass_bytes(rs, ox, oz, mt + 2 * pad)
        size = write_gz(OUT / "mass" / f"{i}_{j}.bin.gz", data)
        mass_index.append([i, j, len(rs), size])
        tot += size
    xs = np.array([r["box"][0] for r in sky] or [0.0])
    zs = np.array([r["box"][1] for r in sky] or [0.0])
    ox, oz = float(xs.min() - 10), float(zs.min() - 10)
    span = float(max(xs.max() - ox, zs.max() - oz) + 10)
    data = b"SZM1" + struct.pack("<Ifff", len(sky), ox, oz, span) + mass_bytes(sky, ox, oz, span)
    ss = write_gz(OUT / "skyline.bin.gz", data)
    tot += ss
    print(f"[bld] {len(detail_index)} detail tiles, {len(mass_index)} mass tiles, skyline {len(sky)} buildings >= {sky_h} m; "
          f"{tot / 1e6:.1f} MB gz ({time.time() - t0:.0f}s)")
    return dict(detailTile=dt, massTile=mt, detail=detail_index, mass=mass_index,
                skyline=dict(file="skyline.bin.gz", count=len(sky), minHeight=sky_h, bytes=ss), count=len(recs),
                heightSources=report.get("heightSources", {}),
                footprintSources=dict(osm=sum(1 for r in recs if r["src"] == "osm"), overture=sum(1 for r in recs if r["src"] == "overture")))


def build_buildings(cfg, osm, frame, full, h, report):
    """All buildings of 深圳市 outside the route corridor (which buildings.json draws), heights and base elevation."""
    t0 = time.time()
    bc, mc = cfg["buildings"], cfg["metro"]
    sz = boundary(osm, frame)
    osm_recs = osm_buildings(cfg, osm, frame)
    opens = load_open_space(osm, frame)
    ov = overture_buildings(cfg, frame, osm_recs, opens) if (ROOT / mc["overture"]).exists() else []
    recs = osm_recs + ov
    polys = np.asarray([r["poly"] for r in recs], dtype=object)
    cent = shapely.centroid(polys)
    keep = np.ones(len(recs), bool)
    drop = defaultdict(int)
    if sz is not None:
        inside = shapely.contains(sz, cent)
        drop["outside 深圳市"] = int((~inside).sum())
        recs = [r for r, k in zip(recs, inside) if k]
        polys, cent = polys[inside], cent[inside]
        keep = np.ones(len(recs), bool)
    if mc["heightModel"]["enabled"]:
        train_height_model(cfg, frame, recs, report)
    near = shapely.distance(polys, frame.line) <= bc["nearDist"]
    drop["route corridor (buildings.json)"] = int((near & keep).sum())
    keep &= ~near
    in_json = np.array([r["id"] in frame.corridor_ids for r in recs])
    drop["drawn by buildings.json"] = int((in_json & keep).sum())
    keep &= ~in_json
    sites = [Polygon(m["footprint"]).buffer(4) for m in frame.models if len(m.get("footprint", [])) >= 3]
    sites += [Polygon(l["footprint"]).buffer(4) for l in frame.route.get("landmarks", []) if len(l.get("footprint") or []) >= 3 and l["id"] != "lianhuashan"]
    if sites:
        st = shapely.STRtree(sites)
        a, _ = st.query(polys, predicate="intersects")
        hit = np.zeros(len(recs), bool)
        hit[a] = True
        drop["model / landmark site"] = int((hit & keep).sum())
        keep &= ~hit
    recs = [r for r, k in zip(recs, keep) if k]
    print(f"[bld] {len(recs)} buildings kept ({sum(1 for r in recs if r['src'] == 'osm')} OSM, {sum(1 for r in recs if r['src'] == 'overture')} Overture); dropped "
          + ", ".join(f"{k} {v}" for k, v in drop.items()))
    tall_overrides(recs, frame, ROOT / "data-raw" / "landmarks" / "tall_buildings.json", report, mc.get("heightOverrides", []))
    assign_heights(cfg, frame, recs, report)
    # footprints for the tiles, boxes, base elevation (lowest terrain under the outline)
    simp = mc["footprintSimplify"]
    for r in recs:
        p = r["poly"]
        s = p.simplify(simp, preserve_topology=True)
        if s.is_empty or s.geom_type != "Polygon":
            s = p
        ext = np.asarray(s.exterior.coords)[:-1]
        if len(ext) < 3:
            ext = np.asarray(p.exterior.coords)[:-1]
        r["fp"] = ext
        r["holes"] = [np.asarray(i.coords)[:-1] for i in s.interiors if Polygon(i).area >= mc["minHoleArea"] and len(i.coords) >= 4] if p.area >= mc["minHoleOwner"] else []
    for r, b in zip(recs, obbs([r["poly"] for r in recs])):
        r["box"] = b
    xy, ix = shapely.get_coordinates(shapely.get_exterior_ring([r["poly"] for r in recs]), return_index=True)
    cen = shapely.get_coordinates(shapely.centroid([r["poly"] for r in recs]))
    xy = np.vstack([xy, cen])
    ix = np.r_[ix, np.arange(len(recs))]
    hv = bilinear(h, full, xy[:, 0], xy[:, 1])
    base = np.full(len(recs), np.inf)
    np.minimum.at(base, ix, hv)
    for r, b in zip(recs, base):
        r["base"] = float(b)
    report["buildings"] = dict(count=len(recs), dropped=dict(drop))
    np.savez_compressed(ROOT / "data-raw" / "metro_buildings.npz",
                        x=np.array([r["box"][0] for r in recs]), z=np.array([r["box"][1] for r in recs]),
                        area=np.array([r["poly"].area for r in recs]), h=np.array([r["h"] for r in recs]),
                        model=np.array([r.get("modelHeight", np.nan) for r in recs]), base=np.array([r["base"] for r in recs]),
                        hsrc=np.array([HSRC.index(r["hsrc"]) for r in recs]), overture=np.array([r["src"] == "overture" for r in recs]))
    print(f"[bld] footprints and bases done ({time.time() - t0:.0f}s)")
    return recs


# ----------------------------------------------------------------------------
# roads and rail
# ----------------------------------------------------------------------------

RAIL_CLASS = 7


def road_width(t, rc):
    """Carriageway width (m) of a way: width tag, else lanes x laneWidth, else the class default (one-way or both)."""
    w = parse_height(t.get("width"))
    if w and 2 <= w <= 60:
        return w
    hw = t.get("highway", "")
    one = t.get("oneway") in ("yes", "1", "true", "-1") or hw in ("motorway", "motorway_link") or t.get("junction") == "roundabout"
    lv = parse_levels(t.get("lanes"))
    if lv and lv <= 12:
        return lv * rc["laneWidth"] + rc["shoulder"]
    base = rc["widths"].get(hw.replace("_link", "") if hw.endswith("_link") else hw, rc["widths"]["default"])
    if hw.endswith("_link"):
        return rc["linkWidth"]
    return base[0] if one else base[1]


def build_roads(cfg, osm, frame, full, h, report):
    """Roads and surface / elevated rail of 深圳市 as 3D centrelines (terrain-draped, bridges on a ramped deck),
    outside the route corridor the corridor road module draws; written as 2 km tiles."""
    t0 = time.time()
    rc, mc = cfg["metro"]["roads"], cfg["metro"]
    sz = boundary(osm, frame)
    reach = sz.buffer(rc["beyondBoundary"]) if sz is not None else None
    corridor = frame.line.buffer(rc["corridorClear"])
    node_ways = defaultdict(list)
    ways = []
    for w in osm["ways"]:
        t = w["tags"]
        hw, rw = t.get("highway"), t.get("railway")
        if hw in ROAD_CLASSES:
            cls = ROAD_CLASSES[hw]
            if hw == "service" and t.get("service") in ("parking_aisle", "driveway", "drive-through"):
                continue
        elif rw in RAIL_TYPES and t.get("usage") != "industrial":
            cls = RAIL_CLASS
        else:
            continue
        if t.get("tunnel") not in (None, "no") or t.get("covered") == "yes" or t.get("area") == "yes":
            continue
        lvl = (t.get("layer") or "0").split(";")[0]
        try:
            layer = int(float(lvl))
        except ValueError:
            layer = 0
        if layer < 0:
            continue
        bridge = t.get("bridge") not in (None, "no")
        ways.append(dict(id=w["id"], cls=cls, tags=t, refs=w["refs"], xz=frame.proj.fwd(w["ll"]), bridge=bridge, layer=max(layer, 1) if bridge else 0))
    for k, w in enumerate(ways):
        for end in (w["refs"][0], w["refs"][-1]):
            node_ways[end].append(k)
    out = defaultdict(list)
    n_pts = 0
    kept = 0
    for k, w in enumerate(ways):
        line = LineString(w["xz"])
        if line.length < 1:
            continue
        if reach is not None and not line.intersects(reach):
            continue
        # drop the parts inside the corridor (drawn by the corridor road module)
        if line.intersects(corridor):
            line = line.difference(corridor)
        parts = [g for g in getattr(line, "geoms", [line]) if g.geom_type == "LineString" and g.length >= 8]
        if not parts:
            continue
        kept += 1
        width = RAIL_TRACK if w["cls"] == RAIL_CLASS else road_width(w["tags"], rc)
        deck = rc["deckPerLayer"] * w["layer"] if w["bridge"] else 0.0
        # bridge ends that meet a ground-level way ramp down to it
        ground_end = []
        for end in (w["refs"][0], w["refs"][-1]):
            others = [ways[o] for o in node_ways[end] if o != k]
            ground_end.append(not others or any(not o["bridge"] for o in others))
        full_len = LineString(w["xz"]).length
        for part in parts:
            # resample along the part, keeping its arc position on the whole way for the ramps
            L = part.length
            n = max(2, int(math.ceil(L / rc["step"])) + 1)
            ss = np.linspace(0, L, n)
            pts = shapely.get_coordinates(shapely.line_interpolate_point(part, ss))
            s_way = shapely.line_locate_point(LineString(w["xz"]), shapely.points(pts)) if w["bridge"] else ss
            tan = np.gradient(pts, axis=0)
            tan /= np.maximum(np.linalg.norm(tan, axis=1, keepdims=True), 1e-6)
            nor = np.column_stack([-tan[:, 1], tan[:, 0]]) * (width / 2)
            tc = bilinear(h, full, pts[:, 0], pts[:, 1])
            tl = bilinear(h, full, pts[:, 0] + nor[:, 0], pts[:, 1] + nor[:, 1])
            tr = bilinear(h, full, pts[:, 0] - nor[:, 0], pts[:, 1] - nor[:, 1])
            ground = np.maximum(tc, np.maximum(tl, tr))
            curv = np.abs(tl + tr - 2 * tc)
            y = ground + rc["lift"] + rc["classLift"] * (7 - w["cls"]) + np.minimum(1.0, curv * 0.6)
            if w["bridge"]:
                ramp = np.ones(len(pts))
                if ground_end[0]:
                    ramp = np.minimum(ramp, s_way / rc["rampLength"])
                if ground_end[1]:
                    ramp = np.minimum(ramp, (full_len - s_way) / rc["rampLength"])
                # deck follows the higher of its two ends over water and valleys
                e0 = float(bilinear(h, full, *w["xz"][0]))
                e1 = float(bilinear(h, full, *w["xz"][-1]))
                level = np.maximum(ground, e0 + (e1 - e0) * np.clip(s_way / max(full_len, 1), 0, 1))
                y = np.maximum(y, level + rc["lift"] + deck * np.clip(ramp, 0, 1))
            mid = pts[len(pts) // 2]
            key = (math.floor(mid[0] / mc["detailTile"]), math.floor(mid[1] / mc["detailTile"]))
            out[key].append((w["cls"], w["bridge"], width, pts, y, ground))
            n_pts += len(pts)
    for f in (OUT / "roads").glob("*.bin.gz"):
        f.unlink()
    index = []
    tot = 0
    dt = mc["detailTile"]
    for (i, j), items in sorted(out.items()):
        ox, oz = (i + 0.5) * dt, (j + 0.5) * dt
        body = bytearray()
        written = 0
        for cls, br, width, pts, y, ground in items:
            # very long ways are split so every point stays within the tile's int16 range (+-3.2 km)
            for k0 in range(0, len(pts) - 1, 120):
                sl = slice(k0, min(len(pts), k0 + 121))
                q = np.round((pts[sl] - [ox, oz]) * 10).astype(np.int64)
                if np.abs(q).max() > 32767:
                    continue
                d = np.diff(q, axis=0, prepend=np.zeros((1, 2), np.int64))
                body += struct.pack("<BBBBH", cls, 1 if br else 0, min(255, int(round(width * 4))), 0, len(q))
                body += d.astype("<i2").tobytes()
                body += np.round(y[sl] * 10).astype("<i2").tobytes()
                if br:
                    body += np.round(ground[sl] * 10).astype("<i2").tobytes()
                written += 1
        data = b"SZR1" + struct.pack("<Iff", written, ox, oz) + bytes(body)
        size = write_gz(OUT / "roads" / f"{i}_{j}.bin.gz", data)
        index.append([i, j, written, size])
        tot += size
    print(f"[roads] {kept} ways ({sum(1 for w in ways if w['cls'] == RAIL_CLASS)} rail), {n_pts} points in {len(index)} tiles, "
          f"{tot / 1e6:.1f} MB gz ({time.time() - t0:.0f}s)")
    report["roads"] = dict(ways=kept, points=n_pts, tiles=len(index), bytes=tot)
    return dict(tile=dt, tiles=index, count=kept)


RAIL_TRACK = 4.0


# ----------------------------------------------------------------------------
# binary outputs
# ----------------------------------------------------------------------------


def write_gz(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(gzip.compress(data, compresslevel=9, mtime=0))
    return path.stat().st_size


def encode_heights(h):
    """Int16 decimetres, each row delta-coded left to right (the first value of a row is absolute)."""
    q = np.clip(np.round(h * 10), -32768, 32767).astype(np.int32)
    d = q.copy()
    d[:, 1:] = q[:, 1:] - q[:, :-1]
    if np.abs(d).max() > 32767:
        raise ValueError("height delta overflows int16")
    return d.astype("<i2").tobytes()


def crop(full, h, bbox_grid):
    i0 = int(round((bbox_grid.x0 - full.x0) / full.cell))
    j0 = int(round((bbox_grid.z0 - full.z0) / full.cell))
    i0, j0 = max(0, i0), max(0, j0)
    i1, j1 = min(full.nx, i0 + bbox_grid.nx), min(full.nz, j0 + bbox_grid.nz)
    g = Grid(full.x0 + i0 * full.cell, full.z0 + j0 * full.cell, full.cell, i1 - i0, j1 - j0)
    return g, h[j0:j1, i0:i1]


def downsample(full, h, k):
    nz, nx = (h.shape[0] // k) * k, (h.shape[1] // k) * k
    o = h[:nz, :nx].reshape(nz // k, k, nx // k, k).mean(axis=(1, 3))
    return Grid(full.x0, full.z0, full.cell * k, nx // k, nz // k), o.astype(np.float32)


def deshade(ground, grid, ac):
    """Per-cell factor that takes the imagery's own sun shading off the slopes (C-correction): the image was
    lit from sunAzimuth / sunElevation; the game lights the terrain itself."""
    gz, gx = np.gradient(ground.astype(np.float64), grid.cell)
    n = np.stack([-gx, np.ones_like(gx), -gz], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    az, el = math.radians(ac["sunAzimuth"]), math.radians(ac["sunElevation"])
    sun = np.array([math.sin(az) * math.cos(el), math.sin(el), -math.cos(az) * math.cos(el)])
    cos_i = np.clip(n @ sun, 0.0, 1.0)
    c = ac["deshadeC"]
    return np.clip((math.sin(el) + c) / (cos_i + c), ac["deshadeClamp"][0], ac["deshadeClamp"][1]).astype(np.float32)


def albedo_texture(cfg, frame, grid, width, path, report_key, report, shade=None):
    """Sentinel-2 reflectance resampled onto `grid`'s extent at `width` px, as an sRGB JPEG (linear albedo after
    decoding). shade = (grid, factor) of deshade() applied per pixel."""
    import rasterio
    from PIL import Image
    from scipy.ndimage import map_coordinates

    ac = cfg["metro"]["albedo"]
    hgt = int(round(width * grid.nz / grid.nx))
    px = (grid.nx * grid.cell) / width
    xs = grid.x0 + (np.arange(width) + 0.5) * px
    zs = grid.z0 + (np.arange(hgt) + 0.5) * (grid.nz * grid.cell / hgt)
    gx, gz = np.meshgrid(xs, zs)
    ll = frame.ll(gx, gz)
    with rasterio.open(ROOT / cfg["metro"]["imagery"]) as ds:
        t = ds.transform
        col = (ll[..., 0] - t.c) / t.a - 0.5
        row = (ll[..., 1] - t.f) / t.e - 0.5
        bands = []
        for b in (1, 2, 3):
            a = ds.read(b).astype(np.float32) / 10000.0
            bands.append(map_coordinates(a, [row.ravel(), col.ravel()], order=1, mode="nearest").reshape(gx.shape))
    rgb = np.stack(bands, -1)
    if shade is not None:
        sg, sf = shade
        rgb *= bilinear(sf, sg, gx, gz)[..., None]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    rgb = lum[..., None] + (rgb - lum[..., None]) * ac["saturation"]
    rgb = np.clip(rgb * ac["gain"], 0, 1)
    srgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    img = Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, quality=ac["jpegQuality"], optimize=True, progressive=False)
    report[report_key] = dict(width=width, height=hgt, metersPerPixel=round(px, 2), bytes=path.stat().st_size)
    print(f"[albedo] {path.name}: {width} x {hgt} px, {px:.1f} m/px, {path.stat().st_size / 1e6:.1f} MB")
    return dict(file=path.name, width=width, height=hgt)


def triangulate(poly):
    """Earcut triangles of a polygon with holes -> (verts (n, 2), tris (m, 3))."""
    import mapbox_earcut as earcut

    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None, None
    verts = np.vstack(rings).astype(np.float64)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = earcut.triangulate_float64(verts, ends).reshape(-1, 3)
    # earcut keeps the input ring orientation; face every triangle up (+y with x east, z south: 2D cross < 0)
    a, b, c = verts[tri[:, 0]], verts[tri[:, 1]], verts[tri[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = cross > 0
    tri[flip] = tri[flip][:, [0, 2, 1]]
    return verts, tri


def water_mesh(cfg, frame, sea, water, sea_y, tile_m, report):
    """Flat water triangles per tile_m tile: sea at sea_y, inland pieces at their level. One gz file with all tiles."""
    t0 = time.time()
    simp = cfg["metro"]["water"]["simplify"]
    tiles = defaultdict(lambda: ([], [], 0))
    def add(key, verts, tri, y):
        vs, ts, n = tiles[key]
        vs.append(np.column_stack([verts[:, 0], np.full(len(verts), y), verts[:, 1]]))
        ts.append(tri + n)
        tiles[key] = (vs, ts, n + len(verts))
    for p in sea:
        # simplify before cutting into tiles, so neighbouring tiles share their exact straight edge
        p = p.simplify(simp, preserve_topology=True)
        x0, z0, x1, z1 = p.bounds
        for i in range(math.floor(x0 / tile_m), math.floor(x1 / tile_m) + 1):
            for j in range(math.floor(z0 / tile_m), math.floor(z1 / tile_m) + 1):
                q = p.intersection(box(i * tile_m, j * tile_m, (i + 1) * tile_m, (j + 1) * tile_m))
                for g in getattr(q, "geoms", [q]):
                    if g.geom_type != "Polygon" or g.area < 50:
                        continue
                    v, t = triangulate(g)
                    if v is not None and len(t):
                        add((i, j), v, t, sea_y)
    for wp in water:
        g = wp["poly"].simplify(simp, preserve_topology=True)
        if g.is_empty or g.geom_type != "Polygon":
            continue
        c = g.representative_point()
        v, t = triangulate(g)
        if v is not None and len(t):
            add((math.floor(c.x / tile_m), math.floor(c.y / tile_m)), v, t, wp["y"])
    parts, index, nv_all, nt_all = [], [], 0, 0
    head = bytearray()
    for (i, j), (vs, ts, n) in sorted(tiles.items()):
        # world coordinates (not tile-relative): edges shared by neighbouring tiles stay bit-identical, no cracks
        v = np.vstack(vs)
        t = np.vstack(ts).astype("<u4")
        parts.append(struct.pack("<iiII", i, j, len(v), len(t) * 3) + v.astype("<f4").tobytes() + t.tobytes())
        nv_all += len(v)
        nt_all += len(t)
    data = b"SZW2" + struct.pack("<If", len(parts), tile_m) + b"".join(parts)
    size = write_gz(OUT / "water.bin.gz", data)
    report["waterMesh"] = dict(tiles=len(parts), vertices=nv_all, triangles=nt_all, bytes=size)
    print(f"[water] mesh: {len(parts)} tiles, {nv_all} vertices, {nt_all} triangles, {size / 1e6:.1f} MB gz in {time.time() - t0:.0f}s")


def write_terrain(cfg, frame, full, h, e0, w, ground, report):
    """Inner 30 m grid (metro bbox + innerPad) and outer 120 m grid (whole window) as gz height files, the
    corridor weight around the route, and the albedo textures."""
    mc, tc = cfg["metro"], cfg["metro"]["terrain"]
    want = Grid.covering(frame, mc["bbox"], full.cell, full.cell, pad=tc["innerPad"])
    inner, hi = crop(full, h, want)
    k = int(round(tc["outerCell"] / full.cell))
    outer, ho = downsample(full, h, k)
    si = write_gz(OUT / "terrain_inner.bin.gz", encode_heights(hi))
    so = write_gz(OUT / "terrain_outer.bin.gz", encode_heights(ho))
    print(f"[terrain] inner {inner.nx} x {inner.nz} ({si / 1e6:.1f} MB gz), outer {outer.nx} x {outer.nz} ({so / 1e6:.1f} MB gz)")
    js, is_ = np.nonzero(w > 0.002)
    pad = 4
    cg = Grid(full.x0 + (is_.min() - pad) * full.cell, full.z0 + (js.min() - pad) * full.cell, full.cell,
              is_.max() - is_.min() + 1 + 2 * pad, js.max() - js.min() + 1 + 2 * pad)
    cgrid, cw = crop(full, w, cg)
    sc = write_gz(OUT / "corridor.bin.gz", np.round(cw * 255).astype(np.uint8).tobytes())
    print(f"[terrain] corridor weight {cgrid.nx} x {cgrid.nz} cells ({sc / 1e3:.0f} KB gz)")
    shade = (full, deshade(ground, full, mc["albedo"]))
    ai = albedo_texture(cfg, frame, inner, mc["albedo"]["innerWidth"], OUT / "albedo_inner.jpg", "albedoInner", report, shade)
    ao = albedo_texture(cfg, frame, outer, mc["albedo"]["outerWidth"], OUT / "albedo_outer.jpg", "albedoOuter", report, shade)
    return dict(
        seaLevel=round(-e0, 3), routeElevation=round(e0, 2), groundY=tc["groundY"],
        flatInner=tc["flatInner"], flatOuter=tc["flatOuter"], innerBlend=tc["innerBlend"],
        inner=dict(**inner.meta(), file="terrain_inner.bin.gz", bytes=si, albedo=ai),
        outer=dict(**outer.meta(), file="terrain_outer.bin.gz", bytes=so, albedo=ao),
        corridor=dict(**cgrid.meta(), file="corridor.bin.gz"),
        min=round(float(h.min()), 2), max=round(float(h.max()), 2),
    ), inner, hi, outer, ho


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--only", choices=["osm", "terrain", "water", "buildings", "roads"])
    ap.add_argument("--no-plot", action="store_true")
    args = ap.parse_args()
    cfg = json.loads(CFG_PATH.read_text())
    osm = load_osm(cfg, args.rebuild)
    if args.only == "osm":
        return
    frame = Frame()
    report = {}
    t0 = time.time()
    fp = [p for b in osm["buildings"] for p in osm_polygon(frame, b["polys"], holes=False)]
    full, h, e0, sea, water, w, ground = build_terrain(cfg, frame, fp, report)
    np.save(ROOT / "data-raw" / "metro_terrain_dev.npy", h)
    terrain_meta, inner, hi, outer, ho = write_terrain(cfg, frame, full, h, e0, w, ground, report)
    water_mesh(cfg, frame, sea, water, -e0, cfg["metro"]["massTile"], report)
    meta_path = OUT / "metro.json"
    old = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta = dict(version=1, generatedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                origin=frame.route["meta"]["origin"], terrain=terrain_meta,
                water=dict(file="water.bin.gz", tile=cfg["metro"]["massTile"], **report.get("waterMesh", {})))
    if args.only in (None, "buildings"):
        recs = build_buildings(cfg, osm, frame, full, h, report)
        meta["buildings"] = write_buildings(cfg, frame, recs, report)
    elif "buildings" in old:
        meta["buildings"] = old["buildings"]
    if args.only in (None, "roads"):
        meta["roads"] = build_roads(cfg, osm, frame, full, h, report)
    elif "roads" in old:
        meta["roads"] = old["roads"]
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    (ROOT / "data-raw" / "metro_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
