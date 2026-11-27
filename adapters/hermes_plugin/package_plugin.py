"""Build a self-contained, platform-specific source for `hermes plugins install`."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile


FILES = ("plugin.yaml", "__init__.py", "personal_credentials.py", "personal_operations.py", "native.py", "workspace_cli.py")
ROOT = Path(__file__).resolve().parents[2]
ASSETS = {".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".txt"}
FRONTEND_SOURCE_SUFFIXES = {".ts", ".vue", ".css", ".js", ".mjs", ".svg"}
PRIVATE_NAMES = {".data", ".env", ".git", ".npmrc", ".ssh", "auth.json", "credential_pool.json", "state.db", "config.yaml"}


def _copy_tree(source, destination, *, suffixes=None, exclude=()):
    """Copy only regular, public input files. Never follow links out of a tree."""
    if not source.is_dir():
        raise ValueError("A required distribution input is missing.")
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part.startswith(".") or part in PRIVATE_NAMES or part in exclude for part in relative.parts):
            continue
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("Distribution inputs must not contain links.")
        if path.is_file() and (suffixes is None or path.suffix in suffixes):
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def _run(command, cwd, env, *, timeout=240):
    completed = subprocess.run(command, cwd=cwd, env=env, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode:
        # Build and package-manager diagnostics can contain local registry credentials.
        step = " ".join([Path(command[0]).name, *command[1:3]])
        raise RuntimeError(f"Distribution command failed ({step}, exit {completed.returncode}).")
    return completed.stdout


def audit_payload(directory):
    files = []
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("The distribution contains a link.")
        if any(part in PRIVATE_NAMES or part.startswith(".env") or part.endswith(".binding") for part in relative.parts):
            raise ValueError("The distribution contains private state.")
        if path.is_file():
            files.append({"path": relative.as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size})
    return files


def package(destination, *, archive=None):
    destination = destination.resolve()
    if destination.exists() or (archive and archive.resolve().exists()):
        raise ValueError("Use a new distribution destination.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    git = shutil.which("git")
    if not node or not npm or not git:
        raise ValueError("The exporter needs Node, npm and Git.")
    # Build inputs and environment are freshly assembled. Vite never sees the
    # developer's .env files, VITE_* variables, user npmrc or provider settings.
    with tempfile.TemporaryDirectory(prefix="sth-hermes-build-") as temporary:
        staging = Path(temporary).resolve()
        build, payload = staging / "build", staging / "payload"
        build.mkdir()
        payload.mkdir()
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS"}}
        for key in ("HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "TMPDIR"):
            env[key] = str(staging)
        empty_config = staging / "empty-config"
        empty_config.touch()
        empty_global = staging / "empty-global-config"
        empty_global.touch()
        env.update(NPM_CONFIG_USERCONFIG=str(empty_config), NPM_CONFIG_GLOBALCONFIG=str(empty_global),
                   NPM_CONFIG_CACHE=str(staging / "npm-cache"), GIT_CONFIG_NOSYSTEM="1",
                   GIT_CONFIG_GLOBAL=str(empty_config), GIT_TERMINAL_PROMPT="0")
        node_info = json.loads(_run([node, "-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"], staging, env))
        version = tuple(int(part) for part in node_info["version"].split("."))
        if version < (24, 15, 0):
            raise ValueError("Node >=24.15.0 is required to export this runtime.")
        for name in ("package.json", "package-lock.json", "vite.config.ts"):
            shutil.copyfile(ROOT / name, build / name)
        _copy_tree(ROOT / "src", build / "src", suffixes={".ts"})
        for name in ("workspace.mjs", "workspace-store.mjs", "workspace-runtime.mjs", "workspace-daemon.mjs"):
            target = build / "scripts" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "scripts" / name, target)
        _copy_tree(ROOT / "frontend", build / "frontend", suffixes=FRONTEND_SOURCE_SUFFIXES, exclude={"dist", "tests", "node_modules"})
        shutil.copyfile(ROOT / "frontend" / "tsconfig.json", build / "frontend" / "tsconfig.json")
        _copy_tree(ROOT / "web", build / "web", suffixes=ASSETS)
        _run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], build, env)
        _run([npm, "run", "build"], build, env)
        _run([npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], build, env)
        runtime = payload / "runtime"
        _copy_tree(build / "src", runtime / "src", suffixes={".ts"})
        _copy_tree(build / "scripts", runtime / "scripts", suffixes={".mjs"})
        _copy_tree(build / "web", runtime / "web", suffixes=ASSETS)
        _copy_tree(build / "frontend" / "dist", runtime / "frontend" / "dist", suffixes=ASSETS)
        _copy_tree(build / "node_modules", runtime / "node_modules")
        metadata = json.loads((build / "package.json").read_text(encoding="utf-8"))
        runtime_package = {key: metadata[key] for key in ("name", "version", "private", "type", "engines", "dependencies")}
        runtime_package["scripts"] = {"start": "node src/main.ts", "workspace": "node scripts/workspace.mjs"}
        (runtime / "package.json").write_text(json.dumps(runtime_package, indent=2) + "\n", encoding="utf-8")
        lock = json.loads((build / "package-lock.json").read_text(encoding="utf-8"))
        lock["packages"] = {key: value for key, value in lock["packages"].items() if not value.get("dev")}
        lock["packages"][""] = {key: value for key, value in runtime_package.items() if key not in ("type", "private", "scripts")}
        (runtime / "package-lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        binary = runtime / "bin" / ("node.exe" if node_info["platform"] == "win32" else "node")
        binary.parent.mkdir()
        shutil.copy2(node, binary)
        license_url = f"https://raw.githubusercontent.com/nodejs/node/v{node_info['version']}/LICENSE"
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(license_url, timeout=30) as response:
            license_text = response.read(2_000_001)
        if len(license_text) > 2_000_000 or b"Node.js" not in license_text or b"MIT" not in license_text:
            raise ValueError("The Node license could not be verified.")
        (binary.parent / "NODE-LICENSE.txt").write_bytes(license_text)
        for name in FILES:
            shutil.copyfile(source / name, payload / name)
        readme = """# Sth for Hermes

本包自带 Sth、Node、生产依赖和已构建网页。需要已配置模型的 Hermes 和 Git。
请保留解压目录，用 PowerShell 在该目录执行以下三步。

```powershell
hermes plugins install ([System.Uri](Get-Location).Path).AbsoluteUri --enable --force
hermes sth workspace create my-writing
hermes chat --cli --oneshot --toolsets sth-personal-operations --query '请保存今天的日记，标题是我的第一篇，正文是今天开始写作。保存后读取并给出网页链接。'
```

完整本地社区包含 Node 可执行文件和压缩前端，Hermes 扫描会给出 CAUTION。
上面的 --force 是 Hermes 为确认安装所提供的参数。请先核对分发者及 ZIP 的 SHA-256。

文件包与导出机器的操作系统和 CPU 架构对应。工作区在当前 Hermes profile 的
sth-workspaces 目录持久保存。关闭终端后继续运行，可用 hermes sth workspace stop
停止，用 start 恢复。升级前先 stop，安装新包后 start。数据独立于插件安装目录。

已有 Sth 可运行 hermes sth workspace connect <服务地址> --workspace existing，
在隐藏输入提示中输入该服务连接页的一次性连接码。外接服务无需创建本地工作区。
终端连接仅用于当前 profile 的原生终端会话。QQ 和微信仍需各自私聊配对。
"""
        (payload / "README.md").write_text(readme, encoding="utf-8")
        (payload / ".gitattributes").write_text("* -text\n", encoding="utf-8")
        manifest = {"format": 1, "runtime": node_info, "files": audit_payload(payload)}
        (payload / "distribution.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _run([str(binary), str(runtime / "scripts" / "workspace.mjs"), "--help"], staging, env)
        for command in ([git, "init", "--quiet", "--initial-branch=main", "--template="],
                        [git, "add", "--all"],
                        [git, "-c", "user.name=Sth plugin package", "-c", "user.email=sth-plugin@localhost",
                         "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Package self-contained Sth Hermes plugin"]):
            _run(command, payload, env)
        # Only the assembled public payload is published, including its own Git
        # history. The source checkout and build directory are never distributed.
        shutil.copytree(payload, destination)
    result = {"installIdentifier": destination.as_uri(), "directory": str(destination), "runtime": node_info,
              "fileCount": len(manifest["files"])}
    if archive:
        archive = archive.resolve()
        archive.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for path in sorted(destination.rglob("*")):
                if path.is_file():
                    bundle.write(path, Path(destination.name) / path.relative_to(destination))
        result.update(archive=str(archive), sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="必须为尚不存在的分发目录。")
    parser.add_argument("--archive", type=Path, help="另外生成可交给普通用户的 ZIP 包，目标文件需尚不存在。")
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.destination, archive=args.archive), ensure_ascii=False))
    except RuntimeError as error:
        parser.exit(1, str(error) + "\n")
    except (OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, "Plugin packaging failed. Check the build inputs, npm registry and Node >=24.15.0. Use new output paths.\n")
