# SHENZHEN DRIVE｜深圳极速穿越

浏览器 3D 城市计时驾驶。黄昏时分驾驶小米 SU7，沿深南大道从南山科技园一路向东，穿过世界之窗、华侨城、车公庙 / 香蜜湖，进入福田中心区后绕行 CBD：右转益田路直奔平安金融中心脚下，左转福华三路、左转金田路平交穿过深南大道，最后左转福中三路，沿深圳市民中心正立面冲线。基于真实 OpenStreetMap 数据，Three.js + TypeScript + Vite。

*A browser 3D time-trial: drive a Xiaomi SU7 east along Shenzhen's Shennan Boulevard at dusk, from Nanshan Science Park to the Civic Center.*

## 运行

```bash
npm install
npm run dev          # 打开终端打印的地址，默认 http://127.0.0.1:5173/
```

- **调试模式**：`http://127.0.0.1:5173/?debug` — 显示 FPS、draw call、三角面数和当前路线坐标 s/d；数字键 1–9 跳到对应检查点，0 跳到终点前转弯处，F 切换自由相机。
- **场景预览**：`http://127.0.0.1:5173/preview.html` — 不含玩法，镜头沿路线自动巡游，用于检查街景。
- **打包**：`npm run build` 输出到 `dist/`，`npm run preview` 本地预览打包结果。
- **稳定试玩版**：`npm run playtest` 打包到 `playtest/` 并在 `http://127.0.0.1:4173/` 提供静态服务。开发服务器（5173）在代码变动时会自动刷新页面；试玩请用 4173，它只在重新运行该命令时更新。

## 操作

| 按键 | 作用 |
|---|---|
| W / ↑ | 加速 |
| S / ↓ | 刹车；停稳后继续按住为低速倒车 |
| A / ←、D / → | 左 / 右转向 |
| R | 回到最近通过的检查点（计时不中断） |
| M | 静音 / 取消静音 |

流程：开始界面 → 3 秒倒计时 → 驾驶（按顺序通过检查点）→ 冲过终点 → 成绩页（最佳成绩保存在 localStorage）→ 重新挑战。

## 测试

```bash
npm test             # Vitest 单元测试
npm run e2e          # Playwright 冒烟测试（自动在 5177 端口启动 Vite）
npm run typecheck    # TypeScript 类型检查
```

- `tests/route.test.ts`：世界坐标 ↔ 路线坐标 (s, d) 的往返精度、转弯处投影不跳支、起终点外推、左右符号、朝向约定。
- `tests/data.test.ts`：`public/data/route.json` / `buildings.json` 存在时校验格式（含 `turns`、`clearZones`）、采样间距、除各转弯圆弧外无折角、每处转弯方向与半径、检查点顺序、分区连续、剪切比例 60–80%、建筑高度与轮廓。
- `e2e/smoke.spec.ts`：菜单 → 开始 → 按住 W 驾驶 4 秒 → 左右转向 → R 重置（计时不清零）→ 传送到终点前 60 m 冲线 → 成绩页；全程检查控制台无报错，截图保存为 `evidence/smoke-0*.png`。
- `e2e/audio.spec.ts`：在真实 Chrome 中运行音频引擎，验证静止无声、电机音高随车速变化、静音和挂起 / 恢复。
- 浏览器：未安装 Playwright 自带的 Chromium（`npx playwright install chromium`）时，自动使用系统 Google Chrome（macOS headless 下通过 ANGLE/Metal 硬件渲染 WebGL 2）；可用 `PW_CHANNEL=chromium` 或 `PW_CHANNEL=chrome` 指定。

## 城市数据管线

```bash
uv venv .venv
source .venv/bin/activate && uv pip install osmium shapely numpy matplotlib
sh data-raw/download.sh                        # 下载 Geofabrik 广东省 OSM 提取（约 176 MB，可断点续传，进度见 data-raw/download.log）
.venv/bin/python scripts/build_city_data.py    # 或 npm run data；--rebuild 忽略缓存，--no-plot 不生成 evidence/route_plot.png
```

- 输入：`data-raw/guangdong-latest.osm.pbf`（不入库）。
- 输出：`public/data/route.json`（中心线、车道宽度、分区、检查点、终点、转弯、路口、地标、路牌，格式见 `src/route/types.ts`）和 `public/data/buildings.json`（OSM 建筑轮廓与高度）。
- 参数（路线各段道路 `route.legs` 与转弯半径、剪切区间、检查点、地标 OSM id 与视廊 `viewCorridors`、高度估算规则、圈速估算 `race`）在 `scripts/city_config.json`；重复运行结果一致，运行时打印理想圈速估算与各项自检。

## 项目结构

```
src/
  main.ts          启动：加载数据，创建渲染器、场景和游戏
  config.ts        全部可调参数（按子系统分区）
  route/           路线数据格式、世界坐标 ↔ 路线坐标 (s, d)、合成占位路线
  game/            主循环（固定 60 Hz 物理 + 插值渲染）、数据加载、模块接口
  vehicle/         简化运动学车辆、道路边界碰撞、SU7 模型与车漆
  camera/          第三人称跟随镜头
  race/            倒计时、检查点、计时、最佳成绩
  hud/             开始界面、HUD、成绩页
  input/           键盘输入
  audio/           Web Audio 程序化音效
  city/            道路、道路设施、建筑、地标
  render/          渲染器、天空与环境贴图、后处理
  debug/           ?debug 调试面板
scripts/           Python 城市数据管线
public/            data/（管线产物）、models/（SU7）、textures/
tests/、e2e/       Vitest 单元测试、Playwright 端到端测试
evidence/          截图等过程证据
docs/              资产归属、关键 prompts、版本记录
```

## 艺术化简化

- **剪切拼接**：沿真实中心线（约 16.1 km）在深南大道单调的直线段整段剪掉若干区间，后续道路与建筑整体平移拼接，总长约为真实的 76%（当前约 12.3 km）。不整体缩放，建筑不变形；落在剪掉区间内的建筑直接丢弃。剪切点只选在深南大道直线段，福田 CBD 绕行段不剪，拼接处无折角。区间见 `route.json` 的 `meta.cuts`。
- **立交与高架**：沿途立交简化为平面路口，高架桥只作为背景。益田路、金田路在现实中以高架跨越深南大道，游戏里简化为平面路口（右转进益田路、金田路平交直行穿过深南大道）。
- **只开同向车道**：可驾驶范围始终是行驶方向的那一幅路（4 车道 × 3.5 m，车道线可自由跨越，越出道路边界才碰撞）；中央绿化带和对向车道是静态景观。CBD 支路在现实中只有 2–3 车道，游戏里统一按 4 车道宽度处理；福中三路西行紧贴市民中心南立面，车道整体向南（市民广场一侧）平移 7 m，避免压到建筑。
- **转弯**：只在真实路口转弯，共 4 处（右转益田路 R30、左转福华三路 R40、左转金田路 R40、左转福中三路 R32），均为切线圆弧倒角，其余路段无折角。左转圆弧都在路口范围内；右转按渠化右转处理，圆弧内侧会切过路口转角约 7 m。
- **地标视廊**：为了让平安金融中心在深南大道上一路充当天际线引导、在 CBD 段清楚可见，让市民中心在最后一段完整露出，让世界之窗埃菲尔铁塔可见，数据管线沿视线（追尾镜头位置 → 地标）把挡视线的建筑压低到视线以下；压低后不足 12 m 或是程序化补位块的直接去掉。不在视线上的建筑一律不动，华侨城大厦（300 m）保留不压。扫过的视线楔形写入 `route.json` 的 `clearZones`，运行时补位建筑会避开这些区域。参数见 `scripts/city_config.json` 的 `viewCorridors`。
- **APEC**：只在香蜜湖路口以路牌文字出现（“深圳国际交流中心 · 2026 APEC 主会场”），不使用官方徽标，不建模国际交流中心。
- **范围**：MVP 不含交通车辆和行人。

## 资产归属（摘要）

- 小米 SU7 模型：Sketchfab [Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9)，作者 Car2022（现名 Mona x Supercars），CC BY 4.0；仅在运行时替换车漆材质。本项目与小米公司无关联，未获其认可。
- 地图数据 © OpenStreetMap contributors，[ODbL 1.0](https://www.openstreetmap.org/copyright)，经 Geofabrik 提取。
- Three.js（MIT）、postprocessing（Zlib）。天空、环境贴图和全部音效由代码程序生成，无音频文件。
- AI 生成素材及完整清单见 [docs/asset-credits.md](docs/asset-credits.md)；关键 prompts 见 [docs/prompts.md](docs/prompts.md)；版本记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
