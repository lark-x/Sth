# 作品创作入口

`ProjectRoute.vue` 和 `WorkspaceRoute.vue` 均提供 default export，并遵守 `frontend/CONTRACT.md` 的 `url`、`navigate`、`refresh` 合约。

## Shell 注册

- `/projects`、`/projects/new`、`/projects/:projectId` 使用 `ProjectRoute.vue`，导航归属 `/create`。现有注册表的 projects 域已经指向该组件。
- `/workspace` 使用 `WorkspaceRoute.vue`，导航归属 `/create`。无 tab 或 `tab=projects` 打开作品阅读入口。`tab=continue`、`characters`、`sources`、`diaries` 打开已有内容。
- 精确路径 `/create` 使用 `WorkspaceRoute.vue`。无查询参数时打开作品创作入口，带旧版 `q` 或 `projectId` 参数时使用原有场景筛选语义，仍可搜索、切换作品和读取更多场景。
- `/scenes`、`/drafts`、`/chapters`、`/branches`、`/events`、`/narratives`、`/templates`、`/writing-requirements`、`/generation-plans` 以及它们的参数、编辑和版本地址，继续走各自业务组件或现有 legacy fallback。此模块提供到这些业务页的准确链接。

`/workspace?tab=projects&projectId=…` 可定位作品。`/projects/:projectId` 是新作品阅读地址。列表默认读取第一部已存作品的实际内容。未知作品编号会显示错误。

从已有内容接续使用 `/workspace?tab=continue&from=character|source|diary&characterId|sourceId|noteId=…&revision=…`。资料可附带 UTF-16 半开区间 `start`、`end`，必须是指定版本中的有效原文位置。

## 业务操作

作品创建只提交 `project.create({ title })`。角色和资料可以明确保存为独立场景，使用 `scene.create` 固定角色版本或资料版本与原文位置，之后从场景页安排进章节。日记接续打开指定版本正文及其引用，并提供当前版本编辑入口。选择内容、切换作品、展开讲法、重新读取都只做读取。

新建作品和场景的未完成提交保留同一个 stepId。丢失响应或刷新页面后，重试先查 `/api/web/receipt`，未找到回执才重发原请求。名称草稿保存在当前标签页 sessionStorage 中。

候选稿对照、讲述、IF、角色和资料链接保留各自要求的版本参数。场景正文显示当前场景采用的准确稿件版本，而非候选稿的最新版本。工具区保留场景、章节、IF、事件、模板、要求、方案和准备写作入口。

作品标题下的内容导航提供“创作决定”，直接进入 `/author-context?projectId=当前作品编号`。

## 独立验证

执行 `node --test tests/browser/creative-entry.test.mjs`。测试在隔离内存数据库上启动真实业务 API，通过专用 Vite middleware 宿主挂载组件并验证 shell 合约，不写共享注册表或 frontend/dist。另有一项测试从当前 `frontend/main.ts` 和共享注册表进入，验证完整 shell 中的桌面、窄屏和创建作品。页面截图按 `STH_BROWSER_ARTIFACTS=1` 开启。
