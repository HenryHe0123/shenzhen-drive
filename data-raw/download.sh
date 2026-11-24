#!/bin/sh
# Resumable download of the Guangdong OSM extract. Progress goes to download.log.
cd "$(dirname "$0")"
URL=https://download.geofabrik.de/asia/china/guangdong-latest.osm.pbf
{
  echo "[$(date '+%F %T')] start, existing bytes: $(stat -f%z guangdong-latest.osm.pbf 2>/dev/null || echo 0)"
  curl -L -C - --retry 10 --retry-delay 5 --progress-bar -o guangdong-latest.osm.pbf "$URL" 2>&1 | tr '\r' '\n' | awk 'NR % 20 == 0'
  echo "[$(date '+%F %T')] curl exit: $?, bytes: $(stat -f%z guangdong-latest.osm.pbf)"
  if [ "$(stat -f%z guangdong-latest.osm.pbf)" = "176061618" ]; then echo "DOWNLOAD_DONE"; else echo "DOWNLOAD_INCOMPLETE (rerun: sh data-raw/download.sh)"; fi
} >> download.log 2>&1
