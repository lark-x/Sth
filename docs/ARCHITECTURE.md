# Sth 静态架构基线

首次采集的业务源码来自 `fd60fc2801561045c1736aa37515a42a045f5dc4`。当前快照的输入身份以 [architecture-baseline.json](architecture-baseline.json) 的 `inputSha256` 和逐文件 SHA-256 为准。快照纳入采集脚本本身，因此仅修改采集方法也会产生差异。

## 入口与所有权

| 入口或流程 | 权威实现和边界 |
| --- | --- |
| 服务与工作区生命周期 | [主进程](../src/main.ts#L9)和[工作区 daemon](../scripts/workspace-daemon.mjs#L105)打开同一套 [SQLite 初始化和迁移入口](../src/database.ts#L15)，并启动媒体、生成和外部检索 worker。工作区、宿主绑定和启动尝试登记由 [withRegistry](../scripts/workspace-store.mjs#L39) 管理。 |
| 网页与宿主的操作契约 | [工作区注册表](../src/workspace.ts#L18)装配各域操作和资源路径。[HTTP 服务](../src/server.ts#L99)分别校验网页与个人连接，再调用同一 [Operations 执行器](../src/core/operations.ts#L163)。[通用请求、回执及描述符](../src/core/contracts.ts#L20)与[目录筛选](../src/core/discovery.ts#L13)各有一个入口。 |
| 网页路由 | [HTML 入口](../web/index.html#L10)挂载 [Vue 壳](../frontend/main.ts#L1)，由[路由表](../frontend/routes.ts#L35)分发。未迁完的路径通过 [LegacyRoute](../frontend/LegacyRoute.vue#L9)加载旧页面，其[渲染入口](../web/assets/app.js#L15)调用同一网页 API。 |
| 首页速记与日记 | [首页速记](../frontend/HomePage.vue#L43)和[日记编辑](../frontend/diary/useDiaryRoute.ts#L281)都调用[资料库操作](../src/library/index.ts#L172)。日记与角色修订的存储定义在[资料库 schema](../src/library/storage.ts#L8)。 |
| 章节、候选稿、采用与 IF | [书库上下文](../frontend/manuscript/library-data.ts#L95)定位作品和文稿，最近记录由 [manuscripts](../src/manuscripts.ts#L38)提供。章节编排、[候选稿修订](../src/story/index.ts#L314)、[采用](../src/story/index.ts#L233)和 [IF 归属与检查点](../src/story/branches.ts#L99)由 story 域执行。 |
| 依据、创作决定和组稿 | [原文读取](../src/sources/index.ts#L117)与[选段固定](../src/sources/pins.ts#L11)以确切修订为依据。[决定与问题](../src/story/decision-operations.ts#L29)属于 story 域，[准备写作](../frontend/context/PrepareWriting.vue#L99)调用 generation 的[持久化组稿操作](../src/generation/index.ts#L155)。[文稿证据操作](../src/generation/evidence.ts#L29)按文稿版本查关联，网页由[依据面板](../frontend/writing/ManuscriptEvidence.vue#L175)读取。 |
| 宿主与异步执行 | [MCP stdio](../adapters/mcp/cli.mjs#L59)和 [Hermes 插件](../adapters/hermes_plugin/__init__.py#L24)包装个人操作与结果链接。[外部检索](../src/sources/external.ts#L75)、[生成](../src/generation/worker.ts#L113)和[媒体](../src/jobs/worker.ts#L120)各有自己的异步入口。 |

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

每批先保留旧快照，再核对文件、依赖及循环、重复区段、复杂度热点、operation 和 schema 对象的增减。文件增删和内容变化纳入过期判断，包括未忽略的新增测试。确认差异后在采集工作树执行 `--write` 和 `--check`，随代码检查受影响的源码入口链接。链接锚点用于定位，逐文件分析和实测数值以快照为准。这一阶段以可重跑快照、可定位入口和有证据的处理决定为完成条件。行为、性能与真实设备验证由迭代验收记录追踪。 [迭代约束](WORKSPACE_ITERATION.md#2026-11-28-补充执行约束)

## 采集口径

| 指标 | 方法与边界 |
| --- | --- |
| 清单与覆盖 | 从 Git 索引和未忽略的新增路径读取 `src`、`frontend`、`web`、`adapters`、`scripts`、`tests` 中的普通文件。保留测试源码并单独标识，排除 vendor、构建目录、依赖、fixture 目录、缓存和生成产物。仓库根的 npm 清单、锁文件、TypeScript 与 Vite 配置作为补充哈希输入。本次采集 281 个文件，其中 63 个归类为测试代码，包含 `tests/` 的 31 个测试及 3 个辅助文件。265 个文件有依赖采集，264 个有复杂度和重复扫描。覆盖计数按根目录、格式和测试归类。 |
| 依赖与循环 | 使用 TypeScript AST、Vue SFC 解析、Python AST 和 HTML 的入口标签。内部依赖和待解析引用都保留行、列，供增量区分同一行的多次引用。保存分域边数和强连通分量。`runtimeCycles` 排除显式 `import type` 等类型边，保留函数字面动态导入与局部 Python 导入，表示潜在运行时依赖。本次采集 908 处边、1 个循环分量，待解析清单含 5 处计算式动态导入和 1 处未解析的本地引用。第三方、隐式 Python 父包、Vue 模板表达式、CSS `url()` 或 `@import`、运行时拼出的路径、子进程参数及服务间调用超出图的覆盖。 |
| 重复区段 | JS、TS 和 Vue 脚本属于同一词法组，Python 单独采集，源文件和测试各自比较。跨文件匹配连续完全相同的 token 序列，门槛为 80 个 token 且两侧各跨至少 5 行。忽略注释及普通空白，保留 token 类型、标识符、字面值和 Python 缩进结构。记录经逐 token 验证的最大区段、哈希和两侧行号。本次命中 1 对源码、19 对测试。导入、测试装配和惯用写法可能命中。改名、改常量、换语言、换结构或同文件的语义重复可能漏掉。 |
| 认知复杂度代理 | 每个函数、方法、回调与顶层范围独立计分。`if`、循环、`switch`/`match`、`catch`/`except` 和条件表达式各计 `1 + 当前计分分支嵌套深度`，布尔短路与 JS 空值合并的每个操作符计 `1`。单独的 `else`、各 `case`、递归、Python 推导式与模板表达式没有专门加分。保留文件总分、最高分和分数至少 12 的范围。此代理用于同口径查阅变化，与 Sonar 认知复杂度及跨语言绝对分数无一一对应。PowerShell、CSS、配置和 SVG 只有文件级哈希。 |
| 公共契约与持久化 | [契约入口](../scripts/contract.ts#L9)在内存 SQLite 注册完整 operation 目录。对完整目录及 116 个描述符分别哈希，JSON 对象键排序，数组保留原顺序。范围是 operation 描述符及资源路径，HTTP 路由、认证和宿主封装仍通过源码及验收检查。采集将系统临时目录显式传给 [openDatabase](../src/database.ts#L15) 和 [withRegistry](../scripts/workspace-store.mjs#L39)。两库各自记录应用 ID、`user_version`、`sqlite_schema` 和逐对象指纹，结束后清理数据库及其临时文件。`sth.sqlite` 当前为版本 4、147 个对象，`persistence.registry` 记录版本 1 的 `registry.sqlite`，包含 `workspaces`、`hosts`、`attempts` 及其 4 个自动索引。登记库版本和对象差异在 `--check` 与 `--compare` 中可见。已有数据上的升级结果、落盘 JSON 语义和业务行为需通过迁移及操作测试验证。 |
| 构建尺寸 | `build` 只记录 `F:/Project/Sth-worktrees/architecture` 本机工作树的 `npm run build` 落盘产物。仓库脚本执行 `vue-tsc --noEmit -p frontend/tsconfig.json && vite build`，调用没有追加参数，使用 Vite CLI 默认生产模式及默认配置加载方式。[配置](../vite.config.ts#L28)指定 `frontend/dist`、`emptyOutDir: true`、资产目录 `vue` 和目标 `es2022`。本次 25 个文件共 501,703 未压缩字节，逐文件记录 SHA-256。主树 summary 单独保留。此总量的范围为 `frontend/dist`，服务另行返回的旧资源和线上指标由主线采集。 [构建命令](../package.json#L28) |

## 有证据的结构问题

| 优先级与处理 | 现状和影响 | 证据 | 收益、成本和风险 | 验收 |
| --- | --- | --- | --- | --- |
| P1 · 随书库摘要交付验收 | 项目和章节书库先列场景，再按条取详情生成正文摘要，近期文稿也有逐条取详情的路径。上限四路并发只约束同时在途的请求数。 | [并发上限](../frontend/manuscript/library-data.ts#L229)、[近期详情](../frontend/manuscript/library-data.ts#L251)、[列表后逐条读](../frontend/manuscript/library-data.ts#L290)。 | 请求随分页而非每条详情增长可压低列表开销。成本在摘要形状、容量和既有搜索语义；若需扩公共契约，由主线先协调。主要风险是摘要错配修订、改写全文搜索边界或旧页兼容。 | 同样本记录按 operation 分类的请求数，再增加列表条目验证无逐条详情增长。核对摘要和链接指向正确稿件修订，并复验筛选与空态。 |
| P2 · 随已排定的路由迁移核对 | Vue 与旧分发同时服务，旧工作区详情函数聚合多个页面分支，修改仍由旧分发接管的路径需要双入口核对。 | [旧分发桥](../frontend/LegacyRoute.vue#L9)、[旧详情分派](../web/assets/workspace.js#L516)代理分数 162。 | 逐路径接管后可减少 UI 分发分支。成本随留存路由、表单和返回行为增长；整片迁移有深链接和旧稿回访风险。独立清理收益未证实。 | 被接管的路线按相同 URL、版本参数、返回位置与失败恢复复验，检查未迁路径仍可进入。 |
| P3 · 观察 Hermes 循环 | `native`、`personal_operations`、`workspace_cli` 构成静态循环。返回方向含函数内导入，冷启动故障未由静态图证实。 | [native → operations](../adapters/hermes_plugin/native.py#L16)、[native → CLI](../adapters/hermes_plugin/native.py#L122)、[operations → native](../adapters/hermes_plugin/personal_operations.py#L240)、[CLI → native](../adapters/hermes_plugin/workspace_cli.py#L13)。 | 有实际启动或安装故障时，厘清共享状态所有权才有可验证收益。现在拆分需要重新验证双方导入顺序和包分发，有 CLI 与网关状态交接风险，暂不排期。 | 以后触发治理时，先复现导入顺序故障，再用同包对冷启动、CLI 配对、网关工具注册与结果回传验收。 |

读稿与场景页的唯一跨文件源码命中是共享导入和组件初始化附近的 117 个 token，页面语义不同，单为缩短重复报告而抽取的收益不足。测试命中多为样例装配和断言，保留独立用例。MCP 与 Hermes 的跨语言结果链接各服务自己的宿主，当前通过共享测试向量约束行为，统一运行时会增加打包和宿主运行风险。 [候选稿](../frontend/writing/DraftPage.vue#L12) · [场景稿](../frontend/writing/ScenePage.vue#L19) · [结果链接对照](../adapters/tests/result-links.test.mjs#L52)
