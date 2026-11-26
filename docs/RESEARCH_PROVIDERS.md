# 外部资料提供方

外部研究共用 Sth 的操作目录、回执和版本化资料库。搜索和读取提交持久任务，由后台 worker 在 SQLite 事务提交后请求上游。任务状态、原文和游标都存入 SQLite，网页或助手可从新的会话继续读取。

## 服务接入

工作区已注册资料表和共享研究操作。Sth 启动时会升级格式 2 或 3 的数据库，并随服务启动外部检索 worker。归档链接使用 `/sources/:id?revision=…`。容器通过 Compose 环境变量读取提供方配置，重新创建容器时需传入同一组变量。[注册入口](../src/workspace.ts) · [服务入口](../src/main.ts)

默认启用中文维基百科。服务进程配置 Akasha 后，`external.providers` 会将 `akasha` 排在首位，省略 `provider` 的搜索默认走 Akasha。网页也可显式选择 `wikipedia-zh`。上游断线时可重试原任务，或显式选择另一提供方新建搜索。

| 服务进程环境变量 | 用途 |
| --- | --- |
| `STH_RESEARCH_AKASHA_URL` | Akasha MCP 的 Streamable HTTP 地址。配置后启用。与本机已有配置使用同一个服务时，取 `[mcp_servers.akasha]` 中的 `url`。 |
| `STH_RESEARCH_AKASHA_AUTHORIZATION` | 可选的完整 `Authorization` 值，有前缀时一并保留。只传给服务进程。 |
| `STH_RESEARCH_MEDIAWIKI_URL` | 默认 `https://zh.wikipedia.org/w/api.php`。可改为有 Search 和 TextExtracts 的 MediaWiki Action API，或设为 `off`。 |
| `STH_RESEARCH_MEDIAWIKI_ID` | 中文维基预设为 `wikipedia-zh`。自定义站点须使用独立 ID。切换到不同语料库时分配新 ID，站点间的 page ID 可重复。 |
| `STH_RESEARCH_MEDIAWIKI_LABEL` | 可选的网页显示名称。 |
| `STH_RESEARCH_MEDIAWIKI_USER_AGENT` | 可选的 User-Agent。默认 `SthResearch/0.1 (personal reference client)`。 |
| `STH_RESEARCH_MEDIAWIKI_LICENSE` | 可选的站点署名或许可说明。中文维基预设会保留文章链接、上游报告的修订号和许可提示。 |
| `NODE_USE_ENV_PROXY` | 环境依赖 HTTP 代理时，在 Node 24 上设为 `1` 以使用 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`。 |

Akasha 的服务端连接使用配置好的地址和鉴权。已有 Akasha 工具的助手可直接走 `external.import`，即使 Sth 服务没有配置相关 MCP。提供方配置由 Sth 服务环境读取。

## 操作契约

按现有网关传入 `{ operationId, stepId, input }`。表中列的是 `input` 与回执中的 `result`。相同写入请求重投时沿用 `stepId`，每次轮询用新的 `stepId` 读取状态，以便收到最新值。

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| `external.providers` | `{}` | `{ items: [{ provider, label, kind }], defaultProvider? }`。 |
| `external.search` | `{ provider?, query, limit?, cursor? }` | 持久任务摘要。`limit` 默认 10，最多 20。 |
| `external.read` | `{ provider, docId, cursor? }` | 持久任务摘要。`docId` 为字符串。 |
| `external.get` | `{ jobId, docId?, offset? }` | 任务摘要和已完成的 `result`。`offset` 与 `docId` 一起使用。 |
| `external.list` | `{ limit?, offset? }` | `{ items }`，按创建时间倒序。默认 20，最多 50。 |
| `external.retry` | `{ jobId }` | 以原 `jobId` 和输入重新排队。已排队或执行中的任务直接返回当前状态。 |
| `external.archive` | `{ jobId, docId, excerpt?, start?, end?, projectIds? }` | `{ provider, docId, sourceId, revision, href, title, projectIds, start?, end? }`。 |
| `external.import` | `{ provider, docId, title, body, origin, url?, upstreamRevision?, license?, projectIds? }` | 同一归档结果结构。 |

任务摘要包括 `jobId`、`provider`、`kind`、`status`、`attempts`、`createdAt`、`updatedAt`，以及适用的 `query`、`docId`、`cursor`。状态为 `queued`、`running`、`succeeded` 或 `failed`。失败包含 `error: { code, message, retryable }`，可据此呈现重试操作。服务异常终止后，查询和读取都是可安全重发的上游请求，租约到期后 worker 重新领取。正常关停时将正在进行的任务放回队列。

搜索结果为 `result.items`，每项至少含 `{ provider, docId, title, origin }`，可能含 `snippet`、`url`、`upstreamRevision`、`license`。用命中项的 `provider`、`docId` 发起读取。MediaWiki 的 `result.nextCursor` 用于同一提供方、同一搜索词的下一页。

读取结果为 `result.documents`，每项含相同身份和出处字段，以及 `body`、`offset`、`totalChars`、可选 `nextOffset`。MediaWiki 请求含章节标题的整篇纯文本提取，保留 Action API 返回的正文形态。Akasha 请求同一来源的游戏原文片段，每个片段保有自身 `chunkId`。原文需要更多 Akasha 上下文时，把 `result.nextCursor` 和**最初读取的** `docId` 一起传给 `external.read`。查看同一个已保存片段的更多字符时，把该片段自己的 `docId` 和 `nextOffset` 传给 `external.get`。正文每页最多 24,000 个 UTF-16 码元，分页不会切开代理对。

归档使用已保存的读取结果。可归档整篇或整片，也可以传唯一匹配的 `excerpt`。对于同一句出现多次的情况，传 `start` 和 `end` 确定位置，`end` 为排他边界，偏移从完整正文开始按 UTF-16 计。需要比对时同时传 `excerpt`。归档正文最多 100,000 个 UTF-16 码元，较长可选范围。返回的 `sourceId` 和 `revision` 可用于 `source.read`、来源引用和回链。

助手导入 Akasha 原文时使用 `provider: "akasha"`、十进制字符串 `docId: String(chunkId)`、`origin: cite` 和 `body: excerpt`，`title` 默认可使用 `cite`。直接导入由调用方提供原文及出处。归档以 `provider`、`docId` 和选段位置确定库内资料身份，重复提交相同的原文和出处会返回既有归档版本。原文或出处发生变化时生成同一资料的新版本。追加项目归属也会保留原版本。已有引文可继续用原来的版本号读回。

## 扩展与验证

新增提供方可实现 `ExternalProvider` 的 `search` 和 `read`，返回统一的文档身份、出处和正文。把同一组提供方传给 `createExternalOperations(providers)` 和 `startExternalWorker(db, { providers })`。使用稳定的提供方 ID，保持相同原文的文档 ID 一致，并将传入的 `AbortSignal` 传到上游请求和响应读取。

`node --test tests/external-research.test.ts` 使用本机 HTTP 服务测试 MediaWiki 请求、Akasha JSON/SSE、跨页原文、精确选段、导入去重、SQLite 重开和断线重试。真实上游验证时可分别用 `wikipedia-zh` 搜索 `故宫`、`akasha` 搜索 `温妮莎 蒙德`，从命中读取原文，归档选段后调用 `source.read` 比对原文和出处。
