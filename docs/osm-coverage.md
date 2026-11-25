# OSM coverage along 深南大道 (SHENZHEN DRIVE)

Data: Geofabrik `guangdong-latest.osm.pbf` (176,061,618 bytes), OSM replication timestamp
**2026-11-23T21:21:17Z**. © OpenStreetMap contributors, ODbL 1.0.

## `scripts/osm_coverage.py` output

Command: `.venv/bin/python scripts/osm_coverage.py` (reads the full Guangdong file, ~20 s).

```
shennan road ways 92 names ['深南大道']
lanes tags ['2', '3', '4']
shennan total way length (both directions) km 30.4
buildings within 300m of Shennan: 1178, height 99, levels 441, either 460 (39%)
footprint >1500 m2: 246, with height/levels 130 (53%)
footprint area km2 1.73 corridor area km2 9.65
平安 [('平安金融中心', '599.1', '117'), ('平安金融中心南塔', '286', '51'), ('平安财险大厦', '220', '40')]
市民中心 [('市民中心站', None, '0')]
腾讯 []
世界之窗 [('世界之窗', None, None), ('世界之窗站', None, '0')]
京基 [('京基·滨河时代广场', '293', '64')]
```

Caveats of that quick script: its bbox starts at lon 113.935, so 腾讯大厦 (lon 113.9296) and the first
~700 m of the route are outside it; it only reads closed ways, so the Civic Center (a multipolygon
relation) is missed; 京基100 (lon 114.1016) is east of its bbox. All three exist in OSM (table below).

## Interpretation

**1. Height estimation share.** In the quick count 39% of buildings near 深南大道 have `height` or
`building:levels` (53% of footprints > 1500 m²), so about 60% need estimation. For the actual
game corridor (`scripts/build_city_data.py`, after cuts, ≤ 300 m from the driving centerline):

| set | count | `height` tag | `building:levels` | estimated |
|---|---:|---:|---:|---:|
| near OSM buildings (≤ 300 m) | 592 | 29 (5%) | 194 (33%) | 369 (62%; 65% of footprint area) |
| far skyline (300–1500 m, h ≥ 80 m) | 388 | 100 | 288 | 0 (only tagged towers are used) |
| procedural filler blocks | 163 | – | – | 163 |

So the zone/area height rules carry most of the near field; the skyline is fully data-backed.

**v0.5.0 height sources** (`buildings.json` `meta.heightSources`, full uncut route, near ≤ 300 m plus far
skyline 300–1500 m with h ≥ 80 m; procedural blocks are off, so every record is a real footprint):

| footprints | count | OSM `height` | OSM levels × 3.2 m | CMAB | zone estimate |
|---|---:|---:|---:|---:|---:|
| OSM (incl. 575 far) | 1,430 | 220 | 746 | 49 | 415 (29%) |
| Overture machine-learned rooftops | 762 | – | – | 129 | 633 (83%) |
| all | 2,192 | 220 (10%) | 746 (34%) | 178 (8%) | 1,048 (48%) |

v0.4.3 for comparison: 1,624 records = 224 `height`, 743 levels, 453 estimated OSM footprints and 204
procedural blocks (60% data-backed counting the blocks, 68% of the real footprints).

CMAB (`scripts/clip_cmab.py`, file `province/广东省/zhusanjiaoyi20220302` of `CMAB_origin.rar`) covers
Shenzhen only east of lon 114.028 (福田 / 罗湖); 南山 and most of the route west of 香蜜湖 have no
CMAB rooftops, which is why Overture additions there mostly keep zone estimates. Calibration on the
corridor (pipeline log `[cmab]`): on 31 OSM buildings with `height`, CMAB is a median 122 m too low
(+6 m below 30 m, −37 m at 30–100 m, −173 m above 100 m); 平安金融中心 has no CMAB rooftop at all.
On 370 buildings with `height` or levels, CMAB beats the zone estimate except on 1500–3000 m²
footprints (towers), so CMAB is used below OSM levels and never for those footprint sizes.

**2. Footprint gaps: yes.** Footprint share of the 600 m wide corridor, per 250 m of real route,
has a median of only 13% (dense Shenzhen blocks are typically 25–40%). Bins below 6% (real arc
length from the start; the full bins are written to `data-raw/coverage_bins.json` on each pipeline run, not committed):

| real s (m) | where | cause |
|---|---|---|
| 2750–3250 | 沙河西路 – 沙河东路 | green belt / water (`landuse=grass`, `natural=water`), real open space |
| 3750–4000 | 世界之窗 | theme park + forest, real open space |
| 6250–6500 | 华侨城 east | residential estates (锦绣花园) mapped as landuse only, few footprints |
| 7250–7500 | 侨城东 – 竹子林 | 竹子林 metro depot (`landuse=railway`, 26 ha) |
| 10000–10250 | 香蜜湖路 interchange | interchange ramps |
| 10500–11750 | 香蜜湖 – 新洲路 | north: 52 ha construction site (香蜜湖 redevelopment); south: Shenzhen Golf Club, metro yard, woods |
| 13000–13250 | 益田路 north of 深南大道 | 市民广场 / 市民中心南广场 plaza, real open space |

Decision until v0.4.3: the pipeline added deterministic **procedural filler blocks** (negative `id`,
counted as `estimated`) only where OSM had no building, road (buffered by class width), park / water /
plaza / surface parking / theme park, landmark, cut interval or route end, and the game added runtime
street-wall blocks on top.

**v0.5.0:** both are off (`"procedural": {"enabled": false}`, `CONFIG.city.buildingFiller = false`).
Instead, Overture Maps footprints whose source is not OSM (machine-learned rooftops,
doi:10.5281/zenodo.8174931) fill OSM's gaps where they overlap no OSM building (< 20% of their area)
and lie outside open space (now also `landuse=construction / brownfield`): 762 buildings. Coverage
(`[coverage]` in the pipeline log, same 600 m corridor per 250 m): median 15% (OSM) → 16% (OSM +
Overture); bins below 6%: 10 → 6. 华侨城 east (6250–6500) and 世界之窗 north (3750–4000) now have real
outlines; what stays below 6% is real open land: 2750–3250 沙河 green belt and water, 7250–7500 竹子林
metro depot, 8750–9000, 10000–10250 香蜜湖 interchange, 10500–10750 香蜜湖 construction site (north)
and woods (south).

**3. Landmark OSM ids** (used for landmarks and for excluding the hand-made ones from `buildings.json`):

| landmark | OSM object | height used | notes |
|---|---|---|---|
| 腾讯大厦 | way 600815118 | 193.2 m (`height`) | excluded from buildings |
| 世界之窗 埃菲尔铁塔 | way 264187661 | 108 m (override) | OSM `height=170` is wrong (1:3 replica = 108 m); excluded from buildings |
| 平安金融中心 (main tower) | way 535860513 | 599.1 m (`height`, 117 levels) | excluded; 南塔 way 773719240 (286 m) and PAFC Mall way 773719239 stay as buildings |
| 深圳市民中心 | relation 10837975 (`building=civic`) | 66 m (override) | no height on the outline; roof `building:part`s go up to 66 m (way 783584168); excluded |
| 莲花山 | node 1889340321 (`natural=peak`, ele 106) | 106 m (peak elevation) | footprint = 莲花山公园 way 41281446 |
| 京基100 | way 164033632 | 441.8 m (override) | not height-tagged in OSM; 4.7 km east of the finish |

Other ids: 世界之窗 theme park way 236402460; 市民广场 way 183106115; 市民中心南广场 way 183106112;
深圳国际交流中心洲际酒店 node 14322540131 (香蜜湖路, ~770 m north of 深南大道; sign only, not modelled).

**4. Road data.** 深南大道 is mapped as two `primary` oneway carriageways (side roads are named
`深南大道辅路` and excluded). `lanes` on the eastbound chain by length: 4 → 32%, 3 → 35%,
2 → 2%, untagged → 30%, so the game uses 4 lanes × 3.5 m. One OSM artefact: near 铜鼓路 (科技园) the
eastbound carriageway jogs ~35 m sideways; that stretch is inside the first cut.
