"""Agent runner: the Anthropic call wrapper + agentic tool loop.

Every request goes through:
  1. Rate limit reservation (buckets acquired by the orchestrator worker).
  2. A shared, FROZEN system-prompt prefix (platform header + shared rules)
     cached with `cache_control: ephemeral` — the per-agent persona is
     appended AFTER the breakpoint so it can vary freely.
  3. Streaming via `client.messages.stream(...)` — thinking deltas, text
     deltas, and tool-input fragments are all yielded to the caller.
  4. Tool use loop: `tool_use` blocks run through backend.tools, results
     appended, loop continues until end_turn / refusal.
  5. Error handling: a most-specific-first exception chain. 429 honors
     retry-after; 529/5xx/network get exponential backoff with jitter. The
     SDK's built-in retries are disabled (max_retries=0) so the loop owns
     pacing end-to-end.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from pathlib import Path
from typing import Any, AsyncIterator

import anthropic
from anthropic import AsyncAnthropic

from backend.tools import ToolRegistry, ApprovalRequired

log = logging.getLogger("aiemployer.runner")

# Default worker model. Override with AIEMPLOYER_MODEL (e.g. when routing
# through a gateway/proxy that serves different model ids).
MODEL = os.environ.get("AIEMPLOYER_MODEL", "claude-opus-5")
MAX_TOKENS = 32_000          # well clear of the ~10min non-stream guard
MAX_TOOL_ROUNDS = 25

# Frozen shared prefix — cached once, read by every agent/task. Must contain
# NO per-request volatility (no timestamps, ids, task text).
SHARED_SYSTEM_PREFIX = """You are an autonomous AI employee inside the "AI Employer" \
desktop application. A human employer assigns you tasks; you complete them \
using your available tools, thinking step by step and verifying your work.

Operating rules:
- Work toward the task's stated goal; don't stop to ask questions unless \
truly blocked.
- Prefer tools over guessing: read files before editing, verify before \
reporting done.
- Keep final answers concise and actionable.
"""

# ---- prompt caching ---------------------------------------------------------
# tools + SHARED_SYSTEM_PREFIX are the shared prefix; the breakpoint sits on
# the last system block so both are cached together (tools render first).
# Per-agent persona and task payload are appended after it and never cached.
#
# Verify it's working: response.usage.cache_read_input_tokens must grow turn
# over turn. If it stays 0, something above leaked per-request data into the
# prefix (the classic bugs: timestamps, uuids, unsorted JSON).


def build_system(agent_persona: str) -> list[dict[str, Any]]:
    """Frozen cached prefix, then the volatile per-agent persona."""
    return [
        {
            "type": "text",
            "text": SHARED_SYSTEM_PREFIX,
            "cache_control": {"type": "ephemeral"},
        },
        # Persona varies per agent — deliberately AFTER the breakpoint.
        {"type": "text", "text": agent_persona},
    ]


# ---- retry policy -----------------------------------------------------------

MAX_RETRIES = 5
BASE_DELAY = 1.0
MAX_DELAY = 60.0


async def _sleep_backoff(attempt: int, retry_after: float | None = None) -> float:
    if retry_after is not None:
        delay = retry_after + random.uniform(0, 1.0)   # jitter
    else:
        delay = min(BASE_DELAY * (2 ** attempt) + random.uniform(0, 1.0), MAX_DELAY)
    await asyncio.sleep(delay)
    return delay


def _retry_after_of(exc: anthropic.RateLimitError) -> float | None:
    try:
        return float(exc.response.headers.get("retry-after"))
    except (TypeError, ValueError, AttributeError):
        return None


async def _stream_turn(
    client: AsyncAnthropic,
    payload: dict[str, Any],
    emitter: "EventSink",
) -> anthropic.types.Message:
    """One streaming API turn; yields reasoning/text/tool-input to emitter."""
    async with client.messages.stream(**payload) as stream:
        async for event in stream:
            et = event.type
            if et == "content_block_start":
                if event.content_block.type == "thinking":
                    await emitter.emit("thinking_start", {"preview": "[thinking…]"})
                elif event.content_block.type == "text":
                    await emitter.emit("text_start", {})
                elif event.content_block.type == "tool_use":
                    await emitter.emit(
                        "tool_call_start",
                        {"name": event.content_block.name, "id": event.content_block.id},
                    )
            elif et == "content_block_delta":
                d = event.delta
                if d.type == "thinking_delta":
                    await emitter.emit("thinking_delta", {"text": d.thinking})
                elif d.type == "text_delta":
                    await emitter.emit("text_delta", {"text": d.text})
                elif d.type == "input_json_delta":
                    # Eager tool-input streaming: fragment arrives live.
                    await emitter.emit("tool_input_delta", {"json": d.partial_json})
            elif et == "message_delta" and event.usage:
                await emitter.emit(
                    "usage",
                    {"output_tokens": event.usage.output_tokens},
                )
        return await stream.get_final_message()


class EventSink:
    """Consumes runner events — the SSE layer and DB logger both hook here."""

    async def emit(self, kind: str, data: dict[str, Any]) -> None:
        raise NotImplementedError


# ---- main loop --------------------------------------------------------------

async def run_agent(
    client: AsyncAnthropic,
    tools_registry: ToolRegistry,
    agent: dict[str, Any],
    task: dict[str, Any],
    emitter: EventSink,
    workspace: Path,
) -> dict[str, int]:
    """Run one task through the agentic loop. Returns actual token usage."""
    api_tools = tools_registry.to_api_schema()
    system = build_system(agent.get("persona") or agent.get("system_prompt") or "")

    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": task.get("description") or ""},
            ],
        }
    ]

    total_in = 0
    total_out = 0
    round_no = 0
    json_retries = 0

    while True:
        round_no += 1
        if round_no > MAX_TOOL_ROUNDS:
            await emitter.emit("log", {"text": "[runner] max tool rounds reached; stopping"})
            break

        payload: dict[str, Any] = {
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "tools": api_tools,
            "messages": messages,
            "thinking": {"type": "adaptive", "display": "summarized"},
            "output_config": {"effort": "high"},
        }

        # ---- send with retries ----------------------------------------
        for attempt in range(MAX_RETRIES):
            try:
                response = await _stream_turn(client, payload, emitter)
                json_retries = 0
                break
            except ValueError:
                # Unparseable tool-input JSON raised from the stream iterator
                # (eager streaming). The tool_use block never completed, so
                # there is no tool_use_id to answer — re-issue the turn,
                # bounded on consecutive failures of this one turn.
                json_retries += 1
                if json_retries > 2:
                    raise
                continue
            except anthropic.RateLimitError as e:
                if attempt == MAX_RETRIES - 1:
                    raise
                retry_after = _retry_after_of(e)
                delay = await _sleep_backoff(attempt, retry_after)
                await emitter.emit("log", {"text": f"[runner] 429 rate limited; retry in {delay:.1f}s"})
            except anthropic.APIStatusError as e:  # includes 529 overloaded
                if attempt == MAX_RETRIES - 1:
                    raise
                if e.status_code < 500:
                    raise  # non-retryable client error
                delay = await _sleep_backoff(attempt)
                await emitter.emit("log", {"text": f"[runner] {e.status_code} server error; retry in {delay:.1f}s"})
            except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
                if attempt == MAX_RETRIES - 1:
                    raise
                delay = await _sleep_backoff(attempt)
                await emitter.emit("log", {"text": f"[runner] {type(e).__name__}; retry in {delay:.1f}s"})

        # usage accounting
        u = response.usage
        total_in += (u.input_tokens or 0) + (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0)
        total_out += u.output_tokens or 0
        await emitter.emit(
            "turn_usage",
            {
                "input_tokens": u.input_tokens,
                "cache_read": u.cache_read_input_tokens,
                "cache_write": u.cache_creation_input_tokens,
                "output_tokens": u.output_tokens,
            },
        )

        # safety refusals — never run tools
        if response.stop_reason == "refusal":
            await emitter.emit("log", {"text": "[runner] model refused (stop_reason=refusal)"})
            break

        # server-side pause — re-send turn verbatim
        if response.stop_reason == "pause_turn":
            messages.append({"role": "assistant", "content": response.content})
            continue

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            break  # end_turn / max_tokens — task finished

        if response.stop_reason == "max_tokens":
            await emitter.emit("log", {"text": "[runner] output truncated (max_tokens); raising cap advised"})

        # ---- execute tools ---------------------------------------------
        messages.append({"role": "assistant", "content": response.content})
        results: list[dict[str, Any]] = []
        for block in tool_uses:
            name = block.name
            args = block.input
            # eager streaming can deliver truncated/partial input
            if not isinstance(args, dict):
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "is_error": True,
                        "content": json.dumps({"INVALID_JSON": json.dumps(args, default=str)}),
                    }
                )
                continue
            await emitter.emit("tool_exec", {"name": name, "args": args})
            try:
                out = await tools_registry.execute(name, args, workspace=workspace, agent_id=agent["id"])
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": str(out)})
            except ApprovalRequired as gate:
                # Human-in-the-loop: ask the UI, await the verdict.
                decision = await emitter.request_approval(
                    {"tool": name, "args": args, "reason": str(gate)}
                )
                if decision != "approve":
                    results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                         "content": "denied by human approver"}
                    )
                else:
                    out = await tools_registry.execute_approved(
                        name, args, workspace=workspace, agent_id=agent["id"]
                    )
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": str(out)})
            except Exception as e:  # noqa: BLE001 — tool failure is a result, not a crash
                results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                     "content": f"{type(e).__name__}: {e}"}
                )

        messages.append({"role": "user", "content": results})

    return {"input_tokens": total_in, "output_tokens": total_out}


def make_client() -> AsyncAnthropic:
    return AsyncAnthropic(max_retries=0)  # we own the retry loop