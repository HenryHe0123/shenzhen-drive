#!/usr/bin/env python3
"""Cut the city-data bbox out of the World Settlement Footprint 3D building height (DLR, CC BY 4.0).

Reads the global cloud-optimised GeoTIFF over HTTP (only the blocks covering the bbox) and writes
`wsf3d.path` of scripts/city_config.json: average building height per ~90 m cell, Int16 with gain
0.1 (as in the source), which scripts/build_city_data.py samples per footprint.

Usage: .venv/bin/python scripts/clip_wsf3d.py
"""

import json
import os
from pathlib import Path

import rasterio
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
SRC = "/vsicurl/https://download.geoservice.dlr.de/WSF3D/files/global/WSF3D_V02_BuildingHeight.tif"


def main():
    cfg = json.loads((ROOT / "scripts" / "city_config.json").read_text())
    W, S, E, N = cfg["osm"]["bbox"]
    pad = 0.02
    out = ROOT / cfg["wsf3d"]["path"]
    os.environ.setdefault("GDAL_HTTP_USERAGENT", "Mozilla/5.0")
    with rasterio.open(SRC) as ds:
        win = from_bounds(W - pad, S - pad, E + pad, N + pad, ds.transform).round_offsets().round_lengths()
        a = ds.read(1, window=win)
        prof = ds.profile.copy()
        for k in ("blockxsize", "blockysize", "tiled"):
            prof.pop(k, None)
        prof.update(width=a.shape[1], height=a.shape[0], transform=ds.window_transform(win), compress="lzw")
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", **prof) as dst:
        dst.write(a, 1)
    print(f"wrote {out.relative_to(ROOT)}: {a.shape[1]} x {a.shape[0]} cells, max {a.max() * 0.1:.1f} m")


if __name__ == "__main__":
    main()
