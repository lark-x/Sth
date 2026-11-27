# 本地持久工作区

工作区命令使用 Node.js 标准库，最低版本为 24.15.0。守护进程复用 `src/database.ts`、`src/server.ts` 及现有后台 worker。业务数据继续由 Sth 核心管理。

## 首次运行

全新 clone 后，在安装目录准备依赖和网页构建产物。

```sh
npm ci
npm run build
node scripts/workspace.mjs create personal --host codex
```

`create` 默认请求系统分配空闲端口，命令结束后服务在后台继续运行。输出为单行 JSON，包含 `origin`、`workspaceUri`、`dataDir`、`connectionsUrl`、`personalOperationsOrigin`、`pid`、`healthy` 和 `owned`。创建成功后，该宿主会绑定到工作区。

```sh
node scripts/workspace.mjs uri --host codex
node scripts/workspace.mjs status --host codex
node scripts/workspace.mjs doctor --host codex
```

打开 `origin` 可进入网页，`connectionsUrl` 可领取助手连接码。将 `personalOperationsOrigin` 交给宿主适配器作为 `STH_PERSONAL_OPERATIONS_ORIGIN`。每个宿主领取自己的个人连接令牌。

重复运行同名 `create` 会复用原工作区，已在运行时复用原进程。`init` 是 `create` 的别名。`--workspace personal` 可替代 `create` 的名称位置参数。

安装包可通过 `sth-workspace` bin 暴露同一入口，具体 package 配置见本文末尾。安装包应附带已构建的网页。

## 数据和宿主绑定

默认工作区根目录为当前用户的 `~/.sth`，Windows 对应 `%USERPROFILE%\.sth`。优先级依次为 `--home`、`STH_WORKSPACE_HOME`、默认目录。相对 `--home` 按命令执行目录解析，跨宿主配置建议使用绝对路径。

```text
~/.sth/
  registry.sqlite
  workspaces/<workspace-id>/
    lifecycle.sqlite
    service.log
    data/
      sth.sqlite
      sth.sqlite-wal
      sth.sqlite-shm
```

SQLite 的 WAL/SHM 文件按运行状态出现。登记库保存工作区名称、稳定 ID、端口、宿主选择和私有进程控制凭据。新建目录使用私有权限，登记库与工作区数据需要按个人数据保管。

`workspaceUri` 形如 `sth://workspace/<uuid>`，用于识别本机登记的工作区。HTTP 请求使用 `origin`。首次启动后保存 HTTP 端口，后续正常启停沿用该端口。指定 `--port 0` 可以重新分配，工作区 ID 和数据目录保持关联。

名称允许 1–64 位 Unicode 字母、数字、点、下划线和连字符，首位为字母或数字。`--host` 是宿主选择标签，默认值为 `default`。

多个宿主共用同一根目录，并绑定同一工作区名称。

```sh
node scripts/workspace.mjs use personal --host hermes
node scripts/workspace.mjs use personal --host mcp
node scripts/workspace.mjs status --host hermes
node scripts/workspace.mjs list
```

`use` 仅保存宿主的工作区选择。连接配对由宿主适配器完成。`list` 返回登记信息及上次保存的入口，实时健康由 `status` 或 `doctor` 查询。多个宿主共用一个服务，停止该工作区会影响全部已绑定宿主。

需要独立数据时创建另一个名称。

```sh
node scripts/workspace.mjs create second --host another-agent
node scripts/workspace.mjs status --workspace personal
```

## 连接已有 Sth

```sh
node scripts/workspace.mjs connect http://127.0.0.1:9400 --workspace existing --host codex
node scripts/workspace.mjs connect https://sth.example.net --workspace remote --host mcp
```

连接前检查 `/api/health` 必须返回 `name="Sth"`、`status="ok"` 和正整数 `schemaVersion`。连接成功后才更新宿主选择。相同名称重复连接相同地址可复用，名称已指向其他对象时返回 `workspace_exists`。

URI 需要完整 origin，回环地址支持 HTTP，其他地址使用 HTTPS。URI 中的用户信息、路径、查询、片段及 HTTP 重定向会被拒绝。

已有 Sth 登记为 `kind="connected"`，`dataDir` 为 `null`。其启停由原服务的管理方式处理，工作区命令提供状态、入口、诊断及宿主选择。

## 停止、重启和崩溃恢复

```sh
node scripts/workspace.mjs stop --host codex
node scripts/workspace.mjs start --host codex
node scripts/workspace.mjs restart --workspace personal
node scripts/workspace.mjs restart --workspace personal --port 0
```

服务只监听 `127.0.0.1`。本地工作区显式选择自己的数据目录和监听端口。启动 shell 中的 `STH_DATA_DIR`、`STH_PORT`、`STH_CONTAINER` 对它的目录和监听位置无影响。其他供应商配置及 `STH_PUBLIC_ORIGIN`、`STH_WEB_PASSWORD` 沿用启动命令的环境，重启时应在相同环境中执行。

守护进程持有独立 SQLite 写锁，多个进程争用同一工作区时只会有一个成为服务所有者。异常退出或机器重启后系统释放该锁，重新执行 `start` 会使用原数据。更换 clone 或安装位置后，使用同一个 `--home` 和工作区名执行 `restart`，即可切换至当前安装运行。

指定端口已经被占用时，启动返回 `port_in_use`。新建工作区的登记和目录会保留，当前宿主的原有绑定继续有效，可使用下面的命令恢复。

```sh
node scripts/workspace.mjs start --workspace personal --port 0
```

停止使用本机认证管理接口，校验私有随机令牌、工作区 ID、启动代次和 PID。进程存在性检查仅发送信号 0。身份无法确认时返回 `ownership_unverified`。管理路径为 `GET /.well-known/sth-workspace` 和 `POST /.well-known/sth-workspace/stop`，由登记库内的私有 Bearer 令牌保护。

## 本机个性化验证

`doctor` 检查 Node 版本、数据目录权限、本地服务身份、核心健康、网页操作索引以及个人操作索引。每项检查单独返回 `id`、`ok` 及相关反馈。

```sh
node scripts/workspace.mjs doctor --host codex
node scripts/workspace.mjs doctor --host codex --token-env STH_PERSONAL_TOKEN
```

第二条命令从当前进程的 `STH_PERSONAL_TOKEN` 读取该宿主已配对的令牌，调用个人操作目录验证真实鉴权。令牌值应由宿主凭据存储或当前 shell 注入，JSON 和日志中的诊断输出包含验证结果。传入的环境变量缺失时返回 `token_missing`，令牌被撤销或来自其他工作区时返回 HTTP 401 和当前连接页。

未传 `--token-env` 时，个人操作检查验证未鉴权请求返回 401，并报告 `authenticated=false` 和配对入口。需要网页密码的服务可在执行诊断时提供 `STH_WEB_PASSWORD`。

这套聚焦测试通过本机 HTTP 实际签发两个连接、分别写入和读回日记，并在服务重启后复用原令牌。真实 Hermes、MCP、手机客户端的安装与交互由各宿主的验收覆盖。

## 输出、退出码与失败恢复

普通命令向 stdout 输出单行 JSON。`uri` 默认输出 HTTP origin，附加 `--json` 后输出完整状态。`--help` 输出帮助文本。Node 自身的实验性 SQLite 提示可能出现在 stderr。

执行异常向 stderr 输出以下结构，退出码为 1。

```json
{"ok":false,"error":{"code":"port_in_use","message":"该端口已被占用，无法启动工作区。","hint":"使用 start --port 0 分配空闲端口，或明确选择其他端口。"}}
```

`status` 获取到登记信息时总会向 stdout 输出状态对象，实例未就绪或本地身份无法验证时退出码为 1。`doctor` 输出诊断对象，任何检查失败时退出码为 1，查看 `passed` 和 `checks`。因此 `ok=true` 表示成功取得结构化结果，健康状态由 `healthy`、`owned`、`state` 与 `passed` 表达。

| code | 恢复方式 |
| --- | --- |
| `workspace_not_found` | `list` 查看登记，使用 `create`、`connect` 或 `use` 完成宿主选择 |
| `port_in_use` | 选择其他端口，或 `start --port 0` |
| `already_running` | 使用当前入口，或 `restart --port <端口>` |
| `connection_failed` | 检查目标 `/api/health`、TLS 和服务是否运行 |
| `external_lifecycle` | 使用已有服务的原管理方式启停 |
| `ownership_unverified` | 检查 `doctor`、当前端口和 `service.log`，恢复本机管理连接后重试 |
| `installation_incomplete` | clone 后执行 `npm ci`，安装包补齐核心、脚本和网页产物 |
| `invalid_public_origin` | 配置 HTTPS origin 和网页密码，或清除这两个变量后重试 |
| `startup_timeout` | 查看工作区 `service.log` 和 `status`，确认安装后重新 `start` |
| `stop_timeout` | 等待后台任务结束，再查看 `status` |
| `permission_denied` / `disk_full` | 修复该用户目录权限或释放磁盘空间后重试 |

服务日志路径通过 `logPath` 返回，启动错误还会保存在状态的 `lastError` 中。成功启动会清除旧的启动错误。备份使用原有 `scripts/backup.ts`，将 `STH_DATA_DIR` 设为返回的 `dataDir` 后执行。

## 集成接口与 package 配置

`scripts/workspace.mjs` 同时提供 CLI 和 JS 导出，导入模块会保留调用方控制权。

```js
import {
  createWorkspace, connectWorkspace, bindHost, workspaceList, workspaceStatus,
  startWorkspace, stopWorkspace, restartWorkspace, workspaceDoctor,
  runWorkspaceCli,
} from './scripts/workspace.mjs';

const state = await createWorkspace({ home: '/absolute/private/sth', workspace: 'personal', host: 'codex', port: 0 });
await bindHost({ home: '/absolute/private/sth', workspace: 'personal', host: 'hermes' });
const exitCode = await runWorkspaceCli(['status', '--home', '/absolute/private/sth', '--host', 'hermes']);
```

生命周期 JS 函数接收同一组选项 `home`、`workspace` 和 `host`。`create/start/restart` 可接收 `port`，生命周期等待可用 `startupTimeout` 调整，单位为毫秒，默认 15000。`workspaceDoctor` 可接收 `tokenEnv`。异步函数抛出带 `code`、`message`、`hint`、`details` 的 `WorkspaceError`，导出函数的结果采用 CLI 相同的公共字段，CLI 另增加 `ok`。`bindHost` 和 `workspaceList` 为同步函数。

package 元数据由集成主代理配置。建议添加以下条目。

```json
{
  "bin": { "sth-workspace": "./scripts/workspace.mjs" },
  "scripts": {
    "workspace": "node scripts/workspace.mjs",
    "test:onboarding": "node --test tests/onboarding*.test.ts",
    "prepack": "npm run build"
  },
  "files": [
    "src/",
    "scripts/workspace*.mjs",
    "scripts/backup.ts",
    "web/",
    "frontend/dist/",
    "docs/WORKSPACE_SETUP.md"
  ]
}
```

保留现有 `type="module"`、`engines.node=">=24.15.0"` 和核心运行依赖。源码用户先运行 `npm ci` 与 `npm run build`，然后可用 `npm run workspace -- create personal`。安装包的 `files` 清单应与其他入口的需求合并，发布前核对包内存在 `frontend/dist/index.html`。这些脚本通过相对安装路径加载核心，通过用户根目录定位持久数据。

聚焦验证命令如下。

```sh
node --test tests/onboarding-workspace.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

测试使用临时用户根目录和系统分配端口，覆盖持久化、独立工作区、多宿主并发、同机独立配对、占用端口、崩溃恢复、安装位置变化及失败重试。
