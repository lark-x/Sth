# Ulysses 界面迭代执行记录

本文件记录本轮实际执行和证据位置，产品范围及模型规则以 [WORKSPACE_ITERATION.md](WORKSPACE_ITERATION.md) 为准，视觉要求以 [DESIGN.md](../DESIGN.md) 为准。完成项必须对应实际提交或验收产物；未完成项明确保留。

## 基线与工作区

- 改造前业务代码为 `23b2aca186a95180e40d9f01dae0f6bfb0db14c3`。
- 本轮分支为 `feat/ulysses-workspace`，计划与执行约束提交为 `fd60fc2`。该提交只改文档。
- 2026-11-28 核对本机 `9322` 健康，容器 `sth-authoring-web-1` 镜像 revision 标签仍为 `23b2aca`。
- 测试使用临时工作区。架构分析、样稿和各实现任务使用独立 worktree；主代理负责集成。

## 当前任务与所有权

| 任务 | 模型 | 允许写入范围 | 依赖与接口影响 | 状态与验收 |
| --- | --- | --- | --- | --- |
| A0 架构基线 | ChatflowsAI GPT-6.2 Sol xhigh | `scripts/architecture-baseline.mjs`、`docs/ARCHITECTURE.md`、`docs/architecture-baseline.json` | 全量首次扫描；不改业务契约 | 进行中；可复现图、循环、重复、复杂度及接口指纹，并可检查过期与比较增量 |
| P1 可点击样稿 | Xingchi GPT-6.1 Sol xhigh | `docs/prototypes/ulysses-workspace*` | 已确认的灰白视觉；仅模拟数据，无正式业务写入 | 进行中；首页、读稿、角色与依据的四宽度截图和完整路径 |
| N1 返回原稿原段 | ChatflowsAI GPT-6.2 Sol xhigh | `frontend/App.vue`、新增 `frontend/navigation-state.ts` 与 `frontend/tests/navigation-state.test.mjs` | 先复现，基线记录完成再改正式代码；保持 URL 与 history 中既有状态 | 进行中；先记录旧版与选段返回失败，再验证浏览器 Back 和显式返回路径 |
| M0 布局与性能基线 | 当前主模型 | `scripts/measure-authoring.mjs`、本执行记录与忽略目录下证据 | 复用现有隔离 fixture；不新增产品依赖 | 采集工具已编写，待实际运行与独立审查 |

每个任务完成后由新上下文 Reviewer 检查实际差异及证据，主代理完成集成验证后才标记完成。

## 已取得的基线证据

当前日志位于本机忽略目录 `frontend/.artifacts/ulysses-baseline/`，这是可复现的本机运行产物，不是远程可访问附件。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 构建与类型 | 通过 | `build.log`、`typecheck.log` |
| 核心测试 | 130 通过，1 条需真实 ComfyUI 的用例跳过 | `core.log` |
| 通用浏览器测试 | 147 通过 | `browser.log` |
| 适配器测试 | 14 通过，7 条环境条件用例跳过 | `adapters.log` |
| 文稿专项 | 运行中 | `manuscript.log` |
| 改造前截图 | 首轮进程原生退出，完整性未确认；已有画面仅供具体项对照 | `screens.log`、`screens/` |

复现命令使用仓库现有的 `npm run build`、`npm run typecheck`、`node --test tests/*.test.ts`、`npm run test:browser`、`npm run test:manuscript`，以及在 `adapters` 目录运行 `npm test`。每次执行分别保存输出、退出码和时间；环境条件跳过不能计作真实外部集成通过。

页面基线用 `node scripts/measure-authoring.mjs --out frontend/.artifacts/ulysses-baseline/metrics` 采集固定样例的请求数、传输体积、首屏正文位置、实际字体和本机加载时间。计时记录本机样例性能，不作为线上真实用户指标。前后比较须使用同一机器、命令、浏览器和数据，不用单次波动声称提速。

## 已采纳的决策

- 当前模型与 Astra 讨论后，先完成全量基线再按受影响模块更新，治理范围由可复现问题决定。
- 主题先在首页、读稿、角色三页验证，共享变量和接口确定后再铺到其他页面。
- 章内创建独立验收创建成功、归章冲突和已输入正文并存的情况，重试应保留原场景、正文及他人最新章序。
- 历史选段直达与跨辅助页返回分别验证，证据跟随所读稿件修订；无关联时明确说明缺失。
- 列表真实摘要同时比较请求数，避免每个条目额外读取全文造成加载成本扩大。
- 修复者与复验者分开；未完成验证的变更不部署。

## 治理变更记录要求

每个正式结构调整在本节追加问题、范围、证据、收益、成本、风险、验收及前后结果。目前没有批准额外的架构改造。已有 API、持久化数据格式、安全策略和外部契约的变化必须另行论证，不能夹在视觉改造中。
