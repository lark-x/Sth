# 温妮莎研究与两种讲述 · Hermes 验收

正式目标为 `http://127.0.0.1:9322`。隔离预演使用临时 SQLite 数据目录和系统分配的回环端口。两条路径都使用已安装 Hermes CLI、真实模型和本仓库的 Sth stdio MCP。网页 API 独立读回保存的资料、判断、事件、提示词和结果。

## 原文与连接

| AkashaTerminal 文档 | 已核对范围 | 用于验收的原文内容 |
| --- | --- | --- |
| 《温妮莎传奇·下篇》 `doc_41fd9a6f995b` | 18–30 行 | 自由歌谣、少女挣脱镣铐，以及巴巴托斯把歌中主角的位置还给少女。 |
| 《温迪》 `doc_6eb3b3638ac3` | 186–195 行 | 密约使士兵害怕成为奴隶，史家多年后发现密约为伪造品。 |

无密钥的 `https://agent.zlb.ink/api/mcp/` 提供 `akasha_search` 与 `akasha_read`。Windows 主机和 Docker 的 `sth-authoring-web-1` 都可直接连接这个公网 HTTPS 地址，保留末尾斜杠。验收脚本直接通过它读取两份指定原文，随后由 Hermes 通过 `external.import` 归档。

Sth 当前内置 Akasha 搜索的实际变量为 `STH_RESEARCH_AKASHA_URL` 和 `STH_RESEARCH_AKASHA_AUTHORIZATION`。使用 `STH_RESEARCH_AKASHA_URL=https://akasha.daidr.me/service/mcp`，由运行环境提供完整的 Authorization 值。该地址公开，认证值私有。主机和 Docker 可用同一地址，未认证初始化实测返回 HTTP 401。此端点提供 Sth 适配器所需的 `searchAkasha` 和 `readSource`。使用无密钥的 AkashaTerminal 地址作为 Sth 内置搜索上游需要对应工具适配。

## 执行

在工作区根目录用已安装 Hermes 的 Python 启动脚本。默认选择现有本机 `magpie` 配置中的 `codex/gpt-6.2-sol`。

```powershell
$researchPython = Join-Path $env:LOCALAPPDATA 'hermes/hermes-agent/venv/Scripts/python.exe'
& $researchPython -X utf8 scripts/accept-research.py isolated
& $researchPython -X utf8 scripts/accept-research.py preflight
& $researchPython -X utf8 scripts/accept-research.py preview
```

`preflight` 从真实 Akasha 读取资料并检查 9322 的操作目录。完成部署后才运行 `preview`。如预览启用网页认证，通过进程环境提供 `STH_ACCEPT_WEB_PASSWORD`。脚本为每次运行创建独立配对，并在退出时撤销，通过 HTTP 401 验证令牌失效。临时令牌与 Hermes 配置仅在仓库外受限目录短暂存在。

Hermes 准备会话自主完成归档、判断、两个事件及其顺序、两种讲述和两条生成准备记录。每次写作使用新的 Hermes 会话与独立配置，只传本次生成记录 ID，通过 `generations.prompt.page` 读完消息。网页 API 核验也分页读取消息和出处，并检查两份原文、选段坐标、事件顺序和两个结果 ID。控制台显示证据目录，目录保留 `report.json`、Hermes 会话记录、JSONL 和 stderr。

在同一 9322 部署上接续未完成的稿件时，`--resume-report` 接受已撤销配对的旧报告路径。脚本从旧 Hermes 会话恢复已经完成的阶段，使用新的配对提交剩余阶段，并独立读回所有成果。

```powershell
& $researchPython -X utf8 scripts/accept-research.py preview --resume-report $priorReport
```

## 分页读回

`prompt-readback` 使用已完成报告中的史家生成和结果 ID。它创建独立配对和隔离 Hermes 会话，使用 Hermes 默认工具回包上限。Hermes 分别跟随 `messages` 和 `provenance` 的游标，并报告后世辨伪结论及两份资料的选段坐标。脚本核对服务端回执、UTF-16 页边界、网页 API 重组结果和模型给出的出处，最后读回原成稿并撤销配对。

```powershell
$completedReport = Join-Path $env:LOCALAPPDATA 'sth-research-accept-frmj3fhe/report.json'
& $researchPython -X utf8 scripts/accept-research.py prompt-readback --reference-report $completedReport
```

2026-11-24 在 9322 实测通过，运行 ID 为 `prompt-readback-4b6e957d31`。真实 Hermes CLI 使用 `codex/gpt-6.2-sol` 和默认的 50,000 字符回包上限。`messages` 共 1 页、4,636 个 UTF-16 代码单元，`provenance` 共 4 页、45,199 个 UTF-16 代码单元。Hermes 会话中最长的完整回执消息为 20,631 字符。5 个 MCP 回执均与服务端一致，拼接结果与网页 API 一致。

Hermes 读出后世确认《背风的密约》是伪造的，并返回《温妮莎传奇·下篇》版本 1 的 `[13,28)` 与《温迪》版本 1 的 `[305,326)`。两处坐标均在实际提示词出处中核实。[自由歌谣](http://127.0.0.1:9322/sources/d3c22e22-991d-45dd-a2cb-630683107564?revision=1&start=13&end=28) · [后世辨伪](http://127.0.0.1:9322/sources/e0a0c1b5-7fa5-46fb-9764-dbf1fabd7535?revision=1&start=305&end=326)

史家生成 ID 为 `598e2376-9841-4fbf-ba71-2d657905bcb2`，前后两次读回的结果 ID 和正文完全一致。临时配对已撤销，令牌再次调用返回 HTTP 401。独立证据位于 `%LOCALAPPDATA%/sth-research-accept-7l8bk1fk/report.json`。[原成稿](http://127.0.0.1:9322/generations/598e2376-9841-4fbf-ba71-2d657905bcb2/result)

## 验收记录

2026-11-24 在 9322 schema v4 完成 `vennessa-e308179363`。模型为 Hermes CLI 的 `codex/gpt-6.2-sol`，通过真实 Sth stdio MCP 写入。[验收场景](http://127.0.0.1:9322/scenes/2f16f42c-5da6-4bb0-9d79-a92b735599bc)

| 讲法 | 网页 API 读回结果 | 结果 ID | 页面 |
| --- | --- | --- | --- |
| 士兵受限视角 | 生成提示词只含士兵现场，无后世辨伪事件及其引文。正文止于士兵害怕沦为奴隶。 | `36dd8d0e-f1f2-450e-b7ef-246f713b6386` | [提示词](http://127.0.0.1:9322/generations/54fa9a5a-3264-4015-81f3-3928cdbe7f3d/prompt) · [成稿](http://127.0.0.1:9322/generations/54fa9a5a-3264-4015-81f3-3928cdbe7f3d/result) |
| 史家全知视角 | 先讲后世确认密约为伪造品，再回到士兵现场。提示词的来源记录指向两份资料的选段。 | `355aa3af-775a-4b43-ab7a-68510bb4cd11` | [提示词](http://127.0.0.1:9322/generations/598e2376-9841-4fbf-ba71-2d657905bcb2/prompt) · [成稿](http://127.0.0.1:9322/generations/598e2376-9841-4fbf-ba71-2d657905bcb2/result) |

两份资料以 `provider=akasha` 和各自 `docId` 重复归档，两次均返回同一资料 ID 和修订号 `1`。网页 API 读回的归档正文和出处与 Akasha 原文一致。[研究判断](http://127.0.0.1:9322/judgments/890211f9-66c6-49e1-868b-ee7226a64b0a?revision=1)固定了以下三个片段，坐标是归档正文内从零开始的 UTF-16 半开区间。

| 文档与上游行号 | 正文坐标 | 选段 |
| --- | --- | --- |
| `doc_41fd9a6f995b` 18–30 行 | `[13,28)` | [自由歌谣](http://127.0.0.1:9322/sources/d3c22e22-991d-45dd-a2cb-630683107564?revision=1&start=13&end=28) |
| `doc_6eb3b3638ac3` 186–195 行 | `[255,287)` | [士兵对沦为奴隶的恐惧](http://127.0.0.1:9322/sources/e0a0c1b5-7fa5-46fb-9764-dbf1fabd7535?revision=1&start=255&end=287) |
| `doc_6eb3b3638ac3` 186–195 行 | `[305,326)` | [后世辨伪](http://127.0.0.1:9322/sources/e0a0c1b5-7fa5-46fb-9764-dbf1fabd7535?revision=1&start=305&end=326) |

首轮史家 MCP 提示词回包为 50,198 字符，超过 Hermes 默认的 `mcp_result_size_chars=50000`，会话只收到截断预览，未保存稿件。接续时仅为隔离 Hermes 配置将上限设为 `100000`，保留原准备、士兵和史家生成 ID。新会话读取完整提示词并保存，实际 MCP 回执与服务端回执一致。首轮和接续配对都已撤销，旧令牌各自验证返回 HTTP 401。9322 持续健康。

本机证据在 `%LOCALAPPDATA%` 下的 `sth-research-accept-xxp08n1y/report.json`（首轮）和 `sth-research-accept-frmj3fhe/report.json`（完成报告）。同目录保留对应的 Hermes 会话数据库和输出日志。临时绑定文件已清除。

真实上游验证使用运行中的 Akasha。离线恢复另由 `tests/external-research.test.ts` 在本机模拟连接断开，覆盖 SQLite 重开、原任务重试、离线读回归档以及工作进程停止后重新排队。
