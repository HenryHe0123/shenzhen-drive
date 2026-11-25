#!/usr/bin/env python3
"""Offline city-data pipeline for SHENZHEN DRIVE.

Reads the Geofabrik Guangdong extract (data-raw/guangdong-latest.osm.pbf), caches a
small corridor extract plus a parsed pickle in data-raw/, and writes

  public/data/route.json      (RouteData, see src/route/types.ts)
  public/data/buildings.json  (BuildingsData)
  evidence/route_plot.png     (top-down sanity plot)

All tunables (cuts, turn road, landmark ids, height rules) live in
scripts/city_config.json. Re-running is deterministic.

Usage:
  .venv/bin/python scripts/build_city_data.py [--rebuild] [--no-plot]
"""

from __future__ import annotations

import argparse
import datetime as dt
import heapq
import json
import math
import pickle
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium
import shapely
import shapely.affinity
import shapely.ops
from shapely.geometry import LineString, Point, Polygon

ROOT = Path(__file__).resolve().parent.parent
CFG_PATH = ROOT / "scripts" / "city_config.json"
CACHE_VERSION = 5

# ----------------------------------------------------------------------------
# geo
# ----------------------------------------------------------------------------

WGS_A = 6378137.0
WGS_E2 = 6.69437999014e-3


class Proj:
    """Local equirectangular projection: x = east m, z = south m."""

    def __init__(self, lon0: float, lat0: float):
        phi = math.radians(lat0)
        w = math.sqrt(1.0 - WGS_E2 * math.sin(phi) ** 2)
        self.kx = math.radians(1.0) * WGS_A / w * math.cos(phi)
        self.ky = math.radians(1.0) * WGS_A * (1.0 - WGS_E2) / w**3
        self.lon0, self.lat0 = lon0, lat0
        self.off = np.zeros(2)

    def fwd(self, ll):
        ll = np.asarray(ll, float)
        xz = np.stack([(ll[..., 0] - self.lon0) * self.kx, -(ll[..., 1] - self.lat0) * self.ky], axis=-1)
        return xz - self.off

    def inv(self, xz):
        xz = np.asarray(xz, float) + self.off
        return np.stack([self.lon0 + xz[..., 0] / self.kx, self.lat0 - xz[..., 1] / self.ky], axis=-1)


# ----------------------------------------------------------------------------
# OSM extract + parse (cached)
# ----------------------------------------------------------------------------

DRIVABLE = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}


def make_extract(src: Path, dst: Path, bbox):
    W, S, E, N = bbox
    t0 = time.time()
    print(f"[extract] cutting {bbox} from {src.name} -> {dst.name} (one-time, ~1-2 min)")
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
                if o.tags.get("type") in ("multipolygon", "building") and any(
                    m.type == "w" and m.ref in way_ids for m in o.members
                ):
                    wr.add_relation(o)
    tmp.replace(dst)
    print(f"[extract] {len(node_ids)} nodes, {len(way_ids)} ways in {time.time() - t0:.0f}s")


def pbf_timestamp(path: Path):
    try:
        fp = osmium.FileProcessor(str(path), osmium.osm.NOTHING)
        h = fp.header
        ts = h.get("osmosis_replication_timestamp") or h.get("timestamp")
        return ts or None
    except Exception:  # noqa: BLE001
        return None


def parse_osm(extract: Path, keywords):
    """Pull highways, buildings and keyword-named features out of the extract."""
    t0 = time.time()
    ways = {}  # id -> dict(tags, refs, ll)
    buildings = []  # dict(id, kind, tags, ring(list of (lon, lat)))
    named = []  # dict(kind, id, tags, ll | ring)
    open_space = []  # rings (parks, water, plazas, parking, ...) kept free of filler buildings
    street = dict(bus_stops=[], subway_entrances=[], footbridges=[])  # roadside furniture (v0.5.0)
    kw_re = re.compile("|".join(re.escape(k) for k in keywords))
    keep_tags = ("name", "highway", "oneway", "lanes", "junction", "layer", "bridge", "tunnel", "ref", "name:en")
    for o in osmium.FileProcessor(str(extract)).with_areas():
        t = o.tags
        if o.is_node():
            nm = " ".join(v for k, v in t if k.startswith("name") or k in ("alt_name", "official_name", "brand"))
            if nm and kw_re.search(nm):
                named.append(dict(kind="n", id=o.id, tags=dict(t), ll=(o.location.lon, o.location.lat)))
            if t.get("highway") == "bus_stop" or t.get("public_transport") == "platform" and t.get("bus") != "no" and t.get("railway") is None:
                street["bus_stops"].append(dict(id=o.id, name=t.get("name"), ll=(o.location.lon, o.location.lat)))
            elif t.get("railway") == "subway_entrance":
                street["subway_entrances"].append(dict(id=o.id, name=t.get("name"), ref=t.get("ref"), ll=(o.location.lon, o.location.lat)))
        elif o.is_way():
            hw = t.get("highway")
            if hw in ("footway", "path", "pedestrian", "steps", "cycleway") and t.get("bridge") not in (None, "no"):
                try:
                    street["footbridges"].append(dict(id=o.id, name=t.get("name"), layer=t.get("layer"), ll=[(n.lon, n.lat) for n in o.nodes]))
                except osmium.InvalidLocationError:
                    pass
            if hw in DRIVABLE:
                try:
                    ll = [(n.lon, n.lat) for n in o.nodes]
                except osmium.InvalidLocationError:
                    continue
                ways[o.id] = dict(
                    tags={k: t.get(k) for k in keep_tags if k in t},
                    refs=[n.ref for n in o.nodes],
                    ll=ll,
                )
        elif o.is_area():
            nm = " ".join(v for k, v in t if k.startswith("name") or k in ("alt_name", "official_name", "brand"))
            is_bld = "building" in t and t.get("building") != "no"
            hit = bool(nm and kw_re.search(nm))
            is_open = not is_bld and is_open_space(t)
            if not (is_bld or hit or is_open):
                continue
            try:
                rings = []
                for outer in o.outer_rings():
                    rings.append([(n.lon, n.lat) for n in outer])
            except osmium.InvalidLocationError:
                continue
            if not rings:
                continue
            ring = max(rings, key=lambda r: abs(_ring_area_ll(r)))
            rec = dict(kind="w" if o.from_way() else "r", id=o.orig_id(), tags=dict(t), ring=ring)
            if is_bld:
                buildings.append(rec)
            if hit:
                named.append(rec)
            if is_open:
                open_space.extend(rings)
    print(f"[parse] {len(ways)} drivable ways, {len(buildings)} buildings, {len(named)} named hits, "
          f"{len(open_space)} open-space rings, " + ", ".join(f"{len(v)} {k}" for k, v in street.items()) + f" in {time.time() - t0:.0f}s")
    return dict(ways=ways, buildings=buildings, named=named, open=open_space, street=street)


OPEN_TAGS = {
    "leisure": {"park", "garden", "pitch", "stadium", "playground", "golf_course", "track", "nature_reserve", "common", "dog_park"},
    "landuse": {"grass", "forest", "recreation_ground", "meadow", "cemetery", "village_green", "flowerbed", "orchard", "basin", "reservoir", "railway",
                "construction", "brownfield"},
    "natural": {"water", "wood", "scrub", "grassland", "wetland", "heath", "beach", "bare_rock"},
    "amenity": {"parking", "grave_yard", "fountain"},
    "place": {"square"},
    "tourism": {"theme_park", "zoo", "camp_site"},
    "water": {"lake", "pond", "reservoir", "river", "canal"},
}


def is_open_space(t):
    if t.get("parking") in ("underground", "multi-storey", "rooftop"):
        return False
    if t.get("highway") == "pedestrian" and t.get("area") == "yes":
        return True
    return any(t.get(k) in v for k, v in OPEN_TAGS.items())


def _ring_area_ll(r):
    a = 0.0
    for i in range(len(r) - 1):
        a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
    return a / 2


def load_osm(cfg, rebuild=False):
    src = ROOT / cfg["osm"]["pbf"]
    ext = ROOT / cfg["osm"]["extract"]
    cache = ROOT / cfg["osm"]["cache"]
    if rebuild or not ext.exists():
        if not src.exists():
            sys.exit(f"missing {src}; run sh data-raw/download.sh")
        make_extract(src, ext, cfg["osm"]["bbox"])
    if not rebuild and cache.exists() and cache.stat().st_mtime > ext.stat().st_mtime:
        with open(cache, "rb") as f:
            d = pickle.load(f)
        if d.get("version") == CACHE_VERSION and d.get("keywords") == cfg["osm"]["keywords"]:
            return d
    d = parse_osm(ext, cfg["osm"]["keywords"])
    d["version"] = CACHE_VERSION
    d["keywords"] = cfg["osm"]["keywords"]
    d["timestamp"] = pbf_timestamp(src) if src.exists() else pbf_timestamp(ext)
    with open(cache, "wb") as f:
        pickle.dump(d, f, protocol=pickle.HIGHEST_PROTOCOL)
    return d


# ----------------------------------------------------------------------------
# polyline helpers
# ----------------------------------------------------------------------------


def arclen(p):
    seg = np.hypot(*np.diff(p, axis=0).T)
    return np.concatenate([[0.0], np.cumsum(seg)])


def dedupe(p, eps=1e-6):
    p = np.asarray(p, float)
    keep = np.concatenate([[True], np.hypot(*np.diff(p, axis=0).T) > eps])
    return p[keep]


def resample(p, step, s_from=None, s_to=None):
    p = dedupe(p)
    s = arclen(p)
    a = 0.0 if s_from is None else s_from
    b = s[-1] if s_to is None else s_to
    n = max(2, int(round((b - a) / step)) + 1)
    q = np.linspace(a, b, n)
    return np.column_stack([np.interp(q, s, p[:, 0]), np.interp(q, s, p[:, 1])])


def gaussian_smooth(p, sigma, step=1.0):
    """Resample at `step` then Gaussian-smooth x/z with linear end extrapolation."""
    q = resample(p, step)
    r = int(math.ceil(3 * sigma / step))
    if r < 1 or len(q) < 3:
        return q
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * step / sigma) ** 2)
    k /= k.sum()
    d0 = q[0] - q[1]
    d1 = q[-1] - q[-2]
    head = q[0] + d0 * np.arange(r, 0, -1)[:, None]
    tail = q[-1] + d1 * np.arange(1, r + 1)[:, None]
    ext = np.vstack([head, q, tail])
    return np.column_stack([np.convolve(ext[:, 0], k, "valid"), np.convolve(ext[:, 1], k, "valid")])


class Polyline:
    def __init__(self, pts):
        self.p = dedupe(pts)
        self.s = arclen(self.p)
        self.length = float(self.s[-1])
        self.line = LineString(self.p)

    def at(self, s):
        s = np.clip(np.asarray(s, float), 0, self.length)
        return np.stack([np.interp(s, self.s, self.p[:, 0]), np.interp(s, self.s, self.p[:, 1])], axis=-1)

    def tangent(self, s, span=0.0):
        s = np.asarray(s, float)
        if span > 0:
            v = self.at(s + span) - self.at(s - span)
        else:
            i = np.clip(np.searchsorted(self.s, s, side="right") - 1, 0, len(self.p) - 2)
            v = self.p[i + 1] - self.p[i]
        return v / np.linalg.norm(v, axis=-1, keepdims=True)

    def heading(self, s, span=0.0):
        t = self.tangent(s, span)
        return np.arctan2(t[..., 1], t[..., 0])

    def project(self, pts):
        """Global nearest projection -> (s, d); d > 0 right of travel direction."""
        pts = np.atleast_2d(np.asarray(pts, float))
        if getattr(self, "_tree", None) is None:
            self._tree = shapely.STRtree(shapely.linestrings(np.stack([self.p[:-1], self.p[1:]], axis=1)))
            self._seg = np.diff(self.p, axis=0)
            self._seglen = np.hypot(self._seg[:, 0], self._seg[:, 1])
        ii, jj = self._tree.query_nearest(shapely.points(pts), all_matches=False)
        k = np.empty(len(pts), dtype=int)
        k[ii] = jj
        A, AB, L = self.p[k], self._seg[k], self._seglen[k]
        t = np.clip(((pts - A) * AB).sum(1) / (L * L), 0.0, 1.0)
        v = pts - (A + t[:, None] * AB)
        tan = AB / L[:, None]
        return self.s[k] + t * L, -v[:, 0] * tan[:, 1] + v[:, 1] * tan[:, 0]

    def slice(self, a, b, step=1.0):
        a, b = max(0.0, a), min(self.length, b)
        inner = self.p[(self.s > a) & (self.s < b)]
        return np.vstack([self.at(a)[None], inner, self.at(b)[None]])


def rot2(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s], [s, c]])


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


# ----------------------------------------------------------------------------
# road graph
# ----------------------------------------------------------------------------


def is_oneway(tags):
    ow = tags.get("oneway")
    if ow in ("yes", "1", "true"):
        return 1
    if ow == "-1":
        return -1
    if tags.get("junction") == "roundabout" or tags.get("highway") == "motorway":
        return 1
    return 0


class Graph:
    def __init__(self, ways, proj, accept):
        """accept(way_id, tags) -> cost multiplier or None (excluded)."""
        self.adj = defaultdict(list)
        self.xy = {}
        for wid, w in ways.items():
            m = accept(wid, w["tags"])
            if m is None:
                continue
            xy = proj.fwd(w["ll"])
            refs = w["refs"]
            for r, p in zip(refs, xy):
                self.xy[r] = p
            ow = is_oneway(w["tags"])
            for i in range(len(refs) - 1):
                a, b = refs[i], refs[i + 1]
                L = float(np.hypot(*(xy[i + 1] - xy[i])))
                if ow >= 0:
                    self.adj[a].append((b, L * m, wid))
                if ow <= 0:
                    self.adj[b].append((a, L * m, wid))

    def nearest(self, p, cand=None):
        ids = list(cand if cand is not None else self.xy.keys())
        P = np.array([self.xy[i] for i in ids])
        k = int(np.argmin(np.hypot(*(P - p).T)))
        return ids[k], float(np.hypot(*(P[k] - p)))

    def bridge_gaps(self, max_gap=80.0, max_angle=40.0):
        """Connect dead ends to nodes ahead (fixes small OSM gaps at interchanges)."""
        indeg = defaultdict(int)
        prev = {}
        for a, lst in self.adj.items():
            for b, _, _ in lst:
                indeg[b] += 1
                prev[b] = a
        ids = list(self.xy.keys())
        P = np.array([self.xy[i] for i in ids])
        added = 0
        for n in ids:
            if self.adj.get(n) or n not in prev:
                continue
            d_in = self.xy[n] - self.xy[prev[n]]
            d_in /= np.linalg.norm(d_in) + 1e-9
            v = P - self.xy[n]
            dist = np.hypot(*v.T)
            cosang = (v @ d_in) / (dist + 1e-9)
            ok = (dist > 0.5) & (dist < max_gap) & (cosang > math.cos(math.radians(max_angle)))
            if ok.any():
                k = int(np.argmin(np.where(ok, dist, np.inf)))
                self.adj[n].append((ids[k], float(dist[k]) * 1.5, -1))
                added += 1
        return added

    def dijkstra(self, src, dst):
        dist = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == dst:
                break
            if d > dist.get(u, math.inf):
                continue
            for v, c, wid in self.adj.get(u, ()):
                nd = d + c
                if nd < dist.get(v, math.inf):
                    dist[v] = nd
                    prev[v] = (u, wid)
                    heapq.heappush(pq, (nd, v))
        if dst not in dist:
            return None, None
        path, wids = [dst], []
        while path[-1] != src:
            u, wid = prev[path[-1]]
            path.append(u)
            wids.append(wid)
        path.reverse()
        wids.reverse()
        return path, wids

    def coords(self, path):
        return np.array([self.xy[n] for n in path])


# ----------------------------------------------------------------------------
# route centerline
# ----------------------------------------------------------------------------


def compass(v):
    """Compass bearing (deg, 0 = north, 90 = east) of an x/z vector."""
    return math.degrees(math.atan2(v[0], -v[1])) % 360


def way_travel_bearing(w, proj):
    xy = proj.fwd(w["ll"])
    v = xy[-1] - xy[0]
    if is_oneway(w["tags"]) == -1:
        v = -v
    return compass(v)


def build_chain(ways, proj, name_re, highways, want_deg, src_pt, dst_pt, label):
    """Shortest directed path along one named road, restricted to carriageways
    travelling roughly `want_deg`; snaps src/dst to nodes of such carriageways."""
    rx = re.compile(name_re)
    hw = set(highways)

    def accept(_wid, t):
        return 1.0 if t.get("highway") in hw and rx.search(t.get("name", "")) else None

    g = Graph(ways, proj, accept)
    nb = g.bridge_gaps()
    cand = set()
    for wid, w in ways.items():
        if accept(wid, w["tags"]) and is_oneway(w["tags"]) != 0:
            if abs((way_travel_bearing(w, proj) - want_deg + 180) % 360 - 180) <= 50:
                cand.update(w["refs"])
    src, e0 = g.nearest(np.asarray(src_pt), cand)
    dst, e1 = g.nearest(np.asarray(dst_pt), cand)
    path, wids = g.dijkstra(src, dst)
    if path is None:
        sys.exit(f"[route] no path for {label}")
    pts = g.coords(path)
    used = sorted({w for w in wids if w > 0})
    print(
        f"[route] {label}: {len(path)} nodes, {len(used)} ways, {arclen(pts)[-1]:.0f} m "
        f"(snap {e0:.0f}/{e1:.0f} m, {sum(1 for w in wids if w < 0)} gap bridges used of {nb})"
    )
    return pts, used


def fillet(S: Polyline, N: Polyline, R: float, fit=50.0):
    """Join incoming S and outgoing N (which cross) with a tangent circular arc."""
    inter = S.line.intersection(N.line)
    pts = [inter] if inter.geom_type == "Point" else list(getattr(inter, "geoms", []))
    if not pts:
        sys.exit("[route] main road and turn road do not cross")
    P = np.array(pts[0].coords[0])
    sP = S.line.project(Point(P))
    nP = N.line.project(Point(P))
    u = S.at(sP) - S.at(sP - fit)
    u /= np.linalg.norm(u)
    v = N.at(nP + fit) - N.at(nP)
    v /= np.linalg.norm(v)
    a1, a2 = S.at(sP - fit / 2), N.at(nP + fit / 2)
    t, _ = np.linalg.solve(np.column_stack([u, -v]), a2 - a1)
    C = a1 + t * u
    theta = math.acos(float(np.clip(u @ v, -1, 1)))
    T = R * math.tan(theta / 2)
    A, B = C - u * T, C + v * T
    cross = u[0] * v[1] - u[1] * v[0]
    direction = "left" if cross < 0 else "right"  # x/z frame has z = south
    nl = np.array([u[1], -u[0]]) if cross < 0 else np.array([-u[1], u[0]])
    ctr = A + nl * R
    phA = math.atan2(A[1] - ctr[1], A[0] - ctr[0])
    phB = math.atan2(B[1] - ctr[1], B[0] - ctr[0])
    dph = wrap(phB - phA)
    n = max(8, int(abs(dph) * R / 0.5))
    ph = phA + dph * np.linspace(0, 1, n + 1)
    arc = np.column_stack([ctr[0] + R * np.cos(ph), ctr[1] + R * np.sin(ph)])
    sA = S.line.project(Point(A))
    nB = N.line.project(Point(B))
    err = max(np.linalg.norm(S.at(sA) - A), np.linalg.norm(N.at(nB) - B), abs(np.linalg.norm(B - ctr) - R))
    info = dict(theta=math.degrees(theta), T=T, direction=direction, err=err, sA=sA, nB=nB, corner=C, arcLen=abs(dph) * R)
    return arc, info


class Features:
    """Lookup of parsed OSM objects by 'w123' / 'r123' / 'n123'."""

    def __init__(self, osm):
        self.idx = {}
        for rec in osm["named"]:
            self.idx[f"{rec['kind']}{rec['id']}"] = rec
        for rec in osm["buildings"]:
            self.idx[f"{rec['kind']}{rec['id']}"] = rec

    def get(self, ref):
        return self.idx.get(ref)

    def geom(self, ref, proj):
        """-> (centroid xz, ring xz or None, tags)"""
        rec = self.idx.get(ref)
        if rec is None:
            return None
        if "ring" in rec:
            ring = proj.fwd(rec["ring"])
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            c = np.array(poly.centroid.coords[0])
            return c, ring[:-1] if np.allclose(ring[0], ring[-1]) else ring, rec["tags"]
        return proj.fwd(rec["ll"]), None, rec["tags"]


def build_route(osm, cfg, proj, feats, quiet=False):
    """Chains route.legs (one named road each, on the carriageway travelling its bearing) and joins
    consecutive legs with tangent circular fillets at their crossing."""
    rc = cfg["route"]
    ways = osm["ways"]
    ll = lambda p: proj.fwd(np.asarray(p, float))  # noqa: E731

    tencent = feats.geom(rc["startLandmark"], proj)
    finish_lm = feats.geom(rc["finishLandmark"], proj)
    if tencent is None or finish_lm is None:
        sys.exit("[route] start/finish landmark not found in OSM extract")

    legs = []
    for lg in rc["legs"]:
        raw, used = build_chain(ways, proj, lg["regex"], lg["highways"], lg["bearing"], ll(lg["from"]), ll(lg["to"]),
                                f"{lg['name']} heading {lg['bearing']} deg")
        p = gaussian_smooth(raw, rc["smoothSigma"])
        if lg.get("offset"):
            t = np.gradient(p, axis=0)
            t /= np.linalg.norm(t, axis=1, keepdims=True)
            p = p + np.column_stack([-t[:, 1], t[:, 0]]) * lg["offset"]
        legs.append(dict(cfg=lg, P=Polyline(p), ways=used))
    fillets = []
    for prev, nxt in zip(legs, legs[1:]):
        arc, fi = fillet(prev["P"], nxt["P"], nxt["cfg"]["radius"])
        if fi["direction"] != nxt["cfg"].get("turn", fi["direction"]):
            print(f"[route] WARNING: turn onto {nxt['cfg']['name']} is {fi['direction']}, expected {nxt['cfg']['turn']}")
        fillets.append((arc, fi))

    S = legs[0]["P"]
    sT, dT = S.project(tencent[0][None])
    s_start = float(sT[0]) - rc["startBeforeTencent"]
    if s_start < 0:
        sys.exit("[route] main chain does not reach far enough west of the start landmark")

    # finish: abeam the finish landmark's centroid on the last leg
    last = legs[-1]["P"]
    nF, _ = last.project(finish_lm[0][None])
    n_finish = float(nF[0]) + rc.get("finishOffset", 0.0)
    n_end = n_finish + rc["runout"]
    if n_end > last.length:
        sys.exit("[route] last leg too short for the run-out")

    pieces, turns, leg_ranges = [], [], []
    a, s = s_start, 0.0
    for i, lg in enumerate(legs):
        b = fillets[i][1]["sA"] if i < len(fillets) else n_end
        if b <= a + 1:
            sys.exit(f"[route] leg {lg['cfg']['name']} has no straight part between its turns")
        part = lg["P"].slice(a, b)
        pieces.append(part if i == 0 else part[1:])
        leg_ranges.append((s, s + b - a, lg["cfg"]))
        if i == len(legs) - 1:
            s_finish = s + n_finish - a
        s += b - a
        if i < len(fillets):
            arc, fi = fillets[i]
            pieces[-1] = pieces[-1][:-1]
            pieces.append(arc)
            nm = legs[i + 1]["cfg"]
            turns.append(dict(s0=s, s1=s + fi["arcLen"], direction=fi["direction"], name=nm["name"], radius=nm["radius"], fi=fi))
            s += fi["arcLen"]
            a = fi["nB"]
    U = np.vstack(pieces)
    if not quiet:
        for t in turns:
            fi = t["fi"]
            print(f"[route] turn {t['direction']:5} onto {t['name']}: {fi['theta']:.1f} deg, R={t['radius']} m, tangent {fi['T']:.1f} m, "
                  f"arc {fi['arcLen']:.1f} m, join error {fi['err'] * 100:.1f} cm, s_orig {t['s0']:.0f}-{t['s1']:.0f}")
        print(f"[route] start {float(dT[0]):.0f} m lateral from start landmark; finish {s_finish:.0f}, run-out {rc['runout']} m")
    return dict(U=U, turns=turns, legs=leg_ranges, s_finish=s_finish, s_start=s_start, S_ways=legs[0]["ways"])


def opposite_chains(osm, cfg, proj):
    """Opposite-direction carriageway of every leg (same named road, reversed bearing)."""
    rc = cfg["route"]
    ll = lambda p: proj.fwd(np.asarray(p, float))  # noqa: E731
    out = []
    for lg in rc["legs"]:
        pts, _ = build_chain(osm["ways"], proj, lg["regex"], lg["highways"], (lg["bearing"] + 180) % 360,
                             ll(lg["to"]), ll(lg["from"]), f"{lg['name']} opposite carriageway")
        out.append(Polyline(gaussian_smooth(pts, rc["smoothSigma"])))
    return out


CROSS_HW = ("trunk", "primary", "secondary", "tertiary", "unclassified")
CROSS_SKIP = re.compile(r"辅路|辅道|立交|匝道|隧道|通道|出口|入口")


def cross_streets(osm, cfg, proj, U: Polyline, R, buf=12.0, min_angle=35.0, turn_margin=55.0):
    """Named roads meeting the uncut centerline (crossings and T-junctions) -> sorted [(s_orig, name)].
    Skips the road being driven at s and, around each turn, the two roads the turn joins."""
    skip = [(a, b, re.compile(lg["regex"])) for a, b, lg in R["legs"]]
    for t, (_, _, lg0), (_, _, lg1) in zip(R["turns"], R["legs"], R["legs"][1:]):
        for lg in (lg0, lg1):
            skip.append((t["s0"] - turn_margin, t["s1"] + turn_margin, re.compile(lg["regex"])))
    corridor = U.line.buffer(buf)
    hits = defaultdict(list)
    for w in osm["ways"].values():
        t = w["tags"]
        name = t.get("name", "")
        if not name or t.get("highway") not in CROSS_HW or CROSS_SKIP.search(name):
            continue
        xy = proj.fwd(w["ll"])
        line = LineString(xy)
        if not line.intersects(corridor):
            continue
        inter = line.intersection(corridor)
        for g in getattr(inter, "geoms", [inter]):
            if g.is_empty or g.length > 4 * buf:
                continue
            p = np.array(g.interpolate(0.5, normalized=True).coords[0])
            s, _ = U.project(p[None])
            s = float(s[0])
            gc = np.asarray(g.coords)
            v = gc[-1] - gc[0]
            if np.linalg.norm(v) < 1:
                continue
            tan = U.tangent(np.clip(s, 1, U.length - 1), 5.0)
            ang = math.degrees(math.acos(min(1.0, abs(float(v @ tan)) / np.linalg.norm(v))))
            if ang < min_angle:
                continue
            if any(a <= s <= b and rx.search(name) for a, b, rx in skip):
                continue
            hits[name].append(s)
    out = []
    for name, ss in hits.items():
        ss.sort()
        cl = [ss[0]]
        for s in ss[1:] + [math.inf]:
            if s - cl[-1] < 120:
                cl.append(s)
            else:
                out.append((float(np.mean(cl)), name))
                cl = [s]
    return sorted(out)


# ----------------------------------------------------------------------------
# cuts: remove [s0, s1] intervals and rigidly re-attach later pieces
# ----------------------------------------------------------------------------


class Splicer:
    def __init__(self, U: Polyline, cuts, span=20.0):
        self.U = U
        self.cuts = sorted((float(c["s0"]), float(c["s1"])) for c in cuts)
        for (_, b0), (a1, _) in zip(self.cuts, self.cuts[1:]):
            if b0 >= a1:
                sys.exit("[cuts] overlapping cut intervals")
        self.starts = np.array([0.0] + [b for _, b in self.cuts])
        self.ends = np.array([a for a, _ in self.cuts] + [U.length])
        self.rot, self.trans, self.offset = [0.0], [np.zeros(2)], [0.0]
        for a, b in self.cuts:
            th0, t0 = self.rot[-1], self.trans[-1]
            Pa = rot2(th0) @ U.at(a) + t0
            th = wrap(float(U.heading(a, span)) + th0 - float(U.heading(b, span)))
            self.rot.append(th)
            self.trans.append(Pa - rot2(th) @ U.at(b))
            self.offset.append(self.offset[-1] + (b - a))
        self.offset = np.array(self.offset)
        self.fstarts = self.starts - self.offset

    def piece(self, s):
        """Kept piece index for original s (-1 inside a cut)."""
        s = np.atleast_1d(np.asarray(s, float))
        k = np.clip(np.searchsorted(self.starts, s, side="right") - 1, 0, None)
        return np.where(s > self.ends[k] + 1e-9, -1, k)

    def s_final(self, s):
        s = np.atleast_1d(np.asarray(s, float))
        k = self.piece(s)
        return np.where(k >= 0, s - self.offset[np.maximum(k, 0)], np.nan)

    def s_orig(self, sf):
        sf = np.atleast_1d(np.asarray(sf, float))
        k = np.clip(np.searchsorted(self.fstarts, sf, side="right") - 1, 0, None)
        return sf + self.offset[k]

    def apply(self, pts, k):
        return np.asarray(pts, float) @ rot2(self.rot[k]).T + self.trans[k]

    def spliced(self):
        out = []
        for k, (a, b) in enumerate(zip(self.starts, self.ends)):
            seg = self.apply(self.U.slice(a, b), k)
            out.append(seg if k == 0 else seg[1:])
        return np.vstack(out)


# ----------------------------------------------------------------------------
# heights
# ----------------------------------------------------------------------------

NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")


def parse_height(v):
    if not v:
        return None
    v = v.strip().lower().replace(",", ".")
    m = NUM_RE.search(v)
    if not m:
        return None
    h = float(m.group())
    if "ft" in v or "'" in v:
        h *= 0.3048
    return h if h > 0 else None


def parse_levels(v):
    if not v:
        return None
    nums = [float(x) for x in NUM_RE.findall(v.replace(",", "."))]
    nums = [n for n in nums if n > 0]
    return max(nums) if nums else None


def hash01(oid: int, salt: int = 0) -> float:
    """Deterministic uniform [0, 1) from an OSM id (splitmix64)."""
    z = (oid * 0x9E3779B97F4A7C15 + salt * 0xBF58476D1CE4E5B9 + 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    z ^= z >> 31
    return (z & 0xFFFFFFFFFFFF) / float(1 << 48)


def building_height(tags, zone, area, oid, hc, cmab_h=None, cmab_first=None):
    """(height, source): OSM height > OSM levels > CMAB > zone estimate. cmab_first(levels_height)
    True lets CMAB win over the levels height in height bands where calibration found it closer."""
    h = parse_height(tags.get("height"))
    if h:
        return h, "tag"
    lv = parse_levels(tags.get("building:levels"))
    if lv:
        hl = lv * hc["levelHeight"] + hc.get("roofAllowance", 0.0)
        if cmab_h and cmab_first and cmab_first(hl):
            return cmab_h, "cmab"
        return hl, "levels"
    if cmab_h:
        return cmab_h, "cmab"
    btype = tags.get("building", "yes")
    r = hash01(oid)
    if btype in hc["lowTypes"]:
        lo, hi = hc["lowRange"]
    elif btype in hc["midTypes"]:
        lo, hi = hc["midRange"]
    else:
        z = hc["zones"][zone]
        lo, hi = next(rng for amax, rng in z if area < amax)
    return lo + (hi - lo) * r**1.3, "estimated"


OSM_USE = {
    "office": "office",
    "commercial": "commercial", "retail": "commercial", "supermarket": "commercial", "hotel": "commercial", "kiosk": "commercial",
    "residential": "residential", "apartments": "residential", "house": "residential", "dormitory": "residential", "detached": "residential",
    "terrace": "residential", "semidetached_house": "residential",
    "industrial": "industrial", "warehouse": "industrial", "factory": "industrial", "manufacture": "industrial",
    "school": "public", "university": "public", "college": "public", "hospital": "public", "public": "public", "civic": "public",
    "government": "public", "kindergarten": "public", "museum": "public", "library": "public", "train_station": "public",
    "transportation": "public", "sports_hall": "public", "stadium": "public", "theatre": "public", "church": "public", "temple": "public",
}


CMAB_USE = {"居住": "residential", "办公": "office", "商服": "commercial", "公服": "public", "工业": "industrial"}
# CMAB age = first year GAIA sees the pixel built up (1986 = in or before 1986, AF2018 = after 2018)
CMAB_AGE = {**{str(y): f"{y // 10 * 10}s" for y in range(1980, 2019)}, "AF2018": "2020s"}


def building_use(tags, cm, mi):
    """office / residential / commercial / public / industrial from the OSM building tag, else CMAB's predicted function."""
    u = OSM_USE.get(tags.get("building", ""))
    if u:
        return u
    if cm is not None and mi is not None:
        return CMAB_USE.get(str(cm["use"][mi]))
    return None


def building_age(tags, cm, mi):
    """Construction period: OSM start_date / building:year decade, else CMAB's age class."""
    m = re.search(r"(1[89]\d\d|20\d\d)", tags.get("start_date", "") or tags.get("building:year", "") or "")
    if m:
        return f"{int(m.group(1)) // 10 * 10}s"
    if cm is not None and mi is not None:
        return CMAB_AGE.get(str(cm["age"][mi]))
    return None


def load_cmab(cfg, proj):
    """CMAB rooftops clipped to the OSM bbox (data-raw/cmab/*.parquet, written by scripts/clip_cmab.py):
    local-metre polygons with height, function and age, plus an STRtree. None when the file is missing."""
    cc = cfg.get("cmab")
    if not cc:
        return None
    path = ROOT / cc["path"]
    if not path.exists():
        print(f"[cmab] {path.relative_to(ROOT)} missing; run sh data-raw/download.sh cmab")
        return None
    import pyarrow.parquet as pq

    t = pq.read_table(path)
    geoms = shapely.from_wkb(t.column("wkb").to_numpy(zero_copy_only=False))
    geoms = shapely.transform(geoms, lambda ll: proj.fwd(ll))
    geoms = shapely.make_valid(geoms)
    keep = ~shapely.is_empty(geoms) & (shapely.area(geoms) >= 4)
    geoms = geoms[keep]
    col = lambda k: np.asarray(t.column(k).to_numpy(zero_copy_only=False))[keep]  # noqa: E731
    cm = dict(polys=geoms, h=col("height").astype(float), use=col("function"), age=col("age"),
              cent=shapely.centroid(geoms), tree=shapely.STRtree(geoms))
    print(f"[cmab] {len(geoms)} rooftops from {path.relative_to(ROOT)}")
    return cm


def cmab_skip(cc, area):
    """True for footprint sizes where calibration found CMAB no better than the zone estimate."""
    lo, hi = cc.get("skipArea", (0, 0))
    return lo <= area < hi


def cmab_match(poly, cm, min_overlap):
    """Index of the CMAB rooftop matching an OSM footprint: overlap > min_overlap of the footprint or its
    centroid inside it; the largest overlap wins. None when nothing matches."""
    if cm is None:
        return None
    best = None
    for i in cm["tree"].query(poly, predicate="intersects"):
        a = poly.intersection(cm["polys"][i]).area
        if a > min_overlap * poly.area or poly.contains(cm["cent"][i]):
            if best is None or a > best[0]:
                best = (a, int(i))
    return None if best is None else best[1]


def cmab_calibration(rows, hc):
    """rows: (tags, cmab height). Prints CMAB vs OSM height and CMAB vs levels x levelHeight, per band."""
    tag = [(parse_height(t.get("height")), h) for t, h in rows if parse_height(t.get("height"))]
    if tag:
        e = np.array([c - o for o, c in tag])
        rel = np.array([abs(c - o) / o for o, c in tag])
        print(f"[cmab] calibration on {len(tag)} OSM buildings with `height`: median |error| {np.median(np.abs(e)):.1f} m "
              f"({np.median(rel):.0%}), bias (CMAB - OSM) median {np.median(e):+.1f} m, mean {np.mean(e):+.1f} m")
        for lo, hi in ((0, 30), (30, 100), (100, 1e9)):
            sel = [(o, c) for o, c in tag if lo <= o < hi]
            if sel:
                ee = np.array([c - o for o, c in sel])
                print(f"[cmab]   height {lo:.0f}-{hi if hi < 1e9 else '':>3} m: n {len(sel)}, median |error| {np.median(np.abs(ee)):.1f} m, bias {np.median(ee):+.1f} m")
    lv = [(t, h) for t, h in rows if not parse_height(t.get("height")) and parse_levels(t.get("building:levels"))]
    both = [(parse_height(t.get("height")), parse_levels(t.get("building:levels")) * hc["levelHeight"] + hc.get("roofAllowance", 0.0), h)
            for t, h in rows if parse_height(t.get("height")) and parse_levels(t.get("building:levels"))]
    if both:
        print(f"[cmab] on {len(both)} buildings with both `height` and levels (truth = `height`):")
        for lo, hi in ((0, 30), (30, 100), (100, 1e9)):
            sel = [(o, l, c) for o, l, c in both if lo <= l < hi]
            if sel:
                el = np.median([abs(l - o) for o, l, _ in sel])
                ec = np.median([abs(c - o) for o, _, c in sel])
                win = sum(abs(c - o) < abs(l - o) for o, l, c in sel)
                print(f"[cmab]   levels height {lo:.0f}-{hi if hi < 1e9 else '':>3} m: n {len(sel)}, median |error| levels {el:.1f} m, "
                      f"CMAB {ec:.1f} m; CMAB closer for {win}")
    if lv:
        d = np.array([h - (parse_levels(t.get("building:levels")) * hc["levelHeight"] + hc.get("roofAllowance", 0.0)) for t, h in lv])
        print(f"[cmab] {len(lv)} buildings with levels only: CMAB - levels height median {np.median(d):+.1f} m, median |diff| {np.median(np.abs(d)):.1f} m")


# ----------------------------------------------------------------------------
# assembly
# ----------------------------------------------------------------------------


def gauss1d(v, sigma_samples):
    r = int(math.ceil(3 * sigma_samples))
    if r < 1:
        return v
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_samples) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(v, r, mode="edge"), k, "valid")


def round_pts(p, nd=1):
    return [[round(float(x), nd), round(float(z), nd)] for x, z in p]


def resolve_anchor(spec, xs_map, lm_s, R):
    """Original-frame s of an anchor: s, turn<N>Start/End (1-based), turnStart/End (last turn),
    finish, landmark:<id> or a cross-street name."""
    at = spec.get("at")
    if "s" in spec:
        return float(spec["s"])
    m = re.match(r"^turn(\d*)(Start|End)$", at or "")
    if m:
        t = R["turns"][int(m.group(1)) - 1 if m.group(1) else -1]
        return t["s0"] if m.group(2) == "Start" else t["s1"]
    if at == "finish":
        return R["s_finish"]
    if at and at.startswith("landmark:"):
        return lm_s[at.split(":", 1)[1]]
    if at in xs_map:
        return xs_map[at]
    sys.exit(f"[config] cannot resolve anchor {spec}")


def opposite_orig(cfg, Ws, U: Polyline, R):
    """Smoothed lateral offset of the opposite carriageway on the original s grid: each leg's
    opposite-direction chain projected onto that leg; bridged linearly through the turns."""
    oc = cfg["opposite"]
    grid = np.arange(0.0, U.length + 2.0, 2.0)
    raw = np.full(len(grid), np.nan)
    for W, (a, b, lg) in zip(Ws, R["legs"]):
        if "oppositeFixed" in lg:
            raw[(grid >= a) & (grid <= b)] = lg["oppositeFixed"]
            print(f"[opposite] {lg['name']}: fixed {lg['oppositeFixed']} m")
            continue
        s_w, d_w = U.project(W.at(np.arange(0.0, W.length, 2.0)))
        m = (d_w < -4) & (d_w > -150) & (s_w > a + 15) & (s_w < b - 15)
        if m.sum() < 2:
            print(f"[opposite] {lg['name']}: no opposite carriageway found, using {oc['undivided']} m")
            raw[(grid >= a) & (grid <= b)] = oc["undivided"]
            continue
        o = np.argsort(s_w[m])
        sel = (grid >= s_w[m].min()) & (grid <= s_w[m].max())
        raw[sel] = np.interp(grid[sel], s_w[m][o], d_w[m][o])
        print(f"[opposite] {lg['name']}: median offset {np.median(d_w[m]):.1f} m")
    ok = ~np.isnan(raw)
    raw = np.interp(grid, grid[ok], raw[ok])
    return grid, np.clip(gauss1d(raw, oc["smoothSigma"] / 2.0), oc["min"], oc["max"])


SIDE_ROAD_NAME = re.compile(r"辅路|辅道")


def side_roads(cfg, osm, proj, U, opp_o, grid):
    """Lateral centre offset of the side road (辅路) on each side, on the original 2 m s grid (NaN where there
    is none), and its lane count. Candidates: ways named *辅路 / *辅道, or unnamed secondary / tertiary /
    unclassified ways, running parallel to the route (right side in the driving direction, left side against
    it when one-way), between minGap and maxGap beyond the carriageway edge."""
    sc = cfg["sideRoads"]
    edge = cfg["road"]["halfWidthRight"] + 0.3
    out = {}
    for side in ("right", "left"):
        best = np.full(len(grid), np.nan)
        lanes = np.full(len(grid), np.nan)
        for w in osm["ways"].values():
            t = w["tags"]
            nm = t.get("name", "")
            if not (SIDE_ROAD_NAME.search(nm) or (not nm and t.get("highway") in ("secondary", "tertiary", "unclassified"))):
                continue
            xy = resample(proj.fwd(w["ll"]), 2.0)
            if len(xy) < 4:
                continue
            s, d = U.project(xy)
            ds = np.diff(s)
            par = np.abs(ds) / np.maximum(np.hypot(*np.diff(xy, axis=0).T), 1e-6) > 0.94
            ow = is_oneway(t)
            fwd = np.sign(np.median(ds)) * (1 if ow >= 0 else -1)
            if ow != 0 and fwd != (1 if side == "right" else -1):
                continue
            ss, dd = (s[:-1] + s[1:]) / 2, (d[:-1] + d[1:]) / 2
            opp = np.interp(ss, grid, opp_o)
            gap = dd - edge if side == "right" else (opp - edge) - dd
            ok = par & (gap > sc["minGap"]) & (gap < sc["maxGap"]) & (ss > 1) & (ss < U.length - 1)
            n = parse_levels(t.get("lanes")) or sc["defaultLanes"]
            for si, gi in zip(ss[ok], gap[ok]):
                i = int(round(si / 2.0))
                if 0 <= i < len(grid) and not (gi >= best[i]):
                    best[i], lanes[i] = gi, n
        # fill short holes, drop short runs, smooth inside runs, keep a planted separator
        ok = ~np.isnan(best)
        idx = np.nonzero(ok)[0]
        if len(idx):
            for a, b in zip(idx[:-1], idx[1:]):
                if 1 < b - a <= sc["fillGap"] / 2.0:
                    best[a:b + 1] = np.interp(np.arange(a, b + 1), [a, b], [best[a], best[b]])
                    lanes[a:b + 1] = lanes[a]
        ok = ~np.isnan(best)
        runs, i = [], 0
        while i < len(ok):
            if ok[i]:
                j = i
                while j + 1 < len(ok) and ok[j + 1]:
                    j += 1
                runs.append((i, j))
                i = j + 1
            else:
                i += 1
        gap = np.full(len(grid), np.nan)
        ln = np.full(len(grid), np.nan)
        for a, b in runs:
            if (b - a) * 2.0 < sc["minRun"]:
                continue
            g = gauss1d(best[a:b + 1], sc["smoothSigma"] / 2.0)
            n = float(np.median(lanes[a:b + 1]))
            hw = n * sc["laneWidth"] / 2
            gap[a:b + 1] = np.maximum(g, sc["minSeparator"] + hw)
            ln[a:b + 1] = n
        centre = edge + gap if side == "right" else np.interp(grid, grid, opp_o) - edge - gap
        out[side] = (centre, ln)
        cov = np.mean(~np.isnan(gap))
        print(f"[side] {side}: side road along {cov:.0%} of the route, {sum(1 for a, b in runs if (b - a) * 2 >= sc['minRun'])} runs, "
              f"median gap to the carriageway edge {np.nanmedian(gap) if cov else float('nan'):.1f} m")
    return out


def road_margins(cfg, sr, grid, opp_o):
    """margins(s) -> (right, opposite): a footprint vertex at (s, d) is on the road corridor when
    opp(s) - opposite < d < right. Constant buildings.rightMargin / oppositeMargin, widened to the outer
    edge of the side road plus buildingSetback (its curb and sidewalk) where there is one."""
    bc, sc = cfg["buildings"], cfg.get("sideRoads", {})
    if not sr:
        return lambda s: (np.full(np.shape(s), bc["rightMargin"], float), np.full(np.shape(s), bc["oppositeMargin"], float))
    (rc, rn), (lc, ln) = sr["right"], sr["left"]
    right = rc + rn * sc["laneWidth"] / 2 + sc["buildingSetback"]
    opp = (opp_o - lc) + ln * sc["laneWidth"] / 2 + sc["buildingSetback"]
    right = np.where(np.isnan(right), bc["rightMargin"], np.maximum(bc["rightMargin"], right))
    opp = np.where(np.isnan(opp), bc["oppositeMargin"], np.maximum(bc["oppositeMargin"], opp))
    return lambda s: (np.interp(s, grid, right), np.interp(s, grid, opp))


def street_furniture(cfg, osm, proj, U, sp, sf, F, L, opp_o, grid):
    """Footbridges crossing the route, bus stops and subway entrances beside it, in final route coordinates."""
    fc = cfg["streetFurniture"]
    edge = cfg["road"]["halfWidthRight"] + 0.3
    st = osm.get("street") or {}
    bridges = []
    for b in st.get("footbridges", []):
        xy = proj.fwd(b["ll"])
        if len(xy) < 2:
            continue
        line = LineString(xy)
        if not line.intersects(U.line):
            continue
        for g in getattr(line.intersection(U.line), "geoms", [line.intersection(U.line)]):
            if g.geom_type != "Point":
                continue
            p = np.array(g.coords[0])
            s0, _ = U.project(p[None])
            s0 = float(s0[0])
            if sp.piece(np.array([s0]))[0] < 0:
                continue
            k = int(np.argmin(np.hypot(*(xy - p).T)))
            a, c = xy[max(k - 1, 0)], xy[min(k + 1, len(xy) - 1)]
            tan = U.tangent(np.clip(s0, 1, U.length - 1), 5.0)
            v = (c - a) / (np.linalg.norm(c - a) + 1e-9)
            if abs(float(v @ tan)) > math.cos(math.radians(45)):
                continue
            s_v, d_v = U.project(xy)
            near = np.abs(s_v - s0) < fc["bridgeMaxSpan"]
            opp = float(np.interp(s0, grid, opp_o))
            d0, d1 = float(d_v[near].min()), float(d_v[near].max())
            d0, d1 = max(d0, opp - fc["bridgeMaxReach"]), min(d1, fc["bridgeMaxReach"])
            if d1 < edge + 2 or d0 > opp - edge - 2:
                continue
            ang = math.atan2(float(v @ tan), float(v @ np.array([-tan[1], tan[0]])))
            ang = (ang + math.pi / 2) % math.pi - math.pi / 2
            bridges.append(dict(s=round(sf(s0), 1), d0=round(d0, 1), d1=round(d1, 1), skew=round(ang, 3), osmId=b["id"]))
    bridges.sort(key=lambda r: r["s"])
    dedup = []
    for r in bridges:
        if dedup and abs(r["s"] - dedup[-1]["s"]) < fc["bridgeMinSpacing"]:
            continue
        dedup.append(r)

    def beside(items, max_out, min_spacing, label):
        recs = []
        for it in items:
            p = proj.fwd(np.array(it["ll"]))
            s0, d0 = U.project(p[None])
            s0, d0 = float(s0[0]), float(d0[0])
            if not (5 < s0 < U.length - 5) or sp.piece(np.array([s0]))[0] < 0:
                continue
            opp = float(np.interp(s0, grid, opp_o))
            if edge < d0 < edge + max_out:
                side = "right"
            elif opp - edge - max_out < d0 < opp - edge:
                side = "left"
            else:
                continue
            rec = dict(s=round(sf(s0), 1), d=round(d0, 1), side=side)
            if it.get("name"):
                rec["name"] = it["name"]
            recs.append(rec)
        recs.sort(key=lambda r: (r["side"], r["s"]))
        out = []
        for r in recs:
            if out and out[-1]["side"] == r["side"] and r["s"] - out[-1]["s"] < min_spacing:
                continue
            out.append(r)
        out.sort(key=lambda r: r["s"])
        print(f"[street] {len(out)} {label} ({sum(1 for r in out if r['side'] == 'right')} right, {sum(1 for r in out if r['side'] == 'left')} left)")
        return out

    stops = beside(st.get("bus_stops", []), fc["stopMaxOut"], fc["stopMinSpacing"], "bus stops")
    exits = beside(st.get("subway_entrances", []), fc["entranceMaxOut"], fc["entranceMinSpacing"], "subway entrances")
    print(f"[street] {len(dedup)} footbridges cross the route at s " + ", ".join(f"{r['s']:.0f}" for r in dedup))
    return dedup, stops, exits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="re-cut the corridor extract and re-parse")
    ap.add_argument("--no-plot", action="store_true")
    ap.add_argument("--plan", action="store_true", help="print curvature/landmark profile for choosing cuts")
    args = ap.parse_args()
    cfg = json.loads(CFG_PATH.read_text())
    t0 = time.time()
    osm = load_osm(cfg, args.rebuild)
    feats = Features(osm)
    rc = cfg["route"]

    # pass 1 finds the start point; pass 2 re-projects everything centred on it
    p0 = Proj(*rc["hints"]["mainStart"])
    r0 = build_route(osm, cfg, p0, feats, quiet=True)
    origin = p0.inv(r0["U"][0])
    proj = Proj(float(origin[0]), float(origin[1]))
    R = build_route(osm, cfg, proj, feats)
    proj.off = R["U"][0].copy()
    R["U"] = R["U"] - proj.off
    origin = proj.inv(np.zeros(2))
    U = Polyline(resample(R["U"], 0.5))
    print(f"[route] origin {origin[0]:.6f}, {origin[1]:.6f}; real length {U.length:.0f} m; "
          f"{len(R['turns'])} turns; finish s {R['s_finish']:.0f}")
    xs = cross_streets(osm, cfg, proj, U, R)
    if args.plan:
        plan_report(cfg, proj, feats, U, R, xs)
        return

    lanes_report(osm, R, proj, U)

    # ---- landmarks (original frame) ----
    lms = []
    for lm in cfg["landmarks"]:
        g = feats.geom(lm["osm"], proj)
        if g is None:
            print(f"[landmark] MISSING {lm['id']} ({lm['osm']})")
            continue
        c, ring, tags = g
        if lm.get("footprintFrom"):
            g2 = feats.geom(lm["footprintFrom"], proj)
            ring = g2[1] if g2 else None
        h = lm.get("height")
        if h is None:
            h = parse_height(tags.get("height")) or parse_height(tags.get("ele"))
            if h is None and parse_levels(tags.get("building:levels")):
                h = parse_levels(tags.get("building:levels")) * cfg["heights"]["levelHeight"]
        s_o, d_o = U.project(c[None])
        if lm.get("maxDistFromFinish"):
            fin = U.at(R["s_finish"])
            if np.linalg.norm(c - fin) > lm["maxDistFromFinish"]:
                print(f"[landmark] {lm['id']} skipped: too far from finish")
                continue
        lms.append(dict(cfg=lm, c=c, ring=ring, h=h, s_o=float(s_o[0]), d_o=float(d_o[0])))
    lm_s = {l["cfg"]["id"]: l["s_o"] for l in lms}

    # ---- cuts ----
    sp = Splicer(U, cfg["cuts"])
    protect = [(lm_s[k], k) for k in cfg["cutProtect"]["landmarks"] if k in lm_s]
    xs_map = {}
    for s, n in xs:
        xs_map.setdefault(n, s)
    protect += [(xs_map[n], n) for n in cfg["cutProtect"]["intersections"] if n in xs_map]
    protect += [(t["s0"], f"turn onto {t['name']}") for t in R["turns"]]
    leg0_end = R["legs"][0][1]
    for a, b in sp.cuts:
        if b > leg0_end - cfg["cutProtect"]["minDist"]:
            sys.exit(f"[cuts] cut {a:.0f}-{b:.0f} reaches into the CBD detour (main road ends at s {leg0_end:.0f})")
        for s, what in protect:
            gap = max(a - s, s - b)
            if gap < cfg["cutProtect"]["minDist"]:
                print(f"[cuts] WARNING cut {a:.0f}-{b:.0f} only {gap:.0f} m from {what}")
    F = Polyline(sp.spliced())
    step = rc["sampleSpacing"]
    L = math.floor(F.length / step + 1e-6) * step
    ss = np.arange(0.0, L + step / 2, step)
    cl = F.at(ss)
    sf = lambda s: float(sp.s_final(s)[0])  # noqa: E731
    print(f"[cuts] {len(sp.cuts)} cuts, removed {sp.offset[-1]:.0f} m; final length {L:.0f} m "
          f"({L / U.length:.1%} of real); splice rotations "
          + ", ".join(f"{math.degrees(r):+.2f} deg" for r in sp.rot[1:]))

    # ---- opposite carriageway, side roads ----
    grid, opp_o = opposite_orig(cfg, opposite_chains(osm, cfg, proj), U, R)
    opp_f = np.interp(sp.s_orig(ss), grid, opp_o)
    opp_f = np.clip(gauss1d(opp_f, cfg["opposite"]["spliceSigma"] / step), cfg["opposite"]["min"], cfg["opposite"]["max"])
    sr = side_roads(cfg, osm, proj, U, opp_o, grid) if cfg.get("sideRoads", {}).get("enabled") else None
    margins = road_margins(cfg, sr, grid, opp_o)
    turns_f = [dict(s0=round(sf(t["s0"]), 1), s1=round(sf(t["s1"]), 1), direction=t["direction"], name=t["name"],
                    radius=t["radius"]) for t in R["turns"]]

    # ---- sections / checkpoints / intersections / signs ----
    sections = []
    for i, sec in enumerate(cfg["sections"]):
        s0 = 0.0 if sec["from"] == "start" else sf(resolve_anchor({"at": sec["from"]}, xs_map, lm_s, R))
        sections.append(dict(id=sec["id"], name=sec["name"], s0=s0))
    for i, sec in enumerate(sections):
        sec["s1"] = sections[i + 1]["s0"] if i + 1 < len(sections) else L
    sec_bounds_orig = [sp.s_orig(np.array([sec["s0"]]))[0] if sec["s0"] > 0 else -1e9 for sec in sections]

    def zone_of(s_o):
        k = int(np.searchsorted(sec_bounds_orig, s_o, side="right") - 1)
        return sections[max(k, 0)]["id"]

    checkpoints = []
    for cp in cfg["checkpoints"]:
        s = sf(resolve_anchor(cp, xs_map, lm_s, R)) + cp.get("offset", 0.0)
        name = cp.get("name") or cp["at"]
        checkpoints.append(dict(s=round(s, 1), name=name))
    finish = dict(s=round(sf(R["s_finish"]), 1), name=rc["finishName"])
    intersections = []
    for s, n in xs:
        s_f = sf(s)
        if not math.isnan(s_f) and 0 < s_f < L:
            intersections.append(dict(s=round(s_f, 1), name=n))
    signs = []
    for sg in cfg["signs"]:
        s = sf(resolve_anchor(sg, xs_map, lm_s, R)) + sg.get("offset", 0.0)
        rec = dict(s=round(s, 1), side=sg["side"], text=sg["text"])
        if sg.get("sub"):
            rec["sub"] = sg["sub"]
        signs.append(rec)

    # ---- landmarks (final frame) ----
    landmarks = []
    for l in lms:
        k = int(sp.piece(np.clip(l["s_o"], 0, U.length))[0])
        if k < 0:
            print(f"[landmark] WARNING {l['cfg']['id']} falls inside a cut")
            continue
        c = sp.apply(l["c"][None], k)[0]
        s_f, d_f = F.project(c[None])
        rec = dict(id=l["cfg"]["id"], name=l["cfg"]["name"], osmId=int(l["cfg"]["osm"][1:]),
                   x=round(float(c[0]), 1), z=round(float(c[1]), 1),
                   s=round(float(np.clip(s_f[0], 0, L)), 1), d=round(float(d_f[0]), 1))
        if l["ring"] is not None:
            poly = Polygon(sp.apply(l["ring"], k)).simplify(cfg["buildings"]["simplify"])
            rec["footprint"] = round_pts(np.asarray(poly.exterior.coords)[:-1])
        if l["h"]:
            rec["height"] = round(float(l["h"]), 1)
        landmarks.append(rec)

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    route = dict(
        meta=dict(
            generatedAt=now,
            osmTimestamp=osm.get("timestamp"),
            source=cfg["source"],
            origin=dict(lon=round(float(origin[0]), 7), lat=round(float(origin[1]), 7)),
            realLength=round(U.length, 1),
            length=round(L, 1),
            cuts=[dict(s0=c["s0"], s1=c["s1"], note=c.get("note", "")) for c in sorted(cfg["cuts"], key=lambda c: c["s0"])],
            sampleSpacing=step,
        ),
        centerline=round_pts(cl, 3),
        road=cfg["road"],
        oppositeOffset=[round(float(v), 2) for v in opp_f],
        sections=[dict(id=s["id"], name=s["name"], s0=round(s["s0"], 1), s1=round(s["s1"], 1)) for s in sections],
        checkpoints=checkpoints,
        finish=finish,
        turns=turns_f,
        turn=turns_f[-1],
        intersections=intersections,
        landmarks=landmarks,
        signs=signs,
    )
    if sr:
        so = sp.s_orig(ss)
        runs = []
        for side, key in (("right", "sideRoadRight"), ("left", "sideRoadLeft")):
            c, n = (np.interp(so, grid, v) for v in sr[side])
            route[key] = [None if math.isnan(v) else round(float(v), 2) for v in c]
            i = 0
            while i < len(c):
                if math.isnan(c[i]):
                    i += 1
                    continue
                j = i
                while j + 1 < len(c) and not math.isnan(c[j + 1]):
                    j += 1
                runs.append(dict(side=side, s0=round(float(ss[i]), 1), s1=round(float(ss[j]), 1), lanes=int(round(float(np.nanmedian(n[i:j + 1]))))))
                i = j + 1
        route["sideRoadLanes"] = sorted(runs, key=lambda r: r["s0"])
    if cfg.get("streetFurniture", {}).get("enabled"):
        route["footbridges"], route["busStops"], route["subwayEntrances"] = street_furniture(cfg, osm, proj, U, sp, sf, F, L, opp_o, grid)
    out_dir = ROOT / "public" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- real-building models, registered in the original frame ----
    models, _ = load_city_models(cfg)
    regs, reg_polys = register_city_models(cfg, osm, proj, models) if models else ([], None)
    model_obstacles = [r["sil_o"] for r in regs
                       if not (r["cfg"].get("landmark") and not r["cfg"].get("replaceLandmark") and not r["cfg"].get("part"))]

    # ---- buildings (view corridors run after the fillers so fillers cannot re-block) ----
    cm = load_cmab(cfg, proj)
    blds, hs, obstacles = build_buildings(cfg, osm, proj, U, sp, F, L, grid, opp_o, zone_of, lms, cm, margins)
    ov_blds, _, ov_polys = overture_buildings(cfg, osm, proj, U, sp, L, grid, opp_o, zone_of, lms, load_overture(cfg, proj), cm, margins)
    fill = procedural_fill(cfg, osm, proj, U, sp, L, grid, opp_o, zone_of, obstacles + ov_polys + model_obstacles, lms)
    blds = sorted(blds + ov_blds + fill, key=lambda r: (r["s"], r["id"]))
    final_s = lambda v: v if isinstance(v, (int, float)) else (  # noqa: E731
        sf(resolve_anchor({"at": v} if isinstance(v, str) else v, xs_map, lm_s, R)) + (v.get("offset", 0.0) if isinstance(v, dict) else 0.0))
    blds, zones = apply_view_corridors(cfg, route, blds, F, final_s)
    if zones:
        route["clearZones"] = zones
    city_records, model_report = [], None
    if regs:
        city_records, blds, model_report = finalize_city_models(cfg, regs, reg_polys, route, blds, sp, U, F, L, route["oppositeOffset"])
    view_check(cfg, route, blds, city_records)
    route.pop("_sight", None)
    lap = lap_time(cl, step, cfg["race"], route["finish"]["s"])
    print(f"[lap] optimal lap estimate {lap['time'] // 60:.0f}:{lap['time'] % 60:05.2f} "
          f"(top {lap['vmax'] * 3.6:.0f} km/h, slowest corner {lap['vmin_corner'] * 3.6:.0f} km/h, "
          f"{lap['full'] / 1000:.1f} km at > 300 km/h)")
    hs = dict(tag=0, levels=0, cmab=0, overture=0, estimated=0)
    for b in blds:
        hs[b.pop("_src", "estimated")] += 1
    write_json(out_dir / "route.json", route)
    print(f"[out] route.json {(out_dir / 'route.json').stat().st_size / 1024:.0f} KB")
    footprints = dict(osm=sum(1 for b in blds if b["id"] > 0 and b.get("src") != "overture"),
                      overture=sum(1 for b in blds if b.get("src") == "overture"), procedural=sum(1 for b in blds if b["id"] < 0))
    bdata = dict(
        meta=dict(generatedAt=now, osmTimestamp=osm.get("timestamp"), count=len(blds), heightSources=hs, footprintSources=footprints),
        buildings=blds,
    )
    write_json(out_dir / "buildings.json", bdata, compact=True)
    real = len(blds) - footprints["procedural"]
    print(f"[out] buildings.json {(out_dir / 'buildings.json').stat().st_size / 1024:.0f} KB, {len(blds)} buildings, heights {hs}, "
          f"footprints {footprints}; real footprints with a data-backed height {1 - (hs['estimated'] - footprints['procedural']) / max(1, real):.1%}")
    if cfg.get("cityModelDefaults"):
        write_city_models(cfg, city_records, now)

    ok = validate(route, bdata, cfg)
    coverage_report(cfg, osm, proj, U, sp, R, ov_polys)
    if not args.no_plot:
        (ROOT / "evidence").mkdir(exist_ok=True)
        plot(route, bdata, sp, U, F, ROOT / "evidence" / "route_plot.png")
        if model_report:
            plot_city_models(route, bdata, model_report, ROOT / "evidence" / "city_models_registration.png")
    print(f"done in {time.time() - t0:.1f}s")
    if not ok:
        sys.exit(1)


def write_json(path, obj, compact=False):
    if compact:
        txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    else:
        parts = []
        for k, v in obj.items():
            if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
                inner = ",\n".join("    " + json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in v)
                parts.append(f'  "{k}": [\n{inner}\n  ]')
            else:
                parts.append(f'  "{k}": ' + json.dumps(v, ensure_ascii=False, separators=(",", ":")))
        txt = "{\n" + ",\n".join(parts) + "\n}\n"
    path.write_text(txt, encoding="utf-8")


def lanes_report(osm, R, proj, U):
    tot = defaultdict(float)
    for wid in R["S_ways"]:
        w = osm["ways"][wid]
        L = arclen(proj.fwd(w["ll"]))[-1]
        tot[w["tags"].get("lanes", "?")] += L
    s = sum(tot.values())
    print("[road] main-road lanes tag by length: " + ", ".join(f"{k}: {v / s:.0%}" for k, v in sorted(tot.items())))


# ----------------------------------------------------------------------------
# buildings
# ----------------------------------------------------------------------------


def build_buildings(cfg, osm, proj, U, sp, F, L, grid, opp_o, zone_of, lms, cm=None, margins=None):
    bc, hc = cfg["buildings"], cfg["heights"]
    margins = margins or road_margins(cfg, None, grid, opp_o)
    cc = cfg.get("cmab", {})
    bands = cc.get("preferOverLevels", [])
    cmab_first = (lambda hl: any(lo <= hl < hi for lo, hi in bands)) if bands else None
    exclude = set(bc["excludeIds"])
    near_d, far_d = bc["nearDist"], bc["farDist"]
    lo = U.p.min(0) - far_d - 200
    hi = U.p.max(0) + far_d + 200
    cands = []
    for b in osm["buildings"]:
        ref = f"{b['kind']}{b['id']}"
        t = b["tags"]
        if ref in exclude or "building:part" in t and "building" not in t:
            continue
        if t.get("location") == "underground" or (parse_height(t.get("layer")) is None and (t.get("layer") or "").startswith("-")
                                                   and (parse_levels(t.get("building:levels")) or 0) == 0):
            continue
        ring = proj.fwd(b["ring"])
        if (ring.max(0) < lo).any() or (ring.min(0) > hi).any():
            continue
        if len(ring) < 4:
            continue
        poly = Polygon(ring)
        if not poly.is_valid:
            poly = poly.buffer(0)
            if poly.geom_type == "MultiPolygon":
                poly = max(poly.geoms, key=lambda g: g.area)
            if poly.is_empty or poly.geom_type != "Polygon":
                continue
        if poly.area < bc["minArea"]:
            continue
        cands.append((b, ref, poly))
    print(f"[bld] {len(cands)} candidate footprints in bbox")

    polys = [c[2] for c in cands]
    dist = shapely.distance(np.array(polys, dtype=object), U.line)
    hs = dict(tag=0, levels=0, cmab=0, estimated=0)
    out = []
    dropped = defaultdict(int)
    sec_ids = {s["id"] for s in cfg["sections"]}
    calib = []
    for (b, ref, poly), dd in zip(cands, dist):
        if dd > far_d:
            continue
        far = dd > near_d
        t = b["tags"]
        oid = b["id"]
        c = np.array(poly.centroid.coords[0])
        s_c, d_c = U.project(c[None])
        s_c, d_c = float(s_c[0]), float(d_c[0])
        zone = zone_of(s_c)
        assert zone in sec_ids
        mi = cmab_match(poly, cm, cc.get("minOverlap", 0.3))
        cmab_h = float(cm["h"][mi]) if mi is not None and cm["h"][mi] > 0 else None
        if cmab_h:
            calib.append((t, cmab_h))
            if cmab_skip(cc, poly.area):
                cmab_h = None
        h, src = building_height(t, zone, poly.area, oid, hc, cmab_h, cmab_first)
        if far and (src == "estimated" or h < bc["farMinHeight"]):
            continue
        simp = poly.simplify(bc["simplify"] if not far else bc["simplifyFar"], preserve_topology=True)
        if simp.is_empty or simp.geom_type != "Polygon":
            simp = poly
        fp = np.asarray(simp.exterior.coords)[:-1]
        if len(fp) < 3:
            dropped["degenerate"] += 1
            continue
        s_v, d_v = U.project(fp)
        if (sp.piece(s_v) < 0).any() or sp.piece(np.array([s_c]))[0] < 0:
            dropped["in cut"] += 1
            continue
        opp_v = np.interp(s_v, grid, opp_o)
        mr, mo = margins(s_v)
        inside = (d_v >= opp_v - mo) & (d_v <= mr)
        inside &= (s_v > 0.5) & (s_v < U.length - 0.5)
        if inside.any() or (opp_v[0] - mo[0] <= d_c <= mr[0] and 0.5 < s_c < U.length - 0.5):
            dropped["road corridor" if (inside & (d_v <= bc["rightMargin"]) & (d_v >= opp_v - bc["oppositeMargin"])).any() else "side road"] += 1
            continue
        k = int(sp.piece(np.array([np.clip(s_c, 0, U.length)]))[0])
        fp2 = sp.apply(fp, k)
        c2 = sp.apply(c[None], k)[0]
        s_f = float(np.clip(s_c - sp.offset[k], 0, L))
        h = float(np.clip(h, hc["min"], hc["max"]))
        rec = dict(id=oid, s=round(s_f, 1), d=round(d_c, 1), h=round(h, 1), zone=zone)
        if far:
            rec["far"] = True
        rec["fp"] = round_pts(fp2, 1)
        use, age = building_use(t, cm, mi), building_age(t, cm, mi)
        if use:
            rec["use"] = use
        if age:
            rec["age"] = age
        rec["_src"] = src
        out.append(rec)
        hs[src] += 1
    out.sort(key=lambda r: (r["s"], r["id"]))
    print(f"[bld] kept {len(out)} ({sum(1 for r in out if r.get('far'))} far); dropped " + ", ".join(f"{k} {v}" for k, v in dropped.items()))
    if cm is not None:
        print(f"[cmab] {len(calib)} of the in-range OSM buildings matched a CMAB rooftop")
        cmab_calibration(calib, hc)
    obstacles = [p for p, dd in zip(polys, dist) if dd <= near_d + 60]
    return out, hs, obstacles


def load_overture(cfg, proj):
    """Overture Maps buildings (data-raw/overture/buildings.parquet) whose sources are not OpenStreetMap
    (machine-learned rooftops), as local-metre polygons. None when the file is missing."""
    oc = cfg.get("overture")
    if not oc or not oc.get("enabled", True):
        return None
    path = ROOT / oc["path"]
    if not path.exists():
        print(f"[overture] {path.relative_to(ROOT)} missing; run sh data-raw/download.sh overture")
        return None
    import pyarrow.parquet as pq

    t = pq.read_table(path, columns=["id", "sources", "height", "num_floors", "geometry"])
    srcs = t.column("sources").to_pylist()
    ml = np.array([not any(s["dataset"] == "OpenStreetMap" for s in (ss or [])) for ss in srcs])
    datasets = defaultdict(int)
    for ss, m in zip(srcs, ml):
        if m:
            datasets[",".join(sorted({s["dataset"] for s in ss or []}))] += 1
    geoms = shapely.from_wkb(np.asarray(t.column("geometry").to_numpy(zero_copy_only=False))[ml])
    geoms = shapely.make_valid(shapely.transform(geoms, lambda ll: proj.fwd(ll)))
    out = []
    for gid, g, h, nf in zip(np.asarray(t.column("id").to_pylist())[ml], geoms, np.asarray(t.column("height").to_pylist(), dtype=object)[ml],
                             np.asarray(t.column("num_floors").to_pylist(), dtype=object)[ml]):
        if g.geom_type != "Polygon":
            parts = [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
            if not parts:
                continue
            g = max(parts, key=lambda p: p.area)
        out.append(dict(id=gid, poly=Polygon(g.exterior), height=h, floors=nf))
    print(f"[overture] {len(out)} non-OSM footprints of {t.num_rows} ({', '.join(f'{k}: {v}' for k, v in datasets.items())})")
    return out


def overture_id(gid):
    """Stable positive numeric id for an Overture UUID, above every OSM id and below 2^53."""
    return 10**15 + int(gid.replace("-", "")[:12], 16) % 10**14


def overture_buildings(cfg, osm, proj, U, sp, L, grid, opp_o, zone_of, lms, ov, cm, margins=None):
    """Overture rooftops that overlap no OSM building (< maxOsmOverlap of their area), off the road corridor,
    outside parks / water / plazas / construction sites / landmarks; heights Overture > CMAB > zone estimate."""
    if not ov:
        return [], dict(overture=0, cmab=0, estimated=0), []
    oc, bc, hc = cfg["overture"], cfg["buildings"], cfg["heights"]
    near_d, far_d = bc["nearDist"], bc["farDist"]
    margins = margins or road_margins(cfg, None, grid, opp_o)
    t0 = time.time()
    lo = U.p.min(0) - far_d - 200
    hi = U.p.max(0) + far_d + 200
    osm_polys = []
    for b in osm["buildings"]:
        ring = proj.fwd(b["ring"])
        if len(ring) < 4 or (ring.max(0) < lo).any() or (ring.min(0) > hi).any():
            continue
        p = Polygon(ring)
        osm_polys.append(p if p.is_valid else p.buffer(0))
    osm_tree = shapely.STRtree(osm_polys)
    reach = U.line.buffer(far_d + 50)
    opens = []
    for ring in osm["open"]:
        p = Polygon(proj.fwd(ring))
        p = p if p.is_valid else p.buffer(0)
        if not p.is_empty and p.intersects(reach):
            opens.append(p)
    open_tree = shapely.STRtree(opens)
    sites = [Polygon(l["ring"]).buffer(5) for l in lms if l["ring"] is not None and l["cfg"]["id"] != "lianhuashan"]
    out, kept_polys = [], []
    hs = dict(overture=0, cmab=0, estimated=0)
    dropped = defaultdict(int)
    for rec in ov:
        poly = rec["poly"]
        if poly.area < bc["minArea"] or not poly.intersects(reach):
            continue
        dd = float(poly.distance(U.line))
        if dd > far_d:
            continue
        far = dd > near_d
        if any(poly.intersection(osm_polys[i]).area >= oc["maxOsmOverlap"] * poly.area for i in osm_tree.query(poly, predicate="intersects")):
            dropped["overlaps OSM"] += 1
            continue
        c = np.array(poly.centroid.coords[0])
        cpt = Point(c)
        if any(opens[i].contains(cpt) or poly.intersection(opens[i]).area > oc["maxOpenOverlap"] * poly.area
               for i in open_tree.query(poly, predicate="intersects")):
            dropped["open space"] += 1
            continue
        if any(poly.intersects(s) for s in sites):
            dropped["landmark"] += 1
            continue
        s_c, d_c = U.project(c[None])
        s_c, d_c = float(s_c[0]), float(d_c[0])
        zone = zone_of(s_c)
        mi = cmab_match(poly, cm, cfg.get("cmab", {}).get("minOverlap", 0.3))
        if rec["height"] and rec["height"] > 0:
            h, src = float(rec["height"]), "overture"
        elif rec["floors"] and rec["floors"] > 0:
            h, src = rec["floors"] * hc["levelHeight"] + hc.get("roofAllowance", 0.0), "overture"
        elif mi is not None and cm["h"][mi] > 0 and not cmab_skip(cfg.get("cmab", {}), poly.area):
            h, src = float(cm["h"][mi]), "cmab"
        else:
            h, src = building_height({}, zone, poly.area, overture_id(rec["id"]), hc)
        if far and (src == "estimated" or h < bc["farMinHeight"]):
            continue
        simp = poly.simplify(bc["simplify"] if not far else bc["simplifyFar"], preserve_topology=True)
        fp = np.asarray((simp if simp.geom_type == "Polygon" and not simp.is_empty else poly).exterior.coords)[:-1]
        if len(fp) < 3:
            continue
        s_v, d_v = U.project(fp)
        if (sp.piece(s_v) < 0).any():
            dropped["in cut"] += 1
            continue
        opp_v = np.interp(s_v, grid, opp_o)
        mr, mo = margins(s_v)
        inside = (d_v >= opp_v - mo) & (d_v <= mr) & (s_v > 0.5) & (s_v < U.length - 0.5)
        if inside.any():
            dropped["road corridor"] += 1
            continue
        k = int(sp.piece(np.array([np.clip(s_c, 0, U.length)]))[0])
        r = dict(id=overture_id(rec["id"]), s=round(float(np.clip(s_c - sp.offset[k], 0, L)), 1), d=round(d_c, 1),
                 h=round(float(np.clip(h, hc["min"], hc["max"])), 1), zone=zone)
        if far:
            r["far"] = True
        r["fp"] = round_pts(sp.apply(fp, k), 1)
        r["src"] = "overture"
        use, age = building_use({}, cm, mi), building_age({}, cm, mi)
        if use:
            r["use"] = use
        if age:
            r["age"] = age
        r["_src"] = src
        out.append(r)
        kept_polys.append(poly)
        hs[src] += 1
    print(f"[overture] added {len(out)} buildings ({sum(1 for r in out if r.get('far'))} far), heights {hs}; dropped "
          + ", ".join(f"{k} {v}" for k, v in dropped.items()) + f" in {time.time() - t0:.1f}s")
    return out, hs, kept_polys


def procedural_fill(cfg, osm, proj, U, sp, L, grid, opp_o, zone_of, obstacles, lms):
    """Deterministic filler blocks where OSM has no footprints (negative ids).
    Never placed on OSM roads, parks/water/plazas/parking, landmarks, cuts or past the route ends."""
    pc = cfg["procedural"]
    if not pc.get("enabled"):
        return []
    t0 = time.time()
    reach = U.line.buffer(pc["maxDist"] + 40)
    obs = [p.buffer(pc["gapToBuildings"]) for p in obstacles]
    for w in osm["ways"].values():
        hw = w["tags"]["highway"]
        line = LineString(proj.fwd(w["ll"]))
        if line.intersects(reach):
            obs.append(line.buffer(pc["roadHalfWidth"].get(hw, pc["roadHalfWidth"]["default"]) + pc["gapToRoads"]))
    for ring in osm["open"]:
        poly = Polygon(proj.fwd(ring))
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty and poly.intersects(reach):
            obs.append(poly)
    for l in lms:
        if l["ring"] is not None and l["cfg"]["id"] != "lianhuashan":
            obs.append(Polygon(l["ring"]).buffer(pc["gapToLandmarks"]))
    tree = shapely.STRtree(obs)
    placed = []
    cells = defaultdict(list)
    out = []
    lo_w, hi_w = pc["width"]
    lo_d, hi_d = pc["depth"]
    for side in (1, -1):
        for s in np.arange(pc["step"] / 2, U.length - 10, pc["step"]):
            if sp.piece(np.array([s]))[0] < 0:
                continue
            c0 = U.at(s)
            t = U.tangent(np.clip(s, 10, U.length - 10), 10.0)
            n = np.array([-t[1], t[0]])
            opp = float(np.interp(s, grid, opp_o))
            for bi, band in enumerate(pc["bands"]):
                seed = int(round(s * 10)) * 131 + bi * 7 + (1 if side > 0 else 0)
                u = [hash01(seed, j) for j in range(1, 6)]
                if u[4] < pc["skipChance"]:
                    continue
                w = lo_w + (hi_w - lo_w) * u[0]
                dep = lo_d + (hi_d - lo_d) * u[1]
                dc = band + (u[2] - 0.5) * pc["lateralJitter"]
                d_center = dc if side > 0 else opp - dc
                if side > 0 and d_center - dep / 2 < pc["minRight"]:
                    continue
                if side < 0 and d_center + dep / 2 > opp - pc["minLeftBeyondOpposite"]:
                    continue
                if abs(d_center) + dep / 2 > pc["maxDist"]:
                    continue
                a = math.radians((u[3] - 0.5) * pc["rotJitter"])
                ta = t * math.cos(a) + n * math.sin(a)
                na = np.array([-ta[1], ta[0]])
                ctr = c0 + n * d_center
                corners = np.array([ctr + ta * sx * w / 2 + na * sz * dep / 2 for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
                poly = Polygon(corners)
                if len(tree.query(poly, predicate="intersects")):
                    continue
                key = (int(ctr[0] // 100), int(ctr[1] // 100))
                near = [q for dx in (-1, 0, 1) for dz in (-1, 0, 1) for q in cells[(key[0] + dx, key[1] + dz)]]
                if any(q.intersects(poly) for q in near):
                    continue
                s_v, d_v = U.project(corners)
                if (sp.piece(s_v) < 0).any() or s_v.min() <= 1 or s_v.max() >= U.length - 1:
                    continue
                cells[key].append(poly.buffer(pc["gapBetween"]))
                placed.append((s, d_center, poly, corners))
    for i, (s, d_center, poly, corners) in enumerate(sorted(placed, key=lambda p: (p[0], p[1]))):
        oid = -(i + 1)
        zone = zone_of(s)
        h, _ = building_height({}, zone, poly.area, oid, cfg["heights"])
        k = int(sp.piece(np.array([s]))[0])
        out.append(dict(id=oid, s=round(float(s - sp.offset[k]), 1), d=round(float(d_center), 1),
                        h=round(float(np.clip(h, cfg["heights"]["min"], cfg["heights"]["max"])), 1), zone=zone,
                        fp=round_pts(sp.apply(corners, k), 1)))
    print(f"[fill] {len(out)} procedural filler blocks in {time.time() - t0:.1f}s")
    return out


def lap_time(cl, step, rc, s_end):
    """Optimal-lap estimate from startS to s_end: curvature cap v <= sqrt(latAcc * R), forward pass
    with a(v) = accel * (1 - (v / vmax)^2), backward pass with constant braking."""
    seg = np.diff(cl, axis=0)
    h = np.unwrap(np.arctan2(seg[:, 1], seg[:, 0]))
    s_pts = np.arange(len(cl)) * step
    hp = np.interp(s_pts, (np.arange(len(h)) + 0.5) * step, h)
    win = max(1, int(round(rc["curvatureWindow"] / step)))
    kap = np.convolve(np.abs(np.gradient(hp, step)), np.ones(win) / win, "same")
    vmax, a0, brake = rc["vmax"], rc["accel"], rc["brake"]
    cap = np.minimum(vmax, np.sqrt(rc["latAcc"] / np.maximum(kap, 1e-9)))
    i0, i1 = int(round(rc["startS"] / step)), int(round(s_end / step))
    v = np.zeros(i1 + 1)
    for i in range(i0, i1):
        v[i + 1] = min(cap[i + 1], math.sqrt(v[i] ** 2 + 2 * a0 * (1 - (v[i] / vmax) ** 2) * step))
    for i in range(i1 - 1, i0 - 1, -1):
        v[i] = min(v[i], math.sqrt(v[i + 1] ** 2 + 2 * brake * step))
    vv = v[i0:i1 + 1]
    t = float(np.sum(2 * step / np.maximum(vv[1:] + vv[:-1], 1e-6)))
    tail = vv[int(200 / step):]
    return dict(time=t, vmax=float(vv.max()), vmin_corner=float(tail.min()), full=float(np.sum(vv > 300 / 3.6) * step), v=v, i0=i0)


def roof_cap(top, minimum):
    """Largest height whose runtime extrusion (roof boxes up to +6.5 m from 25 m, crown up to
    +14 m above 90 m, see src/city/buildings) stays below `top`; None when under `minimum`."""
    if top >= 110.5:
        h = top - 20.5
    elif top >= 96.5:
        h = 90.0
    elif top >= 31.5:
        h = top - 6.5
    else:
        h = min(top, 24.9)
    return h if h >= minimum else None


def apply_view_corridors(cfg, route, blds, F, final_s):
    """Sight-line clearing toward landmarks (artistic simplification, README).

    For camera points along [s0, s1] (route point cameraBack m behind s, d = cameraD, cameraHeight
    m up) whose bearing to a landmark target lies within +-halfFov of the route tangent, 2D sight
    lines run to the landmark centroid and densified footprint outline (stopping where they enter
    the footprint). A building whose footprint crosses a sight line and rises above the 3D line
    (camera -> target at minVisibleFrom) is capped just below it, or dropped when the cap would be
    under minKeep or it is a procedural filler (id < 0). Buildings off every sight line are untouched.
    Returns (kept buildings, clear-zone rings = simplified union of the swept wedges)."""
    vcs = cfg.get("viewCorridors") or []
    if not vcs:
        return blds, []
    dflt = cfg.get("viewCorridorDefaults", {})
    lmk = {l["id"]: l for l in route["landmarks"]}
    L = route["meta"]["length"]
    polys = []
    for b in blds:
        p = Polygon(b["fp"])
        polys.append(p if p.is_valid else p.buffer(0))
    polys = np.array(polys, dtype=object)
    tree = shapely.STRtree(polys)
    cap = np.full(len(blds), np.inf)
    owner = [None] * len(blds)
    zones = []
    sight = []  # per corridor: (landmark, sight lines, cameras, distances, minVisibleFrom, cameraHeight, margin)
    for vc in vcs:
        o = {**dflt, **vc}
        l = lmk.get(o["landmark"])
        if l is None:
            print(f"[view] WARNING landmark {o['landmark']} missing, corridor skipped")
            continue
        if l.get("footprint"):
            lpoly = Polygon(l["footprint"])
            lpoly = lpoly if lpoly.is_valid else lpoly.buffer(0)
        else:
            lpoly = Point(l["x"], l["z"]).buffer(o.get("radius", 20.0), 8)
        ring = LineString(lpoly.exterior.coords)
        n_t = max(4, int(ring.length / o["targetSpacing"]))
        targets = [np.array(ring.interpolate(i / n_t, normalized=True).coords[0]) for i in range(n_t)]
        targets.append(np.array([l["x"], l["z"]]))
        s0, s1 = final_s(o["s0"]), final_s(o["s1"])
        H, ch, half = o["minVisibleFrom"], o["cameraHeight"], math.radians(o["halfFov"])
        segs, cams, dists, wedges = [], [], [], []
        prev = []
        for s in np.arange(s0, s1 + 1e-6, o["step"]):
            sc = float(np.clip(s - o["cameraBack"], 0, L))
            t = F.tangent(np.clip(sc, 1, L - 1), 2.0)
            cam = F.at(sc) + np.array([-t[1], t[0]]) * o["cameraD"]
            tv = F.tangent(np.clip(s, 1, L - 1), 2.0)
            ends = []
            for tp in targets:
                v = tp - cam
                if abs(math.atan2(tv[0] * v[1] - tv[1] * v[0], float(tv @ v))) > half:
                    continue
                seg = LineString([cam, tp])
                hit = seg.intersection(lpoly)
                dist = float(shapely.distance(Point(cam), hit)) if not hit.is_empty else float(np.hypot(*v))
                if dist < 1:
                    continue
                end = cam + v / np.hypot(*v) * dist
                segs.append(LineString([cam, end]))
                cams.append(cam)
                dists.append(dist)
                ends.append(end)
            # swept wedge: hull of this and the previous viewpoint's fan, so the zone has no gaps
            cur = [cam] + ends if len(ends) >= 2 else []
            if cur:
                wedges.append(shapely.MultiPoint(cur + prev).convex_hull)
            prev = cur
        if not segs:
            print(f"[view] {o['landmark']}: no viewpoint has it within +-{o['halfFov']} deg")
            continue
        segs = np.array(segs, dtype=object)
        sight.append((o["landmark"], segs, np.array(cams), np.array(dists), H, ch, o["margin"]))
        si, bi = tree.query(segs, predicate="intersects")
        inter = shapely.intersection(segs[si], polys[bi])
        t_in = shapely.distance(shapely.points(np.array(cams)[si]), inter)
        y = ch + (H - ch) * t_in / np.array(dists)[si] - o["margin"]
        hit = set()
        for b, top in zip(bi, y):
            hit.add(int(b))
            if top < cap[b]:
                cap[b] = top
                owner[b] = o["landmark"]
        zone = shapely.union_all(wedges).simplify(o["zoneSimplify"])
        for g in getattr(zone, "geoms", [zone]):
            if g.geom_type == "Polygon" and g.area > 1:
                zones.append(round_pts(np.asarray(g.exterior.coords)[:-1], 1))
        print(f"[view] {o['landmark']}: {len(segs)} sight lines from s {s0:.0f}-{s1:.0f}, {len(hit)} buildings on them")

    protect = {int(r[1:]) for r in dflt.get("keepIds", [])}
    keep, stats = [], defaultdict(lambda: dict(capped=0, dropped=0, lost=0.0))
    for i, b in enumerate(blds):
        if not np.isfinite(cap[i]) or b["id"] in protect:
            keep.append(b)
            continue
        h_ok = roof_cap(cap[i], 0.0)
        if h_ok is not None and b["h"] <= h_ok:
            keep.append(b)
            continue
        st = stats[owner[i]]
        h_new = roof_cap(cap[i], dflt.get("minKeep", 12.0))
        if h_new is None or b["id"] < 0:
            st["dropped"] += 1
            st["lost"] += b["h"]
            continue
        st["capped"] += 1
        st["lost"] += b["h"] - h_new
        keep.append({**b, "h": round(float(h_new), 1)})
    for k, st in stats.items():
        print(f"[view] {k}: capped {st['capped']}, dropped {st['dropped']} (removed {st['lost']:.0f} m of height in total)")
    print(f"[view] {len(zones)} clear-zone polygons, {sum(len(z) for z in zones)} vertices")
    route["_sight"] = sight
    return keep, zones


def view_check(cfg, route, blds, models):
    """Report what still rises above a landmark sight line after capping and model filtering
    (keepIds and landmark replacements are exempt by design), and how many clear-zone overlaps
    are harmless (below every sight line)."""
    if not route.get("_sight"):
        return
    zones = [Polygon(z) for z in route.get("clearZones") or []]
    zones = [z if z.is_valid else z.buffer(0) for z in zones]
    keep = {int(r[1:]) for r in cfg.get("viewCorridorDefaults", {}).get("keepIds", [])}
    n_zone, above = 0, []
    items = [(f"osm {b['id']}", b["h"], Polygon(b["fp"]), b["id"] in keep) for b in blds if b["id"] > 0]
    items += [(m["id"], m["height"], Polygon(m["footprint"]), bool(m.get("replacesLandmark")) or bool(set(m["replacesOsm"]) & keep))
              for m in models]
    for name, h, p, exempt in items:
        p = p if p.is_valid else p.buffer(0)
        if not any(p.intersection(z).area > 1.0 for z in zones):
            continue
        n_zone += 1
        top, lm = sight_cap(route, p)
        if h > top + 0.5 and not exempt:
            above.append(f"{name} ({h:.0f} m > {top:.0f} m, {lm})")
    print(f"[view] check: {n_zone} kept buildings/models overlap clear zones; {len(above)} rise above a sight line"
          + (": " + ", ".join(above[:12]) if above else ""))


def sight_cap(route, poly):
    """Lowest sight-line height (same rule as apply_view_corridors) over a final-frame footprint:
    (cap m, landmark), or (inf, None) when no sight line crosses it."""
    best, who = np.inf, None
    for lm, segs, cams, dists, H, ch, margin in route.get("_sight", []):
        hit = shapely.intersects(segs, poly)
        if not hit.any():
            continue
        idx = np.nonzero(hit)[0]
        t_in = shapely.distance(shapely.points(cams[idx]), shapely.intersection(segs[idx], poly))
        y = float(np.min(ch + (H - ch) * t_in / dists[idx] - margin))
        if y < best:
            best, who = y, lm
    return best, who


# ----------------------------------------------------------------------------
# real-building models: register processed GLBs (public/models/city/index.json, written by
# scripts/process_city_models.mjs) against OSM footprints, splice, filter, replace
# ----------------------------------------------------------------------------


def rot_y(theta):
    """2x2 matrix on (x, z) column vectors matching three.js rotation.y = theta (z points south)."""
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, s], [-s, c]])


def place(geom, theta, t):
    """Model-local x/z geometry -> world: rotation.y = theta about the model origin, then + t."""
    R = rot_y(theta)
    return shapely.affinity.affine_transform(geom, [R[0, 0], R[0, 1], R[1, 0], R[1, 1], float(t[0]), float(t[1])])


def iou(a, b):
    i = a.intersection(b).area
    return i / (a.area + b.area - i) if i > 0 else 0.0


def valid_poly(rings):
    polys = []
    for r in rings:
        if len(r) >= 3:
            p = Polygon(r)
            polys.append(p if p.is_valid else p.buffer(0))
    g = shapely.union_all(polys) if polys else Polygon()
    return g if g.is_valid else g.buffer(0)


def fit_pose(model, target, t_init, rc, yaw0=0.0, yaw_range=None):
    """Maximise IoU(model placed at (theta, t), target) - yawPrior * |theta - yaw0| / pi.
    Coarse yaw grid with centroid alignment, pattern search on the translation for the best few,
    then a fine yaw sweep. Returns (theta, t, IoU)."""
    mc = np.array(model.centroid.coords[0])
    tc = np.array(target.centroid.coords[0])

    def score(th, v):
        return v - rc["yawPrior"] * abs(wrap(th - yaw0)) / math.pi

    def refine(th, t, step):
        best = iou(place(model, th, t), target)
        while step >= 0.25:
            moved = False
            for dx, dz in ((step, 0), (-step, 0), (0, step), (0, -step)):
                tt = t + np.array([dx, dz])
                v = iou(place(model, th, tt), target)
                if v > best + 1e-6:
                    best, t, moved = v, tt, True
            if not moved:
                step /= 2
        return best, t

    degs = np.arange(0.0, 360.0, rc["yawCoarse"])
    if yaw_range is not None:
        degs = np.arange(yaw_range[0], yaw_range[1] + 1e-9, rc["yawFine"])
    coarse = []
    for deg in degs:
        th = math.radians(deg)
        t = tc - rot_y(th) @ mc
        coarse.append((score(th, iou(place(model, th, t), target)), th, t))
    coarse.sort(key=lambda c: -c[0])
    best = None
    for _, th, t in coarse[:4]:
        v, t = refine(th, t, 8.0)
        if best is None or score(th, v) > best[0]:
            best = (score(th, v), th, t, v)
    _, th_b, t_b, _ = best
    for dd in np.arange(-rc["yawCoarse"], rc["yawCoarse"] + 1e-9, rc["yawFine"]):
        th = th_b + math.radians(dd)
        v, t = refine(th, t_b, 2.0)
        if score(th, v) > best[0]:
            best = (score(th, v), th, t, v)
    return wrap(best[1]), best[2], best[3]


def load_city_models(cfg):
    dflt = cfg.get("cityModelDefaults")
    entries = [e for e in cfg.get("cityModels", []) if e.get("enabled", True)]
    if not dflt or not entries:
        return [], {}
    path = ROOT / dflt["index"]
    if not path.exists():
        print(f"[models] {path.relative_to(ROOT)} missing; run node scripts/process_city_models.mjs")
        return [], {}
    index = json.loads(path.read_text())["models"]
    out = []
    for e in entries:
        mid = e["file"].removesuffix(".glb")
        if mid not in index:
            print(f"[models] WARNING {mid} not processed yet (node scripts/process_city_models.mjs)")
            continue
        out.append(dict(cfg=e, id=mid, meta=index[mid]))
    return out, index


def register_city_models(cfg, osm, proj, models):
    """Original-frame registration: lat/lon -> local, best OSM target(s) within matchRadius, yaw +
    translation maximising IoU between the model silhouette and the target footprint union."""
    rc = cfg["cityModelDefaults"]["register"]
    t0 = time.time()
    # OSM building polygons near any model (one STRtree)
    centers = np.array([[m["meta"]["lon"], m["meta"]["lat"]] for m in models])
    recs, polys = [], []
    for b in osm["buildings"]:
        r0 = b["ring"][0]
        if np.min(np.abs(centers[:, 0] - r0[0]) * 103000 + np.abs(centers[:, 1] - r0[1]) * 111000) > 700:
            continue
        ring = proj.fwd(b["ring"])
        if len(ring) < 4:
            continue
        p = Polygon(ring)
        if not p.is_valid:
            p = p.buffer(0)
            if p.geom_type == "MultiPolygon":
                p = max(p.geoms, key=lambda g: g.area)
        if p.is_empty or p.area < 20:
            continue
        recs.append(b)
        polys.append(p)
    polys = np.array(polys, dtype=object)
    tree = shapely.STRtree(polys)
    ref_of = [f"{b['kind']}{b['id']}" for b in recs]
    by_ref = {r: i for i, r in enumerate(ref_of)}
    out = []
    for m in models:
        meta, e = m["meta"], m["cfg"]
        sil_full = valid_poly(meta["silhouette"])
        # registerBy=tower: fit only the parts above half the model height (towers whose podium
        # differs from the OSM one); the footprint and keep-out still use the full silhouette
        sil = valid_poly(meta["towerSilhouette"]) if e.get("registerBy") == "tower" else sil_full
        hull = Polygon(meta["footprint"])
        P0 = proj.fwd(np.array([meta["lon"], meta["lat"]]))
        t_init = P0 - np.array(meta["nativeOrigin"])
        init = place(sil, 0.0, t_init)
        reg = dict(m, sil=sil_full, hull=hull, P0=P0, theta=0.0, t=t_init, iou=None, targets=[], note="")
        if e.get("register", True) is False:
            reg["note"] = "manifest pose (register=false)"
            out.append(reg)
            continue
        forced = e.get("osm")
        if forced:
            forced = [forced] if isinstance(forced, str) else forced
            idx = [by_ref[r] for r in forced if r in by_ref]
            if len(idx) != len(forced):
                print(f"[models] WARNING {m['id']}: forced OSM {forced} not all found")
            cands = [idx] if idx else []
        else:
            near = tree.query(init.buffer(rc["matchRadius"]))
            near = sorted(near, key=lambda i: init.distance(polys[i]))[:6]
            cands = [[i] for i in near]
            # multi-building models (towers on a shared podium, A/B/C blocks): everything the
            # manifest pose covers substantially, as one target
            cover = sorted(i for i in tree.query(init) if init.intersection(polys[i]).area >= rc["candidateMinOverlap"] * polys[i].area)
            if len(cover) > 1:
                cands.append(cover)
        if not cands:
            reg["note"] = f"no OSM footprint within {rc['matchRadius']} m: manifest position, native orientation"
            print(f"[models] {m['id']}: {reg['note']}")
            out.append(reg)
            continue
        yr = e.get("yawRange")
        best = None
        for c in cands:
            target = shapely.union_all(list(polys[c]))
            th, t, v = fit_pose(sil, target, t_init, rc, yaw_range=yr)
            # prefer targets near the manifest position (manifest positions are ~30 m off at worst)
            dist = float(np.hypot(*(np.array(place(sil, th, t).centroid.coords[0]) - np.array(init.centroid.coords[0]))))
            sc = v - 0.002 * dist
            if best is None or sc > best[0]:
                best = (sc, c, th, t, v)
        _, members, th, t, v = best
        if not forced:
            # grow the target with every OSM footprint the placed model covers substantially
            for _ in range(3):
                placed = place(sil, th, t)
                cover = [i for i in tree.query(placed.buffer(2.0))
                         if placed.intersection(polys[i]).area >= rc["candidateMinOverlap"] * polys[i].area]
                grown = sorted(set(members) | set(cover))
                if grown == sorted(members):
                    break
                members = grown
                th, t, v = fit_pose(sil, shapely.union_all(list(polys[members])), t, rc, yaw_range=yr)
        reg.update(theta=th, t=t, iou=v, targets=[ref_of[i] for i in members],
                   target_poly=shapely.union_all(list(polys[members])))
        out.append(reg)
    for reg in out:
        e = reg["cfg"]
        if e.get("yaw"):
            reg["theta"] = wrap(reg["theta"] + math.radians(e["yaw"]))
        if e.get("shift"):
            reg["t"] = reg["t"] + np.array(e["shift"], float)
        reg["sil_o"] = place(reg["sil"], reg["theta"], reg["t"])
        reg["hull_o"] = place(reg["hull"], reg["theta"], reg["t"])
        moved = float(np.hypot(*(np.asarray(reg["sil_o"].centroid.coords[0]) - np.asarray(place(reg["sil"], 0.0, reg["P0"] - np.array(reg["meta"]["nativeOrigin"])).centroid.coords[0]))))
        reg["moved"] = moved
        iou_s = f"IoU {reg['iou']:.2f}" if reg["iou"] is not None else "unregistered"
        print(f"[models] {reg['id'][:44]:44} {iou_s:12} yaw {math.degrees(reg['theta']):+7.1f} deg, moved {moved:5.1f} m, "
              f"targets {','.join(reg['targets'][:5])}{'...' if len(reg['targets']) > 5 else ''}{(' (' + reg['note'] + ')') if reg['note'] else ''}")
    reg_polys = dict(polys=polys, refs=ref_of, tree=tree)
    print(f"[models] registered {len(out)} models in {time.time() - t0:.1f}s")
    return out, reg_polys


def model_footprint(geom):
    """Single-ring keep-out footprint: the silhouette ring when the model is one connected part,
    else the convex hull of its parts."""
    if geom.geom_type == "Polygon":
        return Polygon(geom.exterior).simplify(0.5)
    return geom.convex_hull


def finalize_city_models(cfg, regs, reg_polys, route, blds, sp, U, F, L, opp_final):
    """Splice to the final frame, drop models in cuts / on the road corridor / in clear zones
    (unless replacing a landmark) / overlapping a higher-priority model, then remove the replaced
    OSM footprints and procedural fillers under the models. Returns (records, buildings, report)."""
    dflt = cfg["cityModelDefaults"]
    rc = dflt["register"]
    road = route["road"]
    zones = [Polygon(z) for z in route.get("clearZones") or []]
    zones = [z if z.is_valid else z.buffer(0) for z in zones]
    half = max(road["halfWidthLeft"], road["halfWidthRight"])
    keep_ids = set(cfg.get("viewCorridorDefaults", {}).get("keepIds", []))
    kept, skipped = [], []
    # landmark parts (e.g. the Civic Square columns) follow their landmark's replacement: placed first
    # are the models that replace a hand-built landmark
    regs = sorted(regs, key=lambda r: r["cfg"].get("part") is not None)
    replaced = set()
    for r in regs:
        e, meta = r["cfg"], r["meta"]
        lm = e.get("landmark")
        replaces = lm if (lm and e.get("replaceLandmark")) else None
        if e.get("part") in replaced:
            replaces = e["part"]
        r["replacesLandmark"] = replaces
        # replacements may come as close as the real building (roof overhangs, 1 m off the road edge)
        margin = rc["roadMarginLandmark"] if replaces else rc["roadMargin"]
        road_buf = F.line.buffer(half + margin)
        if lm and not e.get("replaceLandmark") and not e.get("part"):
            skipped.append((r, f"hand-built landmark '{lm}' kept (replaceLandmark=false)"))
            continue
        if r["iou"] is not None and r["iou"] < rc["minIoU"]:
            print(f"[models] WARNING {r['id']}: low IoU {r['iou']:.2f}")
        s_o, _ = U.project(np.asarray(r["t"])[None])
        k = int(sp.piece(np.clip(s_o, 0, U.length))[0])
        ring_o = np.asarray(model_footprint(r["sil_o"]).exterior.coords)[:-1]
        s_v, d_v = U.project(ring_o)
        in_cut = (sp.piece(np.clip(s_v, 0, U.length)) < 0).any() or k < 0
        if in_cut and e["role"] != "skyline":
            skipped.append((r, "inside a cut interval"))
            continue
        if k < 0:
            # far skyline model abeam a cut: keep it with the transform of the piece before the cut
            k = int(np.searchsorted(sp.starts, s_o[0], side="right") - 1)
        R = rot_y(-sp.rot[k])
        aff = [R[0, 0], R[0, 1], R[1, 0], R[1, 1], float(sp.trans[k][0]), float(sp.trans[k][1])]
        r["k"] = k
        r["origin_f"] = sp.apply(np.asarray(r["t"])[None], k)[0]
        r["yaw_f"] = wrap(r["theta"] - sp.rot[k])
        r["sil_f"] = shapely.affinity.affine_transform(r["sil_o"], aff)
        r["fp_f"] = model_footprint(r["sil_f"])
        if r.get("target_poly") is not None:
            r["target_f"] = shapely.affinity.affine_transform(r["target_poly"], aff)
        sf, df = F.project(r["origin_f"][None])
        r["s_f"], r["d_f"] = float(np.clip(sf[0], 0, L)), float(df[0])
        if e["role"] != "skyline":
            if r["fp_f"].intersects(road_buf):
                near = shapely.ops.nearest_points(r["fp_f"].exterior, F.line)[1]
                sn, _ = F.project(np.array(near.coords[0])[None])
                skipped.append((r, f"on the drivable road ({r['fp_f'].exterior.distance(F.line):.1f} m from the centerline at s {sn[0]:.0f})"))
                continue
            ring = LineString(np.asarray(r["fp_f"].exterior.coords))
            pts = np.array([ring.interpolate(x).coords[0] for x in np.arange(0, ring.length, 1.0)])
            sp_, dp_ = F.project(pts)
            opp = np.interp(sp_, np.arange(len(opp_final)) * route["meta"]["sampleSpacing"], opp_final)
            right = road["halfWidthRight"] + margin if replaces else rc["roadMarginRight"]
            inside = (dp_ >= opp - rc["roadMarginOpposite"]) & (dp_ <= right) & (sp_ > 0.5) & (sp_ < L - 0.5)
            if inside.any():
                skipped.append((r, f"road corridor (d {dp_[inside].min():.0f}..{dp_[inside].max():.0f} m at s {sp_[inside].mean():.0f})"))
                continue
        # models replacing a building the view corridors deliberately keep (keepIds) may stay too
        if not replaces and not set(r["targets"]) & keep_ids:
            hit = [z for z in zones if r["fp_f"].intersection(z).area > rc["clearZoneMinArea"]]
            if hit:
                # a clear zone is the swept wedge; only a model that rises above a sight line blocks
                a = sum(r["fp_f"].intersection(z).area for z in hit)
                top, lm_v = sight_cap(route, r["fp_f"])
                if meta["height"] > top:
                    skipped.append((r, f"blocks the view to {lm_v} ({a:.0f} m2 in a clear zone, {meta['height']:.0f} m > sight line {top:.0f} m)"))
                    continue
                r["viewCap"] = round(float(top), 1) if np.isfinite(top) else 9999.0
                r["clearZoneNote"] = f"{a:.0f} m2 in a clear zone but below the sight lines ({meta['height']:.0f} m <= {top:.0f} m)"
        if replaces and not e.get("part"):
            replaced.add(replaces)
        kept.append(r)
    # mutual overlaps: landmark replacements > landmarks > frontage > skyline, then IoU, then config order
    prio = {"landmark": 2, "frontage": 1, "skyline": 0}
    order = {id(r): i for i, r in enumerate(kept)}
    kept.sort(key=lambda r: (-(r["replacesLandmark"] is not None), -prio[r["cfg"]["role"]], -(r["iou"] or 0), order[id(r)]))
    final = []
    for r in kept:
        clash = next((q for q in final if r["fp_f"].intersection(q["fp_f"]).area > 1.0), None)
        if clash:
            skipped.append((r, f"overlaps {clash['id']}"))
            continue
        final.append(r)
    # replaced OSM footprints: targets + any building mostly covered by (or centred in) a model
    polys, refs = reg_polys["polys"], reg_polys["refs"]
    for r in final:
        rep = set(r["targets"])
        for i in reg_polys["tree"].query(r["sil_o"].buffer(1.0)):
            p = polys[i]
            inter = r["sil_o"].intersection(p).area
            if inter >= rc["replaceMinOverlap"] * p.area or r["sil_o"].contains(p.centroid):
                rep.add(refs[i])
            elif inter > 0.05 * p.area:
                print(f"[models] note {r['id']}: partial overlap {inter / p.area:.0%} with {refs[i]} (kept)")
        r["replacesOsm"] = sorted(int(x[1:]) for x in rep)
    rep_ids = {i for r in final for i in r["replacesOsm"]}
    fps = [r["fp_f"].buffer(rc["fillerGap"]) for r in final]
    keep, n_osm, n_fill = [], 0, 0
    n_ov = 0
    for b in blds:
        if b["id"] > 0 and b["id"] in rep_ids:
            n_osm += 1
            continue
        if b["id"] < 0:
            p = Polygon(b["fp"])
            if any(p.intersects(f) for f in fps):
                n_fill += 1
                continue
        if b.get("src") == "overture":
            p = Polygon(b["fp"]).buffer(0)
            if any(p.intersection(r["fp_f"]).area > rc["replaceMinOverlap"] * p.area or r["fp_f"].contains(p.centroid) for r in final):
                n_ov += 1
                continue
        keep.append(b)
    if n_ov:
        print(f"[models] removed {n_ov} Overture footprints under placed models")
    records = []
    for r in sorted(final, key=lambda r: r["s_f"]):
        meta = r["meta"]
        rec = dict(id=r["id"], file=meta["file"], role=r["cfg"]["role"],
                   x=round(float(r["origin_f"][0]), 2), z=round(float(r["origin_f"][1]), 2), yaw=round(float(r["yaw_f"]), 4),
                   s=round(r["s_f"], 1), d=round(r["d_f"], 1), height=meta["height"],
                   footprint=round_pts(np.asarray(r["fp_f"].exterior.coords)[:-1], 1), replacesOsm=r["replacesOsm"])
        if r["replacesLandmark"]:
            rec["replacesLandmark"] = r["replacesLandmark"]
        if r.get("viewCap") is not None:
            rec["viewCap"] = r["viewCap"]
        rec.update(photoTextured=meta["photoTextured"], tris=meta["tris"], drawCalls=meta["drawCalls"], bytes=meta["bytes"],
                   credit=meta["credit"])
        records.append(rec)
    for r in final:
        if r.get("clearZoneNote"):
            print(f"[models] keep {r['id'][:44]:44} {r['clearZoneNote']}")
    for r, why in skipped:
        print(f"[models] skip {r['id'][:44]:44} {why}")
    print(f"[models] placed {len(records)} of {len(regs)}; removed {n_osm} replaced OSM footprints and {n_fill} procedural fillers")
    return records, keep, dict(final=final, skipped=skipped)


def write_city_models(cfg, records, now):
    dflt = cfg["cityModelDefaults"]
    data = dict(meta=dict(generatedAt=now, count=len(records), totalBytes=sum(r["bytes"] for r in records)), models=records)
    path = ROOT / dflt["output"]
    write_json(path, data)
    print(f"[out] {path.relative_to(ROOT)}: {len(records)} models, {data['meta']['totalBytes'] / 1048576:.2f} MB of GLB")
    missing = [r["id"] for r in records if not (ROOT / "public" / r["file"]).exists()]
    if missing:
        print(f"[models] ERROR placed models without a processed GLB; run node scripts/process_city_models.mjs --only {','.join(missing)}")
    # processed GLBs that ship must be placed (or be a landmark alternative kept for comparison)
    used = {Path(r["file"]).name for r in records}
    alt = {e["file"] for e in cfg.get("cityModels", []) if e.get("landmark") and e.get("enabled", True)}
    for f in sorted((ROOT / dflt["outDir"]).glob("*.glb")):
        if f.name not in used and f.name not in alt:
            f.unlink()
            print(f"[out] removed unused {f.relative_to(ROOT)}")
    if data["meta"]["totalBytes"] > dflt["maxTotalBytes"]:
        print(f"[models] WARNING city models exceed the download budget ({dflt['maxTotalBytes'] / 1048576:.0f} MB)")
    update_credits(cfg, records)


LANDMARK_NAMES = {"tencent": "腾讯大厦", "eiffel": "世界之窗 埃菲尔铁塔", "pingan": "平安金融中心", "civic_center": "深圳市民中心",
                  "kingkey100": "京基100"}
ROLE_NAMES = {"landmark": "地标", "frontage": "沿街建筑", "skyline": "远景"}


def update_credits(cfg, records):
    """Rewrites the 3D Warehouse table in docs/asset-credits.md (between the city-models markers)
    from what ships: placed models plus landmark alternatives kept in public/models/city."""
    path = ROOT / "docs" / "asset-credits.md"
    start, end = "<!-- city-models:start -->", "<!-- city-models:end -->"
    if not path.exists() or start not in path.read_text(encoding="utf-8"):
        return
    dflt = cfg["cityModelDefaults"]
    index = json.loads((ROOT / dflt["index"]).read_text())["models"]
    entries = {e["file"].removesuffix(".glb"): e for e in cfg.get("cityModels", [])}
    shipped = sorted(f.stem for f in (ROOT / dflt["outDir"]).glob("*.glb"))
    placed = {r["id"]: r for r in records}
    rows = []
    for mid in shipped:
        meta, e = index.get(mid), entries.get(mid, {})
        if meta is None:
            continue
        cr = meta["credit"]
        r = placed.get(mid)
        if r is None:
            use = f"未放置：手工地标 {LANDMARK_NAMES.get(e.get('landmark'), e.get('landmark'))} 的备选（replaceLandmark=false），保留供对比"
        elif e.get("part") and r.get("replacesLandmark"):
            use = f"{LANDMARK_NAMES.get(e['part'], e['part'])}的组成部分，随其模型一同替换手工地标"
        else:
            use = ROLE_NAMES[r["role"]]
            if r.get("replacesLandmark"):
                use += f"，替换手工地标 {LANDMARK_NAMES.get(r['replacesLandmark'], r['replacesLandmark'])}"
        extra = e.get("credit", "")
        rows.append(f"| `public/{meta['file']}` | {cr['title']} | {cr['author']} | [3D Warehouse]({cr['url']}) | {use} | {extra} |")
    body = "\n".join([
        start,
        f"共 {len(rows)} 个文件（{sum(1 for m in shipped if m in placed)} 个由 `public/data/city_models.json` 放置）。本表由 `scripts/build_city_data.py` 按实际随游戏分发的文件自动生成。",
        "",
        "| 文件 | 模型（原标题） | 作者 | 来源 | 用途 | 个别改动 |",
        "|---|---|---|---|---|---|",
        *rows,
        end,
    ])
    txt = path.read_text(encoding="utf-8")
    a, b = txt.index(start), txt.index(end) + len(end)
    path.write_text(txt[:a] + body + txt[b:], encoding="utf-8")
    print(f"[out] {path.relative_to(ROOT)}: {len(rows)} 3D Warehouse models credited")


def plot_city_models(route, bdata, report, path):
    import logging

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection

    logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
    plt.rcParams["font.sans-serif"] = ["Arial Unicode MS", "Heiti SC", "PingFang SC", "Hiragino Sans GB", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    cl = np.array(route["centerline"])
    step = route["meta"]["sampleSpacing"]
    ss = np.arange(len(cl)) * step
    Fp = Polyline(cl)
    final, skipped = report["final"], report["skipped"]
    allm = final + [r for r, _ in skipped if "fp_f" in r]
    if not allm:
        return
    groups = []
    for r in sorted(allm, key=lambda r: r["s_f"]):
        x, z = r["origin_f"]
        for g in groups:
            xs = [q["origin_f"][0] for q in g] + [x]
            zs = [q["origin_f"][1] for q in g] + [z]
            if np.ptp(xs) < 420 and np.ptp(zs) < 420:
                g.append(r)
                break
        else:
            groups.append([r])
    n = len(groups)
    cols = min(3, n)
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(8 * cols, 8 * rows), squeeze=False)
    bpolys = [np.array(b["fp"]) for b in bdata["buildings"]]
    for ax, grp in zip(axes.flat, groups):
        xs = np.concatenate([np.asarray(r["fp_f"].exterior.coords)[:, 0] for r in grp])
        zs = np.concatenate([np.asarray(r["fp_f"].exterior.coords)[:, 1] for r in grp])
        cx, cz = (xs.min() + xs.max()) / 2, (zs.min() + zs.max()) / 2
        rr = max(np.ptp(xs), np.ptp(zs)) / 2 + 60
        ax.add_collection(PolyCollection(bpolys, facecolors=[(0.55, 0.55, 0.55, 0.35) if b["id"] > 0 else (0.75, 0.75, 0.75, 0.25)
                                                             for b in bdata["buildings"]], edgecolors=(0.4, 0.4, 0.4, 0.5), linewidths=0.4))
        if route.get("clearZones"):
            ax.add_collection(PolyCollection([np.array(z) for z in route["clearZones"]], facecolors=(0.0, 0.75, 0.85, 0.08),
                                             edgecolors=(0.0, 0.6, 0.7, 0.8), linewidths=0.8, linestyles="--"))
        nn = np.array([[-t[1], t[0]] for t in Fp.tangent(np.clip(ss, 1, ss[-1] - 1), 2.0)])
        for side in (-route["road"]["halfWidthLeft"], route["road"]["halfWidthRight"]):
            e = cl + nn * side
            ax.plot(e[:, 0], e[:, 1], color="0.2", lw=0.8)
        ax.plot(cl[:, 0], cl[:, 1], color="k", lw=0.6, ls=":")
        for lm in route["landmarks"]:
            if lm.get("footprint"):
                fp = np.array(lm["footprint"] + [lm["footprint"][0]])
                ax.plot(fp[:, 0], fp[:, 1], color="gold", lw=1.5)
        for r in grp:
            ok = r in final
            for g in getattr(r.get("target_f"), "geoms", [r.get("target_f")]):
                if g is not None and not g.is_empty:
                    tp = np.asarray(g.exterior.coords)
                    ax.plot(tp[:, 0], tp[:, 1], color="#1f5fbf", lw=1.6)
            fp = np.asarray(r["fp_f"].exterior.coords)
            ax.fill(fp[:, 0], fp[:, 1], color=("#e15759" if ok else "#f2a93b"), alpha=0.35 if ok else 0.2)
            ax.plot(fp[:, 0], fp[:, 1], color=("#b22222" if ok else "#d4801f"), lw=1.0, ls="-" if ok else "--")
            for g in getattr(r["sil_f"], "geoms", [r["sil_f"]]):
                sp_ = np.asarray(g.exterior.coords)
                ax.plot(sp_[:, 0], sp_[:, 1], color="#7a1010", lw=0.5)
            o = r["origin_f"]
            why = next((w for q, w in skipped if q is r), "")
            lab = f"{r['id'][:24]}\nIoU {r['iou']:.2f}" if r["iou"] is not None else f"{r['id'][:24]}\n(manifest pose)"
            if not ok:
                lab += f"\nSKIP: {why[:30]}"
            ax.annotate(lab, o, fontsize=8, ha="center", va="center", color=("#600" if ok else "#8a4b00"), weight="bold",
                        bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.6))
        ax.set_xlim(cx - rr, cx + rr)
        ax.set_ylim(cz + rr, cz - rr)
        ax.set_aspect("equal")
        ax.grid(alpha=0.2)
        ax.set_title(f"s {min(r['s_f'] for r in grp):.0f}-{max(r['s_f'] for r in grp):.0f}: red = placed model footprint "
                     f"(thin = silhouette), blue = OSM target, orange dashed = skipped, grey = buildings.json", fontsize=9)
    for ax in list(axes.flat)[n:]:
        ax.axis("off")
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=100)
    plt.close(fig)
    print(f"[out] {path.relative_to(ROOT)}")


# ----------------------------------------------------------------------------
# validation / reports / plot
# ----------------------------------------------------------------------------


def validate(route, bdata, cfg):
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(f"  [{'ok' if cond else 'FAIL'}] {msg}")
        ok &= bool(cond)

    print("[check]")
    m = route["meta"]
    cl = np.array(route["centerline"], float)
    seg = np.hypot(*np.diff(cl, axis=0).T)
    L = m["length"]
    sp = m["sampleSpacing"]
    check(abs((len(cl) - 1) * sp - L) < 1e-6, f"{len(cl)} samples x {sp} m = {L} m (meta.length)")
    check(seg.min() > sp * 0.995 and seg.max() < sp * 1.001, f"sample spacing {seg.min():.4f}-{seg.max():.4f} m")
    check(np.allclose(cl[0], 0, atol=0.01), f"start at origin {cl[0].tolist()}")
    h = np.unwrap(np.arctan2(np.diff(cl[:, 1]), np.diff(cl[:, 0])))
    dh = np.degrees(np.abs(np.diff(h)))
    s_mid = (np.arange(len(dh)) + 1) * sp
    turns = route.get("turns") or [route["turn"]]
    outside = np.ones(len(s_mid), bool)
    for t in turns:
        outside &= (s_mid < t["s0"] - 2 * sp) | (s_mid > t["s1"] + 2 * sp)
    worst = int(np.argmax(np.where(outside, dh, 0)))
    check(dh[outside].max() < 1.5, f"max heading change outside the {len(turns)} turns {dh[outside].max():.2f} deg/sample at s={s_mid[worst]:.0f}")
    check(all(a["s1"] + 100 < b["s0"] for a, b in zip(turns, turns[1:])), "turns ordered, >= 100 m apart")
    check(route["turn"] == turns[-1], "legacy turn = last turn")
    for t in turns:
        t0, t1 = t["s0"], t["s1"]
        turn = math.degrees(h[min(int(t1 / sp) + 2, len(h) - 1)] - h[max(int(t0 / sp) - 2, 0)])
        ok_dir = (turn < 0) == (t["direction"] == "left")  # z points south: a left turn decreases the x/z heading
        check(60 < abs(turn) < 120 and ok_dir, f"turn {t['direction']:5} {abs(turn):5.1f} deg onto {t['name']} at s {t0}-{t1} "
                                               f"(R {t.get('radius')} m, arc {t1 - t0:.1f} m)")
    for c in m["cuts"]:
        s = c["s0"] - sum(cc["s1"] - cc["s0"] for cc in m["cuts"] if cc["s1"] <= c["s0"])
        i = int(round(s / sp))
        win = dh[max(i - 20, 0): i + 20]
        print(f"       splice at final s={s:.0f}: max heading change nearby {win.max():.3f} deg/sample")
    ratio = L / m["realLength"]
    lo, hi = cfg["lengthRatio"]
    check(lo <= ratio <= hi, f"length {L:.0f} m = {ratio:.1%} of real {m['realLength']:.0f} m (allowed {lo:.0%}-{hi:.0%})")
    cps = [c["s"] for c in route["checkpoints"]]
    fin = route["finish"]["s"]
    check(all(a < b for a, b in zip(cps, cps[1:])), "checkpoints strictly increasing")
    check(cps[0] >= 300 and cps[-1] < fin < L, f"first cp {cps[0]:.0f} >= 300, last cp {cps[-1]:.0f} < finish {fin:.0f} < length {L:.0f}")
    gaps = np.diff([0] + cps + [fin])
    check(gaps.max() <= 2000, f"max gap between start/checkpoints/finish {gaps.max():.0f} m")
    between = [c for c in cps if any(a["s1"] < c < b["s0"] for a, b in zip(turns, turns[1:]))]
    check(len(turns) < 2 or between, f"{len(between)} checkpoint(s) between turns: {between}")
    # debug keys 1-9 reach the first nine
    check(6 <= len(cps) <= 10, f"{len(cps)} checkpoints")
    check(L - fin >= 150, f"run-out after finish {L - fin:.0f} m")
    secs = route["sections"]
    check(secs[0]["s0"] == 0 and secs[-1]["s1"] == L and all(a["s1"] == b["s0"] and a["s0"] < a["s1"] for a, b in zip(secs, secs[1:])),
          "sections contiguous: " + ", ".join(f"{s['id']} {s['s0']:.0f}-{s['s1']:.0f}" for s in secs))
    opp = route.get("oppositeOffset")
    check(opp is None or len(opp) == len(cl), "oppositeOffset length matches centerline")
    want = [l["id"] for l in cfg["landmarks"]]
    have = [l["id"] for l in route["landmarks"]]
    check(all(w in have for w in want if w != "kingkey100"), f"landmarks found: {have} (missing {[w for w in want if w not in have]})")
    b = bdata["buildings"]
    check(len(b) > 0 and bdata["meta"]["count"] == len(b), f"{len(b)} buildings")
    cz = route.get("clearZones")
    if cz is not None:
        check(all(len(z) >= 3 and Polygon(z).area > 1 for z in cz), f"{len(cz)} clear zones are polygons")
    return ok


def coverage_report(cfg, osm, proj, U, sp, R, extra=()):
    """Footprint coverage per 250 m of original route, both sides, 0-300 m lateral: OSM footprints, then
    OSM plus `extra` (original-frame polygons, e.g. the Overture additions)."""
    bins = np.arange(0, U.length + 250, 250.0)
    area = np.zeros(len(bins) - 1)
    polys = []
    for b in osm["buildings"]:
        ring = proj.fwd(b["ring"])
        c = ring.mean(0)
        if (np.abs(c - U.p.mean(0)) > 9000).any():
            continue
        poly = Polygon(ring)
        if poly.is_valid:
            polys.append(poly)
    n_osm = len(polys)
    area_all = None
    for k, poly in enumerate(polys + list(extra)):
        if k == n_osm:
            area_all = area.copy()
        s, d = U.project(np.array(poly.centroid.coords))
        if abs(d[0]) > 300 or not (0.5 < s[0] < U.length - 0.5):
            continue
        (area_all if area_all is not None else area)[int(s[0] // 250)] += poly.area
    if area_all is None:
        area_all = area
    kept_bins = [i for i in range(len(area)) if sp.piece(np.array([bins[i] + 125]))[0] >= 0]
    for label, a in (("OSM", area), ("OSM + Overture", area_all)) if len(extra) else (("OSM", area),):
        cov = a / (250 * 600)
        low = [f"{bins[i]:.0f}-{bins[i] + 250:.0f}" for i in kept_bins if cov[i] < 0.06]
        print(f"[coverage] {label}: footprint share of 600 m wide corridor per 250 m (kept parts): median {np.median(cov[kept_bins]):.0%}; "
              f"bins < 6%: {len(low)} -> {', '.join(low)}")
    cov = area_all / (250 * 600)
    cache = ROOT / "data-raw" / "coverage_bins.json"
    cache.write_text(json.dumps([dict(s0=float(bins[i]), cover=round(float(cov[i]), 3), cover_osm=round(float(area[i] / (250 * 600)), 3),
                                      cut=bool(sp.piece(np.array([bins[i] + 125]))[0] < 0)) for i in range(len(cov))]))


def plot(route, bdata, sp, U, F, path):
    import logging

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection

    logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
    plt.rcParams["font.sans-serif"] = ["Arial Unicode MS", "Heiti SC", "PingFang SC", "Hiragino Sans GB", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    cl = np.array(route["centerline"])
    L = route["meta"]["length"]
    step = route["meta"]["sampleSpacing"]
    Fp = Polyline(cl)
    zc = {"nanshan": "#4e79a7", "oct": "#59a14f", "chegongmiao": "#f28e2b", "futian": "#e15759"}

    def at(s):
        return Fp.at(np.clip(s, 0, L))

    def norm(s):
        t = Fp.tangent(np.clip(s, 1, L - 1), 2.0)
        return np.array([-t[1], t[0]])

    fig = plt.figure(figsize=(22, 16))
    gs = fig.add_gridspec(2, 3, height_ratios=[1.25, 1])
    axes = [fig.add_subplot(gs[0, :])] + [fig.add_subplot(gs[1, i]) for i in range(3)]
    turns = route.get("turns") or [route["turn"]]
    splice_s = []
    for c in route["meta"]["cuts"]:
        splice_s.append(c["s0"] - sum(cc["s1"] - cc["s0"] for cc in route["meta"]["cuts"] if cc["s1"] <= c["s0"]))
    views = [None, (0, 900), (splice_s[-1] - 450, splice_s[-1] + 450) if splice_s else (4000, 5000), (turns[0]["s0"] - 250, L)]
    titles = ["SHENZHEN DRIVE route (local metres, north up; cuts spliced; magenta = turns; grey = procedural filler, "
              "pale = far skyline, dashed cyan = landmark view-corridor clear zones)",
              "start / 腾讯大厦", "last splice", "福田 CBD loop / 平安金融中心 / 市民中心"]
    polys = [np.array(b["fp"]) for b in bdata["buildings"]]
    cols = ["#8c8c8c" if b["id"] < 0 else zc[b["zone"]] for b in bdata["buildings"]]
    alphas = [0.25 if b.get("far") else 0.6 for b in bdata["buildings"]]
    opp = np.array(route.get("oppositeOffset") or [])
    ss = np.arange(len(cl)) * step
    nn = np.array([norm(s) for s in ss])
    for ax, view, title in zip(axes, views, titles):
        pc = PolyCollection([p[:, [0, 1]] for p in polys], facecolors=cols, edgecolors="none")
        pc.set_alpha(None)
        pc.set_facecolor([matplotlib.colors.to_rgba(c, a) for c, a in zip(cols, alphas)])
        ax.add_collection(pc)
        if route.get("clearZones"):
            ax.add_collection(PolyCollection([np.array(z) for z in route["clearZones"]], facecolors=(0.0, 0.75, 0.85, 0.12),
                                             edgecolors=(0.0, 0.6, 0.7, 0.8), linewidths=0.8, linestyles="--"))
        for side in (-7, 7):
            e = cl + nn * side
            ax.plot(e[:, 0], e[:, 1], color="0.35", lw=0.6)
        if len(opp):
            o = cl + nn * opp[:, None]
            ax.plot(o[:, 0], o[:, 1], color="0.6", lw=0.6, ls="--")
        ax.plot(cl[:, 0], cl[:, 1], color="k", lw=1.2)
        for k, t in enumerate(turns):
            ti = (ss >= t["s0"]) & (ss <= t["s1"])
            ax.plot(cl[ti, 0], cl[ti, 1], color="magenta", lw=3)
            if view is not None:
                ax.annotate(f"T{k + 1} {t['direction']} R{t.get('radius', '?')}\n→ {t['name']}", at((t["s0"] + t["s1"]) / 2),
                            xytext=(8, -4), textcoords="offset points", color="magenta", fontsize=8, weight="bold")
        for s in splice_s:
            p = at(s)
            ax.plot(*p, marker="X", color="red", ms=12, zorder=6)
            ax.annotate(f"splice s={s:.0f}", p, xytext=(5, 12), textcoords="offset points", color="red", fontsize=9)
        for cp in route["checkpoints"]:
            p, n = at(cp["s"]), norm(cp["s"])
            seg = np.array([p - n * 12, p + n * 12])
            ax.plot(seg[:, 0], seg[:, 1], color="blue", lw=2.5, zorder=5)
            ax.annotate(f"CP {cp['name']}\n{cp['s']:.0f}", p, xytext=(4, -22), textcoords="offset points", color="blue", fontsize=8)
        p, n = at(route["finish"]["s"]), norm(route["finish"]["s"])
        seg = np.array([p - n * 14, p + n * 14])
        ax.plot(seg[:, 0], seg[:, 1], color="green", lw=4, zorder=5)
        ax.annotate(f"FINISH {route['finish']['s']:.0f}", p, xytext=(-80, 6), textcoords="offset points", color="green", fontsize=9, weight="bold")
        for sg in route["signs"]:
            p = at(sg["s"]) + norm(sg["s"]) * (10 if sg["side"] == "right" else -10)
            ax.plot(*p, marker="s", color="purple", ms=6, zorder=6)
            ax.annotate(f"{sg['text']}", p, xytext=(4, 4), textcoords="offset points", color="purple", fontsize=7)
        for lm in route["landmarks"]:
            if lm.get("footprint"):
                fp = np.array(lm["footprint"] + [lm["footprint"][0]])
                ax.plot(fp[:, 0], fp[:, 1], color="black", lw=1.2)
            ax.plot(lm["x"], lm["z"], marker="*", color="gold", mec="k", ms=14, zorder=7)
            ax.annotate(f"{lm['name']}\ns={lm['s']:.0f} d={lm['d']:.0f}", (lm["x"], lm["z"]), xytext=(6, 6),
                        textcoords="offset points", fontsize=8, weight="bold")
        if view is None:
            pad = 400
            ax.set_xlim(cl[:, 0].min() - pad, cl[:, 0].max() + pad)
            ax.set_ylim(cl[:, 1].max() + pad, cl[:, 1].min() - pad)
            for sec in route["sections"]:
                p = at((sec["s0"] + sec["s1"]) / 2) + norm((sec["s0"] + sec["s1"]) / 2) * 420
                ax.text(p[0], p[1], sec["name"], color=zc[sec["id"]], fontsize=12, weight="bold", ha="center")
        else:
            a, b = view
            seg = cl[(ss >= a) & (ss <= b)]
            cx, cz = seg.mean(0)
            r = max(np.ptp(seg[:, 0]), np.ptp(seg[:, 1])) / 2 + 250
            ax.set_xlim(cx - r, cx + r)
            ax.set_ylim(cz + r, cz - r)
        ax.set_aspect("equal")
        ax.set_title(title)
        ax.grid(alpha=0.2)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=110)
    plt.close(fig)
    print(f"[out] {path.relative_to(ROOT)}")


def plan_report(cfg, proj, feats, U, R, xs):
    print("\n== cross streets (s_orig, name)")
    for s, n in xs:
        print(f"  {s:7.0f}  {n}")
    print("\n== landmarks")
    for lm in cfg.get("landmarks", []):
        g = feats.geom(lm["osm"], proj)
        if g is None:
            print("  MISSING", lm["id"], lm["osm"])
            continue
        s, d = U.project(g[0][None])
        print(f"  {lm['id']:14} s={s[0]:7.0f} d={d[0]:7.0f}")
    print("\n== heading profile (every 100 m): s, compass heading, change over next 100 m, max |dθ|/2m in window")
    for s in np.arange(0, U.length - 100, 100.0):
        h0 = math.degrees(U.heading(s, 2.0))
        h1 = math.degrees(U.heading(s + 100, 2.0))
        hh = np.unwrap(U.heading(np.arange(s, s + 100, 2.0), 1.0))
        k = np.degrees(np.abs(np.diff(hh))).max()
        print(f"  {s:7.0f} {(90 + h0) % 360:6.1f} {math.degrees(wrap(math.radians(h1 - h0))):6.2f} {k:5.2f}")


if __name__ == "__main__":
    main()
