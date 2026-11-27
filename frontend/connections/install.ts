export type Host = 'hermes' | 'codex' | 'antigravity';
export type HermesAction = 'create' | 'connect';

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
  hermesAction?: HermesAction;
  workspaceName?: string;
}

export function absolutePath(path: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(path) && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(path);
}

/** PowerShell single-quoted literals also protect $, backticks and embedded quotes. */
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function installCommand(options: InstallOptions): { command: string; error: string } {
  const { host, repository, profile, distribution, bindingDirectory, config, workspace, executable, binaryDirectory } = options;
  const required = host === 'hermes' ? [distribution] : [repository, bindingDirectory, config, workspace];
  if (!required.every(absolutePath)) return { command: '', error: '请填写本机绝对路径，路径可以包含空格。' };
  if (host === 'hermes' && profile && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)) {
    return { command: '', error: '请填写已有 Hermes profile 的名称，使用 1–64 位字母、数字、下划线或连字符。' };
  }
  if ((host === 'codex' && executable && !absolutePath(executable)) || (host === 'antigravity' && binaryDirectory && !absolutePath(binaryDirectory))) {
    return { command: '', error: '可选的启动器或下载目录也须使用绝对路径。' };
  }
  const hermesAction = options.hermesAction ?? 'connect';
  if (!(host === 'hermes' && hermesAction === 'create')) {
    let origin: URL;
    try { origin = new URL(options.origin); } catch { return { command: '', error: '无法读取当前 Sth 服务地址。' }; }
    if (origin.origin !== options.origin || !['http:', 'https:'].includes(origin.protocol)
      || (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) {
      return { command: '', error: '远程助手需要 HTTPS 服务地址。本机助手可使用 loopback HTTP。' };
    }
  }
  const stopOnFailure = (message: string) => `if ($LASTEXITCODE -ne 0) { throw ${literal(message)} }`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `Set-Location -LiteralPath ${literal(host === 'hermes' ? distribution : repository)}`,
  ];
  if (host === 'hermes') {
    const name = options.workspaceName ?? (hermesAction === 'create' ? 'my-writing' : 'team');
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(name)) {
      return { command: '', error: '工作区名称需为 1–64 位字母、数字、点、下划线或连字符。' };
    }
    const hermes = `hermes${profile ? ` -p ${literal(profile)}` : ''}`;
    lines.push(
      `${hermes} plugins install ([System.Uri](Get-Location).Path).AbsoluteUri --enable --force`,
      stopOnFailure('Hermes 插件安装失败。'),
    );
    if (hermesAction === 'create') lines.push(
      `${hermes} sth workspace create ${literal(name)}`,
      stopOnFailure('工作区创建失败，请查看终端中的说明。'),
    );
    else lines.push(
      `${hermes} sth workspace connect ${literal(options.origin)} --workspace ${literal(name)}`,
      stopOnFailure('Sth 连接失败，请核对服务并生成新码。'),
      `${hermes} sth workspace use ${literal(name)}`,
      stopOnFailure('工作区切换失败，请查看终端中的说明。'),
    );
    lines.push(`${hermes} sth status`);
  } else {
    lines.push(`$env:STH_PERSONAL_OPERATIONS_ORIGIN = ${literal(options.origin)}`);
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
