"""WebSocket connection manager for the team chat channel.

Tracks every live connection (humans and agent listeners), fans out chat
events, and parses @mentions. Agent mentions are dispatched to the
rate-limited task queue by the chat router (which owns that wiring).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from fastapi import WebSocket

log = logging.getLogger("aiemployer.chat")

# Matches @ followed by a name chunk: letters, digits, dashes, underscores.
MENTION_RE = re.compile(r"@([A-Za-z0-9][A-Za-z0-9_-]*)")


def parse_mentions(text: str) -> list[str]:
    """Extract @mention tokens (without the @) in order of appearance."""
    return MENTION_RE.findall(text or "")


@dataclass
class ChatMessage:
    id: int
    sender_id: str
    sender_name: str
    role_badge: str           # DIR | LEAD | OWNER | BOT
    role_label: str           # Project Director | ...
    color: str
    text: str
    mentions: list[str] = field(default_factory=list)
    ts: str = ""


class ChatManager:
    """Owns live connections and broadcast fan-out."""

    def __init__(self) -> None:
        self.connections: dict[str, WebSocket] = {}  # client_id -> ws
        self.members: dict[str, dict] = {}           # client_id -> profile

    async def connect(self, client_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.connections[client_id] = ws

    def disconnect(self, client_id: str) -> None:
        self.connections.pop(client_id, None)
        self.members.pop(client_id, None)

    def register_member(self, client_id: str, member: dict) -> None:
        self.members[client_id] = member

    def online_members(self) -> list[dict]:
        return list(self.members.values())

    async def broadcast(self, event: dict) -> None:
        payload = json.dumps(event, default=str)
        for cid, ws in list(self.connections.items()):
            try:
                await ws.send_text(payload)
            except Exception:  # noqa: BLE001
                self.connections.pop(cid, None)
                log.debug("dropped dead connection %s", cid)