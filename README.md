# Sth

Sth 是个人创作工作区。网页、Hermes 私聊和 MCP 客户端共享同一份日记、角色设定和作品数据，也共享操作目录、版本检查与保存回执。

## 启动

安装 Node.js 24.15 或更新版本，在仓库根目录运行：

```sh
npm ci
npm start
```

网页默认位于 <http://127.0.0.1:9321>。连接管理位于 <http://127.0.0.1:9321/settings/connections>。服务只监听本机回环地址。`STH_PORT` 可修改端口，`STH_DATA_DIR` 可指定数据目录，默认数据库为 `.data/sth.sqlite`。运行时只需要本仓库和自身的依赖。首次启动时作品、角色、日记和助手连接均为空。

使用 Docker 时，在仓库根目录运行 `docker compose up -d --build`。Compose 使用独立的 `sth_data` 数据卷，本机入口同为 `9321`。Node 直接运行和 Docker 可择一使用。容器内数据的备份命令示例为 `docker compose exec web node scripts/backup.ts /tmp/sth-export.sqlite`，随后运行 `docker compose cp web:/tmp/sth-export.sqlite ./sth-export.sqlite`。

## 从第一篇日记开始

1. 在首页写一篇日记并保存，复制这篇日记的链接。个人日记可以直接保存。
2. 需要接入助手时，在「连接」生成连接码。安装了本仓库插件的 Hermes 私聊接收 `sth personal connect <code>`。一次性码十分钟内有效，领取后连接持续生效，直到在网页撤销。
3. 在私聊中说「帮我记下今天的想法，标题写《第一天》，正文写『今天把 Sth 搭起来了』」。打开保存的日记，在网页修改后让助手读回。
4. 在「项目」新建作品，在「角色」保存人设，再用原来的连接写角色日记。角色可以属于个人或作品，日记记录写作时的人设版本。与任务无关的作品不需要预先指定。

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
