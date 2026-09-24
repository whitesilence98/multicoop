"""Auth + real-time team chat over WebSockets.

Flow:
  POST /api/chat/login {username, role}  -> session token (kept in memory)
  WS   /api/chat/ws?token=...            -> live channel

@mentions of agents (@Agent-Dev) are dispatched to the rate-limited
Orchestrator queue as synthesized tasks; the agent's streamed answer is
broadcast back into the chat as a bot message. Tagging a human role
broadcasts a notification event (Electron shows it on the receiving client).
"""
from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from backend.websocket_manager import ChatManager, parse_mentions

log = logging.getLogger("aiemployer.chat")

router = APIRouter(tags=["chat"])

# ---- team roles ----------------------------------------------------------------

ROLES: dict[str, dict[str, str]] = {
    "Project Director": {"badge": "DIR",   "color": "#00FF9D"},
    "Engineering Lead": {"badge": "LEAD",  "color": "#6366F1"},
    "Product Owner":    {"badge": "OWNER", "color": "#F59E0B"},
}

# ---- shared runtime hooks (wired by backend.main) --------------------------------
# main.py sets these at startup so chat routes never import main directly
# (which would be circular). Keys:
#   "db"                        -> backend.db.DB instance
#   "get_agent_by_name"         -> (name) -> agent row dict | None
#   "dispatch_agent_chat_task"  -> (agent_row, text, client_id) -> None
#   "notify"                    -> (client_id, title, body) -> None
hooks: dict[str, Any] = {}

manager = ChatManager()

# token -> session dict (in-memory; enough for a single-user desktop app)
SESSIONS: dict[str, dict] = {}


class LoginIn(BaseModel):
    username: str
    role: str = "Project Director"


# ---- auth ----------------------------------------------------------------------

@router.post("/api/chat/login")
async def chat_login(body: LoginIn) -> dict[str, str]:
    username = body.username.strip()
    role = body.role.strip() if body.role.strip() in ROLES else "Project Director"
    if not username:
        raise HTTPException(400, "username required")

    # Prefer the user's chosen highlight color from Settings (saved under the
    # runtime settings row); fall back to the role's default.
    color = ROLES[role]["color"]
    try:
        from backend.main import db
        from backend.routes.settings import _load_raw

        saved = await _load_raw(db)
        color = saved.get("user_color") or color
    except Exception:  # noqa: BLE001 — chat login must not break on settings read
        pass

    token = secrets.token_urlsafe(24)
    SESSIONS[token] = {
        "client_id": f"u_{secrets.token_hex(8)}",
        "username": username,
        "role": role,
        "badge": ROLES[role]["badge"],
        "color": color,
    }
    return {"token": token, "color": color}


def _session_for(token: str) -> dict | None:
    return SESSIONS.get(token)


# ---- websocket ------------------------------------------------------------------

@router.websocket("/api/chat/ws")
async def chat_ws_endpoint(ws: WebSocket, token: str = "") -> None:
    """Live chat socket: presence + messages + @mention dispatch."""
    session = _session_for(token)
    if session is None:
        await ws.close(code=4401, reason="invalid token")
        return

    client_id = session["client_id"]
    member = {
        "id": client_id,
        "username": session["username"],
        "role": session["role"],
        "badge": session["badge"],
        "color": session["color"],
        "kind": "human",
        "status": "online",
    }
    await manager.connect(client_id, ws)
    manager.register_member(client_id, member)
    await manager.broadcast({"type": "presence", "action": "join", "member": member})
    # Give the fresh client the current roster + recent history.
    await ws.send_text(
        json.dumps({"type": "presence_snapshot", "members": manager.online_members()})
    )

    try:
        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)
            text = (data.get("text") or "").strip()
            if not text:
                continue

            mentions = parse_mentions(text)
            await manager.broadcast(
                {
                    "type": "message",
                    "id": f"m_{time.time_ns()}",
                    "sender": member,
                    "text": text,
                    "mentions": mentions,
                    "ts": _now_iso(),
                }
            )

            # Dispatch each mentioned agent (rate-limited queue via hook).
            for token_name in mentions:
                lookup = hooks.get("get_agent_by_name")
                agent = await lookup(token_name) if lookup else None
                if agent:
                    dispatch = hooks.get("dispatch_agent_chat_task")
                    if dispatch:
                        dispatch(agent, text, client_id)
                # Human-role mentions fall through: the broadcast above is the
                # notification — every connected client (including Electron's
                # notification bridge) sees the mention in the message event.
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast({"type": "presence", "action": "leave", "member": member})


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")