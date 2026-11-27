"""Test real installed Hermes onboarding in an isolated profile and workspace.

Run with Hermes's Python and PYTHONPATH pointing at its installed source.
--real-model also runs two actual model sessions using only the selected model
provider's configuration, read from --source-home. No live records are opened.
"""

import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import urllib.request
from uuid import uuid4
import zipfile


ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "adapters" / "hermes_plugin"


def encode(value):
    return json.dumps(value, ensure_ascii=False)


def request(origin, path, payload=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(origin + path, data=None if payload is None else encode(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with opener.open(req, timeout=15) as response:
        return json.load(response)


def native_probe(fixture):
    from gateway.session_context import clear_session_vars, set_session_vars
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.plugins import get_plugin_manager
    from tools.registry import registry

    manager = get_plugin_manager()
    manager.discover_and_load()
    plugin = manager._plugins["sth-personal-operations"].module
    native, operations = plugin.native, plugin.operations
    fields = {"session_id": fixture["session"], "turn_id": "turn-1", "user_message": "保存今天的日记", "platform": "cli"}

    def tool(name, args, **options):
        value = registry.dispatch(name, args, scope=manager.scope_key, session_id=fields["session_id"], **options)
        return json.loads(value) if isinstance(value, str) else value

    def operation(name, step, value):
        return tool(operations.INVOKE, {"operationId": name, "stepId": step, "input": value})

    assert tool(operations.DISCOVER, {})["error"] == "personal_turn_required"
    policy = SimpleNamespace(source="oneshot", platform="cli")
    with patch("gateway.session_policy.active_policy", return_value=policy):
        tokens = set_session_vars(platform="local", session_id=fields["session_id"])
        try:
            hooks = invoke_hook("pre_llm_call", **fields)
            assert any(operations.DISCOVER in item.get("context", "") for item in hooks if isinstance(item, dict))
            binding = native.connection()
            assert binding and binding["origin"] == fixture["origin"]
            if os.name == "nt":
                storage = Path(os.environ["HERMES_HOME"]) / "sth-personal-operations" / f"{native.KEY}.binding"
                assert binding["token"].encode() not in storage.read_bytes()
            index = tool(operations.DISCOVER, {})
            if fixture["stage"] == "revoked":
                assert index["error"] == "connection_unauthorized"
                return {"revoked": True}
            assert any(item["id"] == "source.create" for item in index["operations"])
            if fixture["stage"] == "first":
                value = {"kind": "setting", "title": "Terminal fixture", "body": "A source saved from the native terminal."}
                saved = operation("source.create", "save", value)
                assert saved["replayed"] is False
                assert operation("source.create", "save", value) == {**saved, "replayed": True}
            else:
                saved = fixture["saved"]
                read = operation("source.read", "read", {"sourceId": saved["result"]["sourceId"]})
                assert read["result"] == saved["result"]
                receipt = tool(operations.RECEIPT, {"operationId": saved["operationId"], "stepId": saved["stepId"]})
                assert receipt == {**saved, "replayed": True}
            assert "result" in saved and binding["token"] not in encode(saved)
            assert operations.active_turn(session_id="another-session") is None
            # Caller-supplied platform fields cannot turn messaging, third-party
            # local integrations, delegation or cron into an owner terminal.
            for source, surface in (("tool", "cli"), ("telegram", "telegram"), ("qqbot", "qqbot"),
                                    ("weixin", "weixin"), ("gui", "desktop"), ("acp", "acp")):
                foreign = SimpleNamespace(source=source, platform=surface)
                with patch("gateway.session_policy.active_policy", return_value=foreign):
                    assert tool(operations.DISCOVER, {}, platform="cli")["error"] == "personal_turn_required"
                    assert native.begin_turn(fields) is None
                    assert native.end_turn(fields) is None
            with patch("agent.delegation_context.is_delegated_child_context", return_value=True):
                assert tool(operations.DISCOVER, {})["error"] == "personal_turn_required"
            with patch("hermes_constants.get_hermes_home", return_value=Path(os.environ["HERMES_HOME"]) / "unpaired-profile"):
                assert tool(operations.DISCOVER, {})["error"] == "personal_turn_required"
            assert tool(operations.DISCOVER, {})["operations"]
            finished = plugin.finish_turn(response_text="已保存", session_id=fields["session_id"])
            if fixture["stage"] == "first":
                assert saved["result"]["href"] in finished
            assert tool(operations.DISCOVER, {})["error"] == "personal_turn_required"
            return {"saved": saved, "isolationChecks": 10}
        finally:
            clear_session_vars(tokens)


def private_root():
    directory = Path(tempfile.mkdtemp(prefix="sth-hermes-onboarding-")).resolve()
    if os.name == "nt":
        identity = subprocess.check_output(["whoami.exe", "/user", "/fo", "csv", "/nh"], text=True)
        sid = re.search(r"S-1-[\d-]+", identity).group(0)
        subprocess.run(["icacls.exe", str(directory), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return directory


def run_acceptance(args):
    import yaml

    directory = private_root()
    home = directory / "profiles" / "fixture"
    home.mkdir(parents=True, mode=0o700)
    (directory / "config.yaml").write_text("{}", encoding="utf-8")
    (home / "config.yaml").write_text("{}", encoding="utf-8")
    source = Path(args.hermes_source).resolve()
    from pm.environments import project_python
    probe_python = str(project_python(source))
    executable = shutil.which("hermes")
    assert executable, "The installed hermes launcher must be on PATH."
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS"}}
    for key in ("HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TEMP", "TMP", "TMPDIR"):
        env[key] = str(directory)
    env.update(HERMES_HOME=str(home), PYTHONPATH=str(source), PYTHONIOENCODING="utf-8", HERMES_DISABLE_AUTO_UPDATE="1",
               HERMES_DISABLE_LAZY_INSTALLS="1", HERMES_NO_DOTENV_OVERRIDE="1")
    # The recipient has Hermes and Git, and no separately installed Node/npm.
    node_path = shutil.which("node")
    if node_path:
        env["PATH"] = os.pathsep.join(part for part in env["PATH"].split(os.pathsep)
                                      if Path(part).resolve() != Path(node_path).resolve().parent)
    assert shutil.which("node", path=env["PATH"]) is None
    hermes = [executable]
    secrets = []
    report = {"directory": str(directory), "profile": str(home), "checks": []}

    def run(command, *, text="", timeout=90, expected=0, log=None):
        completed = subprocess.run(command, cwd=directory, env=env, input=text.encode(), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        combined = completed.stdout + completed.stderr
        assert all(secret.encode() not in combined for secret in secrets), "A subprocess exposed a credential."
        if log:
            (directory / (log + ".stdout")).write_bytes(completed.stdout)
            (directory / (log + ".stderr")).write_bytes(completed.stderr)
        assert completed.returncode == expected, f"{command[-1] if not log else log} exited with {completed.returncode}; private diagnostics are under {directory}"
        return completed.stdout.decode("utf-8")

    def cli(*arguments, **options):
        return run([*hermes, *arguments], **options)

    def probe(stage, **fields):
        text = run([probe_python, "-B", "-X", "utf8", str(Path(__file__).resolve()), "--probe"],
                   text=encode({"stage": stage, "origin": report["origin"], "session": "native-" + stage, **fields}))
        return json.loads(text.split("NATIVE_QA ")[-1])

    workspace_started = False
    try:
        spec = importlib.util.spec_from_file_location("sth_package_plugin", PLUGIN / "package_plugin.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if args.distribution:
            archive = args.distribution.resolve()
            if archive.suffix == ".zip":
                with zipfile.ZipFile(archive) as bundle:
                    assert all(not Path(name).is_absolute() and ".." not in Path(name).parts for name in bundle.namelist())
                    bundle.extractall(directory / "received-package")
                sources = list((directory / "received-package").glob("*/plugin.yaml"))
                assert len(sources) == 1
                distribution = {"installIdentifier": sources[0].parent.as_uri()}
            else:
                distribution = {"installIdentifier": archive.as_uri()}
        else:
            distribution = module.package(directory / "plugin-source")
        # A fresh test data root has no Hermes dependency selection. Prepare
        # that root with official PM using the installed, ABI-matched Python.
        # The three user steps below all use the ordinary installed launcher.
        run([probe_python, "-m", "hermes_cli.main", "pm", "repair"], timeout=300, log="isolated-hermes-runtime")
        cli("plugins", "install", distribution["installIdentifier"], "--enable", "--force", timeout=150, log="install")
        help_text = cli("sth", "--help", log="help")
        assert "workspace" in help_text and "connect" in help_text
        cli("plugins", "doctor", "sth-personal-operations", "--ci", log="doctor")
        report["checks"].append("official_plugin_install_and_doctor")
        status = json.loads(cli("sth", "status", expected=1))
        assert status["connected"] is False
        installed = home / "plugins" / "sth-personal-operations"
        assert installed.is_dir()
        manifest = json.loads((installed / "distribution.json").read_text(encoding="utf-8"))
        actual = module.audit_payload(installed / "runtime")
        expected_files = [{**item, "path": item["path"].removeprefix("runtime/")} for item in manifest["files"] if item["path"].startswith("runtime/")]
        assert actual == expected_files
        assert not (installed / "runtime" / "node_modules" / "vite").exists()
        report["checks"].append("received_complete_runtime_and_production_dependencies_without_private_state")
        created = json.loads(cli("sth", "workspace", "create", "fixture", log="create"))
        workspace_started = True
        assert created["connected"] and created["owned"] and created["healthy"] and created["kind"] == "local"
        report["origin"] = created["origin"]
        report["workspaceId"] = created["id"]
        assert str(home) in created["dataDir"]
        with sqlite3.connect(f"{(home / 'sth-workspaces' / 'registry.sqlite').as_uri()}?mode=ro", uri=True) as db:
            runtime = json.loads(db.execute("SELECT runtime FROM workspaces WHERE id=?", (created["id"],)).fetchone()[0])
        assert Path(runtime["installationPath"]).resolve() == (installed / "runtime").resolve()
        report["runtimePath"] = runtime["installationPath"]
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for path in ("/", "/diaries", "/assets/app.js"):
            with opener.open(created["origin"] + path) as response:
                content = response.read().decode("utf-8")
                assert response.status == 200
                if path != "/assets/app.js":
                    assets = re.findall(r'(?:src|href)="(/vue/[^" ]+)"', content)
                    assert assets
                    for asset in assets:
                        with opener.open(created["origin"] + asset) as asset_response:
                            assert asset_response.status == 200 and asset_response.read()
        assert request(created["origin"], "/api/web/invoke", {"operationId": "diary.list", "stepId": "empty-first-diary", "input": {}})["result"]["items"] == []
        report["checks"].append("create_with_bundled_node_and_runtime_and_built_vue_web_without_repository")
        if args.real_model:
            configured = yaml.safe_load((args.source_home / "config.yaml").read_text(encoding="utf-8"))
            selected = copy.deepcopy(configured["model"])
            provider = selected["provider"]
            if args.model:
                selected["default"] = args.model
            provider_config = copy.deepcopy(configured["providers"][provider])
            for key, value in provider_config.items():
                if ("key" in key or "token" in key or "secret" in key) and isinstance(value, str) and len(value) >= 16:
                    secrets.append(value)
            isolated = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
            isolated.update(model=selected, providers={provider: provider_config},
                            agent={"run_budget_seconds": 240, "max_turns": 15},
                            tools={"tool_search": {"enabled": "off"}},
                            platform_toolsets={"cli": ["sth-personal-operations"]})
            (home / "config.yaml").write_text(encode(isolated), encoding="utf-8")
            title = "我的首篇日记-" + uuid4().hex[:12]
            body = "这是实际 Hermes 模型通过原生插件保存的隔离测试日记。-" + uuid4().hex
            prompts = [f"请直接保存今天的日记，标题是「{title}」，正文逐字为「{body}」。保存后读取该篇日记，核对完整正文，并给出网页链接。请执行保存和读取。",
                       f"这是一个新会话。请从已连接的 Sth 工作区找到标题为「{title}」的日记，读取并给出其完整正文和 revision。"]
            model_reports = []
            for index, prompt in enumerate(prompts, 1):
                print(f"Running isolated Hermes model session {index}", flush=True)
                cli("chat", "--cli", "--oneshot", "--ignore-rules", "--toolsets", "sth-personal-operations", "--max-turns", "15",
                    "--format", "stream-json", "--query-file", "-", text=prompt, timeout=300, log=f"model-{index}")
                with sqlite3.connect(f"{(home / 'state.db').as_uri()}?mode=ro", uri=True) as db:
                    session = db.execute("SELECT id,model,tool_call_count FROM sessions ORDER BY started_at DESC LIMIT 1").fetchone()
                    rows = db.execute("SELECT content FROM messages WHERE session_id=? AND role='tool' ORDER BY id", (session[0],)).fetchall()
                receipts = []
                for (content,) in rows:
                    # Hermes may wrap untrusted tool data in its transport envelope.
                    match = re.search(r'\{"operationId":.*\}', content or "", flags=re.S)
                    if match:
                        try:
                            value, _ = json.JSONDecoder().raw_decode(match[0])
                        except ValueError:
                            continue
                        if "result" in value and "stepId" in value:
                            receipts.append(value)
                assert session and session[1] == selected["default"] and receipts
                assert any(r["operationId"] == "diary.read" and r["result"].get("body") == body for r in receipts)
                if index == 1:
                    assert any(r["operationId"] == "diary.create" and r["result"].get("body") == body for r in receipts)
                model_reports.append({"sessionId": session[0], "model": session[1], "toolCalls": session[2],
                                      "operations": [r["operationId"] for r in receipts]})
            assert model_reports[0]["sessionId"] != model_reports[1]["sessionId"]
            search = request(created["origin"], "/api/web/invoke", {"operationId": "diary.list", "stepId": "web-check-model", "input": {}})
            items = search["result"]["items"]
            assert len(items) == 1 and items[0]["title"] == title
            report["modelSessions"] = model_reports
            report["checks"].append("real_model_native_save_and_fresh_session_read")
        first = probe("first")
        restarted = probe("restart", saved=first["saved"])
        assert restarted["saved"] == first["saved"]
        report["checks"].extend(["native_save_replay_and_result_link", "new_process_read_and_original_receipt", "deny_foreign_platform_profile_delegation_and_session"])
        web = request(created["origin"], "/api/web/invoke", {"operationId": "source.read", "stepId": "web-read-native",
                       "input": {"sourceId": first["saved"]["result"]["sourceId"]}})
        assert web["result"] == first["saved"]["result"]
        before_restart = json.loads(cli("sth", "status"))["connectionId"]
        relaunched = json.loads(cli("sth", "workspace", "restart", "--workspace", "fixture", log="restart"))
        assert relaunched["origin"] == created["origin"] and relaunched["connectionId"] == before_restart
        assert probe("restart", saved=first["saved"])["saved"] == first["saved"]
        report["checks"].append("daemon_restart_preserves_data_and_terminal_connection")
        code = request(created["origin"], "/api/web/connections/code", {})["code"]
        secrets.append(code)
        connected = json.loads(cli("sth", "workspace", "connect", created["origin"], "--workspace", "existing", text=code + "\n", log="connect"))
        assert connected["connected"] and connected["kind"] == "connected"
        report["checks"].append("connect_existing_workspace_with_stdin_code")
        assert json.loads(cli("sth", "status"))["connected"]
        connection_id = json.loads(cli("sth", "status"))["connectionId"]
        request(created["origin"], f"/api/web/connections/{connection_id}/revoke", {})
        assert probe("revoked")["revoked"]
        cli("sth", "status", expected=1)
        cli("sth", "disconnect")
        assert json.loads(cli("sth", "status", expected=1))["connected"] is False
        report["checks"].append("revocation_and_profile_local_disconnect")
        report["passed"] = True
    finally:
        if args.real_model:
            for target, label in ((home, "profile"), (directory, "root")):
                env["HERMES_HOME"] = str(target)
                try:
                    cli("gateway", "stop", timeout=45, log="gateway-stop-" + label)
                except (AssertionError, subprocess.SubprocessError):
                    report["gatewayStopFailed"] = True
            env["HERMES_HOME"] = str(home)
        if workspace_started:
            cli("sth", "workspace", "stop", "--workspace", "fixture", timeout=45, log="stop")
        # Preserve isolated evidence but remove the copied provider credentials.
        for pattern in ("config.yaml*", ".env", ".env.bak*", "auth.json*", "credential_pool.json*"):
            for path in home.rglob(pattern):
                if path.is_file():
                    path.unlink()
        (directory / "report.json").write_text(encode(report), encoding="utf-8")
    print(encode(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--hermes-source", type=Path, default=Path(os.environ.get("STH_TEST_HERMES_SOURCE", ".")))
    parser.add_argument("--distribution", type=Path, help="完整插件 ZIP 或独立 Git 分发目录，省略时重新导出。")
    parser.add_argument("--real-model", action="store_true")
    parser.add_argument("--source-home", type=Path)
    parser.add_argument("--model")
    args = parser.parse_args()
    if args.probe:
        print("NATIVE_QA " + encode(native_probe(json.load(sys.stdin))))
    else:
        if args.real_model and not args.source_home:
            parser.error("--real-model requires --source-home containing the selected model configuration")
        run_acceptance(args)
