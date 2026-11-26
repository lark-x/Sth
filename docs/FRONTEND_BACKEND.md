# 重做 Sth 前端时，从这里开始

本文面向实现下一版网页的开发者和 AI。网页负责导航、编辑草稿、选择和展示。作品归属、引用、选稿、版本冲突、回执和任务状态都由后端决定。一个已配对的助手可直接操作个人工作区，创建资料、场景或个人日记不要求选作品。

## 获得本次构建的契约

在仓库根目录使用 Node.js 24.15+ 安装依赖后执行以下命令。输出来自服务实际注册的 TypeBox 定义，不需要启动服务、配对或读取作者的数据。

```sh
node scripts/contract.ts
node scripts/contract.ts source
node scripts/contract.ts scene.adopt
node scripts/contract.ts generation.plans
node scripts/contract.ts --full
```

线上读取 `GET /api/web/catalog?view=index` 枚举操作，按 `?operationId=source.create` 或 `?prefix=source` 读取完整 `inputSchema` 和 `outputSchema`。无参数的网页目录返回全量定义。`resourcePaths` 声明允许展示的内部资源路径。`interaction` 是可选提示，包含日期字段和结果链接字段。完整目录通常只需在一个页面会话里加载一次。[操作注册](../src/workspace.ts) · [发现逻辑](../src/core/discovery.ts)

## HTTP 与凭据

| 用途 | 网页接口 | 规则 |
| --- | --- | --- |
| 健康与数据库版本 | `GET /api/health` | 返回 `name`、`status`、`schemaVersion`。 |
| 执行业务 | `POST /api/web/invoke` | JSON 对象 `{operationId, stepId, input}`；成功为 `{operationId, stepId, replayed, result}`。业务形状在 `result` 中。 |
| 查某次结果 | `POST /api/web/receipt` | `{operationId, stepId}`；成功返回原始结果和 `replayed: true`。查询的用户入口必须与原请求一致。 |
| 个人连接 | `GET /api/web/connections`、`POST /api/web/connections/code`、`POST /api/web/connections/{connectionId}/revoke` | 生成和撤销使用 JSON 对象 `{}`。一次性码供私聊或 MCP 领取；已领取的连接持续到撤销。 |
| 媒体供应商状态 | `GET /api/web/providers/media` | `unconfigured`、`invalid_config`、`unreachable`、`ready`。这是当前连通性；单个任务的状态从 `jobs.read` 读取。 |
| 图片原件 | `GET` 或 `HEAD /api/web/media/{mediaId}/content` | 图片详情的 `contentHref` 指向二进制端点；详情 `href` 是可分享的网页。响应含 MIME、长度和 SHA-256 ETag。 |
| 角色素材原件 | `GET` 或 `HEAD /api/web/assets/{assetId}/content` | 使用 `asset.import` 或 `asset.read` 返回的 `href`。支持单个 HTTP 字节区间以便拖动音频进度，返回 `206` 和 `Content-Range`；越界返回 `416`。与网页共用所有者认证。 |

网页使用同源请求，JSON 写入须带 `Content-Type: application/json`。独立前端开发服务器可代理 `/api` 到本机后端，并让代理把 Host 与 Origin 对齐到后端使用的地址。正式部署可把新网页和 `/api` 放在同一反向代理域名。配置 `STH_PUBLIC_ORIGIN` 后网页使用 Basic Auth，用户名是 `sth`。个人助手的 Bearer 凭据属于 Hermes/MCP；前端通过 `/api/web` 即可完成日常操作。[HTTP 入口](../src/server.ts) · [连接与助手传输协议](../adapters/README.md)

## 一次保存与一次网络重试

```js
// 在用户按下保存时创建一次，保留到本次提交有确定结果。
const write = {
  operationId: 'source.create', stepId: crypto.randomUUID(),
  input: { kind: 'setting', title: '北港渡船', body: '北港末班渡船是晚上十点。' },
};
async function post(path, body) {
  const response = await fetch(`/api/web/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message), { status: response.status, code: value.code ?? value.error });
  return value;
}
const saved = (await post('invoke', write)).result;
const pin = { sourceId: saved.sourceId, revision: saved.revision, excerpt: '末班渡船是晚上十点' };
await post('invoke', { operationId: 'diary.create', stepId: crypto.randomUUID(),
  input: { title: '末班船', body: '我赶上了十点的船。', diaryDate: '2026-11-24', sourcePins: [pin] } });
```

- 请求超时或页面恢复后，用原 `operationId` 和 `stepId` 调 `receipt`。如果回执尚未出现，允许用**完全相同的输入及步骤 ID**重送。相同 ID 改发其他内容会返回 `409 operation_step_conflict`。
- 每个新的保存动作、轮询、刷新、翻页各用新的步骤 ID。使用旧 ID 读任务会重放旧快照。跨 Hermes、MCP、网页接续时，用资源 ID 和版本号重新读；回执按连接隔离。
- 修订提交使用用户编辑时读到的 `expectedRevision` 或操作声明的专用版本字段。收到领域 `409` 时保留本地草稿，重新读取最新版本并让作者合并。表单校验可参考 JSON Schema，服务端仍校验项目、引用原文和版本等语义约束。
- `400` 显示输入问题，`401` 处理网页登录或助手连接，`403` 检查来源和配对，`404` 处理资源、版本或回执缺失，`409` 展示冲突，`413` 提示缩小请求。普通 JSON 请求最大 1 MiB；`asset.import` 允许最多 8 MiB 的原件经 base64 编码。外部供应商失败还可能是成功 HTTP 响应中的业务状态，任务详情应展示到每一项。

## 页面与业务动作

| 作者的动作 | 操作顺序与界面约定 |
| --- | --- |
| 新建个人资料、关联作品 | `source.create` → `source.search` → `source.read`。`projectIds` 可为空。`source.revise` 创建新版本；`source.history` 和 `source.backlinks` 用于溯源。引用提交 `{sourceId,revision,excerpt}`，其中摘录必须是该版原文。个人日记可直接 `diary.create`，历史读回可指定 `revision`。 |
| 聊到一个场景，比较后入章 | `scene.create` → `draft.create` 两次 → `draft.compare` → `scene.adopt` 固定选中稿的具体版本。`chapter.create` 和 `chapter.arrange` 管章节及顺序。采纳候选和把场景放进某章是独立动作，`chapter.arrange` 提交完整的有序 ID 列表。`scene.branch` 记录 IF 分歧点。 |
| 使用模板写作或显式委托 | `templates.*` 管内容结构，`writing.requirements.*` 管写作要求，`generation.plans.*` 管命名方案。`generations.prepare` 固定输入和版本；普通对话完成写作后用 `generations.save` 校验并保存结构化输出。用户点名方案时才 `generations.start`，然后 `generations.get` → `generations.result.get`。展示请求的模型、实际回报的模型及回报来源，缺失值显示「未知」。 |
| 批量写对照稿 | `generation.batches.create` 接收一组已准备的 generation ID 和明确选定的命名方案；通过 `generation.batches.get` 读进度及尝试历史，`.cancel` 停止余项，`.retry-confirmed-failures` 重试确认失败的项。原始输入、每次尝试和已完成结果都可追溯。 |
| 选择构图并出图 | 建好作品与场景归属后，`composition.create` 保存候选和场景版本，`composition.select` 使用 `expectedSelectionRevision`。`jobs.create` 接受选中的组合，返回 `jobId`；`jobs.read` 返回每项的场景、状态、尝试及媒体链接。`media.list` 查图库，`media.read` 查出处，再从 `contentHref` 读取图片。 |

媒体手动任务使用配置工作流参数，自主任务显式传 `mode: "autonomous"` 与 `maxImages`。`jobs.cancel` 停止剩余排队项；已被上游受理的项仍可能产生结果。`jobs.retry` 仅重试确认失败项。结果为 `unknown` 时用 `jobs.reconcile` 请求只读核对，再以新步骤读 `jobs.read`，保留原请求 ID。文本委托的对应状态名为 `uncertain`。以各自契约的枚举值渲染。

## 角色条目与引用

`character.create` 允许 `{}`，也可以只传 `entries`。角色无需归属作品。显示名称读 `name`，编辑输入使用 `authorName ?? ''`，这样再次保存时不会把占位名称「未命名角色」写成作者设定。可选的 `description` 保存角色描述，兼容字段 `persona` 使用同一份正文。两字段同时提交时必须相同。

每个条目有 `label` 和有序的 `blocks`。普通文本、图像、音频、资源引用可以出现在同一条目。作者首次保存可省略 `entryId`，服务返回稳定 ID；重排、重命名和修订时保留这个 ID。块的位置属于一个具体的角色版本。角色修订使用 `character.revise({characterId, expectedRevision, ...})`，省略 `entries` 会沿用，`entries: []` 清空，传入数组则按提交的顺序完整替换。`character.read({characterId, revision})` 的 `href` 可直接作为历史链接。

```js
// invoke 调用 POST /api/web/invoke，每个新步骤使用新的 stepId，并返回 result。
const voice = await invoke('asset.import', { name: '试音.wav', contentType: 'audio/wav', data: wavBase64 });
const card = await invoke('character.create', { entries: [{ label: '说话方式', blocks: [
  { type: 'audio', assetId: voice.assetId },
  { type: 'text', text: '船靠岸的时候，你再叫我的名字。' },
] }] });
const prepared = await invoke('generations.prepare', { title: '渡口', brief: '续写两句对话', templateId: 'short-story',
  references: [{ kind: 'character', id: card.characterId, revision: card.revision,
    includeDescription: false, selections: [{ entryId: card.entries[0].entryId, blockIndex: 1 }] }] });
const prompt = await invoke('generations.prompt', { generationId: prepared.generationId });
```

`asset.import` 接受标准带填充的 base64，不带 data URL 前缀；同一文件内容复用首次导入的素材及其名称。可存 PNG、JPEG、WebP、GIF、WAV、MP3、Ogg Opus/Vorbis、FLAC。只要 ID 时用 `asset.list({kind,limit,offset})` 浏览和 `asset.read({assetId})` 查元数据。角色卡与提示词快照通过 ID 引用不可变原件，SQLite 备份包含原件。

引用块形如 `{type:'reference',kind:'draft',id,revision,excerpt}`。目标可为 `source`、`scene`、`draft`、`diary` 或 `character`。省略摘录时保存精确版本链接；有摘录时服务器会核对该版本原文。`character.backlinks({kind,id,revision?,currentOnly?,limit?,offset?})` 返回角色链接、角色版本、条目 ID、标签、原始块位置和引用内容。列出目前仍在使用的角色引用时传 `currentOnly: true`。`scene.branch` 及其稿件有自己的 ID，引用分支内容时传该资源的 ID 和版本。

## 提示词组成

从生成记录进入，`generations.prompt({generationId})` 直接返回标题及网页链接 `href`（`/generations/{generationId}/prompt`）。`generations.prepare` 的角色引用默认附上角色描述；只想引用一句时，传 `includeDescription: false`，网页中可取消「附上角色描述」。`entryIds` 选完整条目，`selections` 选原始版本中从零开始的 `blockIndex`。两种选择取并集，顺序以固定版本的角色卡为准。提示词 `path` 表示实际入选内容在本次消息里的位置，`blockIndex` 始终是来源卡里的原位置。因此只选原卡第二块时，新消息路径可为 `blocks/0`，来源仍为 `blockIndex: 1`。引用块带摘录时会提供摘录，只有版本链接时传递该引用本身。要使用完整稿件正文，在 `references` 里显式加入对应的 `draft`。

`templates.list({name:'短篇故事'})` 可发现内置 `short-story`。日记、剧本、分镜等也可用中文名称查找。存在作者自建的同名模板时优先精确匹配作者标题，已知内置 ID 时可直接用 `templates.get`。

| 响应内容 | 页面读取方式 |
| --- | --- |
| `messages[].role`、`parts[]` | 按返回顺序显示。文本取 `text` 原值，图片和音频取 `asset.href`；`asset` 还包含格式、长度、SHA-256。Sth 当前对话组稿用描述符交付素材；OpenAI 兼容委托校验原件后把图像或音频字节编码进请求。音频委托支持 WAV、MP3，具体模型还需支持所选模态。 |
| `provenance[]` | `messageIndex`、`partIndex` 对应消息及内容块。文字范围 `[start,end)` 是原始 `text` 的 UTF-16 位置，适合使用 JS `slice`；先定位再格式化。`path` 为组稿 JSON 的路径，`kind` 区分固定指令、创作请求、模板、要求、输入和引用。角色来源带原始 `entryId`、`entryLabel`、`blockIndex`，版本来自 `revision`。嵌套引用的 `target` 指向实际资源版本。 |
| `status` | `provided` 为 Sth 已提供当前对话上下文；`prepared` 为委托已准备且尚无发出证据；`sent` 为供应商已回复（也可能拒绝该请求）；`unknown` 为发送情况缺少证据。成稿成功与失败从 `generations.get().status` 读取。 |
| `historical`、`parameters` | 旧记录返回所保存的消息，缺少来源的地方展示「历史来源未记录」。委托的 `plan` 固定方案版本，`requestOptions` 返回能核实的模型参数。历史页始终按当时记录展示。 |

扩展格式时，一处登记素材类型和识别方式，再为角色块、显示与供应商编码加对应处理，并补一项从原件到实际请求的测试。扩展业务来源时，在后端组稿过程中建立精确来源与位置；网页和适配器使用同一操作读取。追踪边界是 Sth 生成的内容，外部应用内部会话另行对接。

助手可以用 `generations.prompt.page` 分开读取 `messages`（默认）和 `provenance`，适配 Hermes 默认单次工具回包上限。首请求只需 `generationId` 和可选 `section`。续页保持这两个值，传入上一页的 `nextCursor` 并使用新的 `stepId`，直到返回 `null`。按 `start` 顺序拼接 `fragment` 后解析一次 JSON，可恢复与网页相同的完整数组。

## 研究、讲述和续写

网页的日常入口为日记、创作、角色、资料和任务。`tasks.list` 按时间分页合并后台检索、独立文字委托、文字批次和媒体任务。每项的 `href` 打开原模块详情，批次内各次尝试在该批次展开。连接位于设置，原有资源链接可直接访问。

| 用户动作 | 共享操作与保存约定 |
| --- | --- |
| 找到原文、选中第二处同文 | `external.search`、`external.read` 提交持久检索，`external.get` 给出已保存的结果，`external.archive` 归档。已接外部工具的助手可以 `external.import`。`source.search` 支持在本地资料的某一版本查找出现位置，`source.read` 可从 `range` 读取周围文字。选区按当时原文的 UTF-16 零基半开区间保存。 |
| 保存可复用的理解 | `judgment.create`、`judgment.revise` 保存解释、适用范围和支持或反对它的出处。`source.backlinks` 返回直接引用，`source.impact` 按具体资料版本查采用它的判断、事件、稿件、角色和生成记录。`state` 区分当前对象修订、历史修订和生成快照。 |
| 换个视角讲一遍 | `event.save` 保存事件及依据，`event.order` 的 `action` 可增加或去除已知先后。`narrative.save` 将讲述顺序与视角可知的事件版本绑定到指定场景。`generations.prepare` 的 `story` 指定讲述版本和分支，按视角构建上下文。作者研究页可查看全部证据。 |
| 把原稿中的发现收入角色卡 | `character.adopt-entries` 将选中的文本、判断与固定版本的引用追加为条目。原稿后续修订、共用角色卡的变化都有独立的版本。 |
| 继续一条 IF 线 | `scene.branch` 固定分叉点，`branch.list` 按名字找回，`branch.read` 读取断点。`branch.save` 记录所在场景、可选稿件和讲述，以及分支内角色状态。组稿时可用 `story.checkpointRevision` 选定断点；结果的 `generations.prompt` 可查当时实际纳入的角色状态。 |

新模块的精确字段以 `node scripts/contract.ts <operationId>` 为准。更换外部资料服务时实现提供方协议，网络请求由后台执行。[资料提供方](RESEARCH_PROVIDERS.md) · [四个验收场景](RESEARCH_STORY_PLAN.md)

## 前端重构验收

1. 用隔离数据目录和端口启动后端，从空作品列表直接写资料和日记。网页及个人 API 分别读回，检查两个入口看到同一对象。
2. 用两个编辑窗口改同一条资料，验证冲突后仍可看到本地草稿。打开精确修订的深链接，修改新版后刷新历史页，核对原正文和来源。
3. 将一个场景的第二稿收入章节，从 IF 和原线分别打开其选稿。让一份四段模板升级后，分别打开旧稿来源与新生成结果。
4. 任务列表刷新、网络超时、重启和取消后仍与 `jobs.read` 相符。分别检查成功、失败、未知、尚未配置供应商的呈现。点击已完成图片能预览二进制并返回出处。
5. 执行 `npm run typecheck`、`npm test`、`npm run test:browser` 和 `npm test --prefix adapters`。浏览器回归使用临时数据库。手机打开链接还需要手机可达的网页 origin。[运行与手机访问](../README.md) · [浏览器用例](../tests/browser/workspace.test.mjs)
