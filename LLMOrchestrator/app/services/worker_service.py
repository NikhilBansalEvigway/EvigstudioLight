from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime
from time import perf_counter
from typing import Any

import httpx
from sqlalchemy import select

from app.core.logging import get_logger
from app.core.settings import get_settings
from app.core.time import now
from app.db.session import get_session_factory
from app.models.llm_request import LLMRequest
from app.models.queue_job import QueueJob
from app.services.job_queue import JobQueueService
from app.services.lm_studio_client import LMStudioClient
from app.services.model_registry import ModelRegistryService
from app.services.quota_service import QuotaLease, QuotaService
from app.services.request_store import RequestStore, elapsed_ms
from app.services.scheduler import RedisScheduler
from app.services.worker_monitor import WorkerMonitorService

logger = get_logger(__name__)


def utc_now() -> datetime:
    return now()


def _sanitize_tools_for_lmstudio(payload: dict[str, Any]) -> dict[str, Any]:
    """Fix tool parameter schemas with missing 'type' fields.
    LM Studio's Gemma jinja template crashes with | upper on undefined types."""
    if not payload.get("tools"):
        return payload

    def fix_properties(properties: dict) -> None:
        if not isinstance(properties, dict):
            return
        for value in properties.values():
            if not isinstance(value, dict):
                continue
            if "type" not in value or value["type"] is None:
                if "properties" in value:
                    value["type"] = "object"
                elif "items" in value:
                    value["type"] = "array"
                elif "enum" in value:
                    value["type"] = "string"
                else:
                    value["type"] = "string"
            if "properties" in value:
                fix_properties(value["properties"])

    payload = copy.deepcopy(payload)
    for tool in payload["tools"]:
        params = tool.get("function", {}).get("parameters", {})
        if not params:
            continue
        if "type" not in params or params["type"] is None:
            params["type"] = "object"
        if "properties" in params:
            fix_properties(params["properties"])

    return payload


def _strip_lm_studio_base_url_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove lm_studio_base_url from OpenAI metadata; runtime config controls routing."""
    md = payload.get("metadata")
    if not isinstance(md, dict):
        return payload
    raw = md.get("lm_studio_base_url")
    if raw is None:
        return payload
    new_md = {k: v for k, v in md.items() if k != "lm_studio_base_url"}
    if new_md:
        payload["metadata"] = new_md
    else:
        payload.pop("metadata", None)
    return payload


def _stream_usage_template() -> dict[str, int]:
    return {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
    }


def _merge_usage(usage: dict[str, int], chunk: dict[str, Any]) -> None:
    raw_usage = chunk.get("usage")
    if not isinstance(raw_usage, dict):
        return
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        usage[key] = max(usage[key], int(raw_usage.get(key) or 0))


def _ensure_stream_usage_payload(payload: dict[str, Any]) -> dict[str, Any]:
    payload = copy.deepcopy(payload)
    payload["stream"] = True
    stream_options = payload.get("stream_options")
    if not isinstance(stream_options, dict):
        stream_options = {}
    stream_options.setdefault("include_usage", True)
    payload["stream_options"] = stream_options
    return payload


class WorkerService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.job_queue = JobQueueService()
        self.scheduler = RedisScheduler()
        self.model_registry = ModelRegistryService()
        self.request_store = RequestStore()
        self.quota_service = QuotaService()
        self.lm_client = LMStudioClient()
        self._max_parallel_jobs = max(1, self.settings.worker_max_parallel_jobs)
        self.worker_monitor = WorkerMonitorService()
        self.worker_id = self.worker_monitor.new_worker_id()

    async def run_forever(self) -> None:
        running_tasks: set[asyncio.Task] = set()
        while True:
            await self.worker_monitor.publish_heartbeat(
                worker_id=self.worker_id,
                active_tasks=len(running_tasks),
                max_parallel_jobs=self._max_parallel_jobs,
                status="running",
            )
            # Reap completed tasks so failures do not get swallowed.
            completed = {task for task in running_tasks if task.done()}
            for task in completed:
                running_tasks.remove(task)
                try:
                    task.result()
                except Exception:
                    logger.exception("worker_task_failed")

            if len(running_tasks) >= self._max_parallel_jobs:
                done, _ = await asyncio.wait(
                    running_tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in done:
                    running_tasks.remove(task)
                    try:
                        task.result()
                    except Exception:
                        logger.exception("worker_task_failed")
                continue

            job = await self._dequeue_next_job()
            if job is None:
                if running_tasks:
                    done, _ = await asyncio.wait(
                        running_tasks,
                        timeout=0.05,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in done:
                        running_tasks.remove(task)
                        try:
                            task.result()
                        except Exception:
                            logger.exception("worker_task_failed")
                continue
            running_tasks.add(asyncio.create_task(self._process_job(job)))

    async def process_once(self) -> bool:
        job = await self._dequeue_next_job()
        if job is None:
            return False
        await self._process_job(job)
        return True

    async def _dequeue_next_job(self) -> dict[str, Any] | None:
        models = await self.model_registry.list_models()
        enabled_model_names = {model.name for model in models if model.is_enabled}
        ordered_names = [model.name for model in models if model.is_enabled]

        # Also consume dynamically discovered queue names so UI-selected models
        # not yet present in model_configs are still processed.
        snapshots = await self.scheduler.snapshot()
        dynamic_names = sorted(
            name
            for name, snap in snapshots.items()
            if snap.waiting > 0 and name not in enabled_model_names
        )
        # Prefer queues that currently have waiting jobs (often UI-only / LM Studio models
        # not yet in model_configs) before scanning every enabled row — avoids long stalls.
        queue_names = dynamic_names + ordered_names

        job = await self.job_queue.dequeue_any(
            queue_names,
            timeout_seconds=self.settings.worker_blocking_pop_timeout_seconds,
        )
        return job

    async def _process_job(self, job: dict[str, Any]) -> None:
        request_id = job["request_id"]
        job_id = job["job_id"]
        model_name = job["model_name"]
        user_id = job.get("user_id")
        org_id = job.get("org_id")
        quota_lease = QuotaLease(user_id=user_id, org_id=org_id)
        scheduler_lease = None
        started = perf_counter()
        session_factory = get_session_factory()
        max_retries = int(job.get("max_retries", self.settings.default_max_retries))

        async with session_factory() as session:
            request_result = await session.execute(
                select(LLMRequest).where(LLMRequest.request_id == request_id)
            )
            request = request_result.scalar_one()

            queue_job_result = await session.execute(
                select(QueueJob).where(QueueJob.job_id == job_id)
            )
            queue_job = queue_job_result.scalar_one()

            model_config = await self.model_registry.resolve(model_name)
            try:
                scheduler_lease = await self.scheduler.acquire_slot(
                    model_name=model_name,
                    concurrency_limit=model_config.concurrency_limit,
                    wait_timeout_seconds=self.settings.scheduler_acquire_timeout_seconds,
                )
                queue_job.status = "processing"
                queue_job.attempts += 1
                queue_job.started_at = utc_now()
                request.status = "processing"
                await self.request_store.add_event(
                    session,
                    request_id=request_id,
                    event_type="worker_started",
                    details_json={
                        "job_id": job_id,
                        "wait_time_ms": scheduler_lease.wait_time_ms,
                    },
                )
                await session.commit()

                sanitized_payload = _sanitize_tools_for_lmstudio(
                    job["request_payload_json"]
                )
                to_lm = _strip_lm_studio_base_url_from_payload(sanitized_payload)
                if job.get("stream"):
                    response_payload = await self._run_streaming_job(
                        job_id=job_id,
                        payload=to_lm,
                        timeout_seconds=model_config.timeout_seconds,
                        lm_studio_base_url=model_config.backend_url,
                    )
                else:
                    response_payload = await self.lm_client.chat_completion(
                        to_lm,
                        timeout_seconds=model_config.timeout_seconds,
                        lm_studio_base_url=model_config.backend_url,
                    )
                output_text, finish_reason = self._extract_output_text(response_payload)
                duration_ms = elapsed_ms(started)
                queue_job.status = "completed"
                queue_job.completed_at = utc_now()
                await self.request_store.mark_success(
                    session,
                    request=request,
                    response_payload_json=response_payload,
                    output_text=output_text,
                    finish_reason=finish_reason,
                    processing_time_ms=duration_ms,
                )
                await session.commit()
                await self.job_queue.publish_result(
                    job_id,
                    {
                        "status": "completed",
                        "response_payload": response_payload,
                    },
                )
                if job.get("stream"):
                    await self.job_queue.publish_stream_event(
                        job_id,
                        {"type": "done"},
                        ttl_seconds=model_config.timeout_seconds + 300,
                    )
            except httpx.HTTPStatusError as exc:
                await self._fail_job(
                    session,
                    request=request,
                    queue_job=queue_job,
                    model_name=model_name,
                    job_id=job_id,
                    job_payload=job,
                    max_retries=max_retries,
                    error_code=f"http_{exc.response.status_code}",
                    error_message=exc.response.text,
                    duration_ms=elapsed_ms(started),
                )
            except httpx.TimeoutException as exc:
                timeout_message = str(exc).strip() or (
                    f"LM Studio request timed out after "
                    f"{model_config.timeout_seconds}s"
                )
                await self._fail_job(
                    session,
                    request=request,
                    queue_job=queue_job,
                    model_name=model_name,
                    job_id=job_id,
                    job_payload=job,
                    max_retries=max_retries,
                    error_code="upstream_timeout",
                    error_message=timeout_message,
                    duration_ms=elapsed_ms(started),
                )
            except httpx.RequestError as exc:
                request_error_message = str(exc).strip() or (
                    f"LM Studio network error ({exc.__class__.__name__})"
                )
                await self._fail_job(
                    session,
                    request=request,
                    queue_job=queue_job,
                    model_name=model_name,
                    job_id=job_id,
                    job_payload=job,
                    max_retries=max_retries,
                    error_code="upstream_request_error",
                    error_message=request_error_message,
                    duration_ms=elapsed_ms(started),
                )
            except TimeoutError as exc:
                await self._fail_job(
                    session,
                    request=request,
                    queue_job=queue_job,
                    model_name=model_name,
                    job_id=job_id,
                    job_payload=job,
                    max_retries=max_retries,
                    error_code="scheduler_slot_timeout",
                    error_message=str(exc).strip() or "Worker could not acquire model slot in time",
                    duration_ms=elapsed_ms(started),
                )
            except Exception as exc:
                generic_error_message = str(exc).strip() or exc.__class__.__name__
                await self._fail_job(
                    session,
                    request=request,
                    queue_job=queue_job,
                    model_name=model_name,
                    job_id=job_id,
                    job_payload=job,
                    max_retries=max_retries,
                    error_code="worker_execution_error",
                    error_message=generic_error_message,
                    duration_ms=elapsed_ms(started),
                )
            finally:
                if scheduler_lease is not None:
                    await self.scheduler.release(scheduler_lease)
                await self.quota_service.release(quota_lease)

    async def _run_streaming_job(
        self,
        *,
        job_id: str,
        payload: dict[str, Any],
        timeout_seconds: int,
        lm_studio_base_url: str,
    ) -> dict[str, Any]:
        stream_payload = _ensure_stream_usage_payload(payload)

        completion_id: str | None = None
        created: int | None = None
        model_name: str | None = None
        content_parts: list[str] = []
        finish_reason: str | None = None
        usage = _stream_usage_template()

        async for sse in self.lm_client.chat_completion_stream(
            stream_payload,
            timeout_seconds=timeout_seconds,
            lm_studio_base_url=lm_studio_base_url,
        ):
            await self.job_queue.publish_stream_event(
                job_id,
                {"type": "sse", "data": sse},
                ttl_seconds=timeout_seconds + 300,
            )
            stripped = sse.strip()
            if not stripped.startswith("data: "):
                continue
            data = stripped.removeprefix("data: ").strip()
            if data == "[DONE]":
                continue
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue

            _merge_usage(usage, chunk)
            completion_id = completion_id or chunk.get("id")
            created = created or chunk.get("created")
            model_name = model_name or chunk.get("model")
            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice0 = choices[0] or {}
            delta = choice0.get("delta") or {}
            delta_content = delta.get("content")
            if isinstance(delta_content, str) and delta_content:
                content_parts.append(delta_content)
            if choice0.get("finish_reason"):
                finish_reason = choice0["finish_reason"]

        return {
            "id": completion_id or f"chatcmpl-{job_id}",
            "object": "chat.completion",
            "created": created or int(now().timestamp()),
            "model": model_name or payload.get("model", ""),
            "usage": usage,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "".join(content_parts)},
                    "finish_reason": finish_reason or "stop",
                }
            ],
        }

    async def _fail_job(
        self,
        session,
        *,
        request: LLMRequest,
        queue_job: QueueJob,
        model_name: str,
        job_id: str,
        job_payload: dict[str, Any],
        max_retries: int,
        error_code: str,
        error_message: str,
        duration_ms: int,
    ) -> None:
        queue_job.status = "failed"
        queue_job.error_message = error_message
        queue_job.completed_at = utc_now()
        if queue_job.attempts <= max_retries:
            queue_job.status = "retrying"
            await self.request_store.add_event(
                session,
                request_id=request.request_id,
                event_type="retry_scheduled",
                details_json={
                    "job_id": job_id,
                    "attempt": queue_job.attempts,
                    "max_retries": max_retries,
                    "error_code": error_code,
                },
            )
            await session.commit()
            await self.job_queue.enqueue(
                model_name=model_name,
                job_id=job_id,
                payload={**job_payload, "max_retries": max_retries},
                queue_limit=100000,
            )
            return

        await self.request_store.add_event(
            session,
            request_id=request.request_id,
            event_type="dead_lettered",
            details_json={
                "job_id": job_id,
                "error_code": error_code,
                "model_name": model_name,
                "attempts": queue_job.attempts,
            },
        )
        await self.request_store.mark_failure(
            session,
            request=request,
            error_code=error_code,
            error_message=error_message,
            processing_time_ms=duration_ms,
        )
        await session.commit()
        await self.job_queue.publish_stream_event(
            job_id,
            {
                "type": "error",
                "error_code": error_code,
                "error_message": error_message,
            },
        )
        await self.job_queue.publish_stream_event(job_id, {"type": "done"})
        await self.job_queue.publish_result(
            job_id,
            {
                "status": "failed",
                "error_code": error_code,
                "error_message": error_message,
            },
        )
        await self.job_queue.push_dead_letter(
            model_name,
            {
                "job_id": job_id,
                "request_id": request.request_id,
                "error_code": error_code,
                "error_message": error_message,
                "attempts": queue_job.attempts,
            },
        )
        logger.error(
            "worker_job_failed",
            extra={
                "request_id": request.request_id,
                "job_id": job_id,
                "error_code": error_code,
            },
        )

    def _extract_output_text(
        self, payload: dict[str, Any]
    ) -> tuple[str | None, str | None]:
        choices = payload.get("choices") or []
        if not choices:
            return None, None
        choice = choices[0]
        message = choice.get("message") or {}
        return message.get("content"), choice.get("finish_reason")
