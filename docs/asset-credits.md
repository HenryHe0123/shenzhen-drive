# 资产归属 / Asset credits

## 3D 模型

| 文件 | 来源 | 作者 | 授权 | 使用方式 |
|---|---|---|---|---|
| `public/models/xiaomi_su7.glb`（原件 `assets/xiaomi_su7.glb`） | Sketchfab：[Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9) | Car2022（现名 Mona x Supercars；文件内署名 “GT Cars: Hyperspeed”） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 原样使用，未在建模软件中修改；仅在运行时把车身材质 `Paint1Mtl` 替换为带清漆的金属漆（颜色等参数见 `src/config.ts` 的 `car` 部分） |

署名（CC BY 4.0）：“[Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9)” by Car2022 (Mona x Supercars), licensed under CC BY 4.0. Changes: body paint material replaced at runtime.

**免责声明**：本项目为课程作业，与小米集团（Xiaomi）无任何关联，亦未获其认可或赞助。“Xiaomi”“SU7” 为其各自所有者的商标。

## 地图数据

- © OpenStreetMap contributors. 数据依据 [Open Database License (ODbL) 1.0](https://www.openstreetmap.org/copyright) 提供。
- 提取文件：Geofabrik [guangdong-latest.osm.pbf](https://download.geofabrik.de/asia/china/guangdong.html)。
- 衍生数据：`public/data/route.json`、`public/data/buildings.json` 由 `scripts/build_city_data.py` 生成（深南大道东行中心线、剪切拼接、建筑轮廓，缺失高度按片区规则估算）。二者属于 OSM 衍生数据库，同样按 ODbL 1.0 提供；文件内 `meta.osmTimestamp` 记录 OSM 数据日期。

## 软件库

| 库 | 授权 | 用途 |
|---|---|---|
| [three.js](https://threejs.org/) | MIT | 渲染 |
| [postprocessing](https://github.com/pmndrs/postprocessing) | Zlib | 后处理（色调映射、泛光、抗锯齿） |
| Vite、Vitest | MIT | 开发构建、单元测试（不随游戏分发） |
| Playwright、TypeScript | Apache-2.0 | 端到端测试、类型检查（不随游戏分发） |
| pyosmium | BSD-2-Clause | 离线数据管线 |
| Shapely、NumPy | BSD-3-Clause | 离线数据管线 |
| Matplotlib | Matplotlib License（PSF 类） | 离线数据管线（路线示意图） |

## 程序生成内容（无外部素材）

- 天空与环境贴图：代码生成，经 PMREM 预过滤，供车漆和玻璃反射。
- 建筑立面窗格、道路标线、路牌文字等：着色器与 Canvas 程序生成。
- 全部音效：Web Audio 实时合成（`src/audio/AudioEngine.ts`），包括电机啸叫、风噪、胎噪、碰撞闷响、倒计时提示音和检查点 / 终点音，无音频文件。
- 字体：使用系统字体（PingFang SC / Microsoft YaHei 等），不随项目分发。

## AI 生成素材

原始生成文件、工具及版本、prompt 和使用位置必须可追溯（规范第 05、10 节）。完整 prompt 记入 [prompts.md](prompts.md)。

| 文件 | 工具（版本） | Prompt（摘要，全文见 prompts.md） | 使用位置 |
|---|---|---|---|
| `public/textures/ai/billboard_01.jpg` | Cursor Agent 内置图像生成工具 `GenerateImage`（2026-11-24） | 深圳城市宣传海报：黄昏天际线、带竖向肋条的超高层、文字“深圳 创新之城” | 深南大道右侧路边 / 楼顶灯箱广告牌（`src/city/props/`） |
| `public/textures/ai/billboard_02.jpg` | 同上 | 虚构鲜果茶广告：荔枝芒果果茶、洋红到橙色渐变、文字“鲜果茶” | 同上 |
| `public/textures/ai/billboard_03.jpg` | 同上 | 虚构科技展广告：霓虹电路光轨、无人机剪影、文字“科技周” | 同上 |
| `public/textures/ai/billboard_04.jpg` | 同上 | 虚构深圳湾夜跑节广告：海滨步道跑者剪影、晚霞、文字“深圳湾夜跑” | 同上（生成结果自带广告牌外框，已用 `sips` 裁掉） |

原始生成文件（未修改）保存在 `docs/ai-assets/original/`，完整 prompt 与后处理记录见 [ai-assets/README.md](ai-assets/README.md)。四张均为虚构广告，不含真实品牌、商标或 APEC 官方徽标。
