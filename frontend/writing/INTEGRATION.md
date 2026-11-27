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

## 稿内读写

`DraftPage` 和 `ScenePage` 优先显示正文。`ManuscriptTools` 提供单行粘性工具栏，始终显示可截断的当前稿名，编辑时可从工具栏保存。首位直接使用 `../manuscript/ManuscriptViewControls.vue`，由 Frame 注入专注、资料库和返回文稿列表操作。组件在 Frame 外自动为空，原返回地址保留在“更多”首项。写作域无需 Teleport 目标或全局返回事件。

原位编辑复用 `DraftEditor`、既有写入操作和 receipt 恢复。切换阅读、离开、刷新时保留本标签页的文字、编辑状态和光标。当前稿与精确版本分别使用恢复键，打开旧版不会覆盖当前稿的本地文字。并发更新或旧版底稿要求作者读取最新版本并明确确认继续修订。保存候选稿不改变场景采用关系。

`ManuscriptBody` 保留原始 UTF-16 文字及选区。`reading.ts` 使用 `localStorage` 按稿件和版本持久记录可见字符与屏幕位置，关闭标签后新开页面可继续阅读。首次进入时显式 `start/end` 或锚点优先。从上下文返回仍定位原选段。Frame 的视图变化恢复当前阅读位置，读者离开原选段后收栏不会跳回深链开头。草稿缓冲、编辑状态和待确认写入继续使用 `state.ts` 的标签页会话存储。`rememberManuscript` 只用于最近文稿记录，阅读位置由写作域保存。

`ManuscriptEvidence` 直接接收固定版本的 `scene` 和 `draft`，自带展开开关。场景已采用稿使用该稿固定的 `sceneRevision` 作为依据上下文。原有上下文、角色证据、候选稿和版本历史留在辅助折叠区。

稿件与场景工具栏的“来源与依据”按钮从按钮元素自身派发 `new CustomEvent('sth:open-evidence', { bubbles: true })`，由所属 main 监听并打开正式依据面板。事件的 `target` 始终为可聚焦按钮，面板关闭时可据此返回焦点。工具栏在同一 main 监听 `sth:evidence-state`，依据 `{ open, panelId }` 同步按钮的 `aria-expanded` 和 `aria-controls`，卸载时移除监听。触发保留当前 URL、版本与选段，旧版来源按当前固定版本读取。

宽屏比稿为对应段落保留等高行，展开单侧操作后重新对齐。手机仅显示所选一稿，以当前段落和屏幕位置切换左右稿。恢复记录绑定已提交的比较版本，选择框中尚未开始比较的选项不会改变记录归属。

稿件原文保留 `#passage-body`，URL 的精确 `revision/start/end` 对应原文内的原生 `<mark>`。角色证据返回稿件的历史选区链接继续沿此 DOM 契约验证。

候选稿保存、修订、IF 建立均保存编辑文字及原操作编号。未知写入结果通过原 receipt 恢复，再决定是否重放。采纳仅在确认页显式提交，冲突后重新读取当前场景，再次确认同一稿件版本。

## 验证

原有写作功能使用 `node --test frontend/tests/writing-vue.test.mjs` 验证。稿内读写使用 `node --experimental-transform-types --test frontend/writing/manuscript.test.mjs`，类型检查使用 `npx vue-tsc --noEmit -p frontend/tsconfig.json`。

稿内测试复用 `scripts/manuscript-fixture.mjs`，运行真实 shell 和隔离数据库，覆盖 320、390、768、1440px 选段首屏、返回上下文、Frame 切换、草稿恢复、并发与旧版保护、回执恢复、采用和 IF、宽屏比稿与手机同段切换。截图写入忽略目录 `frontend/.artifacts/writing-reader/`。测试不写共享注册表或构建发布目录。

WebKit 横向布局回归使用 `node --test frontend/writing/webkit-layout.test.mjs`，构建隔离快照并启动真实 WebKit，在 320、390px 下检查场景、历史稿、比稿和原位编辑。测试记录 `getBoundingClientRect()`、父级滚动宽度和实际横向滚动，覆盖切稿、切版本、手机左右稿、未保存文字恢复、详情展开和更多菜单。32 张截图及测量报告写入 `frontend/.artifacts/writing-reader/webkit-layout-final/manifest.json`，可通过 `STH_WRITING_WEBKIT_ARTIFACTS` 指定输出目录。

持久阅读回归使用 `node --test frontend/writing/reading-browser.test.mjs`，在 Chromium 和 WebKit 关闭标签后创建新页面，从“最近写过”打开稿件或场景。测试覆盖不同稿件与版本隔离、显式选段优先、草稿会话隔离，以及损坏或不可用的持久存储。截图写入 `frontend/.artifacts/writing-reader/reading-persistence/`。
