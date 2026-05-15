from __future__ import annotations

from dataclasses import dataclass

from app.core.settings import get_settings
from app.db.redis import get_redis


@dataclass
class QuotaLease:
    user_id: str | None
    org_id: str | None


class QuotaService:
    def __init__(self) -> None:
        settings = get_settings()
        self._redis = get_redis()
        self._namespace = settings.redis_namespace
        self._user_limit = settings.default_user_active_limit
        self._org_limit = settings.default_org_active_limit
        self._user_rpm_limit = settings.default_user_requests_per_minute
        self._org_rpm_limit = settings.default_org_requests_per_minute

    def _user_key(self, user_id: str) -> str:
        return f"{self._namespace}:quota:user:{user_id}"

    def _org_key(self, org_id: str) -> str:
        return f"{self._namespace}:quota:org:{org_id}"

    def _user_rpm_key(self, user_id: str) -> str:
        return f"{self._namespace}:rate:user:{user_id}"

    def _org_rpm_key(self, org_id: str) -> str:
        return f"{self._namespace}:rate:org:{org_id}"

    async def check_rate_limits(self, user_id: str | None, org_id: str | None) -> None:
        if user_id:
            key = self._user_rpm_key(user_id)
            current = await self._redis.incr(key)
            if current == 1:
                await self._redis.expire(key, 60)
            if current > self._user_rpm_limit:
                raise RuntimeError("user_rate_limit_exceeded")
        if org_id:
            key = self._org_rpm_key(org_id)
            current = await self._redis.incr(key)
            if current == 1:
                await self._redis.expire(key, 60)
            if current > self._org_rpm_limit:
                raise RuntimeError("org_rate_limit_exceeded")

    async def acquire(self, user_id: str | None, org_id: str | None) -> QuotaLease:
        if user_id:
            current = int(await self._redis.get(self._user_key(user_id)) or 0)
            if current >= self._user_limit:
                raise RuntimeError("user_quota_exceeded")
        if org_id:
            current = int(await self._redis.get(self._org_key(org_id)) or 0)
            if current >= self._org_limit:
                raise RuntimeError("org_quota_exceeded")

        if user_id:
            await self._redis.incr(self._user_key(user_id))
        if org_id:
            await self._redis.incr(self._org_key(org_id))
        return QuotaLease(user_id=user_id, org_id=org_id)

    async def release(self, lease: QuotaLease) -> None:
        if lease.user_id:
            key = self._user_key(lease.user_id)
            current = int(await self._redis.get(key) or 0)
            if current <= 1:
                await self._redis.delete(key)
            else:
                await self._redis.decr(key)
        if lease.org_id:
            key = self._org_key(lease.org_id)
            current = int(await self._redis.get(key) or 0)
            if current <= 1:
                await self._redis.delete(key)
            else:
                await self._redis.decr(key)
