#!/usr/bin/env python3
"""Cloud-free Sentinel-2 true-colour composite of the terrain window (city_config.json `metro.terrainBbox`).

Sentinel-2 L2A Collection 1 (ESA Copernicus, free and open; AWS open data via Element 84 Earth Search):
bottom-of-atmosphere reflectance of B04 / B03 / B02, read from the cloud-optimised GeoTIFFs at 20 m
(overview level 1), cloud / cloud-shadow pixels masked with the scene classification (SCL), reprojected
to EPSG:4326 and stacked in date priority: later dates only fill pixels the earlier ones left empty
(the swath edge runs through 大鹏, so the east comes from a neighbouring orbit).

Writes `metro.imagery` (uint16 reflectance x 10000, 3 bands, 1/5400 deg, nodata 0).

Usage: .venv/bin/python scripts/fetch_imagery.py
"""

import json
import os
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

ROOT = Path(__file__).resolve().parent.parent
STAC = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-c1-l2a"
# All six MGRS tiles of the window nearly cloud-free (< 0.05 %); 03-24 is the western orbit, 02-09 / 01-20 the eastern one.
DATES = ["2025-03-24", "2025-02-09", "2025-01-20", "2025-04-03", "2025-01-18"]
RES = 1 / 5400
DECIM = 2
BAD_SCL = (0, 1, 3, 8, 9, 10)  # no data, saturated, cloud shadow, cloud medium / high, cirrus


def stac(body):
    for i in range(6):
        try:
            req = urllib.request.Request(STAC, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            return json.load(urllib.request.urlopen(req, timeout=60))["features"]
        except Exception as e:  # noqa: BLE001
            print(f"  stac retry {i + 1}: {e}")
            time.sleep(3 + 3 * i)
    raise RuntimeError("STAC search failed")


def main():
    cfg = json.loads((ROOT / "scripts" / "city_config.json").read_text())
    W, S, E, N = cfg["metro"]["terrainBbox"]
    out = ROOT / cfg["metro"]["imagery"]
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
    w = int(round((E - W) / RES))
    h = int(round((N - S) / RES))
    tr = from_origin(W, N, RES, RES)
    dst = np.zeros((3, h, w), np.uint16)
    used = []
    for date in DATES:
        items = stac({"collections": [COLLECTION], "bbox": [W, S, E, N], "datetime": f"{date}T00:00:00Z/{date}T23:59:59Z", "limit": 50})
        for it in items:
            p = it["properties"]
            empty = dst[0] == 0
            if not empty.any():
                break
            t0 = time.time()
            a = it["assets"]
            with rasterio.open("/vsicurl/" + a["scl"]["href"]) as ds:
                scl = ds.read(1)  # 20 m native
            bands = []
            for key in ("red", "green", "blue"):
                with rasterio.open("/vsicurl/" + a[key]["href"]) as ds:
                    arr = ds.read(1, out_shape=(ds.height // DECIM, ds.width // DECIM))
                    src_tr = ds.transform * ds.transform.scale(ds.width / arr.shape[1], ds.height / arr.shape[0])
                    crs = ds.crs
                    rb = a[key].get("raster:bands", [{}])[0]
                    scale, offset = rb.get("scale", 1e-4), rb.get("offset", 0.0)
                refl = arr.astype(np.float32) * scale + offset
                ok = (arr > 0) & ~np.isin(scl[: arr.shape[0], : arr.shape[1]], BAD_SCL)
                v = np.where(ok, np.clip(refl, 0.0001, 1.0) * 10000, 0).astype(np.uint16)
                bands.append(v)
            for b, v in enumerate(bands):
                tmp = np.zeros((h, w), np.uint16)
                reproject(v, tmp, src_transform=src_tr, src_crs=crs, dst_transform=tr, dst_crs="EPSG:4326",
                          resampling=Resampling.bilinear, src_nodata=0, dst_nodata=0)
                if b == 0:
                    fill = empty & (tmp > 0)
                dst[b][fill] = tmp[fill]
            used.append(f"{date} {p['grid:code']}")
            print(f"  {date} {p['grid:code']} (cloud {p['eo:cloud_cover']:.3f} %): +{fill.mean():.1%} of the window in {time.time() - t0:.0f}s")
        print(f"[s2] after {date}: {(dst[0] > 0).mean():.1%} filled")
        if (dst[0] > 0).all():
            break
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=3, dtype="uint16", crs="EPSG:4326", transform=tr,
                       nodata=0, compress="deflate", predictor=2, tiled=True) as d:
        d.write(dst)
        d.update_tags(sources="; ".join(used))
    print(f"wrote {out.relative_to(ROOT)}: {w} x {h}, {(dst[0] > 0).mean():.1%} filled; scenes: {', '.join(used)}")


if __name__ == "__main__":
    main()
