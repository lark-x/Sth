# Codex 与 Antigravity 接入 Sth

两个宿主共用 `adapters/mcp/cli.mjs`，通过 Sth 的个人操作接口访问同一份数据。每个宿主分别兑换一次连接码，持有自己的连接 ID、凭据文件和操作回执。两个连接可以选择相同的 `sourceId`，随后按 ID 读取最新版本。

本文的验收环境使用临时 Sth 数据库、回环随机端口和独立宿主 profile。执行命令前，在仓库根目录安装根项目及 `adapters/` 的锁定依赖，并使用 Node.js 24.15.0 或更高版本。

全新 profile 隔离本地设置、会话状态和 MCP 绑定。账号是授权身份，两者分别管理。验收无需注册全新 Google 账号，也未要求专用新账号。官方明确支持本机 App、CLI 和 IDE 扩展共享登录，以及 CLI 静默复用系统安全存储中的有效授权。仅更换 HOME 无法证明账号隔离。

## 安装入口与配置范围

| 入口 | 用途 |
| --- | --- |
| `adapters/mcp/cli.mjs pair` | 从 stdin 兑换一次连接码，创建新的私有凭据目录 |
| `adapters/scripts/install-agent-host.mjs` | 将一个 stdio MCP 条目安装到明确指定的文件 |
| `adapters/scripts/probe-agent-host.mjs` | 在独立 profile 探测真实 CLI、读取配置并检查 Antigravity ACP 登录条件 |
| `adapters/scripts/run-agent-host.mjs` | 用相同的隔离环境启动真实宿主 CLI，支持 `--workspace` 指定已有本地目录 |
| `adapters/scripts/get-antigravity-cli.ps1` | 从 Google 官方发布链下载 Windows CLI，验证 SHA-512 和 Google LLC 签名 |

安装器要求显式传入绝对 `--config`、`--binding` 和 `--workspace` 路径。`--name` 默认使用 `sth-personal`。Antigravity 使用 JSON 的 `mcpServers`，Codex 使用 TOML 的 `mcp_servers`。

Antigravity 的 JSON 更新保留其他属性、服务器条目和文件外围的原始字节。Codex 先在私有临时 `CODEX_HOME` 中复制目标 TOML，再调用真实 `codex mcp list/add` 解析与修改，核对其他服务器定义后提交到指定文件。原有 TOML 注释和无关设置由 Codex 自身的配置编辑器保留。

重复安装相同条目返回 `changed=false`，保留原凭据和目标文件修改时间。同名条目内容有变化时需要用户明确传入 `--replace`。该参数替换所选名称对应的条目。更换凭据或源 ID 也属于这种显式修改。

安装使用目标文件旁的独占锁和临时文件。提交前会再次核对原文件内容、文件身份及修改时间。外部编辑冲突会终止本次提交。配置文件的符号链接、硬链接和父目录 junction 会被拒绝，应传入真实路径。已有文件的 POSIX 权限或 Windows ACL 会复制到新文件。故障时会清理本次创建的锁与临时文件。进程被强制结束后残留的 `.sth-install-lock` 需要在确认对应安装进程已经退出后人工移除。

## 准备真实宿主与隔离 profile

Windows 桌面程序 `Antigravity.exe` 和独立 CLI `agy.exe` 是不同的入口。探测器通过 `--version` 及 `--help` 中的 MCP、ACP 和会话设置能力核验 CLI。只有桌面程序时会报告 `desktop` 路径及 `cli_not_found`。Codex 支持原生可执行文件和官方 npm Windows 启动器，npm 的 `.cmd` 入口会转换为 Node 加官方 `codex.js`，参数直接按 argv 传递。

下面的目录由操作者选择，profile 应使用全新目录，二进制目录也应使用全新目录。

```powershell
$agyBinDirectory = Read-Host '新的隔离 Antigravity CLI 二进制绝对目录'
& .\adapters\scripts\get-antigravity-cli.ps1 -Directory $agyBinDirectory
$agy = Join-Path $agyBinDirectory 'agy.exe'
$agyProfile = Read-Host '新的 Antigravity 验收 profile 绝对目录'
node adapters/scripts/probe-agent-host.mjs `
  --host antigravity --profile $agyProfile --executable $agy

$codexProfile = Read-Host '新的 Codex 验收 profile 绝对目录'
node adapters/scripts/probe-agent-host.mjs `
  --host codex --profile $codexProfile
```

下载脚本读取官方 bootstrap 指定的 Google updater manifest，并要求发布载荷位于官方 Google Storage 路径，校验清单中的 SHA-512 及有效 Google LLC Authenticode 签名。生成的目录中保留 `agy.exe`。脚本直接获取二进制，宿主 PATH 和 shell 配置由操作者按需管理。

profile 保存 `.sth-agent-host-profile.json` 标记。同一宿主可以重复打开该 profile。既有目录缺少标记或标记属于另一个宿主时会拒绝启动。默认工作区位于 `<profile>/home/workspace`。

隔离环境固定 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG 目录和 CODEX_HOME，并只继承系统执行所需变量及网络代理变量。模型密钥、账号选择、已有宿主会话地址、Google ADC 路径等账号环境变量会被移除。

Windows 的系统凭据存储独立于 HOME。当前已验证的 `agy 1.5.18` 还需要 `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` 和 profile 独立的 `ANTIGRAVITY_CREDENTIAL_SCOPE`，才能让新 profile 正确返回登录缺失。这两个开关来自当前 Google 签名二进制，并已用真实 ACP 行为验证。升级 CLI 后应重跑隔离测试。

公开 CLI 参考未给出这两个环境变量的稳定兼容承诺。这里的隔离证据对应已校验的 1.5.18，后续版本需要重新验证实际认证行为。

探测器只发送 ACP `initialize` 与 `session/new`。预期结果为初始化成功及 `-32000 Authentication required`。若新 profile 意外建立了已登录会话，探测器返回失败，验收应先排查隔离条件。ACP 的 `--gemini-dir` 与 `--app-data-dir` 使用相对目录名，当前版本会拒绝绝对的 `--app-data-dir`。

此处的 `Authentication required` 表示强制文件令牌存储的空 profile 中没有授权。它无法证明已安装宿主未登录，也不产生注册新账号的要求。若使用者另有账号隔离约束，需要由其选择允许的授权身份并自行完成官方登录。

## 分别配对并选择同一个源

在专用验收 Sth 的连接页为每个宿主分别生成连接码。将下列 origin 指向该验收服务。安装测试会自动创建随机端口的独立 Sth 服务。

```powershell
$env:STH_PERSONAL_OPERATIONS_ORIGIN = Read-Host '验收 Sth 的回环 HTTP 或 HTTPS origin'
$agyPairDirectory = Join-Path $agyProfile 'sth-pairing'
$code = Read-Host 'Antigravity 的新 Sth 配对码' -AsSecureString
[Net.NetworkCredential]::new('', $code).Password | `
  node adapters/mcp/cli.mjs pair $agyPairDirectory --client-name 'Sth Antigravity'
Remove-Variable code

$codexPairDirectory = Join-Path $codexProfile 'sth-pairing'
$code = Read-Host 'Codex 的另一枚新 Sth 配对码' -AsSecureString
[Net.NetworkCredential]::new('', $code).Password | `
  node adapters/mcp/cli.mjs pair $codexPairDirectory --client-name 'Sth Codex'
Remove-Variable code

$sourceId = Read-Host '两个宿主共同选择的 Sth sourceId'
$agyWorkspace = Join-Path $agyProfile 'home\workspace'
$codexWorkspace = Join-Path $codexProfile 'home\workspace'
$agyConfig = Join-Path $agyProfile 'home\.gemini\config\mcp_config.json'
$codexConfig = Join-Path $codexProfile 'codex\config.toml'

node adapters/scripts/install-agent-host.mjs --host antigravity `
  --config $agyConfig `
  --binding (Join-Path $agyPairDirectory 'personal-connection.json') `
  --workspace $agyWorkspace --source-id $sourceId --executable $agy

node adapters/scripts/install-agent-host.mjs --host codex `
  --config $codexConfig `
  --binding (Join-Path $codexPairDirectory 'personal-connection.json') `
  --workspace $codexWorkspace --source-id $sourceId
```

`pair` 要求新的叶目录，已有配对使用返回的凭据文件即可。配对码通过 stdin 传入。输出只包含连接 ID 和凭据文件路径。凭据绑定兑换时的 Sth origin，使用 Windows 当前用户专用目录 ACL，或 POSIX `0700` 目录和 `0600` 文件。宿主配置只保存凭据文件路径。

所选源在安装时通过该连接的真实 `source.read` 验证。这个读取会在所选 Sth 实例保存该连接的操作回执。MCP discovery 的描述中会携带源 ID，并引导模型发现 `source.read` 后读取最新版本。源选择提供上下文，个人连接仍具有其原有目录权限。版本固定引用需要调用者显式传入 `revision`。

两个宿主的回执按各自连接隔离。撤销某个连接后，该连接需要新配对，另一个宿主可以继续使用自己的连接。希望直接访问完整个人目录时可以省略 `--source-id`。

## 本地工作区配置与真实 CLI 验证

Antigravity 当前官方工作区入口为 `<workspace>/.agents/mcp_config.json`。可将 `--config` 指向这个文件，并将 `--workspace` 指向同一工作区。若同时使用全局配置和工作区配置，按官方说明使用不同服务器名称，例如为工作区条目传入 `--name sth-workspace`。

本机 `agy 1.5.18 mcp list` 实测只展示隔离 HOME 中的全局条目，未展示同时安装的工作区条目。该列表不足以证明工作区条目已被 CLI 激活。本次真实模型验收使用临时 HOME 下的 `~/.gemini/config/mcp_config.json`，工作区条目的模型发现仍待单独验证。

MCP 条目使用当前 Node 和仓库 MCP CLI 的绝对路径，以及独立的工作区参数，支持 Windows 空格与中文路径。MCP 启动时会核验工作区并进入对应目录。仓库或 Node 安装位置变化后，应明确重新安装目标条目。

```powershell
node adapters/scripts/run-agent-host.mjs `
  --host antigravity --profile $agyProfile --executable $agy -- mcp list

node adapters/scripts/run-agent-host.mjs `
  --host codex --profile $codexProfile -- mcp list --json
```

`run-agent-host.mjs` 的 `--` 后为原宿主参数。启动真实已有本地项目时，在分隔符前加入 `--workspace` 及该项目的绝对目录。该启动器始终使用指定 profile 的隔离环境。

需要模型端到端验收时，可选择下面两种授权方式。

- profile 内授权由账号持有人在该 profile 自行完成官方登录，可以使用已有账号。隔离启动器继续使用文件令牌存储及独立 credential scope。
- 复用已有宿主登录需要显式选择正常的共享授权机制。`hosts-antigravity-live.test.mjs` 通过 `STH_TEST_AGY_REUSE_LOGIN=1` 单独启用这项验收。它保留独立 HOME 和配置，明确关闭本次测试的文件令牌强制与独立 scope，并让官方 ACP 自行使用本机已登录授权。测试不读取、复制或输出宿主凭据。缺少授权时记录 `Authentication required` 并跳过模型步骤，用户随后决定如何授权。

共享授权验收在系统临时目录中创建独立工作区及配置，临时 Sth 使用随机回环端口与独立数据库。通过安装器创建的全局 MCP 文件位于临时 HOME 中，ACP 的 `session/new` 传入该工作区和空的额外 MCP 列表，由真实宿主加载安装后的配置。关闭默认 customizations，创建两个独立的新会话，每个会话只发送一轮提示。

ACP 客户端仅按次批准 `sth-fixture` 服务器的源发现、指定源读取，以及第一个会话中与预期版本和随机内容精确匹配的一次修订。其他权限请求均取消。临时设置还拒绝文件、命令和网页操作。客户端不提供文件或终端能力。第二个新会话的提示只含源 ID，要求通过工具读回最新内容，随后核对随机标记、版本、真实 ACP 工具事件与 Sth Web 接口结果。配置原始字节也会再次核对。

宿主有时会先读取临时 HOME 内自动生成的 `mcp/sth-fixture/sth_personal_discover.json` 和 `sth_personal_invoke.json` 工具定义缓存。这些读取由引擎自身执行。工具事件审计只接受这两个精确临时路径的读取及 fixture MCP 调用，其他工具事件会使验收失败。

这是操作者明确选择的官方共享授权路径。默认探测器和启动器仍强制隔离令牌存储。测试不发送 `authenticate`、`--login`、登出、已有会话恢复或已有项目选择操作。Codex 的真实模型集成验收由项目负责人单独执行。

当前 `agy --print-timeout` 只约束提示执行阶段。缺少登录时，CLI 会输出授权提示并等待认证，等待时间可以超过 `--print-timeout`。自动测试另设进程超时并清理其语言服务器子进程。验收日志应记录登录阻断及退出条件。

`agy 1.5.18` 的实际缺登录 `--print` 探测还会尝试启动默认浏览器，与官方 headless 文档描述的非终端立即报错存在差异。自动验收使用 ACP 检查授权及执行提示，避免触发交互登录流程。

## 自动测试与本机证据

```powershell
$env:STH_TEST_AGY = $agy
$env:STH_TEST_CODEX = (Get-Command codex.cmd).Source
node --test adapters/tests/hosts*.test.mjs
node --test adapters/tests/*.test.mjs

# 明确选择已有宿主的正常共享授权后执行真实模型验收
$env:STH_TEST_AGY_REUSE_LOGIN = '1'
node --test adapters/tests/hosts-antigravity-live.test.mjs
Remove-Item Env:STH_TEST_AGY_REUSE_LOGIN
```

未提供对应 CLI 的环境变量时，原生宿主测试会明确跳过。常规测试仍覆盖 JSON 定点更新、同名保护、重复安装、凭据输出、绝对路径、隔离环境、配置锁、外部编辑冲突，以及真实 Sth 服务和 SDK stdio 的读写与撤销。

`hosts-native.test.mjs` 用安装的真实 CLI 读取隔离配置，再用 SDK 启动该配置中的 stdio 命令验证 Sth 的工具发现及源读取。`hosts-antigravity-live.test.mjs` 单独验收实际模型通过 MCP 保存数据及新会话工具读回。默认测试跳过需要显式启用的本机与授权验收，并在结果中说明条件。

2026-11-27 本机检测到 Antigravity 桌面程序，PATH 和默认独立 CLI 目录中缺少 `agy`。从官方清单下载的 `agy 1.5.18` 校验和为 `53605db7013dfed51e8c416d51e0c17a3b5ad0750c13da5669954ba4a281318746be0cf8cde2b256cfdb4bfbdade4badad1a0503931f8458416184549afa06b6`，签名验证为有效 Google LLC。检测到的 Codex CLI 版本为 `0.172.0`。

修正凭据隔离后的真实 Antigravity ACP 初始化报告 `Antigravity ACP Server 1.5.18`，并列出个人 Google、Gemini Enterprise、Gemini API key 和 Agent Platform 四种认证方式。强制文件令牌存储的新 profile 的 `session/new` 返回 `-32000 Authentication required`。明确选择官方共享授权后，本机 ACP 可以创建新的已授权会话。

2026-11-27 真实共享授权验收已通过。首个新 ACP 会话完成两次精确操作发现、源读取和源修订，Sth Web 接口确认随机标记及 revision 2。第二个新会话的提示只提供源 ID，实际调用 `source.read` 并回复同一随机标记。两轮共得到 24 个 ACP 工具状态事件，对应 6 次实际 MCP 调用。临时配置原始字节保持一致，fixture 工作区位于仓库外的系统临时目录。

最终回归执行 `node --test adapters/tests/*.test.mjs`，显式启用真实 Antigravity、Codex CLI 和已有授权模型验收，共 15 项测试，13 项通过、0 项失败、2 项跳过。跳过的项目需要单独指定已安装的 Hermes Python。`git diff --check` 通过。实际宿主验收环境为 Windows，Codex 模型调用由项目负责人负责。

原生模型验收发现 Antigravity 会猜测参数名，曾传入 `operation` 或嵌套的 `caller.stepId`。MCP 的工具描述现在明确给出单个 schema 查询及顶层 `operationId`、`stepId`、`input` 格式，参数错误也返回正确用法。错误调用继续被拒绝。修正后的真实模型流程完整通过。

隔离探索中存在一次边界失误。早期仅替换用户目录、尚未强制文件令牌存储的 `--print` 探测取得了一次真实模型回复及会话 ID，表明当时仍可访问系统账号凭据。该调用使用了纯文本探针。CLI 返回值不足以确认后台凭据刷新行为，隔离验收以修正后的 ACP 认证阻断为准。

## 官方依据

- [Antigravity MCP 配置与工作区发现](https://antigravity.google/docs/mcp/)
- [Antigravity 设置及配置文件位置](https://antigravity.google/docs/settings/)
- [Antigravity 统一授权与本机静默登录](https://antigravity.google/docs/install?tab=cli)
- [Antigravity headless 与工具调用事件](https://antigravity.google/docs/cli/headless/)
- [Antigravity 新会话与工作区范围](https://antigravity.google/docs/cli/conversations/)
- [Antigravity 权限规则](https://antigravity.google/docs/permissions/?tab=cli)
- [Antigravity 官方 Windows CLI bootstrap](https://antigravity.google/cli/install.ps1)
- [Codex MCP 官方文档](https://developers.openai.com/codex/mcp)
- [Codex 配置参考](https://developers.openai.com/codex/config-reference)

实际参数、Windows 凭据隔离与退出行为同时以本机已校验版本的 `--help`、ACP 响应及自动测试为依据。
