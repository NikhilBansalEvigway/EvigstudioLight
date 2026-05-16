from __future__ import annotations

import asyncio
from dataclasses import dataclass
from time import monotonic

from redis.asyncio import Redis

from app.core.settings import get_settings
from app.db.redis import get_redis


@dataclass
class QueueSnapshot:
    active: int
    waiting: int


@dataclass
class QueueLease:
    model_name: str
    entered_queue_at: float
    started_processing_at: float | None = None

    @property
    def wait_time_ms(self) -> int:
        end = self.started_processing_at or monotonic()
        return int((end - self.entered_queue_at) * 1000)


class RedisScheduler:
    def __init__(self) -> None:
        settings = get_settings()
        self._redis: Redis = get_redis()
        self._namespace = settings.redis_namespace
        self._poll_interval = max(settings.scheduler_poll_interval_ms / 1000, 0.05)
        # Self-heal stale active slots after worker crashes/restarts.
        self._active_slot_ttl_seconds = max(
            settings.default_request_timeout_seconds * 4,
            settings.result_wait_timeout_seconds * 2,
            300,
        )

    def active_key(self, model_name: str) -> str:
        return f"{self._namespace}:active:{model_name}"

    def queue_key(self, model_name: str) -> str:
        return f"{self._namespace}:jobs:{model_name}"

    async def acquire_slot(
        self, *, model_name: str, concurrency_limit: int, wait_timeout_seconds: int
    ) -> QueueLease:
        lease = QueueLease(model_name=model_name, entered_queue_at=monotonic())
        deadline = monotonic() + wait_timeout_seconds
        while monotonic() < deadline:
            if await self._try_acquire_slot(
                model_name=model_name, concurrency_limit=concurrency_limit
            ):
                lease.started_processing_at = monotonic()
                return lease
            await asyncio.sleep(self._poll_interval)
        raise TimeoutError("worker_slot_timeout")

    async def _try_acquire_slot(
        self, *, model_name: str, concurrency_limit: int
    ) -> bool:
        active_key = self.active_key(model_name)
        script = """
local active_key = KEYS[1]
local concurrency_limit = tonumber(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])
local active = tonumber(redis.call('GET', active_key) or '0')
if active >= concurrency_limit then
  if redis.call('TTL', active_key) < 0 then
    redis.call('EXPIRE', active_key, ttl_seconds)
  end
  return 0
end
redis.call('INCR', active_key)
redis.call('EXPIRE', active_key, ttl_seconds)
return 1
"""
        result = await self._redis.eval(
            script,
            1,
            active_key,
            str(concurrency_limit),
            str(self._active_slot_ttl_seconds),
        )
        return bool(result)

    async def release(self, lease: QueueLease) -> None:
        active_key = self.active_key(lease.model_name)
        current = int(await self._redis.get(active_key) or 0)
        if current <= 1:
            await self._redis.delete(active_key)
        else:
            await self._redis.decr(active_key)

    async def snapshot(self) -> dict[str, QueueSnapshot]:
        queue_keys = [
            key
            async for key in self._redis.scan_iter(match=f"{self._namespace}:jobs:*")
        ]
        active_keys = [
            key
            async for key in self._redis.scan_iter(match=f"{self._namespace}:active:*")
        ]
        model_names = {key.split(":jobs:", 1)[1] for key in queue_keys}
        model_names.update({key.split(":active:", 1)[1] for key in active_keys})
        snapshots: dict[str, QueueSnapshot] = {}
        for model_name in model_names:
            snapshots[model_name] = QueueSnapshot(
                active=int(await self._redis.get(self.active_key(model_name)) or 0),
                waiting=await self._redis.llen(self.queue_key(model_name)),
            )
        return snapshots
