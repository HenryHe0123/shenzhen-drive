import math
import osmium
from shapely.geometry import LineString, Polygon, Point

S, W, N, E = 22.525, 113.935, 22.560, 114.070
LAT0 = 22.54
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def xy(lon, lat):
    return ((lon - W) * KX, (lat - S) * KY)


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads = []
        self.blds = []

    def way(self, w):
        t = w.tags
        name = t.get("name", "")
        try:
            pts = [xy(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not pts:
            return
        if not any(0 <= x <= (E - W) * KX and 0 <= y <= (N - S) * KY for x, y in pts):
            return
        if "highway" in t and name in ("深南大道", "深南中路", "深南东路"):
            self.roads.append((name, t.get("highway"), t.get("lanes"), pts))
        if "building" in t and len(pts) >= 4:
            self.blds.append(
                dict(
                    name=name,
                    height=t.get("height"),
                    levels=t.get("building:levels"),
                    poly=Polygon(pts),
                )
            )


h = H()
h.apply_file("data-raw/guangdong-latest.osm.pbf", locations=True, idx="flex_mem")
print("shennan road ways", len(h.roads), "names", sorted({r[0] for r in h.roads}))
print("lanes tags", sorted({r[2] for r in h.roads if r[2]}))
road = [LineString(r[3]) for r in h.roads]
from shapely.ops import unary_union

road_u = unary_union(road)
print("shennan total way length (both directions) km", round(road_u.length / 1000, 1))
corr = road_u.buffer(300)
inc = [b for b in h.blds if b["poly"].is_valid and b["poly"].intersects(corr)]
n = len(inc)
hh = sum(1 for b in inc if b["height"])
ll = sum(1 for b in inc if b["levels"])
either = sum(1 for b in inc if b["height"] or b["levels"])
area = sum(b["poly"].area for b in inc)
print(f"buildings within 300m of Shennan: {n}, height {hh}, levels {ll}, either {either} ({either / max(n, 1):.0%})")
big = [b for b in inc if b["poly"].area > 1500]
bige = sum(1 for b in big if b["height"] or b["levels"])
print(f"footprint >1500 m2: {len(big)}, with height/levels {bige} ({bige / max(len(big), 1):.0%})")
print("footprint area km2", round(area / 1e6, 2), "corridor area km2", round(corr.area / 1e6, 2))
for k in ["平安", "市民中心", "腾讯", "世界之窗", "京基"]:
    hits = [(b["name"], b["height"], b["levels"]) for b in h.blds if k in b["name"]]
    print(k, hits[:4])
