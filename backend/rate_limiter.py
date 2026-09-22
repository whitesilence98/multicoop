"""Central rate limiter + dispatch queue for the shared Anthropic API key.

Enforces three independent token buckets — requests-per-minute (RPM),
input-tokens-per-minute (ITPM) and output-tokens-per-minute (OTPM) — and
serializes agent runs through an asyncio.Queue so N concurrent agents can
never collectively exceed the org-level limits on the single shared key.

All agents funnel through Orchestrator.submit(); worker tasks pull from the
queue, acquire the three buckets (estimating tokens up front and refunding
the delta once real usage is known), then hand off to agent_runner.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

log = logging.getLogger("aiemployer.ratelimit")


class TokenBucket:
    """Classic token bucket with continuous refill (asyncio-native)."""

    def __init__(self, capacity: float, refill_per_minute: float, name: str) -> None:
        self.name = name
        self.capacity = float(capacity)
        self.tokens = float(capacity)
        self.rate = refill_per_minute / 60.0  # tokens per second
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, amount: float) -> None:
        """Block until `amount` tokens are available, then consume them."""
        if amount > self.capacity:
            raise ValueError(
                f"{self.name}: request of {amount} exceeds bucket capacity {self.capacity}"
            )
        while True:
            async with self._lock:
                now = time.monotonic()
                elapsed = now - self._updated
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
                self._updated = now
                if self.tokens >= amount:
                    self.tokens -= amount
                    return
                deficit = (amount - self.tokens) / self.rate
            # Sleep in small slices so a bucket refill wakes us promptly.
            await asyncio.sleep(min(deficit, 1.0))

    async def refund(self, amount: float) -> None:
        """Return unused reservation to the bucket (estimation correction)."""
        if amount <= 0:
            return
        async with self._lock:
            self.tokens = min(self.capacity, self.tokens + amount)

    def snapshot(self) -> dict[str, float]:
        return {"available": round(self.tokens, 1), "capacity": self.capacity}


@dataclass
class RunRequest:
    """One unit of work pulled off the dispatch queue."""
    task_id: int
    agent_id: int
    # Estimated tokens for pre-acquisition; reconciled after the run.
    est_input_tokens: int = 4_000
    est_output_tokens: int = 4_000
    meta: dict[str, Any] = field(default_factory=dict)


class Orchestrator:
    """Queue manager owning the three buckets and the worker pool."""

    def __init__(
        self,
        run_handler: Callable[[RunRequest], Awaitable[dict[str, int]]],
        rpm: int = 50,
        itpm: int = 200_000,
        otpm: int = 80_000,
        workers: int = 4,
        max_queue_size: int = 500,
    ) -> None:
        # run_handler executes one RunRequest and returns actual
        # {"input_tokens", "output_tokens"} so buckets can be reconciled.
        self.run_handler = run_handler
        self.rpm_bucket = TokenBucket(rpm, rpm, "rpm")
        self.itpm_bucket = TokenBucket(itpm, itpm, "itpm")
        self.otpm_bucket = TokenBucket(otpm, otpm, "otpm")
        self.queue: asyncio.Queue[RunRequest] = asyncio.Queue(maxsize=max_queue_size)
        self.workers: list[asyncio.Task[None]] = []
        self._running = False
        self._worker_count = workers

    # -- lifecycle ----------------------------------------------------------
    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        for i in range(self._worker_count):
            self.workers.append(asyncio.create_task(self._worker(i), name=f"orchestrator-worker-{i}"))
        log.info("orchestrator started with %d workers", self._worker_count)

    async def stop(self) -> None:
        self._running = False
        for t in self.workers:
            t.cancel()
        await asyncio.gather(*self.workers, return_exceptions=True)
        self.workers.clear()
        log.info("orchestrator stopped")

    # -- public API ---------------------------------------------------------
    async def submit(self, req: RunRequest) -> None:
        await self.queue.put(req)
        log.info("queued run task=%s agent=%s (depth=%d)", req.task_id, req.agent_id, self.queue.qsize())

    async def _worker(self, idx: int) -> None:
        while True:
            req = await self.queue.get()
            try:
                # Pre-acquire: 1 request slot + estimated token reservations.
                await asyncio.gather(
                    self.rpm_bucket.acquire(1.0),
                    self.itpm_bucket.acquire(float(req.est_input_tokens)),
                    self.otpm_bucket.acquire(float(req.est_output_tokens)),
                )
                try:
                    actual = await self.run_handler(req)
                finally:
                    # Correct the reservation with real usage (refund only —
                    # underestimates keep the reservation, overestimates refund).
                    if actual:
                        await self.itpm_bucket.refund(float(req.est_input_tokens - actual.get("input_tokens", 0)))
                        await self.otpm_bucket.refund(float(req.est_output_tokens - actual.get("output_tokens", 0)))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — worker must never die
                log.exception("run task=%s failed", req.task_id)
            finally:
                self.queue.task_done()

    def metrics(self) -> dict[str, Any]:
        return {
            "queue_depth": self.queue.qsize(),
            "buckets": {
                "rpm": self.rpm_bucket.snapshot(),
                "itpm": self.itpm_bucket.snapshot(),
                "otpm": self.otpm_bucket.snapshot(),
            },
        }