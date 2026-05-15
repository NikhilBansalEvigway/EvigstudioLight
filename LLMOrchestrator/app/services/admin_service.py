from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, or_, select

from app.core.runtime_config import RuntimeConfigService
from app.core.time import current_timezone, now, start_of_day
from app.db.session import get_session_factory
from app.models.config_entry import ConfigEntry
from app.models.llm_request import LLMRequest
from app.models.llm_request_event import LLMRequestEvent
from app.models.llm_response import LLMResponse
from app.models.model_config import ModelConfig
from app.models.queue_job import QueueJob
from app.services.alerting import AlertingService
from app.services.scheduler import RedisScheduler
from app.services.worker_monitor import WorkerMonitorService


EDITABLE_CONFIG_KEYS = {
    "lm_studio_base_url",
    "default_model",
    "default_request_timeout_seconds",
    "enable_streaming",
    "default_queue_timeout_seconds",
    "default_max_retries",
    "metrics_enabled",
    "prompt_logging_enabled",
    "secret_redaction_enabled",
    "pii_redaction_enabled",
    "alert_webhook_url",
    "alert_webhook_timeout_seconds",
    "alert_notification_cooldown_seconds",
}

SLOW_REQUEST_THRESHOLD_MS = 5000
QUEUE_ALERT_WAIT_THRESHOLD_MS = 30000
QUEUE_ALERT_DEPTH_THRESHOLD = 10
ERROR_ALERT_RATE_THRESHOLD = 10.0
LATENCY_ALERT_THRESHOLD_MS = 8000


class AdminService:
    REDACTED = "[REDACTED]"
    SECRET_KEY_FRAGMENTS = ("token", "secret", "password", "authorization", "api_key", "apikey")

    @staticmethod
    def extract_usage(response_payload_json: dict[str, Any] | None) -> dict[str, int]:
        usage = response_payload_json.get("usage") if response_payload_json else None
        if not isinstance(usage, dict):
            return {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            }
        return {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
        }

    @classmethod
    def redact_payload(cls, value: Any) -> Any:
        runtime_config = RuntimeConfigService()
        if runtime_config.get("secret_redaction_enabled", True) is False:
            return value
        if isinstance(value, dict):
            redacted = {}
            for key, item in value.items():
                lowered = str(key).lower()
                if any(fragment in lowered for fragment in cls.SECRET_KEY_FRAGMENTS):
                    redacted[key] = cls.REDACTED
                else:
                    redacted[key] = cls.redact_payload(item)
            return redacted
        if isinstance(value, list):
            return [cls.redact_payload(item) for item in value]
        return value

    @classmethod
    def request_metrics(cls, responses: list[LLMResponse]) -> dict[str, int | None]:
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        processing_time_ms: int | None = None
        for response in responses:
            usage = cls.extract_usage(response.response_payload_json)
            prompt_tokens += usage["prompt_tokens"]
            completion_tokens += usage["completion_tokens"]
            total_tokens += usage["total_tokens"]
            if response.processing_time_ms is not None:
                processing_time_ms = max(processing_time_ms or 0, response.processing_time_ms)
        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "processing_time_ms": processing_time_ms,
        }

    @staticmethod
    def _ms_between(start: datetime | None, end: datetime | None) -> int | None:
        if start is None or end is None:
            return None
        # SQLite frequently returns naive datetimes even when columns are declared
        # with timezone=True; normalize to the app timezone so arithmetic works.
        if start.tzinfo is None:
            start = start.replace(tzinfo=current_timezone())
        if end.tzinfo is None:
            end = end.replace(tzinfo=current_timezone())
        return max(int((end - start).total_seconds() * 1000), 0)

    @staticmethod
    def _identity_hints(request: LLMRequest) -> dict[str, str | None]:
        """Extract display labels embedded in request_payload_json.metadata."""
        payload = request.request_payload_json or {}
        md = payload.get("metadata") if isinstance(payload, dict) else None
        if not isinstance(md, dict):
            md = {}
        user_display_name = md.get("user_display_name") or md.get("user_name")
        org_name = md.get("org_name") or md.get("team_name") or md.get("group_name")
        chat_id = md.get("chat_id") or md.get("chatId")
        return {
            "user_display_name": str(user_display_name) if user_display_name else None,
            "org_name": str(org_name) if org_name else None,
            "chat_id": str(chat_id) if chat_id else None,
        }

    @classmethod
    def _percentile(cls, values: list[int], percentile: float) -> float:
        if not values:
            return 0.0
        if len(values) == 1:
            return float(values[0])
        ordered = sorted(values)
        index = (len(ordered) - 1) * percentile
        lower = int(index)
        upper = min(lower + 1, len(ordered) - 1)
        fraction = index - lower
        return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction, 2)

    @classmethod
    def _request_diagnostics(
        cls,
        request: LLMRequest,
        events: list[LLMRequestEvent],
        queue_jobs: list[QueueJob],
    ) -> dict[str, Any]:
        queue_waits = [
            wait
            for wait in [cls._ms_between(job.queued_at, job.started_at) for job in queue_jobs]
            if wait is not None
        ]
        queue_wait_ms = max(queue_waits) if queue_waits else None
        end_to_end_ms = cls._ms_between(request.created_at, request.completed_at)
        retry_count = sum(1 for event in events if event.event_type == "retry_scheduled")
        dead_lettered = any(event.event_type == "dead_lettered" for event in events)
        client_cancelled = any(event.event_type == "client_cancelled" for event in events)
        mode = None
        failure_stage = None
        dropped_reason = None
        for event in events:
            details = event.details_json or {}
            if mode is None and isinstance(details, dict) and details.get("mode"):
                mode = str(details["mode"])
            if event.event_type in {"failed", "timeout", "rejected"}:
                if event.event_type == "rejected":
                    failure_stage = "admission"
                    dropped_reason = str(details.get("error_code") or request.error_code or "rejected")
                elif queue_jobs:
                    failure_stage = "worker"
                    if request.error_code == "scheduler_slot_timeout":
                        dropped_reason = "scheduler_slot_timeout"
                else:
                    failure_stage = "direct"
        if dead_lettered and dropped_reason is None:
            dropped_reason = request.error_code or "dead_lettered"
        final_attempts = max((job.attempts for job in queue_jobs), default=0)
        return {
            "queue_wait_ms": queue_wait_ms,
            "end_to_end_ms": end_to_end_ms,
            "retry_count": retry_count,
            "final_attempts": final_attempts,
            "was_retried": retry_count > 0 or final_attempts > 1,
            "dead_lettered": dead_lettered,
            "dropped": bool(dead_lettered or dropped_reason),
            "dropped_reason": dropped_reason,
            "client_cancelled": client_cancelled,
            "failure_stage": failure_stage,
            "mode": mode,
        }

    async def get_worker_overview(self) -> list[dict[str, Any]]:
        workers = await WorkerMonitorService().list_workers()
        overview = []
        for worker in workers:
            max_parallel_jobs = int(worker.get("max_parallel_jobs") or 0)
            active_tasks = int(worker.get("active_tasks") or 0)
            overview.append(
                {
                    "worker_id": worker.get("worker_id", "unknown"),
                    "active_tasks": active_tasks,
                    "max_parallel_jobs": max_parallel_jobs,
                    "utilization_pct": round((active_tasks / max_parallel_jobs) * 100, 2)
                    if max_parallel_jobs
                    else 0,
                    "status": worker.get("status", "unknown"),
                    "last_seen_at": worker.get("last_seen_at", ""),
                }
            )
        return overview

    @classmethod
    def _performance_rows(
        cls,
        requests: list[LLMRequest],
        responses_by_request: dict[str, list[LLMResponse]],
        diagnostics_by_request: dict[str, dict[str, Any]],
        *,
        key_attr: str,
    ) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for request in requests:
            key = getattr(request, key_attr) or "unknown"
            metrics = cls.request_metrics(responses_by_request.get(request.request_id, []))
            grouped[key].append(
                {
                    "status": request.status,
                    "processing_time_ms": metrics["processing_time_ms"] or 0,
                    "was_retried": diagnostics_by_request.get(request.request_id, {}).get("was_retried", False),
                }
            )

        results = []
        for key, rows in grouped.items():
            count = len(rows)
            latencies = [row["processing_time_ms"] for row in rows if row["processing_time_ms"]]
            errors = sum(1 for row in rows if row["status"] in {"failed", "timeout"})
            timeouts = sum(1 for row in rows if row["status"] == "timeout")
            retries = sum(1 for row in rows if row["was_retried"])
            results.append(
                {
                    "key": key,
                    "request_count": count,
                    "average_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else 0,
                    "error_rate": round((errors / count) * 100, 2) if count else 0,
                    "timeout_rate": round((timeouts / count) * 100, 2) if count else 0,
                    "retry_rate": round((retries / count) * 100, 2) if count else 0,
                }
            )
        results.sort(key=lambda item: (-item["request_count"], item["key"]))
        return results[:8]

    async def list_config_entries(self) -> list[ConfigEntry]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(select(ConfigEntry).order_by(ConfigEntry.key.asc()))
            return list(result.scalars().all())

    async def update_config_entry(
        self, key: str, value_json: Any, actor: str
    ) -> tuple[ConfigEntry, Any]:
        if key not in EDITABLE_CONFIG_KEYS:
            raise ValueError("Config key is not editable from admin UI")

        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(select(ConfigEntry).where(ConfigEntry.key == key))
            entry = result.scalar_one_or_none()
            if entry is None:
                raise LookupError("Config entry not found")
            if not entry.editable_from_ui:
                raise ValueError("Config entry is not editable from admin UI")

            before_value = entry.value_json
            entry.value_json = value_json
            entry.updated_by = actor
            await session.commit()
            await session.refresh(entry)
            return entry, before_value

    async def list_models(self) -> list[ModelConfig]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(select(ModelConfig).order_by(ModelConfig.name.asc()))
            return list(result.scalars().all())

    async def update_model(
        self, model_name: str, updates: dict[str, Any]
    ) -> tuple[ModelConfig, dict[str, Any]]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(select(ModelConfig).where(ModelConfig.name == model_name))
            model = result.scalar_one_or_none()
            if model is None:
                raise LookupError("Model not found")

            before = {
                "alias": model.alias,
                "backend_url": model.backend_url,
                "timeout_seconds": model.timeout_seconds,
                "concurrency_limit": model.concurrency_limit,
                "queue_limit": model.queue_limit,
                "fallback_model": model.fallback_model,
                "is_enabled": model.is_enabled,
            }
            for key, value in updates.items():
                if value is not None:
                    setattr(model, key, value)
            await session.commit()
            await session.refresh(model)
            return model, before

    async def list_requests(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        status: str | None = None,
        source_app: str | None = None,
        model: str | None = None,
        search: str | None = None,
        error_only: bool = False,
        sort_by: str = "created_at",
        sort_dir: str = "desc",
    ) -> list[dict[str, Any]]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            sort_column = {
                "created_at": LLMRequest.created_at,
                "completed_at": LLMRequest.completed_at,
                "status": LLMRequest.status,
                "source_app": LLMRequest.source_app,
                "resolved_model": LLMRequest.resolved_model,
            }.get(sort_by, LLMRequest.created_at)
            order_by = sort_column.asc() if sort_dir == "asc" else sort_column.desc()
            statement = select(LLMRequest).order_by(order_by).offset(offset).limit(limit)
            if status:
                statement = statement.where(LLMRequest.status == status)
            if source_app:
                statement = statement.where(LLMRequest.source_app == source_app)
            if model:
                statement = statement.where(
                    or_(LLMRequest.requested_model == model, LLMRequest.resolved_model == model)
                )
            if error_only:
                statement = statement.where(LLMRequest.error_code.is_not(None))
            if search:
                pattern = f"%{search}%"
                statement = statement.where(
                    or_(
                        LLMRequest.request_id.ilike(pattern),
                        LLMRequest.trace_id.ilike(pattern),
                        LLMRequest.user_id.ilike(pattern),
                        LLMRequest.org_id.ilike(pattern),
                    )
                )

            result = await session.execute(statement)
            requests = list(result.scalars().all())
            request_ids = [request.request_id for request in requests]
            response_map: dict[str, list[LLMResponse]] = defaultdict(list)
            if request_ids:
                response_result = await session.execute(
                    select(LLMResponse)
                    .where(LLMResponse.request_id.in_(request_ids))
                    .order_by(LLMResponse.created_at.asc())
                )
                for response in response_result.scalars().all():
                    response_map[response.request_id].append(response)

            return [
                {
                    "request_id": request.request_id,
                    "trace_id": request.trace_id,
                    "source_app": request.source_app,
                    "user_id": request.user_id,
                    "org_id": request.org_id,
                    **self._identity_hints(request),
                    "requested_model": request.requested_model,
                    "resolved_model": request.resolved_model,
                    "status": request.status,
                    "error_code": request.error_code,
                    "total_tokens": self.request_metrics(response_map.get(request.request_id, []))["total_tokens"],
                    "processing_time_ms": self.request_metrics(response_map.get(request.request_id, []))["processing_time_ms"],
                    "created_at": request.created_at,
                    "completed_at": request.completed_at,
                }
                for request in requests
            ]

    async def get_request_detail(
        self, request_id: str
    ) -> tuple[
        LLMRequest,
        list[LLMResponse],
        list[LLMRequestEvent],
        list[QueueJob],
        dict[str, Any],
        dict[str, Any],
    ]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            request_result = await session.execute(select(LLMRequest).where(LLMRequest.request_id == request_id))
            request = request_result.scalar_one_or_none()
            if request is None:
                raise LookupError("Request not found")

            response_result = await session.execute(
                select(LLMResponse).where(LLMResponse.request_id == request_id).order_by(LLMResponse.created_at.asc())
            )
            event_result = await session.execute(
                select(LLMRequestEvent)
                .where(LLMRequestEvent.request_id == request_id)
                .order_by(LLMRequestEvent.created_at.asc())
            )
            queue_job_result = await session.execute(
                select(QueueJob).where(QueueJob.request_id == request_id).order_by(QueueJob.queued_at.asc())
            )
            responses = list(response_result.scalars().all())
            events = list(event_result.scalars().all())
            queue_jobs = list(queue_job_result.scalars().all())
            return (
                request,
                responses,
                events,
                queue_jobs,
                self.request_metrics(responses),
                self._request_diagnostics(request, events, queue_jobs),
            )

    async def get_queue_overview(self) -> dict[str, Any]:
        snapshots = await RedisScheduler().snapshot()
        session_factory = get_session_factory()
        current = now()
        async with session_factory() as session:
            models_result = await session.execute(select(ModelConfig))
            model_configs = {model.name: model for model in models_result.scalars().all()}
            jobs_result = await session.execute(select(QueueJob).where(QueueJob.status.in_(["queued", "processing", "retrying"])))
            jobs = list(jobs_result.scalars().all())
            events_result = await session.execute(
                select(LLMRequestEvent)
                .where(LLMRequestEvent.event_type == "dead_lettered")
                .where(LLMRequestEvent.created_at >= current - timedelta(days=1))
            )
            dead_events = list(events_result.scalars().all())

        waits_by_model: dict[str, list[int]] = defaultdict(list)
        oldest_waiting_by_model: dict[str, int] = defaultdict(int)
        retrying_by_model: dict[str, int] = defaultdict(int)
        for job in jobs:
            if job.started_at is not None:
                wait_ms = self._ms_between(job.queued_at, job.started_at)
                if wait_ms is not None:
                    waits_by_model[job.model_name].append(wait_ms)
            elif job.status == "queued":
                oldest_waiting_by_model[job.model_name] = max(
                    oldest_waiting_by_model[job.model_name],
                    self._ms_between(job.queued_at, current) or 0,
                )
            if job.status == "retrying":
                retrying_by_model[job.model_name] += 1

        dead_by_model: dict[str, int] = defaultdict(int)
        for event in dead_events:
            details = event.details_json or {}
            job_id = details.get("job_id")
            if not job_id:
                continue
        for event in dead_events:
            details = event.details_json or {}
            target_model = details.get("model_name")
            if isinstance(target_model, str):
                dead_by_model[target_model] += 1

        all_waits = [wait for waits in waits_by_model.values() for wait in waits]
        model_names = set(snapshots.keys()) | set(model_configs.keys()) | {job.model_name for job in jobs}
        models = []
        for model_name in sorted(model_names):
            snapshot = snapshots.get(model_name)
            model_config = model_configs.get(model_name)
            active = snapshot.active if snapshot else 0
            waiting = snapshot.waiting if snapshot else 0
            concurrency_limit = model_config.concurrency_limit if model_config else None
            queue_limit = model_config.queue_limit if model_config else None
            utilization_pct = round((active / concurrency_limit) * 100, 2) if concurrency_limit else 0
            waits = waits_by_model.get(model_name, [])
            models.append(
                {
                    "model_name": model_name,
                    "active": active,
                    "waiting": waiting,
                    "concurrency_limit": concurrency_limit,
                    "queue_limit": queue_limit,
                    "utilization_pct": utilization_pct,
                    "avg_wait_ms": round(sum(waits) / len(waits), 2) if waits else 0,
                    "p95_wait_ms": self._percentile(waits, 0.95) if waits else 0,
                    "oldest_waiting_age_ms": oldest_waiting_by_model.get(model_name, 0),
                    "retrying_jobs": retrying_by_model.get(model_name, 0),
                    "dead_lettered_recent": dead_by_model.get(model_name, 0),
                }
            )

        return {
            "total_active": sum(item["active"] for item in models),
            "total_waiting": sum(item["waiting"] for item in models),
            "avg_wait_ms": round(sum(all_waits) / len(all_waits), 2) if all_waits else 0,
            "p95_wait_ms": self._percentile(all_waits, 0.95) if all_waits else 0,
            "max_wait_ms": max(all_waits) if all_waits else 0,
            "oldest_waiting_age_ms": max(oldest_waiting_by_model.values(), default=0),
            "models": models,
        }

    async def list_error_categories(self, limit: int = 10) -> list[dict[str, Any]]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(
                select(LLMRequest.error_code, func.count(LLMRequest.id))
                .where(LLMRequest.error_code.is_not(None))
                .group_by(LLMRequest.error_code)
                .order_by(func.count(LLMRequest.id).desc(), LLMRequest.error_code.asc())
                .limit(limit)
            )
            return [{"error_code": error_code or "unknown", "count": count} for error_code, count in result.all()]

    async def get_overview(
        self,
        *,
        days: int = 7,
        recent_request_limit: int = 12,
    ) -> dict[str, Any]:
        current = now()
        start_day = start_of_day(current)
        week_start = start_day - timedelta(days=6)
        series_start = start_day - timedelta(days=max(days - 1, 0))
        session_factory = get_session_factory()
        async with session_factory() as session:
            total_requests = int(await session.scalar(select(func.count()).select_from(LLMRequest)) or 0)
            requests_today = int(
                await session.scalar(select(func.count()).select_from(LLMRequest).where(LLMRequest.created_at >= start_day)) or 0
            )
            requests_week = int(
                await session.scalar(select(func.count()).select_from(LLMRequest).where(LLMRequest.created_at >= week_start)) or 0
            )
            total_errors = int(
                await session.scalar(
                    select(func.count()).select_from(LLMRequest).where(LLMRequest.status.in_(["failed", "timeout"]))
                )
                or 0
            )

            request_rows = list(
                (
                    await session.execute(
                        select(LLMRequest).where(LLMRequest.created_at >= series_start).order_by(LLMRequest.created_at.asc())
                    )
                ).scalars().all()
            )
            response_rows = list(
                (
                    await session.execute(
                        select(LLMResponse).where(LLMResponse.created_at >= series_start).order_by(LLMResponse.created_at.asc())
                    )
                ).scalars().all()
            )
            event_rows = list(
                (
                    await session.execute(
                        select(LLMRequestEvent)
                        .where(LLMRequestEvent.created_at >= series_start)
                        .order_by(LLMRequestEvent.created_at.asc())
                    )
                ).scalars().all()
            )
            queue_job_rows = list(
                (
                    await session.execute(select(QueueJob).where(QueueJob.queued_at >= series_start).order_by(QueueJob.queued_at.asc()))
                ).scalars().all()
            )

            recent_requests = await self.list_requests(limit=recent_request_limit)
            status_rows = (
                await session.execute(
                    select(LLMRequest.status, func.count(LLMRequest.id)).group_by(LLMRequest.status).order_by(func.count(LLMRequest.id).desc())
                )
            ).all()
            source_rows = (
                await session.execute(
                    select(func.coalesce(LLMRequest.source_app, "unknown"), func.count(LLMRequest.id))
                    .group_by(LLMRequest.source_app)
                    .order_by(func.count(LLMRequest.id).desc())
                )
            ).all()
            model_rows = (
                await session.execute(
                    select(
                        func.coalesce(LLMRequest.resolved_model, LLMRequest.requested_model, "unknown"),
                        func.count(LLMRequest.id),
                    )
                    .group_by(LLMRequest.resolved_model, LLMRequest.requested_model)
                    .order_by(func.count(LLMRequest.id).desc())
                )
            ).all()

        response_map: dict[str, list[LLMResponse]] = defaultdict(list)
        for response in response_rows:
            response_map[response.request_id].append(response)

        event_map: dict[str, list[LLMRequestEvent]] = defaultdict(list)
        for event in event_rows:
            event_map[event.request_id].append(event)

        queue_job_map: dict[str, list[QueueJob]] = defaultdict(list)
        for job in queue_job_rows:
            queue_job_map[job.request_id].append(job)

        diagnostics_by_request: dict[str, dict[str, Any]] = {}
        for request in request_rows:
            diagnostics_by_request[request.request_id] = self._request_diagnostics(
                request,
                event_map.get(request.request_id, []),
                queue_job_map.get(request.request_id, []),
            )

        buckets: dict[str, dict[str, float]] = {}
        for offset in range(days):
            day = series_start + timedelta(days=offset)
            buckets[day.date().isoformat()] = {
                "requests": 0,
                "tokens": 0,
                "errors": 0,
                "latency_sum": 0,
                "latency_count": 0,
            }

        for request in request_rows:
            key = request.created_at.astimezone(current_timezone()).date().isoformat()
            if key in buckets:
                buckets[key]["requests"] += 1
                if request.status in {"failed", "timeout"}:
                    buckets[key]["errors"] += 1

        tokens_today = 0
        tokens_week = 0
        latency_values: list[int] = []
        queue_wait_values: list[int] = []
        slow_requests: list[dict[str, Any]] = []
        timeout_count = 0
        retried_requests = 0
        eventual_success_after_retry = 0
        for request in request_rows:
            responses = response_map.get(request.request_id, [])
            metrics = self.request_metrics(responses)
            diagnostics = diagnostics_by_request[request.request_id]
            processing_time_ms = metrics["processing_time_ms"] or 0
            if processing_time_ms:
                latency_values.append(processing_time_ms)
            if diagnostics.get("queue_wait_ms") is not None:
                queue_wait_values.append(int(diagnostics["queue_wait_ms"]))
            if diagnostics["was_retried"]:
                retried_requests += 1
                if request.status == "completed":
                    eventual_success_after_retry += 1
            if request.status == "timeout":
                timeout_count += 1
            if processing_time_ms >= SLOW_REQUEST_THRESHOLD_MS:
                slow_requests.append(
                    {
                        "request_id": request.request_id,
                        "source_app": request.source_app,
                        "resolved_model": request.resolved_model,
                        "processing_time_ms": processing_time_ms,
                        "queue_wait_ms": diagnostics.get("queue_wait_ms"),
                        "status": request.status,
                        "created_at": request.created_at,
                    }
                )

        for response in response_rows:
            usage = self.extract_usage(response.response_payload_json)
            total_tokens_value = usage["total_tokens"]
            response_day = response.created_at.astimezone(current_timezone())
            key = response_day.date().isoformat()
            if key in buckets:
                buckets[key]["tokens"] += total_tokens_value
                if response.processing_time_ms is not None:
                    buckets[key]["latency_sum"] += response.processing_time_ms
                    buckets[key]["latency_count"] += 1
            if response_day >= start_day:
                tokens_today += total_tokens_value
            if response_day >= week_start:
                tokens_week += total_tokens_value

        queue = await self.get_queue_overview()
        workers = await self.get_worker_overview()
        total_retry_events = sum(1 for event in event_rows if event.event_type == "retry_scheduled")
        dead_lettered_requests = sum(
            1 for diagnostics in diagnostics_by_request.values() if diagnostics["dead_lettered"]
        )
        average_latency_ms = round(sum(latency_values) / len(latency_values), 2) if latency_values else 0.0
        error_rate = round((total_errors / total_requests) * 100, 2) if total_requests else 0.0
        retry_rate = round((retried_requests / total_requests) * 100, 2) if total_requests else 0.0
        timeout_rate = round((timeout_count / total_requests) * 100, 2) if total_requests else 0.0
        slow_request_rate = round((len(slow_requests) / total_requests) * 100, 2) if total_requests else 0.0

        requests_series = []
        tokens_series = []
        errors_series = []
        latency_series = []
        for key, values in sorted(buckets.items()):
            label = datetime.fromisoformat(key).strftime("%b %d")
            requests_series.append({"label": label, "value": values["requests"]})
            tokens_series.append({"label": label, "value": values["tokens"]})
            errors_series.append({"label": label, "value": values["errors"]})
            latency_series.append(
                {
                    "label": label,
                    "value": round(values["latency_sum"] / values["latency_count"], 2) if values["latency_count"] else 0,
                }
            )

        alerts = [
            {
                "code": "high_error_rate",
                "severity": "critical" if error_rate >= ERROR_ALERT_RATE_THRESHOLD else "info",
                "active": error_rate >= ERROR_ALERT_RATE_THRESHOLD,
                "message": "Error rate is above the configured operational threshold.",
                "observed_value": error_rate,
            },
            {
                "code": "queue_backlog",
                "severity": "warning" if queue["total_waiting"] >= QUEUE_ALERT_DEPTH_THRESHOLD else "info",
                "active": queue["total_waiting"] >= QUEUE_ALERT_DEPTH_THRESHOLD,
                "message": "Queued backlog is growing and may delay requests.",
                "observed_value": queue["total_waiting"],
            },
            {
                "code": "queue_wait_spike",
                "severity": "warning" if queue["p95_wait_ms"] >= QUEUE_ALERT_WAIT_THRESHOLD_MS else "info",
                "active": queue["p95_wait_ms"] >= QUEUE_ALERT_WAIT_THRESHOLD_MS,
                "message": "Queue wait times are above the acceptable threshold.",
                "observed_value": queue["p95_wait_ms"],
            },
            {
                "code": "latency_spike",
                "severity": "warning" if average_latency_ms >= LATENCY_ALERT_THRESHOLD_MS else "info",
                "active": average_latency_ms >= LATENCY_ALERT_THRESHOLD_MS,
                "message": "Average request latency is elevated.",
                "observed_value": average_latency_ms,
            },
            {
                "code": "worker_unavailable",
                "severity": "critical" if not workers else "info",
                "active": not workers,
                "message": "No active worker heartbeats were detected.",
                "observed_value": len(workers),
            },
        ]

        await AlertingService().notify_if_needed(alerts)

        return {
            "summary": {
                "total_requests": total_requests,
                "requests_today": requests_today,
                "requests_week": requests_week,
                "tokens_today": tokens_today,
                "tokens_week": tokens_week,
                "average_latency_ms": average_latency_ms,
                "error_rate": error_rate,
                "queue_depth": queue["total_waiting"],
                "active_requests": queue["total_active"],
                "queue_wait_avg_ms": queue["avg_wait_ms"],
                "queue_wait_p95_ms": queue["p95_wait_ms"],
                "slow_request_rate": slow_request_rate,
                "retry_rate": retry_rate,
                "timeout_rate": timeout_rate,
            },
            "queue": queue,
            "workers": workers,
            "alerts": alerts,
            "retry_summary": {
                "retried_requests": retried_requests,
                "retry_rate": retry_rate,
                "eventual_success_after_retry": eventual_success_after_retry,
                "dead_lettered_requests": dead_lettered_requests,
                "currently_retrying_jobs": sum(item["retrying_jobs"] for item in queue["models"]),
                "total_retry_events": total_retry_events,
            },
            "status_breakdown": [{"key": status, "value": count} for status, count in status_rows],
            "source_breakdown": [{"key": source, "value": count} for source, count in source_rows],
            "model_breakdown": [{"key": model, "value": count} for model, count in model_rows[:8]],
            "model_performance": self._performance_rows(
                request_rows,
                response_map,
                diagnostics_by_request,
                key_attr="resolved_model",
            ),
            "source_performance": self._performance_rows(
                request_rows,
                response_map,
                diagnostics_by_request,
                key_attr="source_app",
            ),
            "slow_requests": sorted(slow_requests, key=lambda item: item["processing_time_ms"], reverse=True)[:8],
            "requests_series": requests_series,
            "tokens_series": tokens_series,
            "errors_series": errors_series,
            "latency_series": latency_series,
            "recent_requests": recent_requests,
        }

    async def clear_all_requests(self) -> dict[str, int]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            deleted_responses = await session.execute(delete(LLMResponse))
            deleted_events = await session.execute(delete(LLMRequestEvent))
            deleted_jobs = await session.execute(delete(QueueJob))
            deleted_requests = await session.execute(delete(LLMRequest))
            await session.commit()
            return {
                "requests": int(deleted_requests.rowcount or 0),
                "responses": int(deleted_responses.rowcount or 0),
                "events": int(deleted_events.rowcount or 0),
                "jobs": int(deleted_jobs.rowcount or 0),
            }
