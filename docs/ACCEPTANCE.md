# Sth 本机交付验收

本机预览为 <http://127.0.0.1:9322>，Compose 工程名 `sth-authoring`，使用独立数据卷 `sth-authoring_workspace`。四阶段基线、角色条目、研究与叙事分别使用数据库格式 2、3、4。下列链接可在运行预览的电脑上打开。

## 2026-11-28 · 全站视觉与交互重设计

应用提交 `482e9af56ad68917283938848594cccf81a3e3ba` 已部署到 <http://127.0.0.1:9322>，开发分支 `feat/cohesive-writing-ui`。采用 Ulysses 方向的灰白资料库、文稿列表与正文，统一 Vue/Reka/Lucide 控件、页面层级和手机触区；新增可中断的菜单、依据面板及导航动效。日记、资料、角色、任务、设置与可达旧页均纳入范围。范围、治理收益、性能成本和失败记录见 [完整执行记录](COHESIVE_UI_EXECUTION.md)。

| 最终合成样例 | 图片 |
| --- | --- |
| 三栏读稿与手机精确选段 | [桌面](cohesive-ui-screens/chromium-1280-reader.png) · [320px](cohesive-ui-screens/chromium-320-reader.png) |
| 两行速记与最近编辑 | [桌面](cohesive-ui-screens/chromium-1280-home.png) · [320px](cohesive-ui-screens/chromium-320-home.png) |
| 比稿核依据与明确采用 | [比稿](cohesive-ui-screens/chromium-1280-compare.png) · [采用](cohesive-ui-screens/chromium-320-adopt.png) |
| 资料列表与长标题原文 | [列表](cohesive-ui-screens/chromium-1280-sources.png) · [详情](cohesive-ui-screens/webkit-320-source-long.png) |
| 日记、设置及旧页 | [日记](cohesive-ui-screens/chromium-1280-diary.png) · [设置](cohesive-ui-screens/webkit-320-settings.png) · [章节编排](cohesive-ui-screens/webkit-320-chapter-arrange.png) |

完整浏览器 **247/247**；完整文稿专项 **186/186**，最终采用标签调整后定向 **15/15**；后端 **130 通过、1 原配置跳过**。类型、构建、架构核对通过。全站两引擎四宽度 432 页面采集为 **431/432**，一次 Chromium 768px 旧 `/requirements` 加载失败未稳定复现，同构建 12 轮旧别名序列 **48/48**；保留这个未确诊风险，不记为一次全绿。动态流程 **6/6**，36 张状态图、2 段视频。来源与哈希见 [截图清单](cohesive-ui-screens/manifest.json)。真机 iOS/WKWebView 和真实模型/私聊本轮未测。

发布后实际服务完成六组视口 **72 个检查项**。第二轮 68 项通过，四个手机“全部文稿”首屏按其资料库语义补测 **4/4**；原 67/72 和 68/72 脚本结果保留，不冒充一次完整全绿。检查脚本先前仅等待 networkidle，或错误要求所有入口都有正文标题；已改为等待业务页实际内容，并区分手机资料库首屏。最终各项无浏览器异常、HTTP 失败和横向溢出，原稿修订、依据焦点/滚动恢复、比稿返回及采用确认可用。主代理查看实际桌面旧稿和 WebKit 320px 设置图；真实作者内容截图只留本机。

运行镜像 `sha256:8000801d5b775fa185e9712e00129098a3780b6a4ad2803a940ec46bbdccb8ad`，OCI revision、运行源码、数据卷与原配置核对通过。26 个前端文件在本机测试构建、镜像、运行容器和 Hermes 包中逐文件一致。发布前后 59 张表、6,291 行与最终演练逐项一致；实际浏览器验收后其余 58 张表未变，原回执全保留，只新增与捕获请求逐项对应的 1,303 条读取回执。HTTP/Docker 健康，完整性与外键检查通过。回滚 dry-run 通过，目标为上一版 `9e73ab1`，未执行回滚。

本机证据根目录 `frontend/.artifacts/cohesive-ui/`：`delivery.json`、`browser-release.log`、`reader-release.log`、`final-pages-v3/manifest.json`、`legacy-route-probe/manifest.json`、`final-motion/manifest.json`、`metrics-comparison.json`、`frontend-delivery.json`、`live-data-audit.json`。发布预检目录 `artifacts/release-preflight-20261127/runs/2026-11-28T13-29-29-282Z-e00683f1/`。验证采用 screenshot-matrix 模式，`browserAcceptancePassed:false` 仅表示未选择 targeted-browser 模式；实际服务检查如上。

新 Hermes 包为 `frontend/.artifacts/cohesive-ui/package/sth-hermes-1.2.0-482e9af-win32-x64.zip`，1,933 个公开文件，Windows x64 / Node 24.15.0；SHA-256 `bb46c94fba9d5c22ee53c9aedfbbd77b8a2fed54685e537d0b1b9ebc291844c4`。分发单测 **16/16**，前端文件等价核对通过。隔离升级验收首次卡于宿主依赖下载，第二次 `pm repair` 超过 300 秒，均未进入插件安装；缓存预置重试结果另行补记，不能称作新包完整升级已通过。

## 2026-11-28 · 作者读写与候选稿审阅

本轮分支为 [`feat/author-reading-review`](https://github.com/lark-x/Sth/tree/feat/author-reading-review)，应用提交 [`9e73ab139c15f678985c732ce69e565acfb815b2`](https://github.com/lark-x/Sth/commit/9e73ab139c15f678985c732ce69e565acfb815b2) 已推送并部署到本机 <http://127.0.0.1:9322>。后续提交只补充交付记录，运行应用以该 SHA 为准。`main` 仍为 `ec1f1e4ba41f261419e70658a76b5e68868caada`。范围、所有权、独立审查、架构成本和失败轮次详见 [本轮记录](AUTHOR_READING_REVIEW.md)。

- 读稿保留正文完整标题，工具栏突出准确修订、采用与旧版身份；手机将场景路径收入版本菜单。
- 文稿列表按标题、真实原文摘要、单列版本信息组织，减少同一范围内重复的章节信息。
- 比稿在桌面收起中间文稿列表，平板默认给正文完整宽度；采用前展示候选版本、目标场景和原采用稿，长正文之前即可确认。
- 依据面板分别解释本版已确认记录、场景可用资料与准备下一稿；读取失败显示未知状态，不能误报没有依据。

| 已实现的界面 | 合成样例截图 |
| --- | --- |
| 桌面读稿与比稿 | [1280px 读稿](author-review-screens/chromium-1280-reader.png) · [双稿对照](author-review-screens/chromium-1280-compare-left.png) |
| 采用前确认 | [1280px 对象与动作](author-review-screens/chromium-1280-adopt.png) |
| 手机正文与列表 | [390px 读稿](author-review-screens/chromium-390-reader.png) · [文稿列表](author-review-screens/chromium-390-directory.png) |
| WebKit 320px | [版本菜单](author-review-screens/webkit-320-versions.png) · [已确认依据](author-review-screens/webkit-320-evidence.png) · [无关联记录](author-review-screens/webkit-320-evidence-empty.png) |

### 验证结果与边界

完整浏览器回归 **239/239**，最终候选文稿专项 **164/164**，均无跳过；类型检查与架构基线核对通过。六组 Chromium 1280/768/390/320、WebKit 390/320 共 **65 个页面状态**通过隔离库截图验收。主代理与独立审查席查看了最终画面；测试计数不替代视觉判断。[截图清单](author-review-screens/manifest.json) 保留来源与摘要，图片均为合成样例。

改造前后 12 个页面组合的 API 请求量相同；390px 旧稿正文起点由 185px 提前至 156px。构建由 639,331 增至 646,465 字节（+7,134，约 1.1%）。用时只有单次样本，有升有降，不宣称性能改善。业务源码摘要为 `432f2c3b846130309b4037709ece83e326eba7a60cfc0908bf1ca399881d694e`，构建摘要为 `47dcf8dd433b56afd1251ee51d8ee48591f72c99da3ba794ceb3f17da3e298c8`。公共操作、数据格式、迁移与依赖版本未改动。

前三轮文稿回归曾出现旧断言、空态加载同步以及偶发的导航加载／WebKit 按钮稳定性超时。旧断言和空态等待已修正；后两类现象仅在定向与最终完整回归中未再出现，未确认根因。保留失败日志和新增失败诊断，没有提高超时或删除、跳过用例。Windows snapshot 浏览器原生退出的记录也保留，未计入通过。真实 iOS/WKWebView、真人私聊和真实模型本轮未验收。两项低优先级视觉观察保留在本轮记录中。

### 部署与数据核对

- 运行镜像为 `sha256:6d58d8a62d02635b1eea4d57b153fb38b2742f46717d099ae1fc43e9c5c356f3`。OCI revision、运行源码、原配置与原数据卷均匹配，Docker 和 HTTP 健康；25 个前端文件在验收构建、发布镜像、运行容器及本轮 Hermes 包中逐文件一致。
- 发布前演练及发布后独立核验通过：59 张表、5,679 行与演练结果一致，完整性和外键正常。回滚 dry-run 通过，目标为上轮 `aeefc4cb1f2aa9c9641ef847c052afa58a028085`，没有执行回滚。
- 实际 9322 服务六组布局验收 **72/72**，覆盖首页、日记、全部文稿、角色、资料、任务、设置、旧稿准确修订、依据开关、比稿返回及采用确认页。没有点击真实稿件的最终采用动作；无控制台异常、HTTP 失败或横向溢出。主代理另查看实际桌面读稿／采用、手机比稿和 WebKit 320px 依据图。
- 浏览器验收后，其余 58 张表完全不变，原有回执全部保留，只新增与捕获请求逐项对应的 **540 条 `web:owner` 读取回执**；结构、内部序列、完整性及外键通过。真实作者内容截图保留本机忽略目录。

本机证据根目录为 `frontend/.artifacts/author-review/`：`final/browser-accepted.log`、`final/manuscript-release.log`、`final/release-execute.log`、`final/verify-release.log`、`final/rollback-dry.log`、`final/frontend-delivery.json`、`live-9e73ab1/report.json`、`final/live-data-audit.json`。预检及发布记录位于 `artifacts/release-preflight-20261127/runs/2026-11-28T08-25-07-578Z-355bb474/`。发布使用 screenshot-matrix 模式；独立核验中的 `browserAcceptancePassed: false` 仅表示未选择 targeted-browser 模式，`browserAcceptancePending: false`，部署后的实际 72 项验证如上。

### Hermes 分发包

本机已生成 `frontend/.artifacts/author-review/package/sth-hermes-1.2.0-ed01a63-win32-x64.zip`，86,781,935 字节，SHA-256 为 `c74aae6768f1380ddd42a6dae669d8837d71d07e3e06d5783e924e4e790b9bb9`。包基于最后业务修改 `ed01a63`；之后至部署提交的变化仅涉及测试及文档，25 个前端文件已与部署镜像逐字节核对一致。当前 ZIP 保存在本机，本轮没有上传或公开新的 GitHub Release。

通过已安装 Hermes 的隔离 profile 先安装 `2307e73` 旧包，再按 stop/install/start 流程升级至本包，确定性验收 **10/10**。1,930 个 manifest 文件和 25 项生产依赖验证通过，升级后的运行时与 HTTP 首页均匹配本包；工作区、连接、原资料版本与回执保留，新写入、重开、幂等重放及跨终端拒绝通过。该记录不是另跑新包的空 profile 安装，也不代表真实模型或真人私聊验收。证据为 `package/onboarding.stdout.log` 和 [安装说明](HERMES_SETUP.md)。

## 2026-11-28 · 统一导航与 UI 基础组件

这次补充迭代针对用户截图中的两套侧栏与视觉落差，分支为 `feat/unified-writing-ui`。全站保持一个资料库实例，读稿为三栏，首页／角色／资料／设置复用同一导航；手机辅助页使用临时资料库 pane。引入 Reka UI 的 Button／Dropdown 基础和 Lucide 图标，按 shadcn-vue 的源码持有方式定制现有灰白主题。原业务接口与版本化内容继续沿用。

| 实际界面 | 截图 |
| --- | --- |
| 桌面读稿、设置共用导航 | [1280px 三栏](unified-ui-screens/chromium-1280-reader.png) · [同一设置侧栏](unified-ui-screens/chromium-1280-settings.png) |
| 菜单及平板布局 | [新建菜单](unified-ui-screens/chromium-1280-create-menu.png) · [768px 读稿](unified-ui-screens/chromium-768-reader.png) |
| 手机首屏 | [390px 读稿](unified-ui-screens/chromium-390-reader.png) · [首页](unified-ui-screens/chromium-390-home.png) |
| WebKit 320px | [资料库](unified-ui-screens/webkit-320-navigation.png) · [正文](unified-ui-screens/webkit-320-reader.png) · [加载完成后的依据](unified-ui-screens/webkit-320-evidence.png) |

图片使用隔离的合成样本，未复制线上作者内容。六组 Chromium 1280/768/390/320、WebKit 390/320 共 40 个页面状态，均验证无横向溢出和浏览器异常，源码与服务构建保持一致。源码摘要 `f6dc468fff971acaa50d5129c4e4ff34c1295056a07b4de0f08ce747a38a7759`，构建摘要 `3581724c7028fefff317155957ab2cb11f8e80167bf1e98e63704f4aa430d800`；图片来源及各组状态见 [清单](unified-ui-screens/manifest.json)。真实 iPhone/WKWebView 验收仍延后。

新增统一导航回归覆盖同一 DOM 实例、作品展开、全局入口、准确选中项、手机关闭／同页点击／Esc、临时 pane 不增历史、辅助页不读文稿列表，以及跨页返回的原修订／选段／焦点／滚动。测试实际发现 WebKit 320px 在隐藏正文后丢失离页坐标，改为切栏前由 App 保存；修前失败日志和修后 4/4 分别保留在 `unified-navigation-main-2.log`、`unified-navigation-fixed.log`。菜单键盘回归 4/4、保存回执可见性定向回归 5/5、角色／首页／日记定向回归 29/29 已通过，均在本机 `frontend/.artifacts/unified-ui/`。

最终完整浏览器回归 **230/230**、文稿专项 **159/159**，均无跳过；构建与类型检查通过。最终日志为 `browser-final.log`、`manuscript-final.log`、`build-final.log`、`typecheck-final.log`。独立代码审查覆盖核心实现、阅读位置修复与测试变更，未发现阻塞；独立视觉审查最后核对 13 张窄屏图，确认资料入口发现性与依据加载完成后的展示问题已经关闭。没有通过增加超时、删除或跳过失败用例来通过本轮验证。

架构基线已更新并通过 `--check --skip-build`。公共接口、数据格式与迁移源码无变化，循环依赖和重复片段数量不变。未压缩构建由 533,421 增至 639,331 字节（+105,910，19.9%）；此为组件依赖成本，不作为性能改善。前后指标与边界见 [本轮治理对照](ULYSSES_EXECUTION.md#2026-11-28--统一工作区与-ui-组件补充迭代)。

### 本轮部署与 GitHub 交付

应用提交 [`aeefc4cb1f2aa9c9641ef847c052afa58a028085`](https://github.com/lark-x/Sth/commit/aeefc4cb1f2aa9c9641ef847c052afa58a028085) 已推送至 [`feat/unified-writing-ui`](https://github.com/lark-x/Sth/tree/feat/unified-writing-ui)，并部署到本机 <http://127.0.0.1:9322>。`main` 仍为 `ec1f1e4ba41f261419e70658a76b5e68868caada`。后续本分支提交只补充交付记录，部署身份以该应用 SHA 为准。

- 运行容器为 `sth-authoring-web-1`，镜像 `sha256:c4beffeb5792859045a5e77ff18abd6512cd0fa69f3cca995f0dd23a4981e93c`。冻结提交、OCI revision、运行源码、原服务配置和 `sth-authoring_workspace` 数据卷均核对通过；Docker 与 HTTP 健康。25 个前端文件与本机验收构建逐文件一致，提交后的应用源码摘要仍与截图清单相同。
- 发布前演练、发布后独立核对通过：59 张表、5,051 行逐项一致，没有新增迁移或表。回滚 dry-run 通过，旧镜像可用，未执行回滚。
- 实际服务六组 Chromium 1280/768/390/320、WebKit 390/320 验收 **60/60**，覆盖首页、日记、全部文稿、角色、资料、任务、设置、旧版稿件、依据开关和已有研究日记。无页面异常、HTTP 失败或横向溢出；依据关闭后恢复触发按钮焦点与原位置。主代理另查看实际桌面旧稿／设置与 WebKit 320px 依据截图。
- 浏览器验收后再次快照对照，其余 58 张表完全不变、原有回执全部保留，只新增与捕获请求逐项匹配的 360 条 `web:owner` 读取回执，完整性、外键与内部序列校验通过。真实作者内容截图保留在本机忽略目录，不上传 GitHub。

本机证据根目录为 `frontend/.artifacts/unified-ui/`：`preflight-aeefc4c.log`、`release-aeefc4c.log`、`verify-release-aeefc4c.log`、`rollback-dry-aeefc4c.log`、`committed-source-aeefc4c.json`、`deployed-frontend-aeefc4c.json`、`live-aeefc4c/report.json`、`live-data-audit-aeefc4c.json`。发布预检目录为 `artifacts/release-preflight-20261127/runs/2026-11-28T03-52-49-301Z-3e11a8d3/`。独立核验采用 screenshot-matrix 模式，报告中的 `browserAcceptancePassed: false` 表示未选择 targeted-browser 模式；其 `browserAcceptancePending: false`，实际部署后的 60 项结果如上。

## 2026-11-28 · Ulysses 方向整合验收

本轮在 `feat/ulysses-workspace` 完成灰白写作界面、真实文稿摘要、紧凑读稿工具栏、章内新建直接落笔、原句优先的依据，以及跨角色/资料多跳返回原稿原段。初轮整合应用代码为 `91be384`，最后独立视觉复核又修正了待确认回执重开时的按钮遮挡。最终应用提交 `2307e7351e63571d9873c39df3b96ca91a6592f2` 已部署到本机 9322，并用于生成本轮 Hermes ZIP；后续分支提交仅补充测试和验收文档。

| 体验 | 正式页面截图 |
| --- | --- |
| 资料库、章节文稿列表、当前正文 | [1280px 三栏](ulysses-screens/desktop-chapter.png) |
| 手机首屏读稿与依据 | [390px 读稿](ulysses-screens/phone-reading.png) · [原文与人物依据](ulysses-screens/phone-evidence.png) |
| 窄屏书库、旧版选段、日记 | [WebKit 320px 章节](ulysses-screens/webkit-320-chapter.png) · [旧版选段](ulysses-screens/webkit-320-passage.png) · [日记](ulysses-screens/webkit-320-diary.png) |
| 首页与辅助资料 | [390px 首页](ulysses-screens/phone-home.png) · [角色正文](ulysses-screens/phone-character.png) |
| 保存响应丢失后重开 | [390px 重试入口](ulysses-screens/phone-receipt-reopened.png) · [WebKit 320px](ulysses-screens/webkit-320-receipt-reopened.png) |
| 同一样本前后对照 | [旧首页](ulysses-screens/before-phone-home.png) / [新首页](ulysses-screens/phone-home.png)；[旧读稿](ulysses-screens/before-phone-reading.png) / [新读稿](ulysses-screens/after-phone-reading.png) |

以上为隔离样例；首页/角色与前后对照保留对应采样阶段，书库、读稿、依据、日记与回执图已由最后六组 `release-*` 图更新。每张图片的原路径、阶段、源码与构建摘要在 [截图清单](ulysses-screens/manifest.json)。完整六组为 Chromium 1280/768/390/320 与 WebKit 390/320，每组 20 个场景，合计 120/120、349 张图。采集构建摘要 `ef40fb75a0e561171a1f18fbf0f571ef76a35630bf5317c98e8cb1999d2e332d`，应用源码摘要 `5b6c11c751e817f9551c08462a6efdee00675cb72282a0efe98d7cedb969a034`；所有通过组的 `sourceStable`、`servedBuildStable` 均为 true。

改造整合完整浏览器回归 222/222；最终回执焦点修复后的文稿专项 159/159；核心 130 通过、1 条真实 ComfyUI 条件用例跳过；适配器 18 通过、3 条真实宿主启动/登录条件用例跳过。已安装 Hermes 的 CLI、合成 QQ/微信上下文及公共结果链接通过，不作为新一轮真人设备或真实模型验收。构建和类型检查通过。

完整浏览器回归过程中发现旧菜单入口和旧预览标题断言不再对应正式界面；更新为实际展开菜单、精确选择行/正文/版本后，经独立审查通过。书库异步摘要测试改为等待准确 preview href。原业务、API、安全与版本断言保留，未增加超时、删除或跳过失败用例。最终全套日志为本机 `frontend/.artifacts/ulysses-baseline/final-{browser,manuscript}-accepted.log`，严格标题补验为 `chapter-create-reviewed-final.log`（10/10）。最后回执修复的完整文稿日志为 `frontend/.artifacts/ulysses-release/manuscript-release.log`，六组新图保存在 `frontend/.artifacts/ulysses-baseline/release-*`。失败轮次也保留。

请求量、首屏位置、包体及本机布局位移的前后变化见 [治理对照](ULYSSES_EXECUTION.md#最终整合的收益与代价)。真实 iOS、WKWebView、真人私聊及大库慢设备性能仍属于后续范围。

### 最终部署、数据与分发核对

- 本机 `sth-authoring-web-1` 运行镜像 `sha256:938ddb159bf8f941ecc16851c97bb3c79ee96d13b18d5dc9710aaa7cb8c37ada`。OCI revision、运行源码、原配置、`sth-authoring_workspace` 数据卷和 25 个前端文件均与冻结候选匹配，Docker 与 HTTP 健康检查通过。发布前演练、发布后独立核对均通过：59 张表、4,560 行逐项一致，完整性与外键正常。回滚 dry-run 通过，未执行回滚。
- 部署后通过实际 9322 页面验收 60/60：Chromium 1280/768/390/320 与 WebKit 390/320，覆盖首页、日记、新建、角色、资料、任务、设置、旧稿、依据开关与已有研究日记。无横向溢出、控制台异常或 HTTP 失败；依据关闭后焦点和滚动恢复。主代理另查看实际桌面读稿、手机旧稿、手机依据与 320px 首页截图。真实作者内容只保存在本机忽略目录。
- 浏览器验收后的快照核对：其余 58 张表完全不变，原有回执全部保留；仅新增与捕获请求逐项对应的 300 条 `web:owner` 读取回执，没有作者内容或配置写入。结构、内部序列、完整性与外键继续通过。
- Xingchi GPT-6.1 Sol xhigh 独立复核最后修改涉及的 30 张隔离样例截图：六组各三张回执状态和编辑/冲突首屏，确认重试按钮及焦点框完整可见，没有剩余视觉阻塞。此前完整逐图审查与四种布局的修前失败证据继续保留。
- Hermes 最终 ZIP 为 `sth-hermes-1.2.0-2307e73-win32-x64.zip`，87,787,642 字节，SHA-256 `d8fe171aa7ec92e343bb23c5579c1508624412bee22f65ee7eb78b90827f7b24`。1,930 个文件、89 个冻结源码输入、生产依赖和截图构建均匹配；包内 25 个前端文件与实际部署镜像逐文件一致。已安装 Hermes 的隔离 profile 从旧 `ae25ac0` ZIP 升级后通过全部 10 项检查，保留资料、版本、连接及原回执，新写入和重启也通过。这是确定性宿主验收，未新增真实模型或真人设备结论。
- GitHub 已上传[未发布的 Windows x64 草稿](https://github.com/lark-x/Sth/releases/tag/untagged-44d41aa989d8bfea1fb6)，目标为上述完整应用 SHA；资产大小与服务端 SHA-256 均核对一致。[安装和升级说明](HERMES_SETUP.md)。`main` 保留 `ec1f1e4ba41f261419e70658a76b5e68868caada`，本轮交付在 `feat/ulysses-workspace`。

可复核的本机证据位于 `frontend/.artifacts/ulysses-release/`：`verify-release-2307e73.log`、`rollback-dry-2307e73.log`、`live-2307e73/report.json`、`live-data-audit-2307e73.json`、`package-equivalence-2307e73.json`、`deployed-package-frontend-2307e73.json`、`onboarding-2307e73.log` 与 `github-draft-2307e73.json`。发布预检根目录为 `artifacts/release-preflight-20261127/runs/2026-11-27T23-44-31-208Z-ce72a5cf/`。独立发布核验采用截图矩阵模式，其 `browserAcceptancePassed: false` 仅表示未运行该脚本的 targeted-browser 模式；`browserAcceptancePending: false`，实际矩阵和上线后 60 项结果分别如上。

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
