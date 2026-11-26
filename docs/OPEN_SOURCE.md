# Sth 开源参考与依赖

核对日期为 2026-11-24。下文的标签固定了本次阅读的上游材料。MCP SDK 的版本与 Sth 锁文件一致，ComfyUI 的实际运行版本由配置的服务实例决定。六个项目中，Sth 的 MCP 适配器直接安装 TypeScript SDK，媒体工作进程按配置调用独立的 ComfyUI 服务。资料、场景、模板和任务的业务状态由 Sth 的 TypeScript 与 SQLite 实现。

## Logseq

`logseq/logseq` 的 `0.10.15` 标签提供按块查看反向链接的设计参考。Sth 用明确的资料 ID、修订号和原文片段记录引用，资料详情可从同一份记录查到具体日记或场景修订。原文查找与引用由本地 SQLite 承载，成本主要是索引、存储和备份。将来若接入 Logseq，同步适配器需处理块 ID 与 Sth 资料版本的映射。该标签采用 AGPL-3.0。若未来采用并修改 AGPL 程序并让用户经网络与之交互，须按第 13 节向这些用户提供对应源码的获取方式。 [上游仓库](https://github.com/logseq/logseq) · [上游反向链接组件](https://github.com/logseq/logseq/blob/03bcefbdf87458f87499abb988ac3b9fac2c07d8/src/main/frontend/components/reference.cljs) · [上游许可证](https://github.com/logseq/logseq/blob/03bcefbdf87458f87499abb988ac3b9fac2c07d8/LICENSE.md) · [Sth 引用存储](../src/sources/pins.ts) · [Sth 反向引用操作](../src/sources/index.ts)

## ink

`inkle/ink` 的 `v1.2.1` 标签以 knots、diverts 和分流示例提供叙事结构参考。Sth 的候选稿保留各自的修订历史，采纳指向确切稿件版本，IF 另存分歧和来源版本。这个流程只需 Sth 的现有服务和数据库。若未来要运行互动叙事，可从场景导出到 ink，并在导出层映射分支、选择与变量，Sth 仍保存作者选稿和引用。ink 为 MIT 许可，分发其软件副本或实质部分时须附版权许可声明。 [上游仓库](https://github.com/inkle/ink) · [上游写作指南](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/Documentation/WritingWithInk.md#5-branching-the-flow) · [上游运行时](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/ink-engine-runtime/Story.cs) · [上游许可证](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/LICENSE.txt) · [Sth 场景与稿件](../src/story/schema.ts)

## Langfuse

`langfuse/langfuse` 的 `v4.84.0` 标签以 Prompt 版本模型提供版本追溯参考。Sth 独立维护内容模板、写作要求、命名方案及生成记录，当前对话组稿在本地保存，点名委托由配置的模型供应商执行。接入 Langfuse 可从既有记录导出追踪数据，需映射版本和执行标识，并选定记录字段。自托管会增加 Web、worker、PostgreSQL、Redis、ClickHouse、对象存储及维护成本，托管服务和模型调用分别按供应商条款计费。 [上游仓库](https://github.com/langfuse/langfuse) · [上游 Prompt 模型](https://github.com/langfuse/langfuse/blob/1e4f187b053cc3e701fcc39519f8140c26299730/packages/shared/prisma/schema.prisma#L994-L1015) · [上游部署配置](https://github.com/langfuse/langfuse/blob/1e4f187b053cc3e701fcc39519f8140c26299730/docker-compose.yml) · [Sth 组稿](../src/generation/composition.ts) · [Sth 生成存储](../src/generation/storage.ts)

该标签根许可证规定，`ee/`、`web/src/ee/`、`worker/src/ee/` 和 `packages/shared/src/server/ee/` 在目录存在时适用 `ee/LICENSE`。企业代码的使用须符合适用协议并持有有效 Enterprise 许可，许可证另允许无订阅地为开发和测试复制、修改。其余自有代码适用 MIT Expat，第三方组件保留各自许可证。 [上游根许可证](https://github.com/langfuse/langfuse/blob/1e4f187b053cc3e701fcc39519f8140c26299730/LICENSE) · [上游 Enterprise 许可证](https://github.com/langfuse/langfuse/blob/1e4f187b053cc3e701fcc39519f8140c26299730/ee/LICENSE)

## Temporal TypeScript SDK

`temporalio/sdk-typescript` 的 `v1.26.0` 标签展示了持久工作流如何调度外部 Activity。Sth 的 worker 从 SQLite 领取任务，在事务外调用提供方，再保存结果或待核对状态。现有单人部署承担本地 worker、数据库和备份成本。迁移到 Temporal 会增加 Temporal Server 或 Cloud、worker 部署及运行成本，还需映射未完成任务的状态、供应商请求标识和重试语义。供应商能否确认请求状态仍取决于其 API。该 SDK 为 MIT。 [上游仓库](https://github.com/temporalio/sdk-typescript) · [上游 Activity 调度](https://github.com/temporalio/sdk-typescript/blob/f649d56a70f7e7eae5a921897b3b229970cd0b27/packages/workflow/src/workflow.ts#L364) · [上游 Worker](https://github.com/temporalio/sdk-typescript/blob/f649d56a70f7e7eae5a921897b3b229970cd0b27/packages/worker/src/worker.ts#L471-L473) · [上游许可证](https://github.com/temporalio/sdk-typescript/blob/f649d56a70f7e7eae5a921897b3b229970cd0b27/LICENSE) · [Sth 任务 worker](../src/jobs/worker.ts)

## MCP TypeScript SDK

`modelcontextprotocol/typescript-sdk` 的 `1.30.0` 版是安装在 `adapters/` 的 MIT 运行依赖。Sth 使用 SDK 的 `Server`、`StdioServerTransport` 和工具调用及列表请求 schema。操作发现、业务校验、配对和持久回执由 Sth 提供。适配器作为 Node.js 进程通过 stdio 与客户端通信，部署包含该进程与 npm 依赖。更换 SDK 或实现时，需通过工具发现、调用、回执与配对的 stdio 回归。分发 SDK 副本时保留 MIT 版权许可声明，传递依赖按各自许可核对。 [上游仓库](https://github.com/modelcontextprotocol/typescript-sdk) · [上游 npm 元数据](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.30.0) · [上游 stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/server/stdio.ts) · [上游请求 schema](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/types.ts#L1430) · [上游许可证](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/LICENSE) · [Sth 锁文件](../adapters/package-lock.json) · [Sth stdio 适配器](../adapters/mcp/cli.mjs)

## ComfyUI

`Comfy-Org/ComfyUI` 的 `v0.46.2` 标签用于核对媒体 HTTP 协议。Sth 用 `fetch` 请求 `/prompt`，通过 `/queue` 与 `/history/{prompt_id}` 核对结果，再用 `/view` 读取图片。ComfyUI 的 Python、PyTorch、节点、模型、算力与存储由独立部署承担，Sth 保存工作流参数和下载的图片。更换提供方时，实现 `MediaProvider` 的提交与查询接口，并逐项验证请求关联、状态核对和输出下载。已有任务保留其原提供方记录。 [上游仓库](https://github.com/Comfy-Org/ComfyUI) · [上游 HTTP 路由](https://github.com/Comfy-Org/ComfyUI/blob/10cdd12609eb17e8a90f2a2dd811b1c82f6107e7/server.py) · [上游运行依赖](https://github.com/Comfy-Org/ComfyUI/blob/10cdd12609eb17e8a90f2a2dd811b1c82f6107e7/requirements.txt) · [Sth 媒体适配器](../src/jobs/provider.ts)

上游附 GPL 第 3 版文本，部分文件头明确授予第 3 版或之后版本。当前部署由 Sth 经 HTTP 调用独立实例。若分发 ComfyUI 或其改版，按相关许可证处理版权、许可文本和对应源码。自定义节点、工作流素材与模型权重可能来自不同作者，分别核对署名、商用和再分发条款。 [上游许可证](https://github.com/Comfy-Org/ComfyUI/blob/10cdd12609eb17e8a90f2a2dd811b1c82f6107e7/LICENSE) · [上游文件头示例](https://github.com/Comfy-Org/ComfyUI/blob/10cdd12609eb17e8a90f2a2dd811b1c82f6107e7/comfy/model_management.py#L1-L16)

## 第三方资料署名

录入第三方原文时，可在资料的 `origin` 字段保留作者或机构、标题、原始链接，以及可核实的许可和版本信息。日记或场景引用保存资料修订和所用片段，可据此回到当时的出处。向外发布内容时，按原材料条款携带相应署名及许可声明。 [Sth 资料字段](../src/sources/contracts.ts) · [Sth 原文与引用读取](../src/sources/index.ts)
