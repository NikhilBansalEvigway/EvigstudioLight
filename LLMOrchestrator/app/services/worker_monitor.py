from __future__ import annotations

import json
from uuid import uuid4

from app.core.settings import get_settings
from app.core.time import now
from app.db.redis import get_redis


def utc_now_iso() -> str:
    return now().isoformat()


class WorkerMonitorService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._redis = get_redis()
        self._namespace = self.settings.redis_namespace

    def new_worker_id(self) -> str:
        return str(uuid4())

    def worker_key(self, worker_id: str) -> str:
        return f"{self._namespace}:worker:{worker_id}"

    async def publish_heartbeat(
        self,
        *,
        worker_id: str,
        active_tasks: int,
        max_parallel_jobs: int,
        status: str,
    ) -> None:
        payload = {
            "worker_id": worker_id,
            "active_tasks": active_tasks,
            "max_parallel_jobs": max_parallel_jobs,
            "status": status,
            "last_seen_at": utc_now_iso(),
        }
        key = self.worker_key(worker_id)
        await self._redis.set(
            key,
            json.dumps(payload),
            ex=max(self.settings.worker_heartbeat_ttl_seconds, 5),
        )

    async def list_workers(self) -> list[dict]:
        workers = []
        async for key in self._redis.scan_iter(match=f"{self._namespace}:worker:*"):
            raw = await self._redis.get(key)
            if not raw:
                continue
            try:
                workers.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
        workers.sort(key=lambda item: item.get("worker_id", ""))
        return workers
