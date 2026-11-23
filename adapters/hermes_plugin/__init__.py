"""Hermes entry point for Sth personal operations."""

from . import personal_operations as operations


def turn_guidance(**fields):
    prompt = fields.get("user_prompt") or fields.get("user_message") or ""
    if operations.CONNECT.search(prompt):
        return {"action": "block", "message": operations.CONNECT_HELP}
    turn = operations.active_turn()
    if turn:
        return {"context": operations.turn_guidance(turn)}
    return None


def finish_turn(*, response_text, **_fields):
    if not isinstance(response_text, str) or not response_text.strip():
        return None
    turn = operations.active_turn()
    return operations.finish_reply(turn, response_text) if turn else None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", operations.shield_connect_code)
    ctx.register_hook("post_gateway_admission", operations.handle_message)
    ctx.register_hook("pre_llm_call", turn_guidance)
    ctx.register_hook("transform_llm_output", finish_turn, hold_stream=True)
    operations.register_tools(ctx)
