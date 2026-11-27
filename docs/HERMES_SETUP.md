# Hermes 安装插件后创建工作区

完整分发包包含 Hermes 插件、Sth 运行时、当前平台的 Node、生产依赖、已构建的 Vue 页面和 web 静态资源。接收者准备已配置模型的 Hermes 和 Git，即可安装并开始写作。

## 普通用户三步

收到 `sth-hermes-1.2.0-win32-x64.zip` 后解压到自己的目录。下面使用 PowerShell，路径按实际解压位置调整。包需要与操作系统和 CPU 架构匹配。

1. 安装。在解压后含 `plugin.yaml` 的目录中运行。

   ```powershell
   Set-Location C:/Downloads/sth-hermes-1.2.0-win32-x64
   hermes plugins install ([System.Uri](Get-Location).Path).AbsoluteUri --enable --force
   ```

2. 创建自己的工作区。

   ```powershell
   hermes sth workspace create my-writing
   ```

   创建命令从插件内的 `runtime` 启动 Sth，在当前 Hermes profile 的 `sth-workspaces` 下建立持久数据，以空闲回环端口运行服务，并完成这个终端的连接。返回的 JSON 包含 `origin`、`workspaceUri`、`dataDir` 和 `connected`。打开 `origin` 即可使用包内 Vue 网页。

3. 让当前 Hermes 模型保存首篇日记并读回。

   ```powershell
   hermes chat --cli --oneshot --toolsets sth-personal-operations --query '请保存今天的日记，标题是我的第一篇，正文是今天开始写作。保存后读取完整正文，并给出网页链接。'
   ```

交互写作可以运行 `hermes -t sth-personal-operations`。插件通过 `sth_personal_discover` 发现业务操作和 schema，通过 `sth_personal_invoke` 保存与读取。普通写作使用当前 Hermes 模型。

完整本地社区包包含 Node 可执行文件和压缩前端，Hermes 安装扫描会给出 CAUTION。`--force` 是 Hermes 提供的显式确认安装参数。安装前核对分发者及 ZIP 的 SHA-256，扫描结果会显示在安装输出中。

所有命令需使用同一个 profile。命名 profile 在每条命令中加 `-p author`，例如 `hermes -p author plugins install <安装标识> --enable --force`、`hermes -p author sth workspace create my-writing` 和 `hermes -p author chat ...`。

## 第二次启动和升级

关闭终端后，本地工作区服务继续运行。新的终端进程和全新 Hermes session 会使用当前 profile 已保存的工作区与终端连接。

```powershell
hermes sth status
hermes sth workspace status
hermes chat --cli --oneshot --toolsets sth-personal-operations --query '找到我的第一篇日记，读取完整正文和 revision。'
```

机器重启后，通过 `start` 恢复服务。以下操作都使用插件自带运行时。

```powershell
hermes sth workspace start --workspace my-writing
hermes sth workspace doctor
hermes sth workspace restart --workspace my-writing
hermes sth workspace stop --workspace my-writing
hermes sth workspace list
hermes sth workspace create another-story
hermes sth workspace use my-writing
```

工作区数据位于 profile 的 `sth-workspaces`，独立于插件程序目录。升级前先停止自有工作区服务，将新包解压到新的目录，执行 `hermes plugins install <新包 file:// 标识> --force --enable`，再运行 `workspace start`。默认使用新插件内的运行时。保留自己的工作区数据目录。

## 连接已有 Sth

在已有服务的 `/settings/connections` 页面生成属于这个终端的一次性码，然后运行下面的命令并在提示处输入。

```powershell
hermes sth workspace connect https://sth.example.net --workspace team
hermes sth workspace use team
hermes sth status
```

已有本机服务可以使用 `http://127.0.0.1:<端口>`，远程服务使用 HTTPS。地址使用完整 origin。TTY 隐藏输入一次性码，自动化调用从 stdin 读取一行。一次性码避免进入聊天提示词与命令行参数。

只需终端 API 连接时，也可以使用 `hermes sth connect --origin <地址>`。已有服务的启动与停止继续由原服务管理方式负责。外接服务始终要求用户提供一次性码，自有回环工作区的显式创建、启用命令可以自动完成终端连接。

希望复用其他宿主已经登记的工作区时，显式选择登记根目录。

```powershell
hermes sth workspace use personal --home C:/path/to/private/sth
```

`--home` 成功后保存在当前 profile 的插件设置中。`--repository` 是可选的外部 Sth 运行时覆盖，供维护者或特殊安装使用。

```powershell
hermes sth workspace create external-runtime --repository F:/another-sth-installation
```

插件设置位于 `plugins.entries.sth-personal-operations.settings`，支持 `repository` 和 `workspace_home`。默认使用包内 `runtime` 和当前 profile 的 `sth-workspaces`。外部运行时覆盖会持续保存。恢复包内运行时可从插件设置中移除 `repository`。

工作区子进程清除继承的 `STH_*`、`VITE_*`、npm 配置及 Node 注入选项，防止创建私有工作区时带入另一服务的数据路径、网页密码或供应商配置。首篇写作由 Hermes 当前模型完成。Sth 内部委托生成、媒体等功能需要为该工作区单独配置对应供应商。

## 凭据、私聊和回执

终端长期凭据保存在当前 profile 的私有存储。Windows 使用当前用户 DPAPI 加密，POSIX 使用私有目录及文件权限。命令只输出连接 ID 和公共工作区状态。

终端调用要求 Hermes 宿主确认来源为 `cli`、`oneshot` 或 `tui`，并提供当前 session 与 turn 标识。第三方 `tool` 来源、QQ／微信等其他平台、后台 cron、委派子代理及未绑定会话均无法借用终端连接。模型参数中的平台声明不参与授权。

QQ／微信继续独立验证机器人账号、私聊发送者、会话及原始消息，并为每个 origin、平台、机器人和联系人保存自己的连接。配对码在进入模型前清除。基于消息的幂等、相对日期固定和保存结果链接保持原规则。各联系人需要独立配对。与不受信任联系人共用 Hermes 宿主时，应按平台限制任意文件读取与代码执行等其他工具的权限，以保护宿主上的凭据存储。

终端写入回执包含宿主 session 和 turn 派生的步骤标识。同一步骤与输入重试会读取已保存结果。跨会话使用资源 ID 与 revision 继续写作。已有原回执时，可用 `sth_personal_receipt` 提供原 `operationId` 和完整服务端 `stepId` 核验结果。

`hermes sth disconnect` 删除当前 profile 的终端凭据。服务端授权可在 Sth 连接页按对应 `connectionId` 撤销。

## 维护者导出完整分发包

下面是维护者的构建操作。维护者需要 Sth 源码、Python 3、Git、npm 和 Node >=24.15.0。接收者使用上面的三步流程。

```powershell
$base = Join-Path $env:LOCALAPPDATA 'SthHermesDistribution'
$distribution = py -3 adapters/hermes_plugin/package_plugin.py `
  (Join-Path $base 'sth-hermes-1.2.0-win32-x64') `
  --archive (Join-Path $base 'sth-hermes-1.2.0-win32-x64.zip') | ConvertFrom-Json
$distribution
```

目标目录和 ZIP 需尚不存在。导出程序在新临时目录中组装白名单构建输入，以清洁环境执行 `npm ci --ignore-scripts`、前端构建及 `npm prune --omit=dev`，然后发布以下内容。

- 清单和五个插件 Python 模块。
- `runtime/src` 和共享 `scripts/workspace*.mjs`。
- `runtime/web`、已构建的 `runtime/frontend/dist` 与生产 `node_modules`。
- 当前平台、架构的 Node 二进制和对应版本官方许可，生产 package 清单及锁文件。
- 每个公开文件的 SHA-256 清单 `distribution.json`、接收者说明和独立 Git 安装源。

构建输入只复制规定类型的代码和静态资源，跳过隐藏文件、测试和已有构建目录。构建环境使用空白 npm 配置和独立缓存。开发 `.env`、`.data`、连接文件、数据库及供应商凭据不会进入分发包。构建时也不会载入开发环境的 `VITE_*` 或 Sth 配置。导出会从 Node 官方仓库下载当前二进制版本的完整许可文本。Git 历史只包含组装后的公开包。

JSON 输出包含 `installIdentifier`、目录、平台、架构、ZIP 路径及 SHA-256。将 ZIP 交给普通 Hermes 用户即可，也可以自行发布这个独立 Git 源，再通过官方 `hermes plugins install <仓库地址> --enable --force` 安装。当前导出是对应平台的包，在其他平台交付时需在目标平台导出。

## 隔离验收

验收脚本使用机器已安装的官方 Hermes，在私有临时根建立全新 named profile。它接收最终 ZIP，解压后用正常 Hermes launcher 安装、运行官方 doctor、创建空工作区，并由真实模型保存首篇日记及读取。第二个新 session 再次读取，核验隔离 session 工具回执和 Sth 网页 API。

```powershell
$runtime = Join-Path $env:LOCALAPPDATA 'hermes/hermes-agent'
$hermesPython = Join-Path $runtime 'venv/Scripts/python.exe'
$env:PYTHONPATH = $runtime
$env:PYTHONIOENCODING = 'utf-8'
& $hermesPython -B -X utf8 adapters/tests/hermes_onboarding.py `
  --hermes-source $runtime `
  --distribution $distribution.archive `
  --real-model --source-home (Join-Path $env:LOCALAPPDATA 'hermes')
```

外层 Python 只负责测试调度。测试从 Hermes 依赖元数据找到实际 ABI 匹配的 Python，为隔离数据根初始化官方 PM 依赖选择。普通用户三步都通过已安装的 `hermes` launcher 执行。测试移除 PATH 中的独立 Node，不传 `--repository`，校验服务实际运行于安装后插件的 `runtime`，并请求 Vue HTML、打包 JS/CSS 和 web 静态资源。

真实模型配置只读取指定来源 profile 的选中模型及该供应商配置，复制到隔离 profile。支持 `--model <模型 ID>` 在同一供应商下显式选择模型。结束后停止隔离服务和 gateway，移除复制的配置与备份，保留私有报告目录。省略 `--real-model` 可以只执行确定性集成检查。

另行覆盖重放、原回执、服务重启后的资料与连接、外接已有服务、跨平台/profile/session/委派拒绝、撤销与断开连接。分发文件的 SHA-256 和生产依赖结构也会检查。

```powershell
py -3 -B -m unittest discover -s adapters/tests -p hermes_distribution.py
$env:STH_TEST_HERMES_PYTHON = $hermesPython
$env:STH_TEST_HERMES_SOURCE = $runtime
node --test adapters/tests/personal.test.mjs
```

私聊回归使用 Hermes 真实网关代码和合成 QQ／微信事件。手机上的真实发送与接收需要单独验收。

## 排查

| 现象 | 处理 |
| --- | --- |
| `hermes sth` 无法识别 | 核对使用同一个 profile，运行 `hermes plugins doctor sth-personal-operations --ci` |
| `sth_setup_failed` | 检查完整包、平台和架构、profile 私有目录及 `workspace status`，必要时重新安装完整包 |
| `connected=false` | 检查服务状态及连接是否已撤销，运行 `workspace start` 或使用新连接码 |
| 模型看不到 Sth 工具 | 启动时指定 `--toolsets sth-personal-operations`，核对命名 profile |
| `personal_turn_required` | 使用正常原生终端或已配对的 QQ／微信私聊，并核对宿主来源 |
| 切换 profile 后没有连接 | 在目标 profile 创建或连接工作区 |
| 保存结果不确定 | 复用原步骤与输入重试，或通过 `sth_personal_receipt` 核验回执 |

共享 CLI 行为见 [WORKSPACE_SETUP.md](WORKSPACE_SETUP.md)，私聊与 MCP 协议见 [adapters/README.md](../adapters/README.md)。
