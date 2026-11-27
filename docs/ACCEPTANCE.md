# Sth 本机交付验收

本机预览为 <http://127.0.0.1:9322>，Compose 工程名 `sth-authoring`，使用独立数据卷 `sth-authoring_workspace`。四阶段基线、角色条目、研究与叙事分别使用数据库格式 2、3、4。下列链接可在运行预览的电脑上打开。

## 2026-11-28 · Ulysses 方向整合验收

本轮在 `feat/ulysses-workspace` 完成灰白写作界面、真实文稿摘要、紧凑读稿工具栏、章内新建直接落笔、原句优先的依据，以及跨角色/资料多跳返回原稿原段。应用代码在 `91be384` 后保持一致，后续提交为测试和交付记录。部署与安装包的版本另行核对，不用本地源码代替运行版本。

| 体验 | 正式页面截图 |
| --- | --- |
| 资料库、章节文稿列表、当前正文 | [1280px 三栏](ulysses-screens/desktop-chapter.png) |
| 手机首屏读稿与依据 | [390px 读稿](ulysses-screens/phone-reading.png) · [原文与人物依据](ulysses-screens/phone-evidence.png) |
| 窄屏书库、旧版选段、日记 | [WebKit 320px 章节](ulysses-screens/webkit-320-chapter.png) · [旧版选段](ulysses-screens/webkit-320-passage.png) · [日记](ulysses-screens/webkit-320-diary.png) |
| 首页与辅助资料 | [390px 首页](ulysses-screens/phone-home.png) · [角色正文](ulysses-screens/phone-character.png) |
| 同一样本前后对照 | [旧首页](ulysses-screens/before-phone-home.png) / [新首页](ulysses-screens/phone-home.png)；[旧读稿](ulysses-screens/before-phone-reading.png) / [新读稿](ulysses-screens/after-phone-reading.png) |

以上为隔离样例；每张图片的原路径、阶段、源码与构建摘要在 [截图清单](ulysses-screens/manifest.json)。完整六组为 Chromium 1280/768/390/320 与 WebKit 390/320，每组 20 个场景，合计 120/120、349 张图。采集构建摘要 `8819bcce78a6ebfbb088078d3bf45232521bc8c63ebf0fcbddf40f1d1cbff505`，应用源码摘要 `588bd0070a39b0a0f7dd1109789e77709e3e2a6ba46c8fed5e62339c14fc6e14`；所有通过组的 `sourceStable`、`servedBuildStable` 均为 true。

最终完整浏览器回归 222/222，文稿专项 154/154；核心 130 通过、1 条真实 ComfyUI 条件用例跳过；适配器 18 通过、3 条真实宿主启动/登录条件用例跳过。已安装 Hermes 的 CLI、合成 QQ/微信上下文及公共结果链接通过，不作为新一轮真人设备或真实模型验收。构建和类型检查通过。

完整浏览器回归过程中发现旧菜单入口和旧预览标题断言不再对应正式界面；更新为实际展开菜单、精确选择行/正文/版本后，经独立审查通过。书库异步摘要测试改为等待准确 preview href。原业务、API、安全与版本断言保留，未增加超时、删除或跳过失败用例。最终全套日志为本机 `frontend/.artifacts/ulysses-baseline/final-{browser,manuscript}-accepted.log`，严格标题补验为 `chapter-create-reviewed-final.log`（10/10）。失败轮次也保留。

请求量、首屏位置、包体及本机布局位移的前后变化见 [治理对照](ULYSSES_EXECUTION.md#最终整合的收益与代价)。真实 iOS、WKWebView、真人私聊及大库慢设备性能仍属于后续范围。

## 2026-11-28 · 改造前的视觉重新评审

当时部署为 `23b2aca`。本日主要页面与依据开关抽查 24/24 通过，另有 7 项定向回归通过，手机白页、返回、长日记输入和章内新建的复测通过。证据保存在本机忽略目录 `frontend/.artifacts/smoke-20261128/`。

用户否定当前绿色主题及 Ulysses 参考的落实程度。对照官方界面与本日截图，当前三栏结构已有实现，配色、中文排版、文稿摘要、首屏层级和跨页风格仍未达标。前端视觉阶段重新开启。下方历史测试和截图记录继续作为对应版本的功能证据，新的完成度及交付要求见[重整计划](WORKSPACE_ITERATION.md#2026-11-28-完成度重新评定)与[设计约定](../DESIGN.md)。

## 2026-11-27 · 文稿资料库

`feat/manuscript-library` 的 `5e7be70` 在干净工作树上完成浏览器截图验收。隔离样例有多章作品、同一幕的三份候选稿、两稿各自确认的组稿记录及一篇日记。Chromium 运行 1280、768、390、320px，WebKit 运行 390、320px。每个视口 20 个场景，120 项通过，共 349 张截图。截图前后浏览器构建的 SHA-256 均为 `ad546493478e7fff637d0570d3057197543b540f9a0e26672ed14d4179ae427a`。

| 作者的操作 | 可以核对的画面 |
| --- | --- |
| 打开作品的第二章，找到当前采用的稿件 | [桌面三栏及选中行](manuscript-screens/chromium-desktop-directory-03-chapter-selected.png) |
| 从助手返回的链接打开旧版选段 | [手机首屏中的目标句](manuscript-screens/chromium-phone-passage-01-assistant-link.png) |
| 确认这份稿件参考过的原句和人物 | [手机展开本次依据](manuscript-screens/chromium-phone-evidence-02-basis-expanded.png) |

本机 9322 已发布 `5e7be70`。容器与 HTTP 健康检查通过，沿用原服务配置和数据卷。升级前 56 张表的 1,177 行逐行核对一致，升级后 59 张表、1,187 行与演练结果相同。随后通过真实 HTTP 打开实际作品、日记和指定旧稿选段，四种宽度共 12 组页面、20 张截图。113 次读取留下 113 条业务回执，40 张作者内容相关表校验一致。关闭依据后四种宽度均回到原选段。真实稿件的对照图保存在本机忽略目录。

用 `npm run test:manuscript` 检查分组往返、读写、证据和窄屏交互。执行 `node scripts/capture-manuscript.mjs --ui snapshot --stage final --out frontend/.artifacts/manuscript-review` 可复现样例及完整截图；再用 `node scripts/capture-manuscript.mjs --gallery frontend/.artifacts/manuscript-review` 生成可逐张查看的本地图册。真实 iOS、WKWebView 和真人私聊另行验收。

## 2026-11-27 · 三宿主创作工作区

该轮发布镜像为 `sth-local:authoring-ae25ac0`，对应代码 `ae25ac0c578af0a2cd6c218f438f80b4eed2ec0f`。日记编辑可在同一标签页刷新后恢复未交稿的内容与待确认的保存请求。作品的「创作决定」提供「按此版准备写作」，可从作者选定的历史版本选择模板、写下要求并查看组稿出处。[打开北港的创作决定](http://127.0.0.1:9322/author-context?projectId=14d8d4f9-6cf7-449d-bec0-c2ff6e69029f&revision=0)

- 干净检出的候选版本通过 141 项浏览器测试，单独通过移动 WebKit 编辑、保存和历史导航。核心套件常规 126 项通过，另在隔离库启用第 127 项，使用实际 ComfyUI 生成 768×512 图片并从数据库备份恢复相同字节。
- 升级前快照 `release-ae25ac0-20261127-152918/pre-upgrade.sqlite` 的 SHA-256 为 `e4ef3275115ece8572861dbbdd8a2fb5f3688d1e87096c62a1345a43b334ed1a`。SQLite 完整性和外键检查通过。新容器继续使用原卷和全部 16 项服务配置。
- 在运行实例的桌面 Chromium 和移动 WebKit 上重开首页、带版本的温妮莎日记与北港场景、场景插画、连接设置和北港创作决定。核对 113 项可发现操作、固定上下文的写作入口与原插画字节。新会话独立读取两版日记和真实宿主测试见[迭代记录](WORKSPACE_ITERATION.md)。
- 在隔离工作区 `decision-72f9836677`，网页作者先后确认第 2、4 版决定。两次独立 Hermes 会话按指定版本查证，改判后的会话同时重建两个版本及其当时引用的原文。MCP 回执、服务端回执和模型回读内容均通过核对。另一场对最终 Windows x64 安装包的空 profile 验收也通过全部 10 项检查。

### 同日首版发布

`feat/vue-authoring-and-hosts` 的代码提交 `2f596583438ea8f553f4478a33e2333d640356eb` 已发布至 9322。运行镜像为 `sth-local:authoring-2f59658`，健康检查通过。数据卷沿用 `sth-authoring_workspace`，发布前后 16 项原服务环境设置一致。发布前一致性快照的 SHA-256 为 `9e5e847675bc41abbd6ff17d8873ca2d170ebec213a171c47c3c8beef4b19d40`，旧镜像为 `sth-local:research-citations-20261124`。

- 干净克隆的 123 项浏览器测试全部通过。核心套件 126 项通过，按配置跳过的 1 项 ComfyUI 实机用例单独启用后也通过，生成的 768×512 PNG 在 SQLite 快照中逐字节恢复。移动 WebKit 日记编辑、重开和历史导航另行通过。
- 上线后在 Chromium 桌面和 WebKit 手机参数下重新打开首页、指定版本的温妮莎日记与北港场景、媒体详情、连接设置。运行实例暴露 113 项操作。归档图片从正式实例下载后的 SHA-256 为 `de58cf3e81adbe783a0bd57ffff3b63c46efb4520ce1af884d133c8928222c42`。
- 原生 Hermes 完整插件安装、新会话读回、Hermes 写入与手机网页修订后 Codex 读回两版、Antigravity 实际模型修订和独立会话读回，分别在隔离数据上验收。真实 iPhone Safari、WKWebView 以及真机 QQ/微信收发仍需按具体设备检查。[详细迭代记录](WORKSPACE_ITERATION.md) · [iOS 接入与设备验收](IOS_EMBEDDING.md)

## 资料研究与多视角叙事

本轮已在升级前导出格式 3 快照，使用副本升级后对 35 张原表双向逐行比对，共 302 条原记录一致，完整性与外键检查通过。预览保留原卷。真实 Hermes 从同一对事件分别写出士兵现场和史家回顾，两稿的视角、固定来源和结果 ID 见[链路与验收记录](RESEARCH_LIVE.md)。也可以打开[实际 Akasha 检索](http://127.0.0.1:9322/research/5661da45-5ece-4f5e-9c54-29dca68d8a6f)和[读回的原文上下文](http://127.0.0.1:9322/research/d48ba388-79ac-4823-93e8-8800658bec08)。

浏览器回归覆盖独立日记、同句多处的精确选段、角色提炼、影响分页、改正先后、IF 接续及提示词出处。桌面与窄屏沿用 `npm run test:browser`。真实模型在空工作区创建日记并从网页首页点开；真实 ComfyUI 生成的 768 × 512 PNG 已在数据库备份中逐字节核对。已安装 Hermes 的 QQ、微信网关事件回归通过，手机平台收发按本文末尾步骤单列验收。

最终研究版通过 85 项后端测试（含真实 ComfyUI）、16 项浏览器测试和 TypeScript 检查。真实 Hermes 接受单条普通中文指令，自行检索和归档《背风的密约》，写成带出处的日记。10 份操作回执与服务端一致。新镜像在空库通过启动和引文反查后，沿用原卷发布至 9322；网页 API 按原归档的 `[0, 32)` 选段读回该日记。[普通指令实测](RESEARCH_CHAT.md) · [研究日记](http://127.0.0.1:9322/diaries/57d9cd7d-c9fa-4bd8-a375-14ccc283890f?revision=1)

在[北港 · 错过末班船](http://127.0.0.1:9322/branches/16b1e7c8-1bed-4102-b3f6-f75d8feb37c2?revision=2)查看接续位置。作者直接设定了旅人错过渡船的事件，保存时只填标题与概述。打开[岸上续写的提示词](http://127.0.0.1:9322/generations/77d60b3f-06ea-4dd3-a45b-560d6a18241a/prompt)，可查到票角被攥湿的角色状态及相应断点。主线登船稿和作者备忘都留在自己的记录中。

## 角色卡与提示词组成

### 从一段声音到一篇作品

本机 Hermes CLI 使用 `codex/gpt-6.2-sol`，经真实 stdio MCP 完成两轮自由创作与修订，共调用 28 次业务操作。验收程序负责导入一段 WAV、配对、跨入口读回及清理。角色添加了录音，模型的写作使用选定文本。以下日记、对白与短篇均由 Hermes 写入 `9322`。

1. 对比许汀的[第 1 版](http://127.0.0.1:9322/characters/1c8fed55-869e-4e37-9ba5-c209fedca2da?revision=1)与[第 2 版](http://127.0.0.1:9322/characters/1c8fed55-869e-4e37-9ba5-c209fedca2da?revision=2)。第 1 版只有录音，称呼与描述为空。第 2 版在同一条目里有录音、文字与故事引文。再打开角色日记[《只湿了一只袜子》](http://127.0.0.1:9322/diaries/1fb1a733-1b82-4aa2-aa2c-e2a501fb648f?revision=1)。
2. 在[《新纱》的提示词组成](http://127.0.0.1:9322/generations/94921af5-e85c-4141-b359-bd0657d932cf/prompt)搜索「灯可以熄了，窗还开着。」。来源链接指向许汀的混合条目和[《第三声以后》第 1 版](http://127.0.0.1:9322/drafts/3da8bd24-28d2-4d47-a066-04cea328767a?revision=1)。同条目里的音频未选入。对照[修订稿](http://127.0.0.1:9322/drafts/3da8bd24-28d2-4d47-a066-04cea328767a?revision=2)和[《新纱》成稿](http://127.0.0.1:9322/generations/94921af5-e85c-4141-b359-bd0657d932cf/result)，历史引文仍可核对。
3. 试玩后补充了中文模板别名、「附上角色描述」开关、提示词操作的直接链接。原始块号用于找来源，组稿后的位置用于定位最终消息，两者在契约中有对应示例。新版提示词读取只返回实际入选的内容及来源。

### 带图委托与数据升级

1. 打开[北港守灯人的角色卡](http://127.0.0.1:9322/characters/acd60da4-263c-4d56-af74-440de0a77ee4?revision=1)。同一条目「他的港口」包含港口插画和一条关于煤油桶的文字设定。
2. 打开[实际委托的提示词组成](http://127.0.0.1:9322/generations/f91ba82e-c8ba-478e-9f57-00c59abc44ed/prompt)。消息包含已选图片。图片 SHA-256 与原图一致，搜索「煤油桶」为零处。展开图片来源可以回到第 1 版角色卡。
3. 打开[本次模型写出的短故事](http://127.0.0.1:9322/generations/f91ba82e-c8ba-478e-9f57-00c59abc44ed/result)。供应商回报模型 `codex/gpt-6.1-terra`，发送状态 `sent`，生成结果 `succeeded`。使用该例可同时验收资料进入请求、出处查看和真实成稿。
4. 打开[旧版分镜的提示词组成](http://127.0.0.1:9322/generations/c0b040f2-a7c9-4178-8a63-2efca7fb6ba3/prompt)。旧记录能读回当时保存的两条消息，页面提示历史记录缺少来源。格式 2 的 [Hermes 验收日记](http://127.0.0.1:9322/diaries/98332944-6eeb-4d86-a9e1-9df68a9b5b40) 和原图在升级后仍可读。另对升级前快照执行独立升级，SQLite 的 `integrity_check` 返回 `ok`，`foreign_key_check` 无记录。

本轮验证通过 TypeScript 检查、57 项后端测试（包含真实 ComfyUI）、9 项 Chromium 浏览器用例、4 项适配器测试。另行运行的 6 项真实模型基线检查通过。最终部署后以 390 像素宽的 Chromium 搜索《新纱》引文，命中同时链接许汀第 2 版与原稿第 1 版；角色、日记、提示词与成稿页面均可直接打开。

## 直接查看本机示例

1. 打开 [北港渡口 · 灯亮时，第 1 版](http://127.0.0.1:9322/scenes/7340d5ef-9e14-4f13-b607-5e8d451f30dd?revision=1)。作品「验收示例 · 北港」中的场景既用于分镜委托，也用于生成插画。
2. 打开 [分镜结果](http://127.0.0.1:9322/generations/c0b040f2-a7c9-4178-8a63-2efca7fb6ba3/result) 和 [生成记录](http://127.0.0.1:9322/generations/c0b040f2-a7c9-4178-8a63-2efca7fb6ba3)。结果含三条镜头，使用内置 `shot-list` 第 1 版，已保存供应商回报的 `codex/gpt-6.1-terra` 和实际 `json_schema` 请求参数。
3. 打开 [出图任务](http://127.0.0.1:9322/jobs/55013bb2-d579-407c-af86-bfecbdad2a3c) 和 [图片详情](http://127.0.0.1:9322/media/1962e998-d269-4c2e-9259-93bdbe61d61f)。选中的构图为「栈桥尽头的引路灯」，上游一次提交完成。Anima Turbo、8 步、种子 `733171` 产出 768 × 512 PNG，共 583,374 字节。`GET` 和 `HEAD` 返回相同长度及 ETag。[原图](http://127.0.0.1:9322/api/web/media/1962e998-d269-4c2e-9259-93bdbe61d61f/content)
4. 运行中的服务通过 `scripts/backup.ts` 导出 SQLite，独立只读打开快照后 `integrity_check` 为 `ok`，外键违规为零，图片的 SHA-256 仍为 `de58cf3e81adbe783a0bd57ffff3b63c46efb4520ce1af884d133c8928222c42`。

## 四阶段基线验证

本次最终运行通过 TypeScript 检查、43 项后端测试（含真实 ComfyUI）、7 项浏览器测试和 4 项适配器测试。`codex/gpt-6.2-sol` 在同一轮真实 Magpie 测试中完成四个阶段，连同独立日记用例及套件计数共 6 项通过。模型工具测试的第四阶段验证到任务排队；上方北港示例另行验证从实际队列到图片归档。预览中的图片、分镜结果与历史场景均已在 390 像素宽的 Chromium 页面打开读回。

| 范围 | 入口 | 验证内容 |
| --- | --- | --- |
| 操作、数据库、后台任务 | `npm run typecheck`、`npm test` | 资料历史及跨作品引用、精确版本选稿与 IF、模板及文字批量委托、五个场景的恢复、取消、失败重试、未知结果只读核对、快照备份。 `STH_TEST_COMFY=1` 并设置四个 `STH_COMFY_*` 参数可包含实际图片供应商用例。 |
| 前端 | `npm run test:browser` | 7 项 Chromium 场景，覆盖桌面及窄屏、原有日记与连接、四个新阶段的作者操作。浏览器测试使用真实业务服务和可控的供应商响应。 |
| 已安装的 Hermes 与 MCP | `npm test --prefix adapters` | 设置 `STH_TEST_HERMES_PYTHON` 指向已安装 Hermes 解释器可完整运行 4 项。合成 QQ 写资料，网页修订，合成微信和独立 MCP 进程接续；验证精确版本链接、长期配对、重复投递和撤销。 |
| 真实模型发现和调用 | `node --test tests/model/*.test.mjs` | 设置 `STH_TEST_MAGPIE=1`，需要 `127.0.0.1:3425/v1` 上能调用工具的模型。可用 `STH_TEST_MAGPIE_MODEL` 选择本机路由。模型先读索引，再取得所需 schema；业务请求和网页读回使用隔离 Sth 实例。 |

## 手机验收

预览与默认 `9321` 实例分别签发连接码。给用于验收的 Hermes profile 加载本仓库 `adapters/hermes_plugin`，把 `STH_PERSONAL_OPERATIONS_ORIGIN` 指向 `http://127.0.0.1:9322`（Hermes 与 Sth 在同一台机器时），重载该 profile，在 [连接页](http://127.0.0.1:9322/settings/connections) 生成并发送一次连接命令即可。手机要直接点开链接时，还需使用其可达的网页域名。[配置步骤](../README.md#手机链接)

用同一私聊发送「保存一条个人设定，北港的末班船晚上十点开」，随后发送「找到这句原话，用它写一篇日记并保留出处」。在网页把设定改为九点，再追问「之前那篇用的是几点？用最新设定再写一篇」。预期分别返回十点、九点的原文与可追溯版本。QQ 与微信的真实设备收发和手机域名访问需要各自验收；本次自动化证据覆盖已安装网关中的合成渠道消息。
