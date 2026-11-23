"""Exercise installed Hermes with a temporary profile and no external transports."""

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from agent.turn_finalizer import apply_llm_output_transform
from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.event import MessageEvent
from gateway.run import GatewayRunner
from gateway.session import SessionSource
from gateway.session_context import clear_session_vars, set_session_vars
from hermes_cli.config import load_config
from hermes_cli.lifecycle import invoke_hook
from hermes_cli.plugins import get_plugin_manager
from model_tools import get_tool_definitions
from tools.registry import registry


FIXTURE = json.loads(os.environ["STH_PERSONAL_FIXTURE"])
STAGE = FIXTURE["stage"]
DISCOVER = "sth_personal_discover"
INVOKE = "sth_personal_invoke"
AUTHOR = "fixture-author"
MODEL = "fixture-selected-in-Hermes"


def event(text, message_id, *, platform=Platform.QQBOT, sender=AUTHOR, chat=None, chat_type="dm", **source_fields):
    timestamp = datetime(2024, 2, 29 if STAGE == "first" else 28, 12, tzinfo=timezone.utc)
    return MessageEvent(text=text, message_id=message_id, timestamp=timestamp, source=SessionSource(
        platform=platform, chat_id=chat or sender, user_id=sender, chat_type=chat_type, **source_fields))


async def main():
    if FIXTURE.get("portal"):
        os.environ["STH_PERSONAL_OPERATIONS_PORTAL_ORIGIN"] = FIXTURE["portal"]
    manager = get_plugin_manager()
    manager.discover_and_load()
    assert {DISCOVER, INVOKE} <= set(manager._plugin_tool_names)
    plugin = manager._plugins["sth-personal-operations"].module.operations

    def tool(name, args):
        output = registry.dispatch(name, args, scope=manager.scope_key)
        return json.loads(output) if isinstance(output, str) else output

    def operation(name, step, input, **options):
        return tool(INVOKE, {"operationId": name, "stepId": step, "input": input, **options})

    assert tool(DISCOVER, {})["error"] == "personal_turn_required"
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(platforms={p: PlatformConfig(enabled=True) for p in (Platform.QQBOT, Platform.WEIXIN)})
    sent = AsyncMock()
    qq = SimpleNamespace(send=sent, _app_id="fixture-qq-bot", is_connected=True)
    wx = SimpleNamespace(send=sent, _account_id="fixture-wechat-bot", is_connected=True)
    runner.adapters = {Platform.QQBOT: qq, Platform.WEIXIN: wx}
    runner.session_store = MagicMock()
    runner.pairing_store = SimpleNamespace(is_approved=lambda *_: False)
    runner._get_unauthorized_dm_behavior = lambda *_args, **_kwargs: "ignore"
    runner._hm_report_ignored_dm = AsyncMock()
    runner._delivery_adapter_for = lambda source: runner.adapters[source.platform]
    runner._intake_adapter_for = runner._delivery_adapter_for
    runner._authorization_adapter = lambda platform, _profile: runner.adapters[platform]
    runner._shared_bot_target_allowed = lambda *_args: True
    runner._rescue_orphaned_overflow = lambda _key, _adapter: None
    runner._enqueue_fifo = MagicMock()
    runner._run_post_turn_hooks = AsyncMock()
    config = load_config()
    writes = []

    def model(message, source, key):
        assert "sth personal connect" not in message.text
        hooks = invoke_hook("pre_llm_call", session_id=key, user_message=message.text, model=MODEL)
        enabled, disabled = runner._resolve_turn_toolsets(config, source, source.platform.value)
        definitions = get_tool_definitions(enabled, disabled, quiet_mode=True, skip_tool_search_assembly=True)
        assert {DISCOVER, INVOKE} <= {item["function"]["name"] for item in definitions}
        if message.text == "你好":
            assert not hooks
            assert tool(DISCOVER, {})["error"] == "personal_turn_required"
            return "普通 Hermes 回复"
        assert any(DISCOVER in item.get("context", "") for item in hooks if isinstance(item, dict))
        catalog = tool(DISCOVER, {})
        if STAGE == "revoked":
            assert catalog["error"] == "connection_unauthorized"
            return "连接已撤销"
        operations = catalog["operations"]
        assert {"project.list", "character.read", "diary.create", "diary.read", "diary.revise"} <= {item["id"] for item in operations}
        assert all(item["inputSchema"] and item["outputSchema"] for item in operations)
        assert operation("diary.create", "spoof", {}, token="spoof")["error"]
        if source.platform == Platform.WEIXIN:
            read = operation("diary.read", "read", {"noteId": FIXTURE["noteId"]})
            assert read["result"]["body"] == FIXTURE["webBody"]
            return MODEL

        draft = {"title": "港口日记", "body": "我看见了晚潮。", "diaryDate": "今天"}
        if STAGE == "multiple":
            original = plugin._post

            def catalog_with_identity(origin, endpoint, body, token=None):
                status, value = original(origin, endpoint, body, token)
                if endpoint == "/catalog" and status == 200:
                    diary = next(item for item in value["operations"] if item["id"] == "diary.create")
                    diary["interaction"]["identityFields"] = ["characterId", "diaryDate"]
                return status, value

            for ordinal in (1, 2):
                with patch.object(plugin, "_post", side_effect=catalog_with_identity):
                    stored = operation("diary.create", "write", draft, occurrence=ordinal)
                    assert not stored["replayed"] and "projectId" not in stored["result"]
                    assert stored["result"]["diaryDate"] == "2024-02-28"
                    assert operation("diary.create", "retry", draft, occurrence=ordinal) == {**stored, "replayed": True}
                    recovered = operation("diary.create", "changed-step", {**draft, "body": "Regenerated"}, occurrence=ordinal)
                    assert recovered["replayed"] and recovered["result"] == stored["result"]
                    assert "未写入" in recovered["replayNotice"]
                writes.append(stored)
            assert writes[0]["result"]["noteId"] != writes[1]["result"]["noteId"]
            return MODEL

        options = operation("character.list", "resolve", {"name": "林岚"})
        actor = options["result"]["items"][0]
        persona = operation("character.read", "persona", {"characterId": actor["characterId"]})
        assert persona["result"]["persona"] == "网页保存的人设"
        assert any("本地日期是 2024-02-29" in item.get("context", "") for item in hooks if isinstance(item, dict))
        draft.update(characterId=actor["characterId"], expectedCharacterRevision=actor["revision"])
        write = operation("diary.create", "save-diary", draft)
        assert write["replayed"] == (STAGE == "restart")
        assert write["result"]["diaryDate"] == "2024-02-29"
        assert len({options["stepId"], persona["stepId"], write["stepId"]}) == 3
        conflict = operation("diary.create", "save-diary", {**draft, "body": "Regenerated draft"})
        assert conflict["error"] == "operation_step_conflict"
        stale = operation("diary.revise", "stale", {"noteId": write["result"]["noteId"], "expectedRevision": 99,
                                                   "title": draft["title"], "body": "Unexpected edit", "diaryDate": "2024-02-29"})
        assert stale["error"] == "diary_revision_conflict"
        assert operation("diary.create", "save-diary", draft) == {**write, "replayed": True}
        writes.append(write)
        return MODEL

    async def agent(message, source, key, _generation):
        tokens = set_session_vars(platform=source.platform.value, session_key=key,
                                  chat_id=source.chat_id, user_id=source.user_id, turn_event=message)
        try:
            def run_and_finish():
                text = model(message, source, key)
                agent_config = SimpleNamespace(session_id=key, model=MODEL, _hold_stream=True,
                                               _held_transforms=manager.held_transforms())
                reply, transformed, _ = apply_llm_output_transform(agent_config, text, turn_id=message.message_id)
                if writes:
                    assert transformed
                    for write in writes:
                        saved = write["result"]
                        assert saved.get("portalUrl", saved["href"]) in reply and saved["title"] in reply
                    if STAGE == "multiple":
                        assert "本次重新生成的内容未写入" in reply
                return reply
            return await asyncio.to_thread(run_and_finish)
        finally:
            clear_session_vars(tokens)

    runner._handle_message_with_agent = agent
    with patch("gateway.run._gateway_runner_ref", return_value=runner):
        if STAGE == "first":
            help_reply = await runner._handle_message(event("sth personal help", "help"))
            assert "个人连接码" in help_reply
            command = "sth personal connect " + FIXTURE["code"]
            for refused in (event(command, "group", chat_type="group"), event(command, "shared", shared_session=True),
                            event(command, "thread", thread_id="thread"), event(command, "other-chat", chat="other")):
                reply = await runner._handle_message(refused)
                assert "已连接 Sth" not in reply and FIXTURE["code"] not in reply
            assert await runner._handle_message(event(command, "unauthorized", sender="not-allowed")) is None
            assert await runner._handle_message(event("你好", "ordinary-before")) == "普通 Hermes 回复"
        if "code" in FIXTURE:
            platform = Platform.WEIXIN if STAGE == "wechat" else Platform.QQBOT
            for _ in range(2):
                reply = await runner._handle_message(event("sth personal connect " + FIXTURE["code"], f"connect-{STAGE}", platform=platform))
                assert "已连接 Sth" in reply and FIXTURE["code"] not in reply
            adapter = runner.adapters[platform]
            identity = (platform.value, getattr(adapter, plugin.PLATFORMS[platform.value]), AUTHOR)
            key = plugin._digest((plugin._origin(), *identity))
            binding = plugin.read_binding(key)
            assert set(binding) == {"key", "connectMessage", "token", "connectionId"}
            assert binding["token"] not in reply
            if os.name == "nt":
                stored = Path(os.environ["HERMES_HOME"], "sth-personal-operations", f"{key}.binding").read_bytes()
                assert binding["token"].encode() not in stored
        if STAGE == "restart":
            qq._app_id = "different-bot"
            assert await runner._handle_message(event("你好", "different-bot")) == "普通 Hermes 回复"
            qq._app_id = "fixture-qq-bot"
            assert await runner._handle_message(event("你好", "different-peer", sender="fixture-other")) == "普通 Hermes 回复"
        if STAGE == "wechat":
            reply = await runner._handle_message(event("读刚才的日记", "read-diary", platform=Platform.WEIXIN))
        else:
            delivery = "diary-delivery-multiple" if STAGE == "multiple" else "diary-delivery-1"
            reply = await runner._handle_message(event("用最新设定写今天的日记", delivery))
        assert MODEL in reply or reply == "连接已撤销"
        sent.assert_not_awaited()
    print("PERSONAL_QA " + json.dumps({"write": writes[0] if writes else None, "writes": writes}))


if __name__ == "__main__":
    asyncio.run(main())
