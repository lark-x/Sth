# 前端集成契约

## 日记路由

shell 对 `/diaries` 和 `/diaries/*` 加载 `frontend/diary/DiaryRoute.vue` 的 default export。

```ts
defineProps<{ url: URL }>()
defineEmits<{
  navigate: [href: string]
  refresh: []
}>()
```

`url` 是当前完整地址，保留 `revision`、`edit`、`projectId`、`characterId` 等参数。组件使用事件导航，不需要安装 router。shell 处理同源历史记录、前进后退、主导航状态与路由切换后的焦点。组件应监听 `url.href`，处理同一组件上的参数变化。

`navigate(href)` 接受同源相对或绝对地址。`refresh()` 重新加载当前路由内容，并使首页数据在返回时重新读取。组件卸载时应取消正在进行的读取。

日记组件尚未存在时，shell 使用现有日记页面。`/diaries` 对应原日记列表，原有 `/?projectId=…` 进入项目日记列表。日记内部链接无需改写。

## 业务域迁移

`frontend/routes.ts` 是 shell 的唯一迁移注册表。每个域可以声明组件模块、地址匹配与导航归属。未迁入的域通过 `web/assets/app.js` 导出的 `mountLegacyRoute` 渲染原页面，继续使用原 API、表单和完整地址。

- 精确 `/create`、`/workspace` 使用 `workspace/WorkspaceRoute.vue`，`/projects` 及其子路由使用 `workspace/ProjectRoute.vue`。
- 精确 `/settings`、`/settings/connections` 使用 `connections/ConnectionsRoute.vue`。其他 settings 地址使用原页面回退。
- 精确 `/author-context` 使用 `context/ContextRoute.vue`，主导航归属创作。
- 资料域使用 `sources/routes.ts` 的 `matchSourcesRoute` 精确匹配后加载 `sources/SourcesRoute.vue`。不匹配的资料地址以及 `/research`、`/judgments` 继续使用原页面。
- 角色域使用 `characters/routes.ts` 的 `matchCharactersRoute`，加载 `characters/CharacterRoute.vue`，导航归属 `/characters`。
- 任务域使用 `tasks/routes.ts` 的 `matchTasksRoute`，加载 `tasks/TasksRoute.vue`，导航归属 `/jobs`。未匹配的任务编辑、生成和媒体地址继续使用原页面。
- 长篇写作域使用 `writing/routes.ts` 的 `matchWritingRoute`，加载 `writing/WritingRoute.vue`，导航归属 `/create`。普通场景版本进入 Vue，带 `narrativeId` 的场景别名及未交付的 action、深路径继续使用原页面。
- 这些模块使用与日记相同的 `url`、`navigate`、`refresh` 契约。模块尚未交付时采用原页面回退。

## 样式与 API

全局 shell 样式位于 `frontend/styles.css`，保留 `/assets/notebook.css` 供原页面使用。域组件应使用 scoped 样式或独立命名空间。共享的业务请求可继续从 `/assets/api.js` 导入，也可使用 `frontend/api.ts` 的类型化请求工具。

## 运行

`npm ci` 安装依赖。`npm start` 先构建 Vue，再启动现有服务。`npm run dev` 启动 Vite 开发服务，默认代理到 `http://127.0.0.1:9321`，可通过 `STH_DEV_API_ORIGIN` 指定隔离后端。`npm run build` 输出到 `frontend/dist/`。

`npm pack` 的 `prepack` 构建网页，包内带 `frontend/dist/` 和启动检查脚本。源码安装的 `npm start` 会重新构建，分发包的 `npm start` 使用随包构建产物。`sth-workspace` 与 `npm run workspace -- …` 指向同一生命周期入口。Hermes 插件及其打包脚本、MCP 适配器和安装命令依赖的文件都在发布白名单内，适配器依赖由 `npm --prefix adapters ci` 单独安装。

安装到 `node_modules/sth` 时，`npm start` 预载 `frontend/node-runtime.mjs`。它只为本包 `src/` 注册 Node 的类型擦除加载钩子，支持直接运行随包 TypeScript。工作区守护进程在导入后端前也需加载该入口，确保 `sth-workspace` bin 的安装版可用。
