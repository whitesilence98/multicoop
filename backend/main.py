"""FastAPI application — the AI Employer orchestrator.

Endpoints:
  GET  /api/health                  readiness probe (Electron sidecar check)
  CRUD /api/agents                  agent personas & tool permissions
  CRUD /api/tasks                   task creation, listing, dispatch
  POST /api/tasks/{id}/dispatch     enqueue a task for execution
  GET  /api/tasks/{id}/stream       SSE stream of agent events
  POST /api/tasks/{id}/approve      human-in-the-loop approval verdicts
  GET  /api/metrics                 queue depth + token bucket snapshots
  GET  /api/usage                   aggregate token usage
"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from backend.agent_runner import EventSink, make_client, run_agent
from backend.db import DB, Agent, Task, event_to_dict
from backend.rate_limiter import Orchestrator, RunRequest
from backend.tools import ApprovalRequired, build_default_registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("aiemployer.api")


def _load_dotenv() -> None:
    """Minimal .env loader (KEY=VALUE lines) so the packaged sidecar picks up
    the project .env without an extra dependency."""
    import os

    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
WORKSPACE = DATA_DIR / "workspace"
WORKSPACE.mkdir(exist_ok=True)

db = DB(DATA_DIR / "aiemployer.db")
registry = build_default_registry()
client = make_client()


# ---- SSE hub + approval gate ---------------------------------------------------

sse_queues: dict[int, set[asyncio.Queue]] = {}
pending_approvals: dict[str, asyncio.Future] = {}


class SSEHub(EventSink):
    """Fan-out runner events to SSE subscribers and persist them to the DB."""

    def __init__(self, task_id: int, agent_id: int | None) -> None:
        self.task_id = task_id
        self.agent_id = agent_id

    async def emit(self, kind: str, data: dict[str, Any]) -> None:
        await db.log_event(self.task_id, self.agent_id, kind, data)
        for q in sse_queues.get(self.task_id, set()):
            await q.put({"kind": kind, "payload": data})

    async def request_approval(self, detail: dict[str, Any]) -> str:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        call_id = f"ap_{id(fut):x}"
        pending_approvals[call_id] = fut
        await self.emit("approval_request", {**detail, "call_id": call_id})
        await db.update_task(self.task_id, status="waiting_approval")
        try:
            return await asyncio.wait_for(fut, timeout=300)
        except asyncio.TimeoutError:
            return "deny"
        finally:
            pending_approvals.pop(call_id, None)
            await db.update_task(self.task_id, status="running")


async def _run_handler(req: RunRequest) -> dict[str, int]:
    """Orchestrator callback: execute one task run end-to-end."""
    from backend.db import utcnow

    async with db.session() as s:
        task = await s.get(Task, req.task_id)
        agent = await s.get(Agent, req.agent_id) if req.agent_id else None
        if task is None:
            return {"input_tokens": 0, "output_tokens": 0}
        task.status = "running"
        task.started_at = utcnow()
        agent_snapshot = {
            "id": agent.id if agent else None,
            "persona": agent.persona if agent else "You are a general-purpose assistant.",
            "permission_level": agent.permission_level if agent else "standard",
            "allowed_tools": agent.allowed_tools if agent else list(registry.tools.keys()),
        }
        task_snapshot = {
            "id": task.id,
            "description": task.description,
            "title": task.title,
        }
        await s.commit()

    hub = SSEHub(req.task_id, agent_snapshot["id"])
    await hub.emit("run_started", {"task": task_snapshot["title"]})
    try:
        tools = registry.to_api_schema(agent_snapshot["allowed_tools"])
        usage = await run_agent(client, registry, agent_snapshot, task_snapshot, hub, WORKSPACE)
        await db.record_usage(req.task_id, usage["input_tokens"], usage["output_tokens"])
        result_text = ""
        async with db.session() as s:
            for ev in await db.list_events(req.task_id):
                if ev.kind == "text_delta":
                    result_text += ev.payload.get("text", "")
        await db.update_task(
            req.task_id,
            status="done",
            finished_at=utcnow(),
            result=result_text[-8000:] or None,
        )
        await hub.emit("run_finished", {"status": "done"})
        return usage
    except Exception as e:  # noqa: BLE001
        log.exception("task %s failed", req.task_id)
        await hub.emit("run_failed", {"error": str(e)})
        await db.update_task(req.task_id, status="failed", finished_at=utcnow())
        return {"input_tokens": 0, "output_tokens": 0}


# ---- lifecycle -----------------------------------------------------------------

orchestrator: Orchestrator | None = None

DEFAULT_AGENTS = [
    {
        "name": "Software Developer",
        "persona": (
            "You are a meticulous senior software developer. You write clean, "
            "well-structured code, read existing files before changing them, and "
            "verify your work before reporting done."
        ),
        "permission_level": "standard",
        "allowed_tools": ["read_file", "write_file", "list_dir"],
        "color": "#00FF9D",
    },
    {
        "name": "Researcher",
        "persona": (
            "You are a thorough research analyst. You gather information, compare "
            "sources, and deliver concise, well-structured findings with clear "
            "recommendations."
        ),
        "permission_level": "readonly",
        "allowed_tools": ["read_file", "list_dir", "web_search"],
        "color": "#6366F1",
    },
    {
        "name": "QA Tester",
        "persona": (
            "You are a detail-obsessed QA engineer. You probe for edge cases, "
            "document reproduction steps precisely, and report bugs with severity "
            "assessments."
        ),
        "permission_level": "standard",
        "allowed_tools": ["read_file", "write_file", "list_dir", "terminal"],
        "color": "#F59E0B",
    },
]


async def _seed_default_agents() -> None:
    """One-time seed: populate a starter workforce on an empty roster."""
    from sqlalchemy import func

    async with db.session() as s:
        count = (await s.execute(_select(func.count(Agent.id)))).scalar() or 0
        if count > 0:
            return
        for spec in DEFAULT_AGENTS:
            s.add(Agent(**spec))
        await s.commit()
        log.info("seeded %d default agents", len(DEFAULT_AGENTS))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global orchestrator
    await db.init()
    await _seed_default_agents()
    orchestrator = Orchestrator(run_handler=_run_handler, rpm=50, itpm=200_000, otpm=80_000, workers=4)
    await orchestrator.start()
    log.info("orchestrator online; workspace=%s", WORKSPACE)
    yield
    await orchestrator.stop()


app = FastAPI(title="AI Employer Orchestrator", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- schemas --------------------------------------------------------------------

class AgentIn(BaseModel):
    name: str
    persona: str = ""
    permission_level: str = Field(default="standard", pattern="^(readonly|standard|elevated)$")
    allowed_tools: list[str] = Field(default_factory=lambda: ["read_file", "write_file", "list_dir"])
    color: str = "#6366F1"


class TaskIn(BaseModel):
    title: str
    description: str = ""
    agent_id: int | None = None
    priority: int = 0
    parent_task_id: int | None = None


# ---- routes ---------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "version": "0.1.0"}


from sqlalchemy import select as _select  # noqa: E402


@app.get("/api/agents")
async def list_agents() -> list[dict[str, Any]]:
    async with db.session() as s:
        rows = (await s.execute(_select(Agent))).scalars().all()
    return [_agent_dict(a) for a in rows]


def _agent_dict(a: Agent) -> dict[str, Any]:
    return {
        "id": a.id,
        "name": a.name,
        "persona": a.persona,
        "permission_level": a.permission_level,
        "allowed_tools": a.allowed_tools,
        "color": a.color,
    }


@app.post("/api/agents", status_code=201)
async def create_agent(body: AgentIn) -> dict[str, Any]:
    async with db.session() as s:
        a = Agent(**body.model_dump())
        s.add(a)
        await s.commit()
        return _agent_dict(a)


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: int) -> dict[str, str]:
    async with db.session() as s:
        a = await s.get(Agent, agent_id)
        if a:
            await s.delete(a)
            await s.commit()
    return {"status": "deleted"}


@app.get("/api/tasks")
async def list_tasks() -> list[dict[str, Any]]:
    from sqlalchemy import select

    async with db.session() as s:
        rows = (await s.execute(select(Task).order_by(Task.priority.desc(), Task.id))).scalars().all()
    return [_task_dict(t) for t in rows]


def _task_dict(t: Task) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title,
        "description": t.description,
        "agent_id": t.agent_id,
        "status": t.status,
        "priority": t.priority,
        "parent_task_id": t.parent_task_id,
        "result": t.result,
        "input_tokens": t.input_tokens,
        "output_tokens": t.output_tokens,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


@app.post("/api/tasks", status_code=201)
async def create_task(body: TaskIn) -> dict[str, Any]:
    async with db.session() as s:
        t = Task(**body.model_dump())
        s.add(t)
        await s.commit()
        return _task_dict(t)


@app.post("/api/tasks/{task_id}/dispatch")
async def dispatch_task(task_id: int) -> dict[str, Any]:
    async with db.session() as s:
        task = await s.get(Task, task_id)
        if not task:
            raise HTTPException(404, "task not found")
        if task.agent_id is None:
            raise HTTPException(400, "task has no assigned agent")
    assert orchestrator is not None
    await orchestrator.submit(
        RunRequest(task_id=task_id, agent_id=task.agent_id, est_input_tokens=4_000, est_output_tokens=4_000)
    )
    await db.update_task(task_id, status="pending")
    return {"status": "queued"}


@app.get("/api/tasks/{task_id}/stream")
async def stream_task(task_id: int, since: int = 0) -> EventSourceResponse:
    """Replay history from `since`, then live-tail the SSE hub."""

    async def gen() -> AsyncIterator[dict[str, Any]]:
        # Backfill: everything already logged, so late subscribers get context.
        last_id = since
        for ev in await db.list_events(task_id, since_id=last_id):
            yield {"id": str(ev.id), "event": ev.kind, "data": json.dumps(event_to_dict(ev)["payload"])}
            last_id = ev.id

        q: asyncio.Queue = asyncio.Queue()
        sse_queues.setdefault(task_id, set()).add(q)
        try:
            yield {"event": "stream_attached", "data": json.dumps({"since": last_id})}
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}  # keepalive
                    continue
                # Events arriving on the live queue carry no DB id; forward
                # with the id the backfill stopped at so the client stays
                # monotonic (they only matter for reconnect cursors).
                last_id += 1
                yield {
                    "id": str(last_id),
                    "event": item["kind"],
                    "data": json.dumps(item["payload"]),
                }
        finally:
            sse_queues.get(task_id, set()).discard(q)

    return EventSourceResponse(gen())


@app.post("/api/tasks/{task_id}/approve")
async def approve(task_id: int, body: dict[str, Any]) -> dict[str, str]:
    call_id = body.get("call_id")
    fut = pending_approvals.get(str(call_id))
    if not fut or fut.done():
        raise HTTPException(404, "no pending approval")
    fut.set_result("approve" if body.get("verdict") == "approve" else "deny")
    return {"status": "recorded"}


@app.get("/api/metrics")
async def metrics() -> dict[str, Any]:
    assert orchestrator is not None
    return orchestrator.metrics()


@app.get("/api/usage")
async def usage() -> dict[str, Any]:
    from sqlalchemy import func, select

    async with db.session() as s:
        row = (await s.execute(select(func.sum(Task.input_tokens), func.sum(Task.output_tokens)))).one()
    return {"input_tokens": row[0] or 0, "output_tokens": row[1] or 0}