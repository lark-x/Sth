# Sth 架构模块地图与静态基线

首次业务基线来自 `fd60fc2`（业务代码与 `23b2aca` 相同）。独立审查修正后的改造前快照保留于 `e0cb151:docs/architecture-baseline.json`。本文件的采集口径描述首次基线，当前计数与增量以重新生成的 JSON 为准，避免手工维护另一组现状数字。当前快照的输入身份以 [architecture-baseline.json](architecture-baseline.json) 的 `inputSha256` 和逐文件 SHA-256 为准。快照纳入采集脚本本身，因此仅修改采集方法也会产生差异。

模块地图按当前源码标明入口、所有者和协作边界。行为细节随所链接的实现核对，实测过程和整合回归状态由执行记录追踪，结构计数及指纹由快照维护。源码链接使用文件路径和正文中的函数名定位，更新实现时一并复核职责描述。[迭代执行记录](ULYSSES_EXECUTION.md) · [采集实现](../scripts/architecture-baseline.mjs)

## 入口与所有权

| 入口或流程 | 权威实现和边界 |
| --- | --- |
| 服务与工作区生命周期 | 主进程和工作区 daemon 共用 SQLite 初始化与迁移，启动生成及外部检索 worker，媒体 worker 随供应商配置启动。工作区、宿主绑定和启动尝试登记由 `withRegistry` 管理。[主进程](../src/main.ts) · [daemon](../scripts/workspace-daemon.mjs) · [数据库](../src/database.ts) · [登记库](../scripts/workspace-store.mjs) |
| 网页与宿主的操作契约 | 工作区模块目录装配各域 DDL、操作和资源路径。HTTP 服务分别校验网页与个人连接，再调用同一 Operations 执行器。通用请求、回执和描述符由 core/contracts 定义，目录筛选由 core/discovery 执行。[模块装配](../src/workspace.ts) · [HTTP 服务](../src/server.ts) · [执行器](../src/core/operations.ts) · [契约](../src/core/contracts.ts) · [目录筛选](../src/core/discovery.ts) |
| 网页路由 | HTML 入口挂载 Vue 壳，`RouteDocument` 通过 `routeLoader` 选择域组件。未接管的路径由 `LegacyRoute` 调用 `mountLegacyRoute`。场景创建、章节选择等现存旧页仍经过该桥接并使用同一网页 API。[HTML](../web/index.html) · [Vue 入口](../frontend/main.ts) · [页面挂载](../frontend/RouteDocument.vue) · [路由表](../frontend/routes.ts) · [旧页桥接](../frontend/LegacyRoute.vue) · [旧渲染入口](../web/assets/app.js) |
| 全站导航、书库布局与阅读预览 | `App` 持续挂载同一个 `ManuscriptFrame` 和 `LibraryPanels`，辅助页隐藏文稿中栏并停止该栏的正文／候选查询。作品树实例、展开与滚动状态跨路由保留。Frame 管理资料库、列表、正文三个 pane；文稿页保存 `history.state.manuscriptPane`，辅助页的手机导航只保存临时 pane、原页面滚动及触发按钮焦点，不增加 history entry。`LibraryPanels` 发布预览 href 和空态原因，集合预览由 frame 挂载，实际打开稿件才改变文稿 URL。[Frame](../frontend/manuscript/ManuscriptFrame.vue) · [书库组件](../frontend/manuscript/LibraryPanels.vue) · [集合路由](../frontend/manuscript/routes.ts) |
| 基础 UI 与新建菜单 | `ui/Button` 基于 Reka Primitive 持有本地组件源码和样式；`CreateMenu` 使用 Reka DropdownMenu 管理菜单键盘和焦点。普通选择发出 navigate，原生链接保留 href 和修饰键行为。App 仍为导航／历史权威，UI 组件不直接调用业务 API。Lucide 图标由 `AppIcon` 按名映射，颜色和字体仍来自原共享 token。[UI 边界与来源](../frontend/ui/README.md) · [图标](../frontend/AppIcon.vue) |
| 书库上下文、摘要与搜索 | `library-data` 解析作品、章节、未归章及最近分组，生成摘要、准确修订链接和全文搜索字段。已采用场景按场景修订读取已采用原文。未采用场景先出列表，由 `LibraryPanels.readCandidates` 按桌面选中预览与可视条目优先、最多四路补取。`loadCandidateSummary` 读取 `draft.list(limit: 1)` 按创建顺序返回的首份候选及其当前修订。搜索覆盖当前分组的标题、正文、章节和日记日期，继续补读尚未匹配的候选，未读完或读取失败时发布搜索进度或未完成状态。近期文稿还会逐条取详情并核对采用修订。[数据与匹配](../frontend/manuscript/library-data.ts) · [调度与预览](../frontend/manuscript/LibraryPanels.vue) · [近期记录合并](../frontend/manuscript/recent.ts) · [服务端近期记录](../src/manuscripts.ts) |
| 阅读位置与多跳返回 | `App.navigate` 在原读稿 history entry 合并保存 URL、窗口滚动和正文焦点目标，并为同一校验后回链记录辅助页实际新增的历史深度与关联 token。有效返回通过 `history.go(-depth)` 回原条目，复制链接、新标签或深度校验失败时按真实 href 回指定修订与选段。`manuscriptReturn` 校验唯一、同源的读稿 `returnTo`，角色与资料页将其传入真实子链接。`restoreReadingPosition` 等待正文挂载后恢复滚动和焦点，路由变化时取消恢复，原条目的 `manuscriptPane` 由 frame 继续管理。[壳层导航](../frontend/App.vue) · [位置恢复](../frontend/navigation-state.ts) · [回链校验](../frontend/manuscript/return-link.ts) · [角色页](../frontend/characters/CharacterPage.vue) · [资料页](../frontend/sources/SourcePage.vue) |
| 首页速记与日记 | 首页速记和日记编辑调用 library 域操作。日记正文、角色修订和关联存储由该域维护。[首页](../frontend/HomePage.vue) · [日记编辑](../frontend/diary/useDiaryRoute.ts) · [资料库操作](../src/library/index.ts) · [存储](../src/library/storage.ts) |
| 章节、候选稿、采用与 IF | 章节编排、场景与候选稿修订、采用属于 story 域，IF 的归属与检查点由 branches 管理。网页书库读取这些操作产生的状态。[Story 操作](../src/story/index.ts) · [IF](../src/story/branches.ts) |
| 章内创建与回执恢复 | 旧工作区的 `createPage`、`placementOptions` 校验作品和章节、读全分页章序，创建后追加场景再进入既有候选稿编辑器。`bindScenePlacement` 把调用、已建场景和目标章节保存到 sessionStorage，恢复时先按原 operationId/stepId 查回执，仅在回执不存在且页面仍活跃时重发同一次调用。章序冲突要求读最新章序再明确提交。归章完成或回执恢复后读取 `scene.read` 核对实际归属，并发归属冲突则回到章节选择页重新读取。离页检查阻止后续补发与导航。[创建与落笔目标](../web/assets/workspace.js) · [进度与恢复](../web/assets/scene-placement.js) |
| 候选稿编辑与恢复 | `DraftEditor` 复用 `useMutation` 保存原 operationId/stepId 的待确认调用。普通未保存稿恢复正文和光标；待确认回执重开优先聚焦并显示原生重试按钮，重试先查原回执。读取和保存卸载后均阻止迟到的页面变更。[编辑器](../frontend/writing/DraftEditor.vue) · [读写状态](../frontend/writing/state.ts) |
| 依据、创作决定和组稿 | 原文及固定选段以确切修订为依据。决定与问题属于 story 域，准备写作调用 generation 的持久化组稿操作，文稿证据按所读版本查关联。[原文读取](../src/sources/index.ts) · [固定选段](../src/sources/pins.ts) · [决定与问题](../src/story/decision-operations.ts) · [准备写作](../frontend/context/PrepareWriting.vue) · [组稿操作](../src/generation/index.ts) · [证据操作](../src/generation/evidence.ts) |
| 读稿工具栏与依据面板 | `ManuscriptTools` 按钮派发冒泡 `sth:open-evidence`，所属 main 中的 `ManuscriptEvidence` 打开面板并保存返回焦点。面板派发 `sth:evidence-state`，携带 `{open,panelId}` 同步工具栏 ARIA 状态。依据组件管理固定侧栏、手机全屏模态、背景 inert 和滚动恢复，frame 根据组件触发器的展开状态腾出正文空间。[工具栏](../frontend/writing/ManuscriptTools.vue) · [依据面板](../frontend/writing/ManuscriptEvidence.vue) · [Frame 样式](../frontend/manuscript/frame.css) |
| 宿主与异步执行 | MCP stdio 和 Hermes 插件包装个人操作与结果链接。外部检索、生成和媒体各有自己的异步入口。[MCP](../adapters/mcp/cli.mjs) · [Hermes](../adapters/hermes_plugin/__init__.py) · [外部检索](../src/sources/external.ts) · [生成](../src/generation/worker.ts) · [媒体](../src/jobs/worker.ts) |

## 复现与更新

在当前工作树用 Git、仓库要求的 Node 和 Python 3.12 或更新版本。首次结果使用 Node 24.15.0、SQLite 3.51.3、Python 3.14.3 和锁文件中的依赖。参考和候选应使用同一工具链与常规生产构建环境。

```sh
npm ci
node scripts/architecture-baseline.mjs --check --skip-build
node scripts/architecture-baseline.mjs --compare /path/to/previous-baseline.json --skip-build
node scripts/architecture-baseline.mjs --check
node scripts/architecture-baseline.mjs --compare
node scripts/architecture-baseline.mjs --write
```

`--check` 返回 `0` 表示一致、`1` 表示快照过期、`2` 表示采集或参数错误。`--compare` 输出同样的增量 JSON，差异本身返回 `0`。两个比较命令默认以已保存快照为参考，也可指定历史文件。无参数时输出当前完整快照，`--write` 在所有采集完成后才更新已保存文件。

只读审查和跨工作树比较使用 `--skip-build`。该参数跳过构建及产物对照，输出 `build.status: "skipped"`。源码、构建配置和锁文件哈希、架构指标、operation 与空库 schema 仍参与过期判断。默认检查会重跑 `npm run build` 并更新本工作树的 `frontend/dist`。完整构建对照要求参考快照来自同一工作树的该命令，历史内存快照和其他工作树的快照可用静态模式对照。

每批先保留旧快照，再核对文件、依赖及循环、重复区段、复杂度热点、operation 和 schema 对象的增减。文件增删和内容变化纳入过期判断，包括未忽略的新增测试。确认差异后在采集工作树执行 `--write` 和 `--check`，随代码检查受影响的源码入口链接及函数职责。逐文件分析和实测数值以快照为准。这一阶段以可重跑快照、可定位入口和有证据的处理决定为完成条件。行为、性能与真实设备验证由迭代验收记录追踪。[迭代约束](WORKSPACE_ITERATION.md#2026-11-28-补充执行约束) · [执行记录](ULYSSES_EXECUTION.md)

## 采集口径

| 指标 | 方法与边界 |
| --- | --- |
| 清单与覆盖 | 从 Git 索引和未忽略的新增路径读取 `src`、`frontend`、`web`、`adapters`、`scripts`、`tests` 中的普通文件。保留测试源码并单独标识，排除 vendor、构建目录、依赖、fixture 目录、缓存和生成产物。仓库根的 npm 清单、锁文件、TypeScript 与 Vite 配置作为补充哈希输入。首次基线采集 281 个文件，其中 63 个归类为测试代码，包含 `tests/` 的 31 个测试及 3 个辅助文件。265 个文件有依赖采集，264 个有复杂度和重复扫描。覆盖计数按根目录、格式和测试归类。 |
| 依赖与循环 | 使用 TypeScript AST、Vue SFC 解析、Python AST 和 HTML 的入口标签。内部依赖和待解析引用都保留行、列，供增量区分同一行的多次引用。保存分域边数和强连通分量。`runtimeCycles` 排除显式 `import type` 等类型边，保留函数字面动态导入与局部 Python 导入，表示潜在运行时依赖。首次基线采集 908 处边、1 个循环分量，待解析清单含 5 处计算式动态导入和 1 处未解析的本地引用。第三方、隐式 Python 父包、Vue 模板表达式、CSS `url()` 或 `@import`、运行时拼出的路径、子进程参数及服务间调用超出图的覆盖。 |
| 重复区段 | JS、TS 和 Vue 脚本属于同一词法组，Python 单独采集，源文件和测试各自比较。跨文件匹配连续完全相同的 token 序列，门槛为 80 个 token 且两侧各跨至少 5 行。忽略注释及普通空白，保留 token 类型、标识符、字面值和 Python 缩进结构。记录经逐 token 验证的最大区段、哈希和两侧行号。首次基线命中 1 对源码、19 对测试。导入、测试装配和惯用写法可能命中。改名、改常量、换语言、换结构或同文件的语义重复可能漏掉。 |
| 认知复杂度代理 | 每个函数、方法、回调与顶层范围独立计分。`if`、循环、`switch`/`match`、`catch`/`except` 和条件表达式各计 `1 + 当前计分分支嵌套深度`，布尔短路与 JS 空值合并的每个操作符计 `1`。单独的 `else`、各 `case`、递归、Python 推导式与模板表达式没有专门加分。保留文件总分、最高分和分数至少 12 的范围。此代理用于同口径查阅变化，与 Sonar 认知复杂度及跨语言绝对分数无一一对应。PowerShell、CSS、配置和 SVG 只有文件级哈希。 |
| 公共契约与持久化 | 契约入口在内存 SQLite 注册完整 operation 目录，首次基线对完整目录及 116 个描述符分别哈希。JSON 对象键排序，数组保留原顺序。范围是 operation 描述符及资源路径，HTTP 路由、认证和宿主封装仍通过源码及验收检查。采集将系统临时目录显式传给 `openDatabase` 和 `withRegistry`。两库各自记录应用 ID、`user_version`、`sqlite_schema` 和逐对象指纹，结束后清理数据库及其临时文件。首次基线的 `sth.sqlite` 为版本 4、147 个对象，`persistence.registry` 记录版本 1 的 `registry.sqlite`，包含 `workspaces`、`hosts`、`attempts` 及其 4 个自动索引。登记库版本和对象差异在 `--check` 与 `--compare` 中可见。已有数据上的升级结果、落盘 JSON 语义和业务行为需通过迁移及操作测试验证。[契约入口](../scripts/contract.ts) · [数据库](../src/database.ts) · [登记库](../scripts/workspace-store.mjs) |
| 构建尺寸 | `build` 记录实际采集工作树的 `npm run build` 落盘产物，路径和工具链见 JSON 的 `build.source`。仓库脚本执行 `vue-tsc --noEmit -p frontend/tsconfig.json && vite build`，调用没有追加参数，使用 Vite CLI 默认生产模式及默认配置加载方式。配置指定 `frontend/dist`、`emptyOutDir: true`、资产目录 `vue` 和目标 `es2022`。首次基线在架构工作树生成 25 个文件、501,703 未压缩字节；整合后在主工作树重新生成。当前逐文件大小、SHA-256 及总量见 JSON。此总量的范围为 `frontend/dist`，服务另行返回的旧资源和线上指标由主线采集。[配置](../vite.config.ts) · [构建命令](../package.json) |

## 有证据的结构问题

| 优先级与处理 | 现状和影响 | 证据 | 收益、成本和风险 | 验收 |
| --- | --- | --- | --- | --- |
| P1 · 摘要已实现，保留请求总成本问题 | 已采用稿按确切版本取原文，候选摘要按桌面预览与可视项渐进读取，全文搜索补读待匹配候选。两处四路上限分别控制详情任务和候选任务，同时在途量受控，逐条读取路径仍存在。 | [详情与摘要](../frontend/manuscript/library-data.ts) · [调度与搜索状态](../frontend/manuscript/LibraryPanels.vue) · [摘要与搜索实测用例](../frontend/manuscript/library-summary.test.mjs) | 当前实测首屏请求下降，滚动和全文搜索请求增加，分阶段结果见下表。候选摘要需要额外的列表和正文请求，保留 N+1 成本。批量契约须由总请求、数据规模及搜索体验收益另行论证。 | 已实测准确修订链接、搜索中间预览、内联保存刷新、近期采用身份及章节读取失败。搜索未完成时不会直接发布确定零结果。清除搜索后等待摘要的短暂提示仍作为 P3 跟踪，整合回归状态由执行记录维护。 |
| P2 · 多跳返回已实现，保留历史状态边界验证 | 同一读稿回链下的多次辅助页导航已记录深度和 token，返回复用原 history entry，URL 回链覆盖新标签与历史提示失效的情况。取消遍历后的定时器只撤销该条目的遍历提示，后续点击可继续返回。 | [导航状态机](../frontend/App.vue) · [正文恢复](../frontend/navigation-state.ts) · [回链校验](../frontend/manuscript/return-link.ts) · [多跳与故障用例](../frontend/tests/navigation-state.test.mjs) | 实际收益为原稿修订、选段、pane、窗口位置与焦点的连续性，成本为局部历史状态。风险在异步正文挂载、新导航争用及不完整 history 提示。 | 已有桌面、手机和 WebKit 定向实测，覆盖多跳、前进后退、辅助页刷新、复制到新标签、取消遍历及无效深度。新标签按 URL 定位修订和选段，像素位置恢复依赖原历史条目。 |
| P2 · 章内创建与恢复已实现，保留分步写入边界 | 创建、归章和进入写稿由旧工作区与 placement helper 协作。回执恢复沿原 step 和场景继续，章节修订冲突需展示最新章序后再提交，最终回链跟随读取到的实际归属。 | [页面装配](../web/assets/workspace.js) · [回执恢复](../web/assets/scene-placement.js) · [创建与故障实测用例](../frontend/tests/chapter-create.test.mjs) | 已减少作者创建后另行归章的操作。成本为 sessionStorage 进度、回执核对和分步写入状态，本地存储不可用、响应丢失及其他作者改章仍需明确恢复。 | 定向实测覆盖正常落笔、未送达与已提交但丢响应、刷新、分页章序、离页期间回执缺失、他人移章及并发选章。完成前按服务端实际 placement 决定编辑器和返回分组。 |
| P2 · 随实际路由迁移核对 | Vue 域路由与旧分发仍共同服务，章内创建等路径继续由旧工作区接管。C1 将恢复逻辑收敛到 placement helper，旧详情分派仍聚合多个分支。 | [域路由](../frontend/routes.ts) · [旧页桥](../frontend/LegacyRoute.vue) · [旧工作区分派](../web/assets/workspace.js) | 逐路径接管可减少分派分支，收益须由具体改动证明。成本随留存路由、表单和恢复状态增长，整片迁移有深链接、原稿回访及已保存进度风险。 | 后续接管按相同 URL、版本参数、返回位置和失败恢复复验，逐文件热点以架构快照为准。 |
| P3 · 保留 Hermes 静态循环观察 | `native`、`personal_operations`、`workspace_cli` 仍构成静态循环，返回方向含函数内导入。当前没有该循环造成启动故障的实测证据。 | [native](../adapters/hermes_plugin/native.py) · [personal_operations](../adapters/hermes_plugin/personal_operations.py) · [workspace_cli](../adapters/hermes_plugin/workspace_cli.py) | 实际启动或安装故障可为厘清共享状态所有权提供治理收益，当前保留实现。拆分成本包括重新验证导入顺序、包分发和 CLI 与网关状态交接。 | 出现故障后先复现导入顺序，再用同一分发包验证冷启动、CLI 配对、网关工具注册与结果回传。 |

24 幕样本记录的是网页 operation 请求数。冷首屏与向列表底部滚动连续采集，全文搜索则在重新加载并清空首屏计数后单独采集，因此“整趟”只合计冷首屏与其后的搜索，滚动列用于独立比较。每阶段按 operation 分类，等待请求结束并取得静默窗，观测与实现见本机产物及测试。[当前请求明细](../frontend/.artifacts/ulysses-baseline/library-final/requests.json) · [采样与重载边界](../frontend/manuscript/library-summary.test.mjs)

| 视口 | 冷首屏，改造前 → 当前 | 滚动新增，改造前 → 当前 | 重载冷首屏后的搜索新增，改造前 → 当前 | 冷首屏＋搜索整趟，改造前 → 当前 |
| --- | --- | --- | --- | --- |
| 桌面 1280px | 36 → 22 | 0 → 8 | 8 → 45 | 44 → 67 |
| 手机 390px | 28 → 13 | 0 → 8 | 0 → 36 | 28 → 49 |

本轮已保存快照与改造前快照的公共 operation 描述符、资源路径、业务 schema 和登记库指纹一致。后续测试补丁进入快照后，当前一致性以采集输入指纹和主回归记录为准。[架构快照](architecture-baseline.json) · [迭代执行记录](ULYSSES_EXECUTION.md)

首次基线中，读稿与场景页的唯一跨文件源码命中是共享导入和组件初始化附近的 117 个 token，页面语义不同，单为缩短重复报告而抽取的收益不足。测试命中多为样例装配和断言，保留独立用例，当前命中及增量由快照维护。MCP 与 Hermes 的跨语言结果链接各服务自己的宿主，通过共享测试向量约束行为，统一运行时会增加打包和宿主运行风险。[候选稿](../frontend/writing/DraftPage.vue) · [场景稿](../frontend/writing/ScenePage.vue) · [结果链接对照](../adapters/tests/result-links.test.mjs)
