# 全站界面重设计基线

基线固定在 `feat/cohesive-writing-ui` 起点提交 `5a7fff4fd4e53a922e02983504fa4c994a7626e8`。隔离 worktree 位于 `C:\Users\12938\AppData\Local\Temp\sth-ui-baseline-5a7fff4`，使用 Node 24.15.0、npm 11.12.1。依赖通过 junction 读取主仓现有安装。tracked 源码与测试均未在本基线副本修改。`npm run test:manuscript` 按正常入口构建了基线副本的 `frontend/dist`。主仓的 `frontend/dist` 未动。日志、截图和测量结果写在忽略目录 `frontend/.artifacts/cohesive-ui/baseline/`。

主代理随后开始的控件与 Frame 动效改动仍留在共享工作树，没有进入这个固定基线。基线副本应保留至改造版完成同脚本对比。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 检查 | 通过 | `typecheck.log` |
| 文稿专项 | 162 通过、2 失败、0 跳过，共 164 项，357.3 秒 | `test-manuscript.log` |
| 页面截图采集 | 42/42 通过，六组视口，177 张图，零异常 | `screens/head-5a7fff4/manifest.json` |
| 性能测量 | complete，3 samples，36 次测量，零错误 | `metrics-samples3/metrics.json`、`measure-authoring-samples3.log` |
| 架构静态核对 | stale，只有 `frontend/tests/shell.test.mjs` 一项旧快照差异 | `architecture-check.json` |

文稿专项失败来自同一 1280px 子例及其父测试。在作品章节分组中，从作品总览使用浏览器返回读稿后，`library-panels.test.mjs:748` 检查侧栏时应有两个条目，实际为零。测试标题为“1280px management remains available with manuscripts and every group survives both return paths”。失败位于从作品总览返回稿件之后的分组恢复断言。子例和父例在 Node 汇总中各计一项。该失败留作后续对比基线。

测试开始前和结束后 worktree 都位于提交 `5a7fff4fd4e53a922e02983504fa4c994a7626e8`，`git diff HEAD` 为空。截图 manifest 的 `sourceStable`、`servedBuildStable` 均为 true，源码摘要为 `432f2c3b846130309b4037709ece83e326eba7a60cfc0908bf1ca399881d694e`，bundle 摘要为 `47dcf8dd433b56afd1251ee51d8ee48591f72c99da3ba794ceb3f17da3e298c8`。架构快照输入摘要从 `1321c7da9424e0e0b055c709d611fad44c2ea9b08bb9c41ba455eca5e94d9c05` 到 `4462a09d4f591eb9142720e28e0d1145424838430280d6fdb8c7aff451977f93`。差异只有 shell 测试文件，公共操作、资源路径、数据库和登记库指纹及运行时循环均无变化。没有重建或覆写架构快照。

## 页面与截图来源

六组视口为 Chromium 1280×800、768×1024、390×844、320×640 和 WebKit 390×844、320×640。隔离 `snapshot` 采集了作品目录、读稿、比稿、采用、依据、编辑和日记，共 42 个场景、177 张图。结果位于 `screens/head-5a7fff4/`。其后只运行指定的三样本性能测量，没有再运行全站截图或测试套件。

已复核 `docs/author-review-screens/manifest.json` 中 12 张公开截图副本，12 张均存在且 SHA-256 与清单一致。其源码摘要和 bundle 摘要分别为 `432f2c3b846130309b4037709ece83e326eba7a60cfc0908bf1ca399881d694e` 与 `47dcf8dd433b56afd1251ee51d8ee48591f72c99da3ba794ceb3f17da3e298c8`，与本次基线采集完全一致，因此记为复用图。清单指向的忽略目录 `frontend/.artifacts/author-review` 不在隔离基线副本中，主仓的该目录仍存在且未改动。来源与采样时间以公开截图清单为准，清单没有记录其 Git 提交。

路由覆盖表依据 `0bca2c2` 引入的 `scripts/capture-cohesive-ui.mjs` fixture 页面入口，并结合 `frontend/routes.ts`、域 matcher、`web/assets/workspace-model.js` 和 `web/assets/app.js` 判定实际承接方。该全站脚本没有在本基线执行。它的 `--only all` 包含章节、分支、模板、配置、资料、生成任务、媒体和旧别名等真实页面。主代理可用它统一进行后续全站采样。本基线运行的是 `capture-manuscript.mjs` 的七类代表页面，不把未采样的全站路由算作通过证据。

## 路由与入口覆盖

以下动态标识来自 `scripts/capture-cohesive-ui.mjs` 的隔离 fixture，具体记录 ID 每次生成。Vue 归属按 `frontend/routes.ts` 及各域 matcher 判断，legacy 归属按 shell 未命中 matcher 后交给 `web/assets/app.js` 的 `mountLegacyRoute` 判断。新全站采集脚本尚未运行，故本表记录路由归属和 fixture 入口，不表示各行都已截图或行为验收。

| 页面域 | fixture 提供的实际入口 | 当前路由归属 | 旧页面承接与别名 |
| --- | --- | --- | --- |
| 首页与日记 | `/`、`/diaries`、`/diaries/<noteId>`、`/diaries/new`、`/?projectId=<projectId>`、`/diaries/<noteId>?edit=1` | 首页、日记由 Vue 承接，`/diaries/new` 使用日记编辑器的新建状态，项目日记由日记列表处理 | `web/assets/app.js` 保留首页及旧日记实现 |
| 作品与工作区 | `/projects`、`/projects/<projectId>`、`/projects/new`、`/projects/<projectId>?view=overview`、`/create`、`/workspace?tab=continue` | Vue `ProjectRoute` 与 `WorkspaceRoute` | 不认识的深层路径如 `/create/unknown`、`/workspace/unknown` 回到旧 shell 的 404 页面 |
| 稿件阅读与修订 | fixture 的 `oldPassage`、`scene`，`/drafts/<draftId>?action=revise&revision=1`、`/drafts/<draftId>?action=adopt&revision=1`、`/scenes/<sceneId>?action=compare`、`/scenes/<sceneId>?action=branch` | Vue WritingRoute，保留 revision、选段与返回参数 | 未实现动作及别名保留旧页，见下方具体路径 |
| 角色与资料 | `/characters?projectId=<projectId>`、fixture 的角色详情、`/characters/new?projectId=<projectId>`、`/sources?projectId=<projectId>`、fixture 的资料详情、`/sources/new?projectId=<projectId>`、`/sources/<sourceId>?action=revise`、长标题资料详情 | Vue CharactersRoute 与 SourcesRoute | `/characters/<id>/history`、`/characters/<id>?action=unknown`、`/sources/<id>/unknown`、`/sources?action=unsupported` 由 legacy 承接 |
| 设置与上下文 | `/settings`、`/settings/connections`、fixture 的 `/author-context` 决定及准备页 | Vue ConnectionsRoute 与 ContextRoute | `/settings/unknown`、`/settings/connections/nested`、`/author-context/nested` 由 legacy 404 承接 |
| 章节与场景编排 | `/chapters?projectId=<projectId>`、`/chapters/<chapterId>`、`/chapters/<chapterId>?action=arrange`、`/chapters/new?projectId=<projectId>`、`/scenes/new?projectId=<projectId>&chapterId=<chapterId>` | LegacyRoute → `mountLegacyRoute` 的 chapters/scenes workspace operations | 当前章节详情、新建、排列和场景创建均仍走 `web/assets/app.js` |
| 候选稿列表与分支 | `/drafts?sceneId=<sceneId>`、`/branches?projectId=<projectId>`、fixture 的 branch detail | LegacyRoute → drafts/branches workspace operations | `/candidates` 是 drafts 的旧别名；`/scenes/<id>?narrativeId=<id>`、`/scenes/<id>?action=revise`、`/scenes/<id>?action=adopt`、`/drafts/<id>?action=adopt-entry`、`/scenes/<id>/unknown` 继续走旧页 |
| 研究与判断 | `/research`、`/judgments?projectId=<projectId>` | LegacyRoute → research/judgments 页面 | `/sources` 是 Vue 归档资料，`/research` 与 `/judgments` 仍是旧操作页 |
| 写作配置 | `/events?projectId=<projectId>`、`/narratives?projectId=<projectId>`、`/templates`、`/templates/new`、`/writing-requirements`、`/writing-requirements/new`、`/generation-plans`、`/generation-plans/new` | LegacyRoute → 对应 workspace operations | `/requirements`、`/plans` 分别别名到 writing-requirements、generation-plans |
| 生成、任务与媒体 | `/generations?projectId=<projectId>`、fixture 的 `/generations/<generationId>/prompt`、`/generations/<generationId>/result`、`/generation-batches`、`/compositions`、`/media`、`/jobs` | generation、batch、composition、`/media` 无 ID 入口仍走 legacy。`/jobs` 与 `/tasks` 列表由 Vue TasksRoute 承接 | `/records` 是 generations 旧别名，`/jobs/new` 与 `/media` 继续旧页；实际任务 `/jobs/<jobId>` 及媒体详情 `/media/<mediaId>` 与列表入口不同 |

shell 浏览器测试另外直接覆盖了 `/create`、`/projects`、`/workspace`、`/settings`、`/settings/connections`、`/author-context`、`/sources`、`/sources/new`、`/research`、`/judgments`、`/sources/id/unknown`、`/sources?action=unsupported`、`/characters`、`/characters/new`、`/jobs`、`/tasks`、`/characters/id/history`、`/characters/id?action=unknown`、`/jobs/new`、`/media`、`/generations`、`/drafts/new`、`/scenes/id?revision=1`、`/scenes/id?action=compare`、`/scenes/id?action=branch`、`/drafts/id?action=revise`、`/drafts/id?action=adopt`、`/scenes/id?narrativeId=story`、`/scenes/id?action=revise`、`/scenes/id?action=adopt`、`/drafts/id?action=adopt-entry`、`/scenes/id/unknown`，以及前述五个未知嵌套路由。示例中的 `id` 是测试占位值，fixture 页面使用真实生成 ID。

旧入口路由别名取自 `web/assets/workspace-model.js`。`/candidates` 指向 drafts，`/requirements` 指向 writing-requirements，`/plans` 指向 generation-plans，`/records` 指向 generations，`/tasks` 指向 jobs。`/tasks` 列表当前已由 Vue matcher 接管，其他四个别名仍由 legacy shell 渲染。不要把业务名推测成 URL，以上入口均可在测试或全站截图 fixture 中找到来源。

## 性能基线

使用 `node scripts/measure-authoring.mjs --samples 3 --out frontend/.artifacts/cohesive-ui/baseline/metrics-samples3`。Chromium `151.0.7922.34`，六条入口分别在 1280×800 与 390×844 各测三次，共 36 次。每次使用新 context、同一隔离 fixture、无节流，等待目标内容、字体和 500ms 请求静默窗。该指标描述本机样例，不代表真实用户 Web Vitals。首个样本的 12 张截图由测量脚本同时生成，未另行补拍。

| 路径 | 视口 | 平均 ready ms | 平均 API 数 | 平均响应字节 | 目标距顶 px |
| --- | ---: | ---: | ---: | ---: | ---: |
| 首页 | 1280 | 171 | 4 | 109,924 | 205 |
| 首页 | 390 | 145 | 4 | 109,924 | 172 |
| 作品 | 1280 | 333 | 18 | 156,545 | 157 |
| 作品 | 390 | 203 | 9 | 108,234 | 234 |
| 旧稿 | 1280 | 206 | 13 | 156,613 | 157 |
| 旧稿 | 390 | 174 | 13 | 156,613 | 156 |
| 角色 | 1280 | 221 | 6 | 590,864 | 196 |
| 角色 | 390 | 157 | 6 | 590,864 | 186 |
| 资料 | 1280 | 212 | 9 | 602,109 | 197 |
| 资料 | 390 | 192 | 9 | 602,111 | 187 |
| 日记 | 1280 | 175 | 7 | 598,839 | 213 |
| 日记 | 390 | 146 | 7 | 598,842 | 181 |

响应字节为每个样本观测值的均值，保留小数后的结果在 `metrics.json`。后续前后对比应复用同一台机器、命令、浏览器和 fixture 方法，并报告三样本变化，不据此单独宣称性能改善。

## 后续对比约定

- 保留本 worktree 和 `frontend/.artifacts/cohesive-ui/baseline/`，直到最终版完成同脚本对比。
- 主代理使用共享工作树中的 `scripts/capture-cohesive-ui.mjs` 统一采集真实路由。其全量路由画面与交互自动化结果分别记录。
- 最终性能复用 `measure-authoring.mjs --samples 3`，比较 12 组路径与视口及完整 bundle 摘要。
- 基线已有两项重复计数失败，前后都列出原始总数与具体断点。只有最终版实际通过后才更新结论。
