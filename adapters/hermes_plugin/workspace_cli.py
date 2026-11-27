"""Use Sth's workspace CLI for lifecycle, then pair only the local terminal."""

import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

from . import native, personal_operations as operations
from .personal_credentials import read_binding, save_binding


def setup_parser(subparsers):
    parser = subparsers.add_parser("workspace", help="使用 Sth scripts/workspace.mjs 管理持久工作区。")
    parser.add_argument("action", choices=("create", "connect", "use", "list", "status", "start", "stop", "restart", "doctor"))
    parser.add_argument("target", nargs="?", help="create/use 的工作区名，或 connect 的服务 origin。")
    parser.add_argument("--repository", type=Path, help="可选的外部 Sth 运行时目录，默认使用插件自带运行时。")
    parser.add_argument("--home", type=Path, help="Sth 工作区登记目录，默认在当前 Hermes profile 的 sth-workspaces 下。")
    parser.add_argument("--workspace", help="已登记的工作区名称。")
    parser.add_argument("--port", type=int, help="create/start/restart 的本机端口，0 为自动分配。")


def _repository(explicit):
    configured = native._context.get_config("repository") if native._context else None
    bundled = Path(__file__).resolve().parent / "runtime"
    candidates = [explicit] if explicit else ([Path(configured)] if configured else []) + [bundled, *Path(__file__).resolve().parents]
    for candidate in candidates:
        if (candidate / "scripts" / "workspace.mjs").is_file():
            return candidate.resolve()
    raise ValueError("插件运行时缺失，请重新安装完整分发包，或使用 --repository 指定外部 Sth 运行时。")


def _node(repository):
    name = "node.exe" if os.name == "nt" else "node"
    for runtime in (repository, Path(__file__).resolve().parent / "runtime"):
        if (runtime / "bin" / name).is_file():
            return str(runtime / "bin" / name)
    found = shutil.which("node")
    if not found:
        raise ValueError("插件 Node 运行时缺失，请重新安装完整分发包。")
    return found


def _select_or_pair(workspace, *, new_connection=False):
    origin = operations._normalize_origin(workspace["origin"])
    key = operations._digest(("sth-native-origin-v1", origin))
    binding = read_binding(key)
    if binding and not new_connection:
        status, catalog = operations._post(origin, "/catalog", {"view": "index"}, binding["token"])
        if status == 200 and isinstance(catalog.get("operations"), list):
            save_binding(native.KEY, binding, None, origin=origin)
            return {"connected": True, "connectionId": binding["connectionId"]}
    if workspace.get("kind") == "local" and workspace.get("owned") is True:
        # This path is reachable only from an explicit owner-terminal lifecycle
        # command for a locally owned daemon. Existing/remote services always
        # require the operator's one-time code, including loopback services.
        if urllib.parse.urlsplit(origin).hostname not in ("127.0.0.1", "::1"):
            raise ValueError("Expected an owned loopback workspace.")
        request = urllib.request.Request(origin + "/api/web/connections/code", data=b"{}",
                                         headers={"Content-Type": "application/json", "Accept": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), operations._NoRedirect)
        with opener.open(request, timeout=8) as response:
            code = json.loads(response.read(32769)).get("code")
    else:
        code = getpass.getpass("Sth 一次性连接码 ") if sys.stdin.isatty() else sys.stdin.readline(256).strip()
    result = native.connect(origin, code)
    return {"connected": result["connected"], "connectionId": result["connectionId"]}


def run_workspace(args):
    from hermes_constants import get_hermes_home

    repository = _repository(args.repository)
    profile = Path(get_hermes_home()).resolve()
    configured_home = native._context.get_config("workspace_home") if native._context else None
    home = (args.home or (Path(configured_home) if configured_home else profile / "sth-workspaces")).resolve()
    host = "hermes-" + operations._digest((str(profile),))[:20]
    if (args.action in ("connect", "use") and not args.target) or (args.target and args.action not in ("create", "connect", "use")):
        raise ValueError("工作区命令的位置参数不正确。")
    command = [_node(repository), str(repository / "scripts" / "workspace.mjs"), args.action]
    if args.target:
        command.append(args.target)
    command += ["--home", str(home), "--host", host, "--json"]
    if args.workspace:
        command += ["--workspace", args.workspace]
    if args.port is not None:
        command += ["--port", str(args.port)]
    # Creating a private workspace must not import another service's owner
    # password, data directory or provider configuration from the launch shell.
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("STH_", "VITE_", "NPM_CONFIG_"))
           and key.upper() not in ("NODE_OPTIONS", "NODE_PATH")}
    completed = subprocess.run(command, cwd=repository, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
    if len(completed.stdout) > 1024 * 1024:
        raise RuntimeError("Sth workspace CLI failed.")
    if completed.returncode != 0 and not (completed.returncode == 1 and args.action in ("status", "doctor")):
        raise RuntimeError("Sth workspace CLI failed.")
    result = json.loads(completed.stdout)
    if result.get("ok") is not True:
        raise ValueError("Sth workspace CLI returned an invalid result.")
    if args.action in ("create", "connect", "use", "start", "restart"):
        result.update(_select_or_pair(result, new_connection=args.action == "connect"))
    if native._context:
        if args.repository:
            native._context.set_config("repository", str(repository))
        native._context.set_config("workspace_home", str(home))
    # Expose only the public workspace CLI fields, never credential/control
    # data even if a future CLI adds it to its result.
    fields = ("ok", "id", "name", "kind", "workspaceUri", "origin", "dataDir", "hosts", "connectionsUrl",
              "personalOperationsOrigin", "personalOperationsUrl", "state", "healthy", "owned", "pid", "logPath",
              "connected", "connectionId", "passed", "checks")
    public = {key: result[key] for key in fields if key in result}
    if args.action == "list":
        public["workspaces"] = [{key: item[key] for key in fields if key in item} for item in result.get("workspaces", [])]
    return public
