# Sth personal adapters

Use Sth's **连接 → 生成配对码** page at `/settings/connections` to pair an assistant. Generate a fresh code for each Hermes private chat or MCP installation. The default API origin is `http://127.0.0.1:9321`. These connections have access to the personal catalog. An operation can accept an optional project in its input, according to its schema.

## Start Sth

From the Sth checkout in PowerShell, use Node.js 24.15 or newer. Set `STH_DATA_DIR` to a dedicated Sth directory on first startup, then reuse that path to retain entries, receipts, and connections.

```powershell
Set-Location F:/Project/Sth
npm ci
$env:STH_DATA_DIR = Join-Path $env:LOCALAPPDATA 'Sth/data'
npm start
```

Keep this terminal open. From a second terminal, `Invoke-RestMethod http://127.0.0.1:9321/api/health` should report `name = Sth` and `status = ok`. Open <http://127.0.0.1:9321/settings/connections> to issue a code. If you set `STH_PORT` for a separate instance, update both adapters' API origins to match.

## Hermes profile

The isolated acceptance test below is the first path for verifying the plugin. It uses synthetic events and needs no QQ or WeChat credentials. For a manual chat later, use a dedicated test bot and explicitly allow the test sender in its isolated Hermes profile. Keep the production bot credentials, files, gateway and active profile out of this setup.

In a fresh PowerShell session that carries no live bot credentials, use the installed runtime and an independent home whose immediate parent is named `profiles`. Keep all Hermes commands for this setup in that session. This pins the home directly and avoids changing the global profile selection.

```powershell
$runtime = Join-Path $env:LOCALAPPDATA 'hermes/hermes-agent'
$hermesPython = Join-Path $runtime 'venv/Scripts/python.exe'
$env:PYTHONPATH = $runtime
$env:HERMES_HOME = Join-Path $env:LOCALAPPDATA 'SthHermes/profiles/sth'
$plugin = Join-Path $env:HERMES_HOME 'plugins/sth-personal-operations'
New-Item -ItemType Directory -Path $plugin -Force | Out-Null
Copy-Item 'F:/Project/Sth/adapters/hermes_plugin/*' -Destination $plugin
& $hermesPython -B -m hermes_cli.main plugins enable sth-personal-operations
& $hermesPython -B -m hermes_cli.main plugins list --user --plain
```

In that home's `config.yaml`, add `sth-personal-operations` to the `platform_toolsets` entries for the channels the test profile uses. Merge these entries with any toolsets already selected in that profile.

```yaml
platform_toolsets:
  qqbot:
    - sth-personal-operations
  weixin:
    - sth-personal-operations
```

When the dedicated test bot and model are configured, start the isolated gateway in the same terminal with `& $hermesPython -B -m hermes_cli.main gateway run --no-supervise`. Use Ctrl+C in that terminal to stop it. The gateway must support `pre_gateway_dispatch`, `post_gateway_admission`, `pre_llm_call`, and `transform_llm_output`.

Send `sth personal connect <code>` as a standalone message in an admitted QQ or WeChat bot private chat. The plugin removes the code before Hermes can queue the text or send it to the model. It redeems the code only for the verified peer and receiving bot account. Send `sth personal help` for the pairing instructions. After pairing, ask in ordinary language, for example `用林岚的最新设定写今天的日记`. Hermes uses the profile's selected model and the `sth_personal_discover` and `sth_personal_invoke` tools.

| Hermes profile setting | Purpose |
| --- | --- |
| `STH_PERSONAL_OPERATIONS_ORIGIN` | HTTPS or loopback HTTP API origin. Defaults to `http://127.0.0.1:9321`. |
| `STH_PERSONAL_OPERATIONS_TIME_ZONE` | Optional IANA zone for relative dates, such as `Asia/Shanghai`. Defaults to the host's local zone. An explicit zone needs zoneinfo data in the Hermes Python environment. |
| `STH_PERSONAL_OPERATIONS_PORTAL_ORIGIN` | Optional browser-facing origin for saved diary links. By default the reply includes the relative `/diaries/<id>` route. |

Set these variables in the isolated profile's `.env` or in its launcher environment before gateway startup. For phone links, configure an HTTPS reverse proxy for Sth that preserves the incoming `Host`. Start Sth with `STH_PUBLIC_ORIGIN=https://sth.example.net` and `STH_WEB_PASSWORD` supplied through its service environment. The browser signs in using username `sth` and that password. Set `STH_PERSONAL_OPERATIONS_PORTAL_ORIGIN=https://sth.example.net` in the isolated Hermes profile. Hermes can keep its API on `http://127.0.0.1:9321` when both services share a machine. Use the externally reachable HTTPS API origin when the adapter runs on another machine. The plugin also accepts an explicit private LAN HTTP link origin when the LAN deployment already serves the Sth web UI there.

Hermes saves bindings and relative delivery dates under the profile's `sth-personal-operations/` directory. Binding keys include the API origin, platform, bot account, and peer. Windows bindings use user-scoped DPAPI. POSIX storage uses a `0700` directory and `0600` files. Use a trusted Hermes profile whose model tools cannot read its credentials or execute arbitrary host code.

The Hermes adapter derives a service step ID from the platform, bot account, peer, session, native message ID, operation, and logical step. For operations declaring `interaction.identityFields`, the declared input values replace the caller's logical step. On a semantic-step conflict the adapter requests the original receipt and reports that result in chat. Use a separate `occurrence` when the user explicitly requests multiple entries with the same identity. For a request that uses `interaction.localDateField` and asks for today, Hermes keeps the delivery's local date across restarts. Operations without identity metadata use the caller's stable step ID and exact input for retries.

## MCP stdio

Use Node.js 20 or newer for the adapter. Run `npm ci` in `adapters/` to install its pinned `@modelcontextprotocol/sdk` `1.30.0` dependency.

Generate a fresh Sth code. From `adapters/`, pass it on stdin with PowerShell 7. The following command creates a new pairing directory under your local app data. Use a new directory name for subsequent pairings.

```powershell
$bindingDirectory = Join-Path $env:LOCALAPPDATA 'SthMcp-pairing'
Read-Host -MaskInput 'Sth one-time connection code' |
  node mcp/cli.mjs pair $bindingDirectory
```

The pairing command prints the connection ID and credential file path. The file pins the API origin and stores the token under a Windows user-only directory ACL or in owner-only POSIX storage. To pair when using a different Sth origin, set `STH_PERSONAL_OPERATIONS_ORIGIN` before running the pairing command.

Register this stdio command in the MCP host using absolute paths. Reserve its stdout for MCP frames.

```json
{
  "mcpServers": {
    "sth-personal": {
      "command": "node",
      "args": [
        "F:/Project/Sth/adapters/mcp/cli.mjs",
        "stdio",
        "C:/path/to/private-directory/personal-connection.json"
      ]
    }
  }
}
```

For secret-environment mode, omit the credential file argument and provide `STH_PERSONAL_OPERATIONS_TOKEN` through the MCP host's secret storage. This mode uses `STH_PERSONAL_OPERATIONS_ORIGIN` at startup or defaults to loopback port 9321.

Discover operation schemas with `sth_personal_discover`. Call `sth_personal_invoke` with `operationId`, `stepId`, and `input`. Use a stable event ID and logical step, for example `request-42:save-diary`. Use an explicit `YYYY-MM-DD` date where the operation requires one. Retry by reusing the same caller `stepId` and input. For an uncertain result, pass the same `operationId` and caller `stepId` to `sth_personal_receipt`. The tool response returns the effective `sth.mcp.v1:`-prefixed service step ID. Caller step IDs can be up to 501 characters. Successes expose the operation envelope as structured content.

Both adapters use `POST /api/v1/personal-operations/{claim,catalog,invoke,receipt}`. Claim accepts `{code,clientName}` and returns `{token,connectionId}`. The other calls use the resulting bearer token. Sth stores receipts per connection. Revoke a connection on the Sth connections page and pair again with a fresh code to replace it. A newly paired connection starts a new receipt history.

## Isolated acceptance tests

Install the Sth root dependencies and use the repository's Node.js 24 runtime for tests. From `adapters/`, `npm test` starts Sth on ephemeral loopback ports with a temporary SQLite database under `adapters/tests/`. The MCP tests use the SDK client over actual child-process stdio.

Set `STH_TEST_HERMES_PYTHON` to the installed Hermes virtual-environment interpreter to include the Hermes integration test. `STH_TEST_HERMES_SOURCE` can point to the installed Hermes source if its layout differs from the standard venv. The fixture checks the installed CLI and exercises gateway admission, tool registration, reply hooks, pairing, and restart replay with synthetic QQ and WeChat events. It uses a temporary profile, a deterministic model stand-in, and stubbed sends.

```powershell
Set-Location F:/Project/Sth/adapters
npm ci
$env:STH_TEST_HERMES_PYTHON = "$env:LOCALAPPDATA/hermes/hermes-agent/venv/Scripts/python.exe"
npm test
```
