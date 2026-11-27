#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WorkspaceError, bindHost, connectWorkspace, createWorkspace, restartWorkspace,
  startWorkspace, stopWorkspace, workspaceDoctor, workspaceList, workspaceStatus,
} from './workspace-runtime.mjs';
import { errorDetails, validateName, validatePort } from './workspace-store.mjs';

export { bindHost, connectWorkspace, createWorkspace, restartWorkspace, startWorkspace,
  stopWorkspace, workspaceDoctor, workspaceList, workspaceStatus } from './workspace-runtime.mjs';

const help = `Sth persistent workspace manager

node scripts/workspace.mjs create [name] [--host name] [--port 0]
node scripts/workspace.mjs connect <http(s)://origin> [--workspace name] [--host name]
node scripts/workspace.mjs use <name> [--host name]
node scripts/workspace.mjs list
node scripts/workspace.mjs status|uri|start|stop|restart|doctor [--workspace name] [--host name]

--home <directory>       工作区根目录，默认 STH_WORKSPACE_HOME 或 ~/.sth
--port <0..65535>         create/start/restart 的监听端口，首次默认 0
--token-env <name>       doctor 验证当前宿主的个人连接令牌
--json                   uri 返回完整状态 JSON，其余命令默认 JSON
--help                   显示此帮助

init 是 create 的别名。每个 host 独立绑定工作区，共享名称即共享数据。
退出命令行后服务继续运行。stop/restart 通过认证的本机接口管理自己创建的服务。
`;

function parse(argv) {
  const options = {};
  const positionals = [];
  const names = { '--home': 'home', '--workspace': 'workspace', '--host': 'host', '--port': 'port', '--token-env': 'tokenEnv' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { command: 'help', options, positionals: [] };
    if (argument === '--json') { options.json = true; continue; }
    if (Object.hasOwn(names, argument)) {
      if (seen.has(argument)) throw new WorkspaceError('invalid_arguments', `参数 ${argument} 重复。`);
      seen.add(argument);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new WorkspaceError('invalid_arguments', `参数 ${argument} 缺少值。`);
      options[names[argument]] = value;
    } else if (argument.startsWith('-')) {
      throw new WorkspaceError('invalid_arguments', `无法识别参数 ${argument}。`, '运行 --help 查看支持的参数。');
    } else positionals.push(argument);
  }
  const command = positionals.shift() ?? 'help';
  if (options.port !== undefined) {
    options.port = validatePort(options.port);
    if (!['create', 'init', 'start', 'restart'].includes(command)) throw new WorkspaceError('invalid_arguments', '--port 仅用于 create、start 或 restart。');
  }
  if (options.tokenEnv !== undefined && (command !== 'doctor' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv))) {
    throw new WorkspaceError('invalid_arguments', '--token-env 仅用于 doctor，值需为合法环境变量名。');
  }
  if (options.workspace) validateName(options.workspace);
  if (options.host) validateName(options.host, 'host');
  return { command, options, positionals };
}

export async function runWorkspaceCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const { command, options, positionals } = parse(argv);
    if (command === 'help') { stdout.write(help); return 0; }
    const count = ['create', 'init', 'connect', 'use'].includes(command) ? 1 : 0;
    if (positionals.length > count || (['connect', 'use'].includes(command) && positionals.length !== 1)) {
      throw new WorkspaceError('invalid_arguments', '命令的位置参数数量不正确。', '运行 --help 查看命令格式。');
    }
    let result;
    switch (command) {
      case 'create': case 'init': {
        if (positionals[0] && options.workspace && positionals[0] !== options.workspace) throw new WorkspaceError('invalid_arguments', '工作区名称参数不一致。');
        result = await createWorkspace({ ...options, workspace: positionals[0] ?? options.workspace ?? 'default' });
        break;
      }
      case 'connect': result = await connectWorkspace(positionals[0], options); break;
      case 'use': {
        bindHost({ ...options, workspace: positionals[0] });
        result = await workspaceStatus({ ...options, workspace: positionals[0] });
        break;
      }
      case 'list': result = workspaceList(options); break;
      case 'start': result = await startWorkspace(options); break;
      case 'stop': result = await stopWorkspace(options); break;
      case 'restart': result = await restartWorkspace(options); break;
      case 'status': case 'uri': result = await workspaceStatus(options); break;
      case 'doctor': result = await workspaceDoctor(options); break;
      default: throw new WorkspaceError('unknown_command', `无法识别命令 ${command}。`, '运行 --help 查看支持的命令。');
    }
    if (command === 'uri' && !options.json) {
      if (!result.origin) throw new WorkspaceError('uri_unavailable', '工作区尚未成功启动，入口地址暂不可用。', '先运行 start。');
      stdout.write(result.origin + '\n');
    } else stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    if (command === 'doctor') return result.passed ? 0 : 1;
    if (command === 'status') return result.healthy && (result.kind === 'connected' || result.owned) ? 0 : 1;
    return 0;
  } catch (error) {
    stderr.write(JSON.stringify({ ok: false, error: errorDetails(error) }) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runWorkspaceCli();
}
