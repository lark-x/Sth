export type Host = 'hermes' | 'codex' | 'antigravity';

export interface InstallOptions {
  host: Host;
  origin: string;
  repository: string;
  profile: string;
  distribution: string;
  bindingDirectory: string;
  config: string;
  workspace: string;
  executable: string;
  binaryDirectory: string;
}

export function absolutePath(path: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(path) && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(path);
}

/** PowerShell single-quoted literals also protect $, backticks and embedded quotes. */
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function installCommand(options: InstallOptions): { command: string; error: string } {
  const { host, repository, profile, distribution, bindingDirectory, config, workspace, executable, binaryDirectory } = options;
  const required = host === 'hermes' ? [repository, profile, distribution] : [repository, bindingDirectory, config, workspace];
  if (!required.every(absolutePath)) return { command: '', error: '请填写本机绝对路径，路径可以包含空格。' };
  if (host === 'hermes' && !/[\\/]profiles[\\/][^\\/]+[\\/]?$/i.test(profile)) {
    return { command: '', error: 'Hermes 独立 profile 目录的直接上级须命名为 profiles。' };
  }
  if ((host === 'codex' && executable && !absolutePath(executable)) || (host === 'antigravity' && binaryDirectory && !absolutePath(binaryDirectory))) {
    return { command: '', error: '可选的启动器或下载目录也须使用绝对路径。' };
  }
  let origin: URL;
  try { origin = new URL(options.origin); } catch { return { command: '', error: '无法读取当前 Sth 服务地址。' }; }
  if (origin.origin !== options.origin || !['http:', 'https:'].includes(origin.protocol)
    || (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) {
    return { command: '', error: '远程助手需要 HTTPS 服务地址。本机助手可使用 loopback HTTP。' };
  }
  const stopOnFailure = (message: string) => `if ($LASTEXITCODE -ne 0) { throw ${literal(message)} }`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `Set-Location -LiteralPath ${literal(repository)}`,
    `$env:STH_PERSONAL_OPERATIONS_ORIGIN = ${literal(origin.origin)}`,
  ];
  if (host === 'hermes') {
    lines.push(
      `$env:HERMES_HOME = ${literal(profile)}`,
      `$package = py -3 adapters/hermes_plugin/package_plugin.py ${literal(distribution)} | ConvertFrom-Json`,
      stopOnFailure('插件打包失败，请使用新的分发目录。'),
      'hermes plugins install $package.installIdentifier --enable',
      stopOnFailure('Hermes 插件安装失败。'),
      `hermes sth connect --origin ${literal(origin.origin)}`,
      stopOnFailure('Sth 连接失败，请核对服务并生成新码。'),
      'hermes sth status',
    );
  } else {
    if (host === 'antigravity' && binaryDirectory) lines.push(
      `& ./adapters/scripts/get-antigravity-cli.ps1 -Directory ${literal(binaryDirectory)}`,
    );
    lines.push(
      'npm --prefix adapters ci', stopOnFailure('适配器依赖安装失败。'),
      `$bindingDirectory = ${literal(bindingDirectory)}`,
      `Read-Host -MaskInput 'Sth 一次性连接码' | node adapters/mcp/cli.mjs pair $bindingDirectory --client-name ${literal(`Sth ${host === 'codex' ? 'Codex' : 'Antigravity'}`)}`,
      stopOnFailure('Sth 配对失败，请核对服务并生成新码。'),
      `node adapters/scripts/install-agent-host.mjs --host ${host} --config ${literal(config)} --binding (Join-Path $bindingDirectory 'personal-connection.json') --workspace ${literal(workspace)}${host === 'codex' && executable ? ` --executable ${literal(executable)}` : ''}`,
      stopOnFailure('宿主安装失败，请检查配置路径和同名 MCP 项。'),
    );
  }
  return { command: lines.join('\n'), error: '' };
}
