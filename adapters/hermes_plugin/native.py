"""Owner-terminal onboarding and native Hermes turn admission.

The terminal binding is deliberately separate from every messaging binding.
Only the host's session surface can admit it, never model-supplied arguments.
"""

import getpass
import json
import sys
import time
import subprocess
from datetime import datetime, timezone
from threading import Lock
from types import SimpleNamespace

from . import personal_operations as operations
from .personal_credentials import prepare_storage, read_binding, save_binding, valid_claim


KEY = operations._digest(("sth-native-terminal-v1",))
LOCAL_SURFACES = frozenset({"cli", "oneshot", "tui"})
SETUP = "请先在终端运行 hermes sth connect --origin <Sth 服务地址>，或运行 hermes sth workspace --help 创建独立工作区。"
_context = None
_turns = {}
_lock = Lock()


def _local_surface():
    if _context is None or _context.session_surface() not in LOCAL_SURFACES:
        return False
    from agent.delegation_context import is_delegated_child_context
    from gateway.session_context import _SESSION_TURN_EVENT, get_session_env
    from gateway.session_policy import active_policy

    # A tool cannot borrow the terminal credential from cron, a delegated agent,
    # or a messaging event even if another local turn ran in the same process.
    event = _SESSION_TURN_EVENT.get()
    policy = active_policy()
    return (not is_delegated_child_context()
            and (policy is None or policy.source in LOCAL_SURFACES)
            and get_session_env("HERMES_SESSION_SOURCE") in ("", *LOCAL_SURFACES)
            and get_session_env("HERMES_CRON_SESSION") != "1"
            and (event is None or (not event.internal and event.source.platform.value == "local")))


def connection():
    binding = read_binding(KEY)
    if not binding:
        return None
    origin = operations._normalize_origin(binding.get("origin", ""))
    return {**binding, "origin": origin}


def begin_turn(fields):
    """Remember host-generated turn identity before any model tool runs."""
    if not _local_surface():
        return None
    session, turn_id = fields.get("session_id"), fields.get("turn_id")
    if not operations._stable_id(session) or not operations._stable_id(turn_id):
        return None
    binding = connection()
    if not binding:
        return {"context": "Sth 终端连接尚未设置。" + SETUP}
    event = SimpleNamespace(text=fields.get("user_message") or "", timestamp=datetime.now(timezone.utc))
    turn = operations.Turn(binding["origin"], binding["token"],
                           "sth.hermes.cli.v1:" + operations._digest((session, turn_id)), event)
    with _lock:
        now = time.monotonic()
        for key, (expires, _) in list(_turns.items()):
            if expires <= now:
                del _turns[key]
        if session not in _turns and len(_turns) >= 256:
            del _turns[next(iter(_turns))]
        _turns[session] = (now + 86400, turn)
    return {"context": operations.turn_guidance(turn)}


def active_turn(fields):
    if not _local_surface():
        return None
    session = fields.get("session_id")
    if not operations._stable_id(session):
        return None
    with _lock:
        expires, turn = _turns.get(session, (0, None))
    if expires <= time.monotonic():
        return None
    # Re-read on every call so disconnect/rebind takes effect in running sessions.
    binding = connection()
    if not binding or binding["origin"] != turn.origin or binding["token"] != turn.token:
        return None
    return turn


def end_turn(fields):
    turn = active_turn(fields)
    if turn:
        with _lock:
            _turns.pop(fields.get("session_id"), None)
    return turn


def connect(origin, code):
    origin = operations._normalize_origin(origin)
    if not isinstance(code, str) or not operations.CODE.fullmatch(code):
        raise ValueError("请输入有效的一次性连接码。")
    prepare_storage(check_write=True)
    status, claim = operations._post(origin, "/claim", {"code": code, "clientName": "Sth Hermes Terminal"})
    if not 200 <= status < 300 or not valid_claim(claim):
        raise ValueError("无法连接 Sth。请核对服务地址并生成新的连接码。")
    save_binding(operations._digest(("sth-native-origin-v1", origin)), claim, None, origin=origin)
    save_binding(KEY, claim, None, origin=origin)
    return {"connected": True, "origin": origin, "connectionId": claim["connectionId"]}


def setup_parser(parser):
    subparsers = parser.add_subparsers(dest="sth_command", required=True)
    pair = subparsers.add_parser("connect", help="连接现有 Sth 工作区，一次性码由隐藏输入或 stdin 读取。")
    pair.add_argument("--origin", required=True, help="HTTPS 或本机 loopback HTTP 服务地址。")
    subparsers.add_parser("status", help="核验当前 profile 的终端连接。")
    subparsers.add_parser("disconnect", help="删除本 profile 的终端凭据，在 Sth 连接页撤销服务端连接。")
    from .workspace_cli import setup_parser as workspace_parser
    workspace_parser(subparsers)


def run_cli(args):
    try:
        if args.sth_command == "connect":
            code = getpass.getpass("Sth 一次性连接码 ") if sys.stdin.isatty() else sys.stdin.readline(256).strip()
            result = connect(args.origin, code)
        elif args.sth_command == "status":
            binding = connection()
            if not binding:
                result = {"connected": False, "message": SETUP}
            else:
                status, catalog = operations._post(binding["origin"], "/catalog", {"view": "index"}, binding["token"])
                result = {"connected": status == 200 and isinstance(catalog.get("operations"), list),
                          "origin": binding["origin"], "connectionId": binding["connectionId"]}
                if not result["connected"]:
                    result["message"] = "连接不可用，请检查服务或重新连接。"
        elif args.sth_command == "disconnect":
            from .personal_credentials import binding_directory
            binding = connection()
            (binding_directory() / f"{KEY}.binding").unlink(missing_ok=True)
            if binding:
                key = operations._digest(("sth-native-origin-v1", binding["origin"]))
                (binding_directory() / f"{key}.binding").unlink(missing_ok=True)
            result = {"connected": False, "message": "已删除本 profile 的终端凭据。可在 Sth 连接页撤销服务端连接。"}
        else:
            from .workspace_cli import run_workspace
            result = run_workspace(args)
        print(json.dumps(result, ensure_ascii=False))
        if result.get("connected") is False and args.sth_command == "status":
            raise SystemExit(1)
        if args.sth_command == "workspace" and ((args.action == "status" and not result.get("healthy"))
                                                or (args.action == "doctor" and not result.get("passed"))):
            raise SystemExit(1)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # HTTP bodies, subprocess diagnostics and exception strings may contain secrets.
        print(json.dumps({"error": "sth_setup_failed", "message": "Sth 设置失败。请核对服务、工作区 CLI 与当前 profile 的私有存储。"}, ensure_ascii=False))
        raise SystemExit(1) from None


def register(ctx):
    global _context
    _context = ctx
    ctx.register_cli_command("sth", "连接或创建 Sth 工作区。", setup_parser, run_cli)
