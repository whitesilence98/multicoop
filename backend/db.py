"""SQLite persistence via SQLAlchemy async.

Stores: agents, tasks, event logs (agent reasoning/tool/stream), and
per-task token usage for budget tracking.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, Integer, String, Text, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    persona: Mapped[str] = mapped_column(Text, default="")
    permission_level: Mapped[str] = mapped_column(String(20), default="standard")  # readonly|standard|elevated
    allowed_tools: Mapped[list] = mapped_column(JSON, default=list)  # ["read_file", "write_file", ...]
    color: Mapped[str] = mapped_column(String(9), default="#6366F1")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    is_active: Mapped[bool] = mapped_column(default=True)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), default="pending"
    )  # pending|running|waiting_approval|done|failed
    priority: Mapped[int] = mapped_column(Integer, default=0)  # higher = sooner
    parent_task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"), nullable=True)  # chains
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class EventLog(Base):
    __tablename__ = "event_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), index=True)
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(40))  # thinking_delta|text_delta|tool_call_start|...
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DB:
    def __init__(self, db_path: Path) -> None:
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def init(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    def session(self) -> AsyncSession:
        return self.session_factory()

    # -- helpers ------------------------------------------------------------
    async def log_event(self, task_id: int, agent_id: int | None, kind: str, payload: dict[str, Any]) -> None:
        async with self.session() as s:
            s.add(EventLog(task_id=task_id, agent_id=agent_id, kind=kind, payload=payload))
            await s.commit()

    async def list_events(self, task_id: int, since_id: int = 0) -> list[EventLog]:
        async with self.session() as s:
            rows = await s.execute(
                select(EventLog)
                .where(EventLog.task_id == task_id, EventLog.id > since_id)
                .order_by(EventLog.id)
                .limit(2000)
            )
            return list(rows.scalars())

    async def update_task(self, task_id: int, **fields: Any) -> Task | None:
        async with self.session() as s:
            task = await s.get(Task, task_id)
            if not task:
                return None
            for k, v in fields.items():
                setattr(task, k, v)
            await s.commit()
            return task

    async def record_usage(self, task_id: int, input_tokens: int, output_tokens: int) -> None:
        async with self.session() as s:
            task = await s.get(Task, task_id)
            if task:
                task.input_tokens += input_tokens
                task.output_tokens += output_tokens
                await s.commit()


def event_to_dict(e: EventLog) -> dict[str, Any]:
    return {
        "id": e.id,
        "task_id": e.task_id,
        "agent_id": e.agent_id,
        "kind": e.kind,
        "payload": e.payload if isinstance(e.payload, dict) else json.loads(str(e.payload)),
        "ts": e.created_at.isoformat() if e.created_at else None,
    }