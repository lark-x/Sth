# Vue 写作页

`WritingRoute.vue` 使用 `url: URL`、`navigate(href)` 和 `refresh()` shell 合约。`routes.ts` 导出 `matchWritingRoute(url)` 和 `writingRoute(url)`。注册表将该 matcher 放在原 writing fallback 域前，组件模块指向 `./writing/WritingRoute.vue`，导航归属 `/create`。

交付的地址如下，均允许末尾单个斜线。

- `/scenes/:id`，含精确 `revision`
- `/scenes/:id?action=compare`，含 `left=draftId@revision`、`right=draftId@revision` 与可选场景 `revision`
- `/scenes/:id?action=branch`，含精确 `revision` 与可选 `draftId`、`draftRevision`
- `/drafts/new?sceneId=…&revision=…`
- `/drafts/:id`，含精确 `revision`、原文 UTF-16 `start`、`end`
- `/drafts/:id?action=revise`，修订当前稿件，保留其上下文版本
- `/drafts/:id?action=adopt&revision=…`，确认采用精确稿件版本

`/scenes`、`/scenes/new`、场景 `action=revise|adopt`、稿件 `action=adopt-entry`、带 `narrativeId` 的场景讲述别名、额外路径、重复 action 和其他未交付 action 均返回 matcher false。原 URL 完整交给现有 fallback。

场景页保留版本历史、引用角色和资料、章节作品、事件讲述、IF 接续、构图、修订场景以及角色反向证据入口。稿件页保留精确正文选区、角色采纳、提炼事件和准备写作。复杂表单在原路由继续工作。

候选稿保存、修订、IF 建立均保存编辑文字及原操作编号。未知写入结果通过原 receipt 恢复，再决定是否重放。采纳仅在确认页显式提交，冲突后重新读取当前场景，再次确认同一稿件版本。

验证入口为 `node --test frontend/tests/writing-vue.test.mjs`。专属测试通过临时 Vite 注册表注入运行真实 shell，业务服务与数据库隔离，无需改共享注册表或构建发布目录。
