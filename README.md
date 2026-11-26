# Sth

Sth 是个人创作工作区。网页、Hermes 私聊和 MCP 客户端共用一套操作，可以管理作品、角色和日记，引用资料、选用场景稿件、套用写作模板，以及委托模型和批量出图。

基础工作区的交付范围见 [AI 原生创作工作区四阶段计划](docs/AI_NATIVE_ROADMAP.md)。从原文研究、归纳判断到按视角写故事的模块边界和场景验收见 [资料研究与故事创作计划](docs/RESEARCH_STORY_PLAN.md)。

重做网页或接入另一位 AI 时，先读 [前端与后端契约](docs/FRONTEND_BACKEND.md)。运行 `node scripts/contract.ts` 可以离线查看当前构建的操作索引，附加操作 ID 可读取准确的输入和输出结构。

本机可直接打开的分镜与出图样例、可复现测试以及手机验收步骤见 [交付验收记录](docs/ACCEPTANCE.md)。

## 启动

安装 Node.js 24.15 或更新版本，在仓库根目录运行：

```sh
npm ci
npm start
```

网页默认位于 <http://127.0.0.1:9321>。连接管理位于 <http://127.0.0.1:9321/settings/connections>。服务只监听本机回环地址。`STH_PORT` 可修改端口，`STH_DATA_DIR` 可指定数据目录，默认数据库为 `.data/sth.sqlite`。运行时只需要本仓库和自身的依赖。首次启动时作品、角色、日记和助手连接均为空。

使用 Docker 时，在仓库根目录运行 `docker compose up -d --build`。Compose 使用独立的 `workspace` 命名卷，本机默认入口同为 `9321`。当前数据库格式为 3，启动时会把格式 2 的 Sth 库在事务中就地升级。升级前可运行 `docker compose exec web node scripts/backup.ts /tmp/sth-export.sqlite`，随后用 `docker compose cp web:/tmp/sth-export.sqlite ./sth-export.sqlite` 将快照存到宿主机。恢复到旧程序时使用升级前快照。

本机并行验收实例使用 `docker compose --env-file examples/local-providers.env -p sth-authoring up -d --build --wait`，网页地址为 <http://127.0.0.1:9322>。该命令使用单独的数据卷和镜像。Hermes 若要连接此实例，应在用于验收的 profile 中设置 `STH_PERSONAL_OPERATIONS_ORIGIN=http://127.0.0.1:9322`，加载本仓库插件，再领取 **9322 网页**签发的连接码。MCP 配对前同样指定该 origin。

## 生成供应商

普通 Hermes 写作由当前会话完成。点名的文字委托使用 `STH_GENERATION_PROVIDERS_JSON` 中的供应商别名，例如 `{"magpie":{"baseUrl":"http://127.0.0.1:3425/v1"}}`。需要密钥时用 `apiKeyEnv` 指向服务进程的环境变量。创建生成方案时选择同一别名和模型；批量任务也固定该方案的版本。

图片任务需要可访问的 ComfyUI 以及 API 格式工作流。示例使用 Anima Turbo、文本编码器和 VAE，分别由工作流中的加载节点指定；`4` 是正向提示词节点，`9` 是唯一图像输出节点。本机 Docker Desktop 示例配置的服务为宿主机端口 `8191`；原生 Node 服务可改用回环地址和本机文件路径。用 `/api/web/providers/media` 查当前供应商状态。[配置示例](examples/local-providers.env) · [工作流](examples/comfyui/anima-turbo.json) · [开源依据](docs/OPEN_SOURCE.md)

## 从第一篇日记开始

1. 在首页写一篇日记并保存，复制这篇日记的链接。个人日记可以直接保存。
2. 需要接入助手时，在「连接」生成连接码。安装了本仓库插件的 Hermes 私聊接收 `sth personal connect <code>`。一次性码十分钟内有效，领取后连接持续生效，直到在网页撤销。
3. 在私聊中说「帮我记下今天的想法，标题写《第一天》，正文写『今天把 Sth 搭起来了』」。打开保存的日记，在网页修改后让助手读回。
4. 到「角色」保存一段声音、一张立绘或几句对白即可开始创作。称呼、角色描述和作品归属都可稍后补充。角色卡能引用场景、稿件和日记的原文，角色日记则固定使用写作时的人设版本。
5. 准备写作时可以选择角色条目中的具体内容。在生成记录打开「提示词组成」，查询 Sth 给出的消息、选入的图像或音频及其来源版本。[角色和提示词契约](docs/FRONTEND_BACKEND.md#角色条目与引用)

从「资料」进入外部检索，读取上下文后归档原文，可以选定具体一段保存判断。打开「创作」创建独立场景，按视角选择可知事件，或从已有场景另开 IF。打开「任务」可一起查找后台检索、文字委托和媒体生成的进度。[配置资料提供方](docs/RESEARCH_PROVIDERS.md) · [真实 Hermes 创作验收](docs/RESEARCH_LIVE.md)

Hermes 和 MCP 各自的安装、隔离配置与验证方式见 [适配器说明](adapters/README.md)。每个客户端可以独立连接和撤销。原 SthStart 签发的连接只能访问原服务。

## 数据和备份

运行 `npm run backup -- <新的备份文件路径>` 可在服务运行时获取一致的 SQLite 快照，已有同名文件会保留。备份包含正文、角色修订、助手连接记录和操作回执，需要与原始数据同样保管。恢复时使用一个新的空目录，将备份文件命名为 `sth.sqlite`，用 `STH_DATA_DIR` 指向它再启动服务。切换前先在单独端口核对内容。

## 手机链接

手机上的 `127.0.0.1` 指向手机本身。需要从手机打开网页时，在自己的 HTTPS 反向代理上将域名转发到本机服务，保留原始 Host。给服务设置完整的 `STH_PUBLIC_ORIGIN`（例如 `https://sth.example.net`）和 `STH_WEB_PASSWORD`，并重启。浏览器使用用户名 `sth` 和该密码。值应保存在本地环境配置中。给 Hermes 的 `STH_PERSONAL_OPERATIONS_PORTAL_ORIGIN` 设置同一地址，它就可以在回复中附上手机能打开的链接。默认本地运行无需这些配置。

## 开发与验收

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm ci --prefix adapters
npm test --prefix adapters
```

业务模块通过 `src/core` 的 `defineOperation` 声明 ID、读写类型、输入与输出 schema、执行函数和可选的交互提示。在 `src/library` 可找到作品、角色与日记的实现。执行上下文提供当前 SQLite 事务。操作按自身的输入解析业务资源，连接只代表已配对的个人助手。外部副作用应交给事务提交后的工作进程。

网页使用 `/api/web`，外部助手使用带 Bearer 凭据的 `/api/v1/personal-operations`。两者访问同一 `Operations` 实例。发起独立的操作时给它新的 `stepId`，重试沿用原值。按连接保存回执，同一个步骤换输入会返回冲突。读取最新内容时也需要新的步骤。

移植来源为 SthStart 的 `6f967ab` 和 `f772164`。该仓库包含重新设计的个人连接、共享操作与日记场景。旧服务的数据库、部署配置和账号凭据不参与启动。
