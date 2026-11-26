# SHENZHEN DRIVE｜深圳极速穿越

浏览器 3D 城市计时驾驶。驾驶小米 SU7（极速 350 km/h，可选白天 / 日落两种时段），沿深南大道从南山科技园一路向东，穿过世界之窗、华侨城、车公庙 / 香蜜湖，进入福田中心区后绕行 CBD：右转益田路直奔平安金融中心脚下，左转福华三路、左转金田路平交穿过深南大道，最后左转福中三路，沿深圳市民中心正立面冲线。沿线之外是整个深圳市的 3D 场景：真实地形和海岸、卫星影像地面、全市约 45 万栋建筑、道路与铁路（v0.6.0，可在“全城巡览”里自由飞越）。基于真实 OpenStreetMap、Overture、Copernicus 数据，Three.js + TypeScript + Vite。

*A browser 3D time-trial: drive a Xiaomi SU7 east along Shenzhen's Shennan Boulevard by day or at sunset, from Nanshan Science Park to the Civic Center.*

## 运行

```bash
npm install
npm run dev          # 打开终端打印的地址，默认 http://127.0.0.1:5173/
```

- **调试模式**：`http://127.0.0.1:5173/?debug` — 显示 FPS、draw call、三角面数和当前路线坐标 s/d；数字键 1–9 跳到前 9 个检查点（共 10 个），0 跳到下一个转弯前（连按依次切换 4 个转弯），F 切换自由相机。
- **场景预览**：`http://127.0.0.1:5173/preview.html` — 不含玩法，镜头沿路线自动巡游，用于检查街景。
- **全城巡览**：`http://127.0.0.1:5173/explore.html`（开始界面也有入口）— 不含比赛，在整个深圳上空自由飞行：左键拖动平移、右键旋转、滚轮缩放，WASD / 方向键平移、Q / E 旋转、R / F 拉近拉远、Shift 加速、T 切换时段，1–9 及面板按钮跳到预设视点（全市俯瞰、福田 CBD、罗湖、后海、宝安、龙华、龙岗、大鹏、深南东路地面等 18 个）。`?view=futian`、`?lon=114.05&lat=22.54&dist=3000&heading=0&pitch=30` 指定初始视角，`?hud=0` 隐藏面板。
- **只看沿线**：任意页面加 `?noMetro` 不加载全城场景（v0.5.0 的场景，用于对比）。
- **打包**：`npm run build` 输出到 `dist/`，`npm run preview` 本地预览打包结果。
- **稳定试玩版**：`npm run playtest` 打包到 `playtest/` 并在 `http://127.0.0.1:4173/` 提供静态服务。开发服务器（5173）在代码变动时会自动刷新页面；试玩请用 4173，它只在重新运行该命令时更新。
- **新版本试玩**：`npm run playtest:next` 打包到 `playtest-next/` 并在 `http://127.0.0.1:4174/` 提供静态服务，与 4173 上的版本互不影响，用于发布前对比试玩。

## 操作

| 按键 | 作用 |
|---|---|
| W / ↑ | 加速 |
| S / ↓ | 刹车；停稳后继续按住为低速倒车 |
| A / ←、D / → | 左 / 右转向 |
| R | 回到最近通过的检查点（计时不中断） |
| Esc / P | 暂停 / 继续（倒计时和比赛中）；窗口失焦或切换标签页时自动暂停 |
| C | 视角：车外（第三人称追尾）/ 车内（驾驶座第一人称），随时切换，暂停中也可以 |
| N | 小地图：全程 / 局部（进入福田 CBD 绕行段前自动切到局部，按 N 后以手动选择为准） |
| M | 静音 / 取消静音 |

流程：开始界面 → 3 秒倒计时 → 驾驶（按顺序通过检查点）→ 冲过终点 → 成绩页（成绩 = 用时 + 撞墙罚时，最佳成绩按成绩比较、保存在 localStorage）→ 重新挑战。

- **撞墙**：按撞向墙面的速度分量（法向速度，不是车速；300 km/h 以 3° 蹭墙只有约 16 km/h）分档。< 15 km/h 擦碰、15–50 km/h 轻撞只有减速，不计数；50–100 km/h 重撞，屏幕震动、边缘闪红，动力和极速降 30–50%，4–8 s 内逐渐恢复，罚时 +5 s；> 100 km/h 严重撞击，车当场停住 2 s 无法驾驶，再从 50% 动力用 8 s 恢复，罚时 +10 s。计时面板实时显示“重撞 N · 严重 M · 罚时 +X s”，受损时车速表上方显示剩余动力。贴着墙刮擦的阻力随车速增大，贴墙行驶会降到约 100 km/h，不能借墙过弯。参数在 `src/config.ts` 的 `collision`。
- **视角**：开始界面和暂停菜单的“视角 车外 / 车内”与 C 键等效，选择记在 localStorage（`?view=chase|cockpit` 临时覆盖）。车内视角坐在左侧驾驶座，看得到 SU7 的方向盘、仪表、中控屏和 A 柱；方向盘随转向转动，镜头随车身俯仰侧倾，转弯时略微看向弯内，加减速时头部轻微前后晃动。录像录的是当前视角。
- **暂停菜单**：继续（Esc）、重新开始本局（回到起点重新倒计时，计时和检查点清零）、回到检查点（同 R）、返回主菜单，以及时段、视角、静音、自动录像开关；↑ ↓ 选择，Enter / 空格确认。暂停期间物理、倒计时、计时和录像全部冻结，计时不含暂停时间。
- **小地图**（左上角，均为北朝上）：全程模式把整条路线缩放进面板；局部模式显示车辆周围约 1.2 km 宽的范围，并向行驶方向前移约 130 m。已行驶路段高亮，车辆箭头为真实位置和朝向，检查点（已过 / 下一个 / 未过）、4 处转弯、起终点旗和世界之窗、平安金融中心、市民中心标注齐全。
- **自动录像**：默认关闭（开始界面或暂停菜单可打开，记在 localStorage；`?record=0|1` 临时覆盖）。从倒计时开始录到冲线后约 2 秒，暂停期间不录；画面为 1920×1080（窗口比例不同则加黑边），叠加计时、车速、路段与检查点、小地图和转弯提示，带游戏声音。本机 Chrome 输出 MP4（H.264 + AAC，约 8 Mbps，约 60 MB/分钟），否则为 WebM。成绩页点击“下载录像”才会保存文件，不点击则不保存；重新开始或返回主菜单会丢弃当前录像。`?recres=720` 改为 1280×720。
- **版本号**：开始界面底部、暂停菜单和驾驶画面左下角显示 `v版本 · 提交 · 构建日期`，版本取自 `package.json`，提交和日期在启动开发服务器或打包时注入。

## 测试

```bash
npm test             # Vitest 单元测试
npm run e2e          # Playwright 冒烟测试（自动在 5177 端口启动 Vite；PW_PORT=xxxx 可换端口）
npm run typecheck    # TypeScript 类型检查
```

- `tests/route.test.ts`：世界坐标 ↔ 路线坐标 (s, d) 的往返精度、转弯处投影不跳支、起终点外推、左右符号、朝向约定。
- `tests/data.test.ts`：`public/data/route.json` / `buildings.json` / `city_models.json` 存在时校验格式（含 `turns`、`clearZones`、辅路、天桥、公交站、地铁口）、采样间距、除各转弯圆弧外无折角、每处转弯方向与半径、检查点顺序、分区连续、全长等于真实路线（无剪切）、建筑高度、轮廓、来源与功能字段；辅路和路边设施不在车行道上；真实建筑模型不压路面、不进视廊、互不重叠、文件存在。
- `tests/vehicle.test.ts`、`tests/race.test.ts`：车辆加速 / 刹车 / 倒车 / 转向与边界碰撞；倒计时、检查点顺序、计时、暂停、重置、撞墙计数等比赛状态机。
- `tests/score.test.ts`：重撞 / 严重撞击罚时与最终成绩。
- `tests/damage.test.ts`：撞击分档阈值、重撞受损的线性恢复、严重撞击的停滞、较弱撞击不缩短恢复期、受损车辆的极速上限与超速滑行。
- `tests/camera.test.ts`：视角切换与监听；车内镜头的眼点位置、跟随车辆朝向、高速时看向弯内、加速度引起的头部偏移上限。
- `tests/screens.test.ts`、`tests/treeSight.test.ts`：APEC 屏幕选址规则、行道树避让地标视线。
- `tests/metro.test.ts`：`public/data/metro` 存在时校验与路线同一坐标系、地形网格解码与高程范围、整条路线上地形为旧地面高度、建筑细节块 / 体块 / 天际线 / 道路块 / 水面的解析，以及路线附近没有全城建筑、建筑底部不悬空。
- `e2e/smoke.spec.ts`：菜单（版本号）→ 开始 → 按住 W 驾驶（HUD、小地图、录像已开始）→ Esc 暂停（计时、车辆、录像冻结）→ 继续 → 失焦自动暂停 → C 切到车内视角再切回 → 左右转向 → R 回到检查点（计时不清零）→ 传送到终点前 60 m 冲线 → 成绩页 → 下载录像并校验文件大小；全程检查控制台无报错，截图保存为 `evidence/smoke-0*.png`。
- `e2e/audio.spec.ts`：在真实 Chrome 中运行音频引擎，验证静止无声、电机音高随车速变化、静音和挂起 / 恢复。
- 浏览器：未安装 Playwright 自带的 Chromium（`npx playwright install chromium`）时，自动使用系统 Google Chrome（macOS headless 下通过 ANGLE/Metal 硬件渲染 WebGL 2）；可用 `PW_CHANNEL=chromium` 或 `PW_CHANNEL=chrome` 指定。

## 城市数据管线

```bash
uv venv .venv
source .venv/bin/activate && uv pip install osmium shapely numpy matplotlib pyarrow pyogrio pyproj overturemaps rasterio
sh data-raw/download.sh                        # 下载 Geofabrik 广东省 OSM 提取（约 176 MB，可断点续传，进度见 data-raw/download.log）
sh data-raw/download.sh cmab                   # CMAB 建筑高度：7.9 GB 压缩包，校验后解出深圳一层并裁剪到范围内（首次会从源码编译 unrar）
sh data-raw/download.sh wsf3d                  # WSF3D 90 m 网格建筑高度：只从全球文件里读取路线范围那一小块（约 50 KB）
sh data-raw/download.sh overture               # Overture 建筑轮廓（范围内约 5.7 万个要素）
.venv/bin/python scripts/build_city_data.py    # 或 npm run data；--rebuild 忽略缓存，--no-plot 不生成 evidence/route_plot.png
```

- 输入（均不入库）：`data-raw/guangdong-latest.osm.pbf`；`data-raw/cmab/cmab_corridor.parquet`（`scripts/clip_cmab.py` 生成）；`data-raw/heights/wsf3d_corridor.tif`（`scripts/clip_wsf3d.py` 生成）；`data-raw/overture/buildings.parquet`。后三项缺失时管线跳过对应来源。
- 输出：`public/data/route.json`（中心线、车道宽度、对向车道、辅路、分区、检查点、终点、转弯、路口、地标、路牌、天桥、公交站、地铁口，格式见 `src/route/types.ts`）和 `public/data/buildings.json`（OSM 与 Overture 建筑轮廓、高度、功能、年代，`meta.heightSources` 记录每种高度来源的数量）。
- 参数（路线各段道路 `route.legs` 与转弯半径、剪切区间、检查点、地标 OSM id、视廊 `viewCorridors`（v0.5.0 起为空）、CMAB 与 Overture 的匹配规则、辅路与路边设施、高度估算规则、圈速估算 `race`）在 `scripts/city_config.json`；重复运行结果一致，运行时打印理想圈速估算、CMAB 校准结果与各项自检。

### 全城场景（v0.6.0）

```bash
uv pip install --python .venv/bin/python scipy scikit-learn mapbox-earcut
sh data-raw/download.sh metro                  # Overture 建筑 / 水体、CMAB 深圳分块、WSF3D、Copernicus DEM、WorldCover、Sentinel-2、维基百科超高层列表（约 15 分钟）
npm run data                                   # 先生成沿线数据（全城管线读 route.json / buildings.json / city_models.json）
npm run data:metro                             # scripts/build_metro_data.py，约 2 分钟；--only terrain|water|buildings|roads 只重做一部分
```

- 输出 `public/data/metro/`（格式见 `src/city/metro/types.ts`）：`metro.json`（坐标网格、分块索引、来源统计），30 m / 120 m 地形高度、路线走廊权重、Sentinel-2 反照率贴图、水面网格、2 km 建筑细节块 `bld/`、8 km 建筑体块 `mass/`、60 m 以上的天际线 `skyline.bin.gz`、道路块 `roads/`；`data-raw/metro_report.json` 记录高度模型的留出检验结果。
- 参数在 `scripts/city_config.json` 的 `metro`（范围、地形去建筑与路线压平、水体、影像校正、建筑分块、高度模型、道路宽度与桥梁）。

## 项目结构

```
src/
  main.ts          启动：加载数据，创建渲染器、场景和游戏
  config.ts        全部可调参数（按子系统分区）
  route/           路线数据格式、世界坐标 ↔ 路线坐标 (s, d)、合成占位路线
  game/            主循环（固定 60 Hz 物理 + 插值渲染）、数据加载、模块接口
  vehicle/         简化运动学车辆、道路边界碰撞与撞击受损、SU7 模型与车漆
  camera/          第三人称跟随镜头、车内第一人称镜头、视角切换
  race/            倒计时、检查点、计时、最佳成绩
  hud/             开始界面、HUD、小地图、暂停菜单、成绩页、版本号
  input/           键盘输入
  audio/           Web Audio 程序化音效
  recording/       自动录像（MediaRecorder，画布 + HUD 合成 + 游戏声音）
  city/            道路、道路设施、建筑、真实建筑模型、地标、APEC 屏幕；metro/ 全城地形、水面、建筑分块（Worker 生成）、道路
  explore.ts       全城巡览页（explore.html）
  render/          渲染器、天空与环境贴图、时段预设、后处理
  debug/           ?debug 调试面板
scripts/           Python 城市数据管线、模型 / 贴图离线处理脚本
public/            data/（管线产物）、models/（SU7、真实建筑）、textures/
tests/、e2e/       Vitest 单元测试、Playwright 端到端测试
evidence/          截图、录像等过程证据（本地保存，不入库；文档引用的图在 docs/images/）
docs/              资产归属、版本记录与版本对比、OSM 数据覆盖率分析
```

## 艺术化简化

- **完整真实路线**：沿真实中心线全程驾驶，约 16.1 km（16,070 m），10 个检查点，理想圈速估算约 3:40。管线仍支持在深南大道直线段剪切拼接（`city_config.json` 的 `cuts`，后续道路与建筑整体平移，不缩放），v0.3.2 及以前剪掉两段直道、总长 12.3 km；现在 `cuts` 为空。
- **立交与高架**：沿途立交简化为平面路口，高架桥只作为背景。益田路、金田路在现实中以高架跨越深南大道，游戏里简化为平面路口（右转进益田路、金田路平交直行穿过深南大道）。
- **只开同向车道**：可驾驶范围始终是行驶方向的那一幅路（4 车道 × 3.5 m，车道线可自由跨越，越出道路边界才碰撞）；中央绿化带和对向车道是静态景观。CBD 支路在现实中只有 2–3 车道，游戏里统一按 4 车道宽度处理；福中三路西行紧贴市民中心南立面，车道整体向南（市民广场一侧）平移 7 m，避免压到建筑。
- **转弯**：只在真实路口转弯，共 4 处（右转益田路 R30、左转福华三路 R40、左转金田路 R40、左转福中三路 R32），均为切线圆弧倒角，其余路段无折角。左转圆弧都在路口范围内；右转按渠化右转处理，圆弧内侧会切过路口转角约 7 m。
- **真实优先（v0.5.0 起）**：建筑一律按数据的真实高度，不再为露出地标而压低或删除（v0.4.3 及以前的“地标视廊”已关闭，代码保留，`viewCorridors` 为空）；平安金融中心、市民中心、埃菲尔铁塔在部分路段会被真实建筑或行道树挡住，这是有意的结果。地标的远景雾效与其他建筑相同。没有任何数据依据的虚构建筑为 0：OSM 没有轮廓的地方用 Overture 的机器学习屋顶轮廓补，两者都没有的地方保持空地。
- **建筑高度**：优先级为 OSM `height` > OSM 楼层数 × 3.2 m > CMAB 或 WSF3D（按占地面积取校准后更准的那个）> 按片区和占地面积估算。CMAB 是单栋数据，但只覆盖经度 114.028 以东（福田 / 罗湖），并且高楼严重偏矮；WSF3D 是全球 90 m 网格的平均建筑高度，覆盖全线，整体偏低约 12 m。两者的校准结果见 `docs/CHANGELOG.md` v0.5.0。
- **道路横断面**：车行道仍为 4 车道 × 3.5 m（碰撞边界不变）；路边按 OSM 的深南大道辅路建出侧分带（行道树、双臂路灯）、辅路（沥青和标线，车开不进去）、自行车道和人行道，没有辅路的路段保持原来的路缘、绿化带、自行车道、人行道。人行天桥、公交候车亭、地铁出入口雨棚按 OSM 位置放置，只做视觉、不参与碰撞，不使用真实商标和标识。
- **APEC**：香蜜湖路口的路牌文字（“深圳国际交流中心 · 2026 APEC 主会场”）、路边广告牌和 LED 屏幕上的“APEC China 2026 · 相约深圳 见证奇迹”画面，只用文字和自绘图形，不使用官方徽标，不建模国际交流中心。
- **真实建筑模型**：沿线部分建筑来自 3D Warehouse 的真实深圳建筑模型，位置按 OSM 轮廓重新配准；模型自带的照片贴图分辨率较低，近看偏糊。
- **全城场景（v0.6.0）**：路线 320 m 内地形压平到原来的地面高度，900 m 外是真实地形（游戏里 y = 0 对应深南大道标高 9.9 m）；建筑高度有 OSM 标注的用标注，其余约 97% 为管线训练的估算（误差见 CHANGELOG），远处建筑是按功能着色的盒子；地表是 24 m 分辨率的卫星影像，没有三维植被；香港、东莞只有地形。
- **范围**：MVP 不含交通车辆和行人。

## 资产归属（摘要）

- 小米 SU7 模型：Sketchfab [Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9)，作者 Car2022（现名 Mona x Supercars），CC BY 4.0；仅在运行时替换车漆材质。本项目与小米公司无关联，未获其认可。
- 地图数据 © OpenStreetMap contributors，[ODbL 1.0](https://www.openstreetmap.org/copyright)，经 Geofabrik 提取；补充建筑轮廓与水体来自 Overture Maps（ODbL 1.0，机器学习屋顶来源 CC BY 4.0），补充建筑高度来自 CMAB（Zhang、Zhao、Long，CC BY 4.0）和 WSF3D（© DLR，CC BY 4.0）。
- 全城地形：Copernicus DEM GLO-30（© DLR / Airbus，Copernicus 许可）；地表影像：contains modified Copernicus Sentinel data 2025；土地覆盖：ESA WorldCover 2021（CC BY 4.0）；超高层高度：英文维基百科 List of tallest buildings in Shenzhen（CC BY-SA 4.0）。
- 真实深圳建筑模型：3D Warehouse 多位作者，[General Model License](https://3dwarehouse.sketchup.com/tos/)，仅随游戏分发处理后的文件，逐个署名见资产清单。
- 小叶榕（Valery.Li）与国标路牌（notbadworks）：Sketchfab，CC BY 4.0，均为离线烘焙 / 减面 / 裁切后的版本。
- 日落预设的车漆反射 HDRI：Poly Haven Shanghai Riverside（Alex Radosnov），CC0。
- Three.js（MIT）、postprocessing（Zlib）。天空和全部音效由代码程序生成，无音频文件。
- AI 生成素材及完整清单见 [docs/asset-credits.md](docs/asset-credits.md)；版本记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)（逐项细节）和 [docs/versions.md](docs/versions.md)（各版本之间的区别与起因一览）。
