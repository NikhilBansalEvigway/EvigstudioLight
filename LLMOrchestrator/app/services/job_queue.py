from __future__ import annotations

import json
from typing import Any

from redis.asyncio import Redis

from app.core.settings import get_settings
from app.db.redis import get_redis


class JobQueueService:
    def __init__(self) -> None:
        settings = get_settings()
        self._redis: Redis = get_redis()
        self._namespace = settings.redis_namespace

    def queue_key(self, model_name: str) -> str:
        return f"{self._namespace}:jobs:{model_name}"

    def result_key(self, job_id: str) -> str:
        return f"{self._namespace}:result:{job_id}"

    def dead_letter_key(self, model_name: str) -> str:
        return f"{self._namespace}:dead:{model_name}"

    def stream_key(self, job_id: str) -> str:
        return f"{self._namespace}:stream:{job_id}"

    async def enqueue(
        self, *, model_name: str, job_id: str, payload: dict[str, Any], queue_limit: int
    ) -> None:
        queue_key = self.queue_key(model_name)
        queue_length = await self._redis.llen(queue_key)
        if queue_length >= queue_limit:
            raise RuntimeError("queue_full")
        await self._redis.rpush(queue_key, json.dumps(payload))

    async def dequeue(self, model_name: str) -> dict[str, Any] | None:
        raw = await self._redis.lpop(self.queue_key(model_name))
        if raw is None:
            return None
        return json.loads(raw)

    async def dequeue_any(
        self, model_names: list[str], timeout_seconds: int
    ) -> dict[str, Any] | None:
        if not model_names:
            return None
        queue_keys = [self.queue_key(model_name) for model_name in model_names]
        timeout = max(int(timeout_seconds), 0)
        result = await self._redis.brpop(queue_keys, timeout=timeout)
        if result is None:
            return None
        queue_key, raw = result
        payload = json.loads(raw)
        if isinstance(payload, dict) and not payload.get("model_name"):
            payload["model_name"] = queue_key.split(":jobs:", 1)[-1]
        return payload

    async def publish_result(
        self, job_id: str, payload: dict[str, Any], ttl_seconds: int = 300
    ) -> None:
        key = self.result_key(job_id)
        await self._redis.lpush(key, json.dumps(payload))
        await self._redis.expire(key, ttl_seconds)

    async def wait_for_result(
        self, job_id: str, timeout_seconds: int
    ) -> dict[str, Any] | None:
        timeout = max(int(timeout_seconds), 0)
        result = await self._redis.brpop(
            [self.result_key(job_id)],
            timeout=timeout,
        )
        if result is None:
            return None
        _, raw = result
        return json.loads(raw)

    async def publish_stream_event(
        self, job_id: str, payload: dict[str, Any], ttl_seconds: int = 300
    ) -> None:
        key = self.stream_key(job_id)
        await self._redis.rpush(key, json.dumps(payload))
        await self._redis.expire(key, ttl_seconds)

    async def wait_for_stream_event(
        self, job_id: str, timeout_seconds: int
    ) -> dict[str, Any] | None:
        timeout = max(int(timeout_seconds), 0)
        result = await self._redis.blpop(
            [self.stream_key(job_id)],
            timeout=timeout,
        )
        if result is None:
            return None
        _, raw = result
        return json.loads(raw)

    async def push_dead_letter(self, model_name: str, payload: dict[str, Any]) -> None:
        await self._redis.rpush(self.dead_letter_key(model_name), json.dumps(payload))
