"""Bi-directional sync between the app's agent roster and Claude Code's
`.claude/agents/` directory.

Export: one Markdown file per agent — Claude Code subagent format
(frontmatter: name/description/tools/model + app-specific fields kept for a
lossless round-trip; body: the persona prompt).
Import: parse every *.md in the directory and upsert agents by name.

Tool names map between the app's sandboxed tools and Claude Code's:
  read_file <-> Read   write_file <-> Write   list_dir <-> Glob
  web_search <-> WebSearch            terminal <-> Bash
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.db import Agent

log = logging.getLogger("aiemployer.claude_sync")

router = APIRouter(prefix="/api/agents/claude", tags=["claude-sync"])

# app tool id <-> Claude Code tool name
APP_TO_CLAUDE = {
    "read_file": "Read",
    "write_file": "Write",
    "list_dir": "Glob",
    "web_search": "WebSearch",
    "terminal": "Bash",
}
CLAUDE_TO_APP = {v: k for k, v in APP_TO_CLAUDE.items()}

# Global Claude Code directory — shared across all projects.
DEFAULT_DIR = Path.home() / ".claude" / "agents"


def _slug(name: str) -> str:
    """Frontmatter `name` — Claude Code expects lowercase alphanumeric +
    hyphens, ≤64 chars."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return (s or "agent")[:64]


def _file_stem(name: str) -> str:
    """Filename convention: UPPER_SNAKE_CASE (e.g. SOFTWARE_DEVELOPER.md)."""
    s = re.sub(r"[^A-Za-z0-9]+", "_", name.strip().upper()).strip("_")
    return s or "AGENT"


def _to_claude_tools(app_tools: list[str]) -> list[str]:
    return [APP_TO_CLAUDE.get(t, t) for t in app_tools]


def _to_app_tools(claude_tools: list[str]) -> list[str]:
    return [CLAUDE_TO_APP.get(t, t) for t in claude_tools]


# ---- (de)serialization ------------------------------------------------------------

def _yaml_scalar(v: str) -> str:
    """Quote values a strict YAML parser would misread (#, :, {, leading
    quotes...) so the frontmatter is valid beyond the naive subset."""
    if re.search(r"""[:#{}[\]&*!|>'"%@`,]""", v) or v != v.strip() or not v:
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v


def _task_description(a: Agent) -> str:
    """The schema's `description` drives WHEN Claude Code delegates to the
    subagent — a task-oriented line, not the persona itself."""
    kind = "elevated" if a.permission_level == "elevated" else a.permission_level
    tools = _to_claude_tools(a.allowed_tools or [])
    tool_hint = f"Uses {', '.join(tools)}." if tools else "Read-only analysis."
    return f"{a.name} — {kind} workforce agent. {tool_hint} Delegate implementation-style work here."


def agent_to_markdown(a: Agent) -> str:
    """Serialize one agent row as a Claude Code subagent definition.

    Schema fields per Claude Code's subagent spec:
      name (lowercase-hyphen), description, tools (comma-separated),
      model (optional). x-* keys are app round-trip metadata.
    """
    persona = (a.persona or "").strip()
    fm: dict[str, str] = {
        "name": _slug(a.name),
        "description": _task_description(a),
        "tools": ", ".join(_to_claude_tools(a.allowed_tools or [])),
    }
    if a.model:
        fm["model"] = a.model
    # App-specific fields — unknown to Claude Code (harmlessly ignored),
    # read back on import for a lossless round-trip.
    fm["x-app-name"] = a.name
    fm["x-permission-level"] = a.permission_level
    fm["x-color"] = a.color
    if a.provider_id and a.provider_id != "default":
        fm["x-provider-id"] = a.provider_id

    lines = ["---"]
    for k, v in fm.items():
        # Single-line scalar values only (persona lives in the body).
        lines.append(f"{k}: {_yaml_scalar(v.replace(chr(10), ' ').strip())}")
    lines.append("---")
    lines.append("")
    lines.append(persona or f"{a.name} persona.")
    return "\n".join(lines) + "\n"


def _parse_simple_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Parse the `---\\nkey: value\\n---\\nbody` subset — no YAML dependency.
    Handles single-line scalar values, optionally quoted."""
    if not text.startswith("---"):
        return {}, text
    try:
        _, fm_block, body = text.split("---", 2)
    except ValueError:
        return {}, text
    fm: dict[str, str] = {}
    for line in fm_block.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip().strip('"').strip("'").strip()
        fm[key.strip()] = value
    return fm, body.strip()


def markdown_to_agent_spec(text: str, fallback_name: str) -> dict[str, Any] | None:
    """Parse a subagent .md file into an AgentIn-shaped dict (None = skip)."""
    fm, body = _parse_simple_frontmatter(text)
    name = fm.get("x-app-name") or fm.get("name") or fallback_name
    if not name:
        return None
    tools_raw = fm.get("tools", "")
    claude_tools = [t.strip() for t in tools_raw.split(",") if t.strip()]
    spec: dict[str, Any] = {
        "name": name,
        "persona": body,
        "permission_level": fm.get("x-permission-level", "standard"),
        "allowed_tools": _to_app_tools(claude_tools) or ["read_file", "list_dir"],
        "color": fm.get("x-color", "#6366F1"),
        "model": fm.get("model") or None,
    }
    if fm.get("x-provider-id"):
        spec["provider_id"] = fm["x-provider-id"]
    # Basic sanity on fields that route to DB columns with patterns.
    if spec["permission_level"] not in ("readonly", "standard", "elevated"):
        spec["permission_level"] = "standard"
    return spec


# ---- schemas ----------------------------------------------------------------------

class SyncDir(BaseModel):
    target_dir: str | None = Field(default=None, description="Absolute path; defaults to the project's .claude/agents")


class ExportOut(BaseModel):
    target_dir: str
    exported: list[str]      # file names written
    skipped: list[str] = Field(default_factory=list)  # name: reason


class ImportOut(BaseModel):
    target_dir: str
    created: list[str]
    updated: list[str]
    skipped: list[str]


# ---- routes -------------------------------------------------------------------------

def _dir_of(body: SyncDir | None) -> Path:
    d = Path((body.target_dir if body and body.target_dir else "") or DEFAULT_DIR)
    if not d.is_absolute():
        raise HTTPException(400, "target_dir must be an absolute path")
    return d


@router.post("/export", response_model=ExportOut)
async def export_agents(body: SyncDir | None = None) -> ExportOut:
    """Write every agent on the roster to <target_dir>/<slug>.md."""
    target = _dir_of(body)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(400, f"cannot create {target}: {e}")

    exported: list[str] = []
    skipped: list[str] = []
    async with db_session() as s:
        rows = (await s.execute(select(Agent).order_by(Agent.id))).scalars().all()

    for a in rows:
        # One file per agent name; an existing file with the same name is
        # overwritten and replaced (write_text truncates in place).
        path = target / f"{_file_stem(a.name)}.md"
        try:
            path.write_text(agent_to_markdown(a), encoding="utf-8")
            exported.append(path.name)
        except OSError as e:
            skipped.append(f"{a.name}: {e}")

    log.info("exported %d agent(s) to %s", len(exported), target)
    return ExportOut(target_dir=str(target), exported=exported, skipped=skipped)


@router.post("/import", response_model=ImportOut)
async def import_agents(body: SyncDir | None = None) -> ImportOut:
    """Upsert agents from every *.md in <target_dir>, matching by name."""
    from backend.main import db as _db

    target = _dir_of(body)
    if not target.exists():
        raise HTTPException(404, f"directory not found: {target}")

    created: list[str] = []
    updated: list[str] = []
    skipped: list[str] = []
    async with _db.session() as s:
        existing = {
            a.name: a
            for a in (await s.execute(select(Agent))).scalars().all()
        }
        for path in sorted(target.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError as e:
                skipped.append(f"{path.name}: {e}")
                continue
            spec = markdown_to_agent_spec(text, path.stem)
            if not spec:
                skipped.append(f"{path.name}: no agent name found")
                continue
            row = existing.get(spec["name"])
            if row is None:
                s.add(Agent(**spec))
                created.append(spec["name"])
            else:
                for k, v in spec.items():
                    setattr(row, k, v)
                updated.append(spec["name"])
        await s.commit()

    log.info("imported from %s: created=%d updated=%d skipped=%d",
             target, len(created), len(updated), len(skipped))
    return ImportOut(target_dir=str(target), created=created, updated=updated, skipped=skipped)


def db_session():
    """Late import keeps this module importable before main.py binds `db`."""
    from backend.main import db

    return db.session()