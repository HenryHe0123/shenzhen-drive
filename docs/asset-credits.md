# 资产归属 / Asset credits

## 3D 模型

| 文件 | 来源 | 作者 | 授权 | 使用方式 |
|---|---|---|---|---|
| `public/models/xiaomi_su7.glb`（与 Sketchfab 下载原件逐字节相同；原件另存 `data-raw/assets/sketchfab/`，不入库） | Sketchfab：[Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9) | Car2022（现名 Mona x Supercars；文件内署名 “GT Cars: Hyperspeed”） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 原样使用，未在建模软件中修改；仅在运行时把车身材质 `Paint1Mtl` 替换为带清漆的金属漆（颜色等参数见 `src/config.ts` 的 `car` 部分） |

署名（CC BY 4.0）：“[Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9)” by Car2022 (Mona x Supercars), licensed under CC BY 4.0. Changes: body paint material replaced at runtime.

**免责声明**：本项目为课程作业，与小米集团（Xiaomi）无任何关联，亦未获其认可或赞助。“Xiaomi”“SU7” 为其各自所有者的商标。

### 3D Warehouse 真实建筑模型

- 授权：[3D Warehouse General Model License](https://3dwarehouse.sketchup.com/tos/)。允许修改，并作为本游戏的一部分分发；不单独转发原模型；保留作者署名（见下表）。
- 仓库和 `public/` 中只有处理后的文件。原始下载在 `data-raw/assets/3dwarehouse/`（已 gitignore，不入库）。
- 统一改动（`scripts/process_city_models.mjs`）：删除卫星图地面片、地面层水平面和地下部分；去除重合面，修正朝内的面；全部网格合并为 1 个 draw call（含镂空贴图的模型为 2 个）；所有材质烘焙进一张 WebP 图集（地标 ≤ 1024 px，其余 ≤ 512 px；独立照片缩小后打包，重复纹理转为横向平铺条带，纯色和近似纯色转为色块）；原点移到地面上的轮廓中心。
- 位置与朝向：`scripts/build_city_data.py` 用 OSM 建筑轮廓重新配准（yaw + 平移，使轮廓 IoU 最大），再套用路线剪切变换；被替换的 OSM 轮廓从 `public/data/buildings.json` 中删除。

<!-- city-models:start -->
共 36 个文件（34 个由 `public/data/city_models.json` 放置）。本表由 `scripts/build_city_data.py` 按实际随游戏分发的文件自动生成。

| 文件 | 模型（原标题） | 作者 | 来源 | 用途 | 个别改动 |
|---|---|---|---|---|---|
| `public/models/city/anlian_building_db0413ea.glb` | Shenzhen Anlian Building 深圳安联大厦 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/db0413ea9ea45dcc78d19d4cf75cc077) | 沿街建筑 |  |
| `public/models/city/arc_de_triomphe_window_of_world_e70fca62.glb` | 深圳世界之窗凯旋门 Arc De Triomphe in Shenzhen's Window of the World | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/e70fca6248bf58c7333c21dcc67a50a) | 地标 |  |
| `public/models/city/citizen_center_columns_1b723d6e.glb` | Shenzhen Citizen Center Columns | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1b723d6efe2343282e4b5d011481ed57) | 沿街建筑，替换手工地标 深圳市民中心 |  |
| `public/models/city/civic_center_mot_638756e4.glb` | 深圳市民中心 | MOT | [3D Warehouse](https://3dwarehouse.sketchup.com/model/638756e451330cb6f5f59be4a8fc936f) | 地标，替换手工地标 深圳市民中心 | 裁掉主体南侧跨越福中三路的台阶平台 |
| `public/models/city/convention_exibition_center_4acfaf83.glb` | 深圳会展中心 Shenzhen Convention & Exibition Center | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/4acfaf8313552ee77917503a0aa843ba) | 沿街建筑 |  |
| `public/models/city/cts_building_8f660740.glb` | 中国港中旅大厦 CTS Building | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/8f660740610d401a3f5fe3b43648000d) | 沿街建筑 |  |
| `public/models/city/dabaihui_plaza_7a7ad91b.glb` | Dabaihui Plaza | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/7a7ad91b-b9a7-420e-98df-5e7225be8f68) | 沿街建筑 |  |
| `public/models/city/eiffel_tower_window_of_world_9d17334b.glb` | 深圳世界之窗埃菲尔铁塔 Eiffel Tower in Shenzhen's Window of the World(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/9d17334bf5b3be1777502157ac53443f) | 未放置：手工地标 世界之窗 埃菲尔铁塔 的备选（replaceLandmark=false），保留供对比 |  |
| `public/models/city/farser_corporate_residence_bf1f49d3.glb` | 深圳富瑞斯国际公寓酒店 Farser Corporate Residence Shenzhen(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/bf1f49d3890474903f07b6de2b72a4d7) | 沿街建筑 |  |
| `public/models/city/fortune_building_c90a567b.glb` | 深圳财富大厦 Shenzhen Fortune Building | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/c90a567bfc8c7243bdf46b31b7778cf2) | 沿街建筑 |  |
| `public/models/city/futian_shangri_la_hotel_3481c83f.glb` | 深圳福田香格里拉大酒店 Shenzhen Futian Shangri-La Hotel | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3481c83fda183b447b01108cccff784e) | 沿街建筑 |  |
| `public/models/city/gold_central_hotel_d8d82029.glb` | 深圳金中環酒店公寓 Shenzhen Gold Central Hotel | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/d8d8202918e9548aeaa81f55a9a2ffc2) | 沿街建筑 |  |
| `public/models/city/great_international_investment_plaza_f8adf623.glb` | 大中华国际交易广场 Great China International Investment Plaza | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/f8adf623c6969b2ecca165dd51caaddd) | 沿街建筑 |  |
| `public/models/city/hanking_center_7d0712d1.glb` | Hanking Center | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/7d0712d1-fcdb-4a11-bfa8-fb8942538815) | 地标 |  |
| `public/models/city/huarong_building_729765e7.glb` | 深圳华融大厦 Shenzhen Huarong Building(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/729765e7eef0036518a29c6239335606) | 沿街建筑 |  |
| `public/models/city/international_chamber_of_commerce_tower_64beb6b2.glb` | International Chamber of Commerce Tower | Stefan L. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/64beb6b2d9343912e7a59953097812c1) | 沿街建筑 |  |
| `public/models/city/kerry_construction_plaza_2_3dbc324e.glb` | 深圳嘉里建設廣場二期 Kerry Construction Plaza 2 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3dbc324e747d596b49bee0b3b22a551d) | 沿街建筑 |  |
| `public/models/city/lord_center_a035ce82.glb` | 诺德中心 Lord Center | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/a035ce82e743f50b72721b5205679ff) | 沿街建筑 |  |
| `public/models/city/louvre_pyramid_window_of_world_1a197da5.glb` | 深圳世界之窗玻璃金字塔 The Louvre Pyramid in Shenzhen's Window of the World(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1a197da5ed9795f354d27d6eba9f65a) | 地标 |  |
| `public/models/city/media_group_building_845f2650.glb` | Shenzhen Media Group Building 深圳广播电影电视集团大厦 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/845f2650819f490b7d30984861683cc) | 沿街建筑 |  |
| `public/models/city/merchants_security_hq_0b5a1129.glb` | China Merchants Security HQ招商证劵总部 | Simba Xu | [3D Warehouse](https://3dwarehouse.sketchup.com/model/0b5a1129-3a45-429c-a65a-2af79321738f) | 沿街建筑 |  |
| `public/models/city/modern_international_tower_951612ea.glb` | 现代国际大厦 Shenzhen Modern International Tower | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/951612eab89dc5e53f5fe3b43648000d) | 沿街建筑 |  |
| `public/models/city/oct_tower_dc36d710.glb` | OCT Tower | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/dc36d710-86c9-4acd-ad6f-8bc8f9cbaba4) | 地标 |  |
| `public/models/city/phoenix_building_c0952b1f.glb` | China Phoenix Building 中國鳳凰大廈 | Daniel G. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/c0952b1f7eea9dd67b3ffb639d9c5abc) | 沿街建筑 |  |
| `public/models/city/ping_an_asset_tower_17c33239.glb` | Shenzhen-Ping An Asset Tower | Beer M. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/17c33239-3852-409a-8079-97daee2b2e8b) | 沿街建筑 |  |
| `public/models/city/ping_an_finance_center_503ec42e.glb` | Ping An Finance Center | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/503ec42e-190d-4b83-9222-99ebc2f8abb0) | 地标，替换手工地标 平安金融中心 | 模型本身含平安金融中心南塔（286 m）与 PAFC Mall 裙楼 |
| `public/models/city/ritz_carlton_f63abc8f.glb` | The Ritz-Carlton Shenzhen 深圳丽思卡尔顿酒店 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/f63abc8f1ac36320bdf46b31b7778cf2) | 沿街建筑 |  |
| `public/models/city/special_zone_daily_tower_2f0fbb8d.glb` | 深圳特区报业大厦Shenzhen Special Zone Daily Tower | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/2f0fbb8d039fc387d2448a2b172d6e42) | 地标 |  |
| `public/models/city/stock_exchange_de23a9e4.glb` | 深圳证券交易所 Shenzhen Stock Exchange(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/de23a9e463a24e0d8b98d35d2e7a4e9) | 地标 |  |
| `public/models/city/tencent_1c412809.glb` | 深圳腾讯大厦 Shenzhen Tencent(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1c4128092666a512d8b98d35d2e7a4e9) | 未放置：手工地标 腾讯大厦 的备选（replaceLandmark=false），保留供对比 |  |
| `public/models/city/time_square_excellence_15fb1d9a.glb` | Time Square Excellence Ⅱ 卓越时代广场二期 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/15fb1d9addedd6107b01108cccff784e) | 沿街建筑 |  |
| `public/models/city/times_square_excellence_b8a73c35.glb` | Times Square Excellence 卓越時代廣場 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/b8a73c35bdd46e4462fd14a1a2fade09) | 沿街建筑 |  |
| `public/models/city/trade_center_220f453c.glb` | Shenzhen Trade Center 深圳经贸中心 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/220f453c0ab67df265f1e8ef1297e5aa) | 沿街建筑 |  |
| `public/models/city/unicom_building_3666a15a.glb` | 深圳联通大厦 China Unicom Building (Shenzhen) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3666a15a39a2a205a5b5516fe36a596a) | 沿街建筑 |  |
| `public/models/city/xingye_bank_building_3a5658da.glb` | 深圳兴业银行大厦 Shenzhen Xingye Bank Building | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3a5658da00400e7abfe8d59f826a82b5) | 沿街建筑 |  |
| `public/models/city/yitian_holiday_plaza_u5b41a7d.glb` | Yitian holiday plaza益田假日广场 | Simba Xu | [3D Warehouse](https://3dwarehouse.sketchup.com/model/u5b41a7d2-8228-4690-ab46-9f0529caae3a) | 沿街建筑 |  |
<!-- city-models:end -->

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
