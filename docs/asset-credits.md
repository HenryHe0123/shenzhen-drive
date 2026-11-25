# 资产归属 / Asset credits

## 3D 模型

| 文件 | 来源 | 作者 | 授权 | 使用方式 |
|---|---|---|---|---|
| `public/models/xiaomi_su7.glb`（与 Sketchfab 下载原件逐字节相同；原件另存 `data-raw/assets/sketchfab/`，不入库） | Sketchfab：[Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9) | Car2022（现名 Mona x Supercars；文件内署名 “GT Cars: Hyperspeed”） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 原样使用，未在建模软件中修改；仅在运行时把车身材质 `Paint1Mtl` 替换为带清漆的金属漆（颜色等参数见 `src/config.ts` 的 `car` 部分） |

署名（CC BY 4.0）：“[Xiaomi SU7](https://sketchfab.com/3d-models/xiaomi-su7-ca2cda599f5341068c992c9f44551bf9)” by Car2022 (Mona x Supercars), licensed under CC BY 4.0. Changes: body paint material replaced at runtime.

### 小叶榕行道树 impostor

| 文件 | 来源 | 作者 | 授权 | 使用方式 |
|---|---|---|---|---|
| `public/textures/trees/banyan_color.webp`、`banyan_normal.webp`、`banyan.json`（原始 GLB 在 `data-raw/assets/sketchfab/`，不入库） | Sketchfab：[Chinese Banyan (Ficus Microcarpa)](https://sketchfab.com/3d-models/chinese-banyan-ficus-microcarpa-2a0dbcdf8f5d48f5ad79987c7a8170ce) | Valery.Li | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 远景：由 `scripts/bake_banyan_impostor.mjs` 离线渲染成 16 个方位的 impostor 图集（反照率 + 覆盖度、法线 + 天空可见度）；烘焙时修剪下垂气根、树冠以下的树干收细、调整叶片与树皮颜色。近景（v0.3.2 起，`public/models/trees/banyan_near.*`）：由 `scripts/bake_banyan_near.mjs` 用 meshoptimizer 减面到约 8,900 个三角面，修剪气根、收细树干、叶片面片放大，烘焙树冠法线和逐顶点天空可见度，叶片 / 细枝 / 藤蔓贴图调色后打包成一张 WebP 图集，树皮转 WebP。原始网格和贴图不随游戏分发；运行时见 `src/city/props/trees.ts`、`treeImpostor.ts`、`treeNear.ts` |

署名（CC BY 4.0）：“[Chinese Banyan (Ficus Microcarpa)](https://sketchfab.com/3d-models/chinese-banyan-ficus-microcarpa-2a0dbcdf8f5d48f5ad79987c7a8170ce)” by Valery.Li, licensed under CC BY 4.0. Changes: rendered into a 16-azimuth impostor atlas (albedo, normals, ambient occlusion); decimated to a ~8.9k-triangle near-LOD mesh with a packed WebP leaf atlas; aerial roots trimmed, trunk slimmed and colours graded; the original mesh is not shipped.

### 国标路牌贴图

| 文件 | 来源 | 作者 | 授权 | 使用方式 |
|---|---|---|---|---|
| `public/textures/signs/*.png`（11 张，248 px：直行、向左/向右转弯、直行和向左/向右转弯、靠右侧道路行驶、禁止停车、禁止长时停车、禁止掉头、禁止向左转弯、人行横道；原始 GLB 在 `data-raw/assets/sketchfab/`，不入库） | Sketchfab：[Chinese Road Signs (32 road signs and more)](https://sketchfab.com/3d-models/chinese-road-signs-32-road-signs-and-more-241ed4fd2fc145259ff9b51bd6f04877) | notbadworks（下载包内署名 bobymonsuta） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 由 `scripts/process_env_and_signs.mjs` 从包内底色贴图中裁出牌面、上下翻正（原图倒置存放）、牌面外缘补白、缩到 248 px；运行时拼进路牌图集，装在程序生成的立柱、信号灯横臂和龙门架立柱上（`src/city/props/roadSigns.ts`）。不使用包内模型网格；限速牌（包内没有）为 Canvas 程序绘制 |

署名（CC BY 4.0）：“[Chinese Road Signs (32 road signs and more)](https://sketchfab.com/3d-models/chinese-road-signs-32-road-signs-and-more-241ed4fd2fc145259ff9b51bd6f04877)” by notbadworks (bobymonsuta), licensed under CC BY 4.0. Changes: sign-face textures extracted, flipped upright, cropped and downscaled to 248 px, placed on procedural posts; the model meshes are not used.

### HDRI

| 文件 | 来源 | 作者 | 授权 | 使用方式 |
|---|---|---|---|---|
| `public/textures/env/shanghai_riverside_1k.hdr`（2k 原图在 `data-raw/assets/hdri/`，不入库） | Poly Haven：[Shanghai Riverside](https://polyhaven.com/a/shanghai_riverside) | Alex Radosnov | [CC0](https://polyhaven.com/license) | v0.3.2 起：由 `scripts/process_env_and_signs.mjs` 降采样到 1k，太阳亮度截断到 24；运行时压暗地面（×0.3）并加暖色，只用于日落预设下车漆、车窗和轮毂的反射（`src/render/reflectionEnv.ts`），不作为背景 |

Poly Haven 的 [Shanghai Bund](https://polyhaven.com/a/shanghai_bund)（Greg Zaal，CC0）原计划用于入夜预设，该预设已取消，未分发。

**免责声明**：本项目为课程作业，与小米集团（Xiaomi）无任何关联，亦未获其认可或赞助。“Xiaomi”“SU7” 为其各自所有者的商标。

### 3D Warehouse 真实建筑模型

- 授权：[3D Warehouse General Model License](https://3dwarehouse.sketchup.com/tos/)。允许修改，并作为本游戏的一部分分发；不单独转发原模型；保留作者署名（见下表）。
- 仓库和 `public/` 中只有处理后的文件。原始下载在 `data-raw/assets/3dwarehouse/`（已 gitignore，不入库）。
- 统一改动（`scripts/process_city_models.mjs`）：删除卫星图地面片、地面层水平面和地下部分；去除重合面，修正朝内的面；全部网格合并为 1 个 draw call（含镂空贴图的模型为 2 个）；所有材质烘焙进一张 WebP 图集（地标 ≤ 1024 px，其余 ≤ 512 px；独立照片缩小后打包，重复纹理转为横向平铺条带，纯色和近似纯色转为色块）；原点移到地面上的轮廓中心。
- 位置与朝向：`scripts/build_city_data.py` 用 OSM 建筑轮廓重新配准（yaw + 平移，使轮廓 IoU 最大），再套用路线剪切变换；被替换的 OSM 轮廓从 `public/data/buildings.json` 中删除。

<!-- city-models:start -->
共 49 个文件（48 个由 `public/data/city_models.json` 放置）。本表由 `scripts/build_city_data.py` 按实际随游戏分发的文件自动生成。

| 文件 | 模型（原标题） | 作者 | 来源 | 用途 | 个别改动 |
|---|---|---|---|---|---|
| `public/models/city/anlian_building_db0413ea.glb` | Shenzhen Anlian Building 深圳安联大厦 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/db0413ea9ea45dcc78d19d4cf75cc077) | 沿街建筑 |  |
| `public/models/city/arc_de_triomphe_window_of_world_e70fca62.glb` | 深圳世界之窗凯旋门 Arc De Triomphe in Shenzhen's Window of the World | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/e70fca6248bf58c7333c21dcc67a50a) | 地标 |  |
| `public/models/city/citizen_center_columns_1b723d6e.glb` | Shenzhen Citizen Center Columns | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1b723d6efe2343282e4b5d011481ed57) | 深圳市民中心的组成部分，随其模型一同替换手工地标 |  |
| `public/models/city/civic_center_mot_638756e4.glb` | 深圳市民中心 | MOT | [3D Warehouse](https://3dwarehouse.sketchup.com/model/638756e451330cb6f5f59be4a8fc936f) | 地标，替换手工地标 深圳市民中心 | 裁掉主体南侧跨越福中三路的台阶平台 |
| `public/models/city/convention_exibition_center_4acfaf83.glb` | 深圳会展中心 Shenzhen Convention & Exibition Center | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/4acfaf8313552ee77917503a0aa843ba) | 沿街建筑 |  |
| `public/models/city/cts_building_8f660740.glb` | 中国港中旅大厦 CTS Building | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/8f660740610d401a3f5fe3b43648000d) | 沿街建筑 |  |
| `public/models/city/customs_d29ae84d.glb` | 深圳海关 Shenzhen Customs | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/d29ae84d48e4f971a11382752cc4a90) | 沿街建筑 |  |
| `public/models/city/dabaihui_plaza_7a7ad91b.glb` | Dabaihui Plaza | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/7a7ad91b-b9a7-420e-98df-5e7225be8f68) | 沿街建筑 |  |
| `public/models/city/diwang_builiding_f2c8db34.glb` | 地王大厦 Diwang Builiding | John Tang | [3D Warehouse](https://3dwarehouse.sketchup.com/model/f2c8db347ef09231ad3ff2466ab804ac) | 远景 |  |
| `public/models/city/eiffel_tower_window_of_world_9d17334b.glb` | 深圳世界之窗埃菲尔铁塔 Eiffel Tower in Shenzhen's Window of the World(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/9d17334bf5b3be1777502157ac53443f) | 未放置：手工地标 世界之窗 埃菲尔铁塔 的备选（replaceLandmark=false），保留供对比 |  |
| `public/models/city/farser_corporate_residence_bf1f49d3.glb` | 深圳富瑞斯国际公寓酒店 Farser Corporate Residence Shenzhen(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/bf1f49d3890474903f07b6de2b72a4d7) | 沿街建筑 |  |
| `public/models/city/fortune_building_c90a567b.glb` | 深圳财富大厦 Shenzhen Fortune Building | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/c90a567bfc8c7243bdf46b31b7778cf2) | 沿街建筑 |  |
| `public/models/city/fuchun_eastern_building_vanke_5a3511e4.glb` | 深圳万科富春东方大厦 Fuchun Eastern Building, Shenzhen Vanke(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/5a3511e4561ea1baa33fee85809a46f3) | 沿街建筑 |  |
| `public/models/city/futian_shangri_la_hotel_3481c83f.glb` | 深圳福田香格里拉大酒店 Shenzhen Futian Shangri-La Hotel | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3481c83fda183b447b01108cccff784e) | 沿街建筑 |  |
| `public/models/city/galaxy_century_building_26468923.glb` | 深圳星河世纪大厦 Shenzhen Galaxy Century Building(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/2646892347497b72a05782541ebe9181) | 沿街建筑 |  |
| `public/models/city/gold_central_hotel_d8d82029.glb` | 深圳金中環酒店公寓 Shenzhen Gold Central Hotel | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/d8d8202918e9548aeaa81f55a9a2ffc2) | 沿街建筑 |  |
| `public/models/city/great_international_investment_plaza_f8adf623.glb` | 大中华国际交易广场 Great China International Investment Plaza | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/f8adf623c6969b2ecca165dd51caaddd) | 沿街建筑 |  |
| `public/models/city/hanking_center_7d0712d1.glb` | Hanking Center | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/7d0712d1-fcdb-4a11-bfa8-fb8942538815) | 地标 |  |
| `public/models/city/huarong_building_729765e7.glb` | 深圳华融大厦 Shenzhen Huarong Building(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/729765e7eef0036518a29c6239335606) | 沿街建筑 |  |
| `public/models/city/international_chamber_of_commerce_tower_64beb6b2.glb` | International Chamber of Commerce Tower | Stefan L. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/64beb6b2d9343912e7a59953097812c1) | 沿街建筑 |  |
| `public/models/city/international_energy_headquarters_51b371ce.glb` | Shenzhen International Energy Headquarters | Beer M. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/51b371ce-a224-464d-8629-4ff18bf5b68e) | 沿街建筑 |  |
| `public/models/city/jialinhaoting_garden_6004d8a8.glb` | 深圳嘉麟豪庭 Shenzhen Jialinhaoting Garden(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/6004d8a8f4644c2a346cbdfc8d38d7d1) | 沿街建筑 |  |
| `public/models/city/jiang_su_building_39aa4f9b.glb` | Jiang Su Building 江苏大厦 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/39aa4f9be89b763e3afab28da07f9112) | 沿街建筑 |  |
| `public/models/city/kerry_construction_plaza_2_3dbc324e.glb` | 深圳嘉里建設廣場二期 Kerry Construction Plaza 2 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3dbc324e747d596b49bee0b3b22a551d) | 沿街建筑 |  |
| `public/models/city/kk100_b7451df0.glb` | KK100 | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/b7451df0-3070-4209-95f5-ff0cfda917e3) | 远景，替换手工地标 京基100 |  |
| `public/models/city/lord_center_a035ce82.glb` | 诺德中心 Lord Center | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/a035ce82e743f50b72721b5205679ff) | 沿街建筑 |  |
| `public/models/city/louvre_pyramid_window_of_world_1a197da5.glb` | 深圳世界之窗玻璃金字塔 The Louvre Pyramid in Shenzhen's Window of the World(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1a197da5ed9795f354d27d6eba9f65a) | 地标 |  |
| `public/models/city/media_group_building_845f2650.glb` | Shenzhen Media Group Building 深圳广播电影电视集团大厦 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/845f2650819f490b7d30984861683cc) | 沿街建筑 |  |
| `public/models/city/merchants_security_hq_0b5a1129.glb` | China Merchants Security HQ招商证劵总部 | Simba Xu | [3D Warehouse](https://3dwarehouse.sketchup.com/model/0b5a1129-3a45-429c-a65a-2af79321738f) | 沿街建筑 |  |
| `public/models/city/modern_international_tower_951612ea.glb` | 现代国际大厦 Shenzhen Modern International Tower | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/951612eab89dc5e53f5fe3b43648000d) | 沿街建筑 |  |
| `public/models/city/new_world_center_d5de7168.glb` | New  World Center ShenZhen | Daniel G. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/d5de71688da390ed782119775fa7d6d8) | 沿街建筑 |  |
| `public/models/city/oct_tower_dc36d710.glb` | OCT Tower | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/dc36d710-86c9-4acd-ad6f-8bc8f9cbaba4) | 地标 |  |
| `public/models/city/phoenix_building_c0952b1f.glb` | China Phoenix Building 中國鳳凰大廈 | Daniel G. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/c0952b1f7eea9dd67b3ffb639d9c5abc) | 沿街建筑 |  |
| `public/models/city/ping_an_asset_tower_17c33239.glb` | Shenzhen-Ping An Asset Tower | Beer M. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/17c33239-3852-409a-8079-97daee2b2e8b) | 沿街建筑 |  |
| `public/models/city/ping_an_finance_center_503ec42e.glb` | Ping An Finance Center | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/503ec42e-190d-4b83-9222-99ebc2f8abb0) | 地标，替换手工地标 平安金融中心 | 模型本身含平安金融中心南塔（286 m）与 PAFC Mall 裙楼 |
| `public/models/city/resources_tower_abfd8c29.glb` | China Resources Tower | Brady Cloud | [3D Warehouse](https://3dwarehouse.sketchup.com/model/abfd8c29-05b7-428e-88c1-38850366a126) | 远景 |  |
| `public/models/city/ritz_carlton_f63abc8f.glb` | The Ritz-Carlton Shenzhen 深圳丽思卡尔顿酒店 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/f63abc8f1ac36320bdf46b31b7778cf2) | 沿街建筑 |  |
| `public/models/city/rongchao_center_14bd6560.glb` | RongChao  Center 荣超中心 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/14bd656069c57ac6cca165dd51caaddd) | 沿街建筑 |  |
| `public/models/city/special_zone_daily_tower_2f0fbb8d.glb` | 深圳特区报业大厦Shenzhen Special Zone Daily Tower | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/2f0fbb8d039fc387d2448a2b172d6e42) | 地标 |  |
| `public/models/city/stock_exchange_de23a9e4.glb` | 深圳证券交易所 Shenzhen Stock Exchange(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/de23a9e463a24e0d8b98d35d2e7a4e9) | 地标 |  |
| `public/models/city/temeisi_building_1a923979.glb` | 深圳特美思大厦 Shenzhen Temeisi Building(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1a923979c53a4f7f3af078df17b76f13) | 沿街建筑 |  |
| `public/models/city/tencent_1c412809.glb` | 深圳腾讯大厦 Shenzhen Tencent(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/1c4128092666a512d8b98d35d2e7a4e9) | 地标，替换手工地标 腾讯大厦 |  |
| `public/models/city/time_square_excellence_15fb1d9a.glb` | Time Square Excellence Ⅱ 卓越时代广场二期 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/15fb1d9addedd6107b01108cccff784e) | 沿街建筑 |  |
| `public/models/city/times_square_excellence_b8a73c35.glb` | Times Square Excellence 卓越時代廣場 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/b8a73c35bdd46e4462fd14a1a2fade09) | 沿街建筑 |  |
| `public/models/city/trade_center_220f453c.glb` | Shenzhen Trade Center 深圳经贸中心 | David Z. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/220f453c0ab67df265f1e8ef1297e5aa) | 沿街建筑 |  |
| `public/models/city/unicom_building_3666a15a.glb` | 深圳联通大厦 China Unicom Building (Shenzhen) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/3666a15a39a2a205a5b5516fe36a596a) | 沿街建筑 |  |
| `public/models/city/university_science_and_technology_buildi_2cfdf5a0.glb` | 深圳大学科技楼 Shenzhen University Science and Technology Building(China) | xz H. | [3D Warehouse](https://3dwarehouse.sketchup.com/model/2cfdf5a09dd5409810e5a1783aea6854) | 沿街建筑 |  |
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

- 天空与环境贴图：代码生成，经 PMREM 预过滤，供车漆和玻璃反射（日落预设下车辆反射改用上表 HDRI）。
- 建筑立面窗格、道路标线、路牌文字等：着色器与 Canvas 程序生成。
- 全部音效：Web Audio 实时合成（`src/audio/AudioEngine.ts`），包括电机啸叫、风噪、胎噪、碰撞闷响、倒计时提示音和检查点 / 终点音，无音频文件。
- 字体：使用系统字体（PingFang SC / Microsoft YaHei 等），不随项目分发。

## AI 生成素材

原始生成文件、工具及版本、prompt 和使用位置必须可追溯（规范第 05、10 节）。完整 prompt 记入 [prompts.md](prompts.md)。

| 文件 | 工具（版本） | Prompt（摘要，全文见 prompts.md） | 使用位置 |
|---|---|---|---|
| `public/textures/ai/billboard_01.jpg` | Cursor Agent 内置图像生成工具 `GenerateImage`（2026-11-24） | 深圳城市宣传海报：黄昏天际线、带竖向肋条的超高层、文字“深圳 创新之城” | 深南大道右侧路边 / 楼顶灯箱广告牌（`src/city/props/`） |
| `public/textures/ai/billboard_02.jpg`（原始 `billboard_apec_a.jpg`） | 同上 | APEC 欢迎海报（浅色山水版）：青绿海浪与山脊、红橙祥云飘带、文字“APEC CHINA 2026 · 相约深圳 见证奇迹” | 同上 |
| `public/textures/ai/billboard_03.jpg`（原始 `billboard_apec_b.jpg`） | 同上 | APEC LED 广告（深蓝夜景版）：深圳湾大桥与发光楼群、彩色飘带、同上文字 | 同上 |
| `public/textures/ai/billboard_04.jpg`（原始 `billboard_02.jpg`） | 同上 | 虚构鲜果茶广告：荔枝芒果果茶、洋红到橙色渐变、文字“鲜果茶” | 同上 |
| `public/textures/ai/facade_apec_01.jpg`（原始 `facade_apec_portrait.jpg`） | 同上 | APEC 竖版 LED 屏画面（9:16）：上方文字“APEC CHINA 2026 · 相约深圳 见证奇迹”，下方山水与祥云飘带 | APEC LED 屏幕（`src/city/screens/`） |

原始生成文件（未修改）保存在 `docs/ai-assets/original/`，完整 prompt、裁切等后处理与已停用的早期素材（“科技周”“深圳湾夜跑”）见 [ai-assets/README.md](ai-assets/README.md)。全部为虚构广告或原创画面，不含真实品牌、商标或 APEC 官方徽标。
