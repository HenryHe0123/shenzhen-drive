#!/usr/bin/env python3
"""Cut the terrain window (city_config.json `metro.terrainBbox`) out of a global DEM.

  Copernicus GLO-30 DSM (ESA / Airbus, Copernicus DEM licence: free use with attribution): surface model
    incl. buildings and canopy, from the AWS open-data bucket (two 1 x 1 degree COGs, ~20 s). Buildings
    are taken out in scripts/build_metro_data.py (morphological opening where footprints are dense).
  FABDEM V1-2 (Hawker et al. 2022, University of Bristol, CC BY-NC-SA 4.0), optional: the same DEM with
    buildings and forests already removed, read out of its 2 GB 10 x 10 degree zip over HTTP range
    requests. The server delivers ~40 KB/s, so a run takes many hours; used instead of GLO-30 when present.

  ESA WorldCover 2021 v200 (CC BY 4.0), 10 m land cover; its built-up class marks where the DSM is lifted
    by buildings outside the footprint data (Hong Kong, Dongguan).

Writes data-raw/terrain/cop30.tif (and fabdem.tif), float32, EPSG:4326, 1 arc-second, and
data-raw/terrain/worldcover.tif (uint8 classes, 1/12000 degree).

Usage: .venv/bin/python scripts/fetch_terrain.py [cop30|fabdem|worldcover]
"""

import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
FABDEM_ZIP = "https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N20E110-N30E120_FABDEM_V1-2.zip"
COP30 = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM/Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM.tif"
WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{lat:02d}E{lon:03d}_Map.tif"
RES = 1 / 3600


def tiles(bbox):
    W, S, E, N = bbox
    for lat in range(math.floor(S), math.ceil(N)):
        for lon in range(math.floor(W), math.ceil(E)):
            yield lat, lon


def mosaic(bbox, path_of, out):
    W, S, E, N = bbox
    w = int(round((E - W) / RES))
    h = int(round((N - S) / RES))
    dst = np.full((h, w), np.nan, np.float32)
    tr = from_origin(W, N, RES, RES)
    for lat, lon in tiles(bbox):
        src = path_of(lat, lon)
        t0 = time.time()
        try:
            ds = rasterio.open(src)
        except Exception as e:  # noqa: BLE001
            print(f"  {lat}/{lon}: unavailable ({e})")
            continue
        with ds:
            tw, ts, te, tn = max(W, ds.bounds.left), max(S, ds.bounds.bottom), min(E, ds.bounds.right), min(N, ds.bounds.top)
            win = from_bounds(tw, ts, te, tn, ds.transform).round_offsets().round_lengths()
            a = ds.read(1, window=win).astype(np.float32)
            if ds.nodata is not None:
                a[a == ds.nodata] = np.nan
            wt = ds.window_transform(win)
        c0 = int(round((wt.c - W) / RES))
        r0 = int(round((N - wt.f) / RES))
        hh, ww = min(a.shape[0], h - r0), min(a.shape[1], w - c0)
        dst[r0:r0 + hh, c0:c0 + ww] = a[:hh, :ww]
        print(f"  tile N{lat} E{lon}: {a.shape[1]} x {a.shape[0]} px in {time.time() - t0:.0f}s")
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32", crs="EPSG:4326",
                       transform=tr, nodata=np.nan, compress="deflate", predictor=3, tiled=True) as d:
        d.write(dst, 1)
    ok = np.isfinite(dst)
    print(f"wrote {out.relative_to(ROOT)}: {w} x {h}, {ok.mean():.1%} valid, range {np.nanmin(dst):.1f} .. {np.nanmax(dst):.1f} m")


def worldcover(bbox, out):
    """WorldCover classes over the window from its 3 x 3 degree tiles (nearest, native 1/12000 degree)."""
    W, S, E, N = bbox
    res = 1 / 12000
    w, h = int(round((E - W) / res)), int(round((N - S) / res))
    dst = np.zeros((h, w), np.uint8)
    for lat in range(math.floor(S / 3) * 3, math.ceil(N / 3) * 3, 3):
        for lon in range(math.floor(W / 3) * 3, math.ceil(E / 3) * 3, 3):
            t0 = time.time()
            with rasterio.open("/vsicurl/" + WORLDCOVER.format(lat=lat, lon=lon)) as ds:
                tw, ts, te, tn = max(W, ds.bounds.left), max(S, ds.bounds.bottom), min(E, ds.bounds.right), min(N, ds.bounds.top)
                if tw >= te or ts >= tn:
                    continue
                win = from_bounds(tw, ts, te, tn, ds.transform).round_offsets().round_lengths()
                a = ds.read(1, window=win)
                wt = ds.window_transform(win)
            c0, r0 = int(round((wt.c - W) / res)), int(round((N - wt.f) / res))
            hh, ww = min(a.shape[0], h - r0), min(a.shape[1], w - c0)
            dst[r0:r0 + hh, c0:c0 + ww] = a[:hh, :ww]
            print(f"  WorldCover N{lat} E{lon}: {a.shape[1]} x {a.shape[0]} px in {time.time() - t0:.0f}s")
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=1, dtype="uint8", crs="EPSG:4326",
                       transform=from_origin(W, N, res, res), nodata=0, compress="deflate", tiled=True) as d:
        d.write(dst, 1)
    print(f"wrote {out.relative_to(ROOT)}: {w} x {h}, built-up {np.mean(dst == 50):.1%}")


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "cop30"
    cfg = json.loads((ROOT / "scripts" / "city_config.json").read_text())
    bbox = cfg["metro"]["terrainBbox"]
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
    os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "3")
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("CPL_VSIL_CURL_CHUNK_SIZE", "4194304")
    out_dir = ROOT / "data-raw" / "terrain"
    if what == "cop30":
        print("[cop30] Copernicus GLO-30 DSM")
        mosaic(bbox, lambda lat, lon: "/vsicurl/" + COP30.format(ns="N" if lat >= 0 else "S", lat=abs(lat), ew="E" if lon >= 0 else "W", lon=abs(lon)),
               out_dir / "cop30.tif")
    if what == "worldcover":
        print("[worldcover] ESA WorldCover 2021")
        worldcover(bbox, out_dir / "worldcover.tif")
    if what == "fabdem":
        print("[fabdem] FABDEM V1-2 (opening the remote zip takes a few minutes)")
        mosaic(bbox, lambda lat, lon: f"/vsizip//vsicurl/{FABDEM_ZIP}/N{lat:02d}E{lon:03d}_FABDEM_V1-2.tif", out_dir / "fabdem.tif")


if __name__ == "__main__":
    main()
