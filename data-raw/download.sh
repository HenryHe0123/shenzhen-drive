#!/bin/sh
# Resumable downloads of the raw city data. Progress goes to download.log.
#   sh data-raw/download.sh            OSM Guangdong extract (Geofabrik)
#   sh data-raw/download.sh cmab       CMAB building heights: 7.9 GB archive, Shenzhen layer clipped to the bbox
#   sh data-raw/download.sh wsf3d      WSF3D 90 m building height, only the bbox window of the global file (needs rasterio in .venv)
#   sh data-raw/download.sh overture   Overture Maps buildings in the bbox (needs overturemaps in .venv)
#   sh data-raw/download.sh metro      whole-city inputs for scripts/build_metro_data.py (~1.3 GB of reads, ~15 min)
#   sh data-raw/download.sh all
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
BBOX=113.90,22.50,114.12,22.585

osm() {
  URL=https://download.geofabrik.de/asia/china/guangdong-latest.osm.pbf
  {
    echo "[$(date '+%F %T')] osm start, existing bytes: $(stat -f%z guangdong-latest.osm.pbf 2>/dev/null || echo 0)"
    curl -L -C - --retry 10 --retry-delay 5 --progress-bar -o guangdong-latest.osm.pbf "$URL" 2>&1 | tr '\r' '\n' | awk 'NR % 20 == 0'
    echo "[$(date '+%F %T')] curl exit: $?, bytes: $(stat -f%z guangdong-latest.osm.pbf)"
    if [ "$(stat -f%z guangdong-latest.osm.pbf)" = "176061618" ]; then echo "DOWNLOAD_DONE"; else echo "DOWNLOAD_INCOMPLETE (rerun: sh data-raw/download.sh)"; fi
  } >> download.log 2>&1
}

# CMAB (Mendeley Data b4t2wxhn2y v5, CC BY 4.0). The archive uses RAR 7 compression, which 7-Zip cannot
# unpack; RARLAB's freeware unrar is built from source into cmab/bin. Shenzhen is in the Pearl River Delta
# part 1 file, which covers only lon >= 114.028 (福田 / 罗湖; 南山 is not in the release).
cmab() {
  mkdir -p cmab && cd cmab || exit 1
  URL=https://data.mendeley.com/public-files/datasets/b4t2wxhn2y/files/a97a40ba-3cce-4319-8096-cdf05f981626/file_downloaded
  SHA=ab381b70f544d303ad7594db38e5b6668526dfa63b63b55863a3b2725ad75977
  LAYER=province/广东省/zhusanjiaoyi20220302
  {
    echo "[$(date '+%F %T')] cmab start, existing bytes: $(stat -f%z CMAB_origin.rar 2>/dev/null || echo 0)"
    if [ "$(stat -f%z CMAB_origin.rar 2>/dev/null)" != "7915238124" ]; then
      curl -L -C - --retry 30 --retry-delay 5 --retry-all-errors -sS -o CMAB_origin.rar "$URL"
    fi
    if [ "$(shasum -a 256 CMAB_origin.rar | cut -d' ' -f1)" != "$SHA" ]; then echo "CMAB_INCOMPLETE (rerun: sh data-raw/download.sh cmab)"; exit 1; fi
    if [ ! -x bin/unrar ]; then
      mkdir -p bin build && curl -sSL -o build/unrarsrc.tar.gz https://www.rarlab.com/rar/unrarsrc-7.3.2.tar.gz &&
        tar xzf build/unrarsrc.tar.gz -C build && make -C build/unrar -f makefile > build/make.log 2>&1 && cp build/unrar/unrar bin/
    fi
    bin/unrar x -o+ -inul CMAB_origin.rar "$LAYER.*" extract/ &&
      "$ROOT/.venv/bin/python" "$ROOT/scripts/clip_cmab.py" "extract/$LAYER.shp" && echo "CMAB_DONE"
  } >> ../download.log 2>&1
  cd ..
}

# WSF3D building height (DLR, CC BY 4.0): reads only the bbox blocks of the global cloud-optimised GeoTIFF.
wsf3d() {
  {
    echo "[$(date '+%F %T')] wsf3d start"
    "$ROOT/.venv/bin/python" "$ROOT/scripts/clip_wsf3d.py" && echo "WSF3D_DONE"
  } >> download.log 2>&1
}

# Overture Maps buildings (ODbL 1.0); the release used is recorded in overture/buildings.parquet.state.
overture() {
  mkdir -p overture
  {
    echo "[$(date '+%F %T')] overture start"
    "$ROOT/.venv/bin/overturemaps" download --bbox=$BBOX -f geoparquet --type=building -o overture/buildings.parquet && echo "OVERTURE_DONE"
  } >> download.log 2>&1
}

# Whole-city scenery (v0.6.0, scripts/build_metro_data.py): Overture buildings / water for the metro and
# terrain windows, the CMAB layers that cover 深圳市, WSF3D, Copernicus GLO-30 + ESA WorldCover, a cloud-free
# Sentinel-2 composite and Wikipedia's tallest-building list. Needs the cmab step's archive for its CMAB part.
METRO_BBOX=113.74,22.39,114.66,22.87
TERRAIN_BBOX=113.55,22.12,114.80,22.995
metro() {
  mkdir -p overture landmarks
  {
    echo "[$(date '+%F %T')] metro start"
    "$ROOT/.venv/bin/overturemaps" download --bbox=$METRO_BBOX -f geoparquet --type=building -o overture/buildings_metro.parquet &&
      "$ROOT/.venv/bin/overturemaps" download --bbox=$TERRAIN_BBOX -f geoparquet --type=water -o overture/water_terrain.parquet &&
      echo "METRO_OVERTURE_DONE"
    if [ -f cmab/CMAB_origin.rar ]; then
      L=province/广东省
      (cd cmab && bin/unrar x -o+ -inul CMAB_origin.rar "$L/zhusanjiaoyi20220302.*" "$L/zhusanjiaoliu20220306.*" "$L/zhusanjiaowu20220302.*" \
        "$L/1921_20220408.*" "$L/1942_20220302.*" extract/) &&
        "$ROOT/.venv/bin/python" "$ROOT/scripts/clip_cmab.py" --metro cmab/extract/$L/zhusanjiaoyi20220302.shp cmab/extract/$L/zhusanjiaoliu20220306.shp \
          cmab/extract/$L/zhusanjiaowu20220302.shp cmab/extract/$L/1921_20220408.shp cmab/extract/$L/1942_20220302.shp && echo "METRO_CMAB_DONE"
    fi
    "$ROOT/.venv/bin/python" "$ROOT/scripts/clip_wsf3d.py" --metro && echo "METRO_WSF3D_DONE"
    "$ROOT/.venv/bin/python" "$ROOT/scripts/fetch_terrain.py" cop30 && "$ROOT/.venv/bin/python" "$ROOT/scripts/fetch_terrain.py" worldcover && echo "METRO_TERRAIN_DONE"
    "$ROOT/.venv/bin/python" -u "$ROOT/scripts/fetch_imagery.py" && echo "METRO_IMAGERY_DONE"
    curl -sS --retry 5 -A "Mozilla/5.0" -o landmarks/wiki_en.json \
      "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_tallest_buildings_in_Shenzhen&prop=wikitext&format=json" &&
      "$ROOT/.venv/bin/python" "$ROOT/scripts/parse_tall_buildings.py" && echo "METRO_TALL_DONE"
  } >> download.log 2>&1
}

case "${1:-osm}" in
  osm) osm ;;
  cmab) cmab ;;
  wsf3d) wsf3d ;;
  overture) overture ;;
  metro) metro ;;
  all) osm; cmab; wsf3d; overture; metro ;;
  *) echo "usage: sh data-raw/download.sh [osm|cmab|wsf3d|overture|metro|all]"; exit 2 ;;
esac
