#!/usr/bin/env python3
"""Clip CMAB rooftops (China Multi-Attribute Building dataset, CC BY 4.0) to the city-data bbox.

Reads the shapefiles given on the command line (extracted from CMAB_origin.rar by
data-raw/download.sh), keeps the rooftops intersecting `osm.bbox` of scripts/city_config.json and
writes `cmab.path` (GeoParquet-like: WGS-84 WKB + height, floors, function, age), which
scripts/build_city_data.py reads.

Usage: .venv/bin/python scripts/clip_cmab.py data-raw/cmab/extract/province/广东省/<id>_<date>.shp [...]
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pyogrio.raw
import shapely
from pyproj import CRS, Transformer

ROOT = Path(__file__).resolve().parent.parent
FIELDS = {"pred_h_r": "height", "Floor": "floors", "predict": "function", "Age": "age"}


def main():
    cfg = json.loads((ROOT / "scripts" / "city_config.json").read_text())
    W, S, E, N = cfg["osm"]["bbox"]
    out = ROOT / cfg["cmab"]["path"]
    cols = {v: [] for v in FIELDS.values()}
    wkb = []
    for shp in sys.argv[1:]:
        info = pyogrio.read_info(shp)
        crs = CRS.from_user_input(info["crs"]) if info["crs"] else CRS.from_epsg(4326)
        to_src = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        xs, ys = to_src.transform([W, E, E, W], [S, S, N, N])
        bbox = (min(xs), min(ys), max(xs), max(ys))
        have = [f for f in FIELDS if f in info["fields"]]
        _, _, geom, data = pyogrio.raw.read(shp, columns=have, bbox=bbox)
        g = shapely.from_wkb(geom)
        to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        g = shapely.transform(g, lambda xy: np.column_stack(to_ll.transform(xy[:, 0], xy[:, 1])))
        sel = shapely.intersects(g, shapely.box(W, S, E, N))
        print(f"{shp}: CRS {crs.name}, {sel.sum()} of {len(g)} rooftops in the bbox; fields {have}")
        wkb.extend(shapely.to_wkb(g[sel]))
        for f, k in FIELDS.items():
            vals = data[have.index(f)][sel] if f in have else np.full(sel.sum(), None)
            cols[k].extend(vals.tolist())
    tbl = pa.table({"wkb": pa.array(wkb, pa.binary()),
                    "height": pa.array([float(v) if v not in (None, "") else None for v in cols["height"]], pa.float64()),
                    "floors": pa.array([float(v) if v not in (None, "") else None for v in cols["floors"]], pa.float64()),
                    "function": pa.array([None if v is None else str(v) for v in cols["function"]], pa.string()),
                    "age": pa.array([None if v is None else str(v) for v in cols["age"]], pa.string())})
    out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(tbl, out)
    print(f"wrote {out.relative_to(ROOT)}: {tbl.num_rows} rooftops")


if __name__ == "__main__":
    main()
