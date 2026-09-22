"""Pluggable local tool engine.

Tools are declared to the model with JSON schemas (tools render at position
0 of the prompt, so the list must be deterministic — we sort by name).
Execution is sandboxed to the agent's workspace root; `elevated` tools
(terminal commands, unrestricted writes) raise ApprovalRequired so the
runner can route them through the human-in-the-loop UI.

Path security: every path argument is model output — untrusted. Resolve and
verify it stays inside the workspace before touching disk.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

MAX_FILE_BYTES = 512_000
MAX_COMMAND_TIMEOUT = 120


class ApprovalRequired(Exception):
    """Raised by elevated tools; the runner routes it to the employer UI."""


class ToolRegistry:
    def __init__(self) -> None:
        self.tools: dict[str, dict[str, Any]] = {}

    def register(
        self,
        name: str,
        description: str,
        schema: dict[str, Any],
        handler: Any,
        elevated: bool = False,
    ) -> None:
        self.tools[name] = {
            "name": name,
            "description": description,
            "input_schema": schema,
            "handler": handler,
            "elevated": elevated,
        }

    # -- API schema (deterministic order — see prompt-caching notes) --------
    def to_api_schema(self, allowed: list[str] | None = None) -> list[dict[str, Any]]:
        names = sorted(self.tools) if allowed is None else sorted(set(allowed) & set(self.tools))
        out = []
        for n in names:
            t = self.tools[n]
            out.append(
                {
                    "name": t["name"],
                    "description": t["description"],
                    "input_schema": t["input_schema"],
                    "eager_input_streaming": True,
                }
            )
        return out

    def _resolve(self, workspace: Path, path: str) -> Path:
        """Confine model-supplied paths to the workspace root."""
        target = (workspace / path).resolve()
        root = workspace.resolve()
        if not (target == root or target.is_relative_to(root)):
            raise ValueError(f"path escapes workspace root: {path}")
        return target

    async def execute(
        self, name: str, args: dict[str, Any], workspace: Path, agent_id: int | None = None
    ) -> str:
        tool = self.tools.get(name)
        if not tool:
            raise ValueError(f"unknown tool: {name}")
        if tool["elevated"]:
            # Runner catches this and asks the employer.
            raise ApprovalRequired(f"tool '{name}' requires employer approval")
        return await tool["handler"](args, workspace, self)

    async def execute_approved(
        self, name: str, args: dict[str, Any], workspace: Path, agent_id: int | None = None
    ) -> str:
        tool = self.tools.get(name)
        if not tool:
            raise ValueError(f"unknown tool: {name}")
        return await tool["handler"](args, workspace, self)


# ---- handlers ----------------------------------------------------------------


async def _read_file(args: dict[str, Any], ws: Path, reg: ToolRegistry) -> str:
    target = reg._resolve(ws, args["path"])
    data = target.read_bytes()[:MAX_FILE_BYTES]
    return data.decode("utf-8", errors="replace")


async def _write_file(args: dict[str, Any], ws: Path, reg: ToolRegistry) -> str:
    target = reg._resolve(ws, args["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(args["contents"], encoding="utf-8")
    return f"wrote {len(args['contents'])} chars to {args['path']}"


async def _list_dir(args: dict[str, Any], ws: Path, reg: ToolRegistry) -> str:
    target = reg._resolve(ws, args.get("path", "."))
    entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name))
    lines = []
    for e in entries[:500]:
        lines.append(f"{'dir ' if e.is_dir() else 'file'} {e.relative_to(ws)}")
    return "\n".join(lines) or "(empty)"


async def _web_search_stub(args: dict[str, Any], ws: Path, reg: ToolRegistry) -> str:
    # Placeholder: wire a real search provider (Tavily/Brave/Serper) here.
    return f"[web_search unavailable] query={args.get('query', '')!r} — configure a search provider"


def _make_run_command():
    if sys.platform == "win32":
        shell_cmd = ["cmd", "/c"]
    else:
        shell_cmd = ["sh", "-c"]

    async def handler(args: dict[str, Any], ws: Path, reg: ToolRegistry) -> str:
        cmd = shell_cmd + [args["command"]]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(ws),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=MAX_COMMAND_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            out2, _ = await proc.communicate()
            return f"[timeout after {MAX_COMMAND_TIMEOUT}s] partial:\n{out2.decode(errors='replace')[:4000]}"
        text = out.decode("utf-8", errors="replace")
        return f"exit={proc.returncode}\n{text[:8000]}"

    return handler


_run_command_handler = _make_run_command()


def build_default_registry() -> ToolRegistry:
    reg = ToolRegistry()

    reg.register(
        "read_file",
        "Read a text file from the workspace. Max 512KB.",
        {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Relative to workspace root"}},
            "required": ["path"],
        },
        _read_file,
    )
    reg.register(
        "write_file",
        "Create or overwrite a text file in the workspace.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "contents": {"type": "string"},
            },
            "required": ["path", "contents"],
        },
        _write_file,
        elevated=False,
    )
    reg.register(
        "list_dir",
        "List files and directories at the given workspace path.",
        {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Defaults to workspace root"}},
            "required": [],
        },
        _list_dir,
    )
    reg.register(
        "web_search",
        "Search the web. Returns ranked results with snippets.",
        {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
        _web_search_stub,
    )
    reg.register(
        "terminal",
        "Run a shell command inside the workspace. Slow/impactful commands only.",
        {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
        _run_command_handler,
        elevated=True,
    )
    return reg