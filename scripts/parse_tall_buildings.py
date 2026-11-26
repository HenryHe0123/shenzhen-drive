#!/usr/bin/env python3
"""Shenzhen's tallest buildings from English Wikipedia's "List of tallest buildings in Shenzhen"
(CC BY-SA 4.0; heights from CTBUH): name, height, floors, year, district and coordinates per row.

Reads data-raw/landmarks/wiki_en.json (the page's wikitext from the MediaWiki parse API, fetched by
data-raw/download.sh tall) and writes data-raw/landmarks/tall_buildings.json, which
scripts/build_metro_data.py matches to footprints (height overrides for the skyline).

Usage: .venv/bin/python scripts/parse_tall_buildings.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data-raw" / "landmarks" / "wiki_en.json"
OUT = ROOT / "data-raw" / "landmarks" / "tall_buildings.json"


def coord(t):
    """Decimal lat / lon from a {{coord}} template (decimal, d|m|s|N|E or decimal|N|decimal|E forms)."""
    m = re.search(r"\{\{coord\|([^}]*)\}\}", t, re.I)
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).split("|") if "=" not in p and not p.strip().startswith(("region:", "type:"))]
    nums, hemi = [], []
    for p in parts:
        if p in ("N", "S", "E", "W"):
            hemi.append(p)
            nums.append(None)
        else:
            try:
                nums.append(float(p))
            except ValueError:
                pass
    if not hemi:
        vals = [n for n in nums if n is not None]
        return (vals[0], vals[1]) if len(vals) >= 2 else None
    # split at hemisphere letters: [lat parts] N [lon parts] E
    groups, cur = [], []
    for n in nums:
        if n is None:
            groups.append(cur)
            cur = []
        else:
            cur.append(n)
    if len(groups) < 2:
        return None
    dms = lambda g: g[0] + (g[1] if len(g) > 1 else 0) / 60 + (g[2] if len(g) > 2 else 0) / 3600  # noqa: E731
    lat, lon = dms(groups[0]), dms(groups[1])
    if hemi[0] == "S":
        lat = -lat
    if hemi[1] == "W":
        lon = -lon
    return lat, lon


def clean(t):
    t = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", t, flags=re.S)
    m = re.search(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", t)
    if m:
        return (m.group(2) or m.group(1)).strip(), m.group(1).strip()
    return re.sub(r"'''?|\{\{[^}]*\}\}", "", t).strip(), None


def main():
    txt = json.loads(SRC.read_text())["parse"]["wikitext"]["*"]
    rows = []
    for tbl in re.findall(r"\{\| class.*?\n\|\}", txt, flags=re.S):
        for row in tbl.split("\n|-")[1:]:
            cells = [c for c in re.split(r"\n\|(?!\})", row) if c.strip()]
            cells = [re.sub(r"^\s*style\{\{=\}\}\"[^\"]*\"\s*\|", "", c).strip() for c in cells]
            hm = next((re.search(r"\{\{cvt\|([\d.]+)\|m", c) for c in cells if "{{cvt|" in c), None)
            c = next((coord(c) for c in cells if "{{coord" in c.lower()), None)
            if not hm or not c:
                continue
            hi = next(i for i, x in enumerate(cells) if "{{cvt|" in x)
            name, article = clean(cells[hi - 2] if "[[File:" in cells[hi - 1] else cells[hi - 1])
            floors = re.sub(r"[^\d]", "", cells[hi + 1]) if hi + 1 < len(cells) else ""
            year = re.search(r"(19|20)\d\d", cells[hi + 2]) if hi + 2 < len(cells) else None
            status = "completed"
            low = " ".join(cells[hi + 2:hi + 3]).lower()
            if "hold" in low or "construction" in low or "proposed" in low or not year:
                status = "other"
            rows.append(dict(name=name, article=article, height=float(hm.group(1)), floors=int(floors) if floors else None,
                             year=int(year.group(0)) if year else None, status=status, lat=round(c[0], 6), lon=round(c[1], 6)))
    seen, out = set(), []
    for r in rows:
        k = (r["name"], r["lat"], r["lon"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    done = [r for r in out if r["status"] == "completed"]
    print(f"wrote {OUT.relative_to(ROOT)}: {len(out)} rows ({len(done)} completed, {min(r['height'] for r in out):.0f}-{max(r['height'] for r in out):.0f} m)")


if __name__ == "__main__":
    main()
