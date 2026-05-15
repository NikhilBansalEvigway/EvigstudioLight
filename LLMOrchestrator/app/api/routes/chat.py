from __future__ import annotations

import asyncio
import json
import uuid
from copy import deepcopy
from time import perf_counter
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select

from app.core.logging import get_logger
from app.db.session import get_session_factory
from app.schemas.chat import ChatCompletionRequest, ChatCompletionResponse, ChatMessage
from app.services.job_queue import JobQueueService
from app.services.lm_studio_client import LMStudioClient
from app.services.model_registry import ModelRegistryService
from app.models.queue_job import QueueJob
from app.services.request_store import RequestStore, elapsed_ms
from app.services.request_trace import new_trace_id

router = APIRouter(prefix="/v1", tags=["chat"])
logger = get_logger(__name__)


def _extract_input_text(messages: list[ChatMessage]) -> str | None:
    parts: list[str] = []
    for message in messages:
        if isinstance(message.content, str):
            parts.append(message.content)
        elif isinstance(message.content, list):
            for part in message.content:
                if isinstance(part, dict) and "text" in part:
                    parts.append(part["text"])
    return "\n".join(parts) if parts else None


def _extract_output_text(payload: dict) -> tuple[str | None, str | None]:
    choices = payload.get("choices") or []
    if not choices:
        return None, None
    choice = choices[0]
    message = choice.get("message") or {}
    return message.get("content"), choice.get("finish_reason")


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
    payload = deepcopy(payload)
    payload["stream"] = True
    stream_options = payload.get("stream_options")
    if not isinstance(stream_options, dict):
        stream_options = {}
    stream_options.setdefault("include_usage", True)
    payload["stream_options"] = stream_options
    return payload


def _sanitize_tools_for_lmstudio(payload: dict[str, Any]) -> dict[str, Any]:
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

    payload = deepcopy(payload)
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


def _request_headers(request: Request) -> dict[str, str | None]:
    return {
        "trace_id": request.headers.get("x-trace-id") or request.headers.get("x-request-id"),
        "source_app": request.headers.get("x-source-app"),
        "user_id": request.headers.get("x-user-id"),
        "org_id": request.headers.get("x-org-id"),
    }


def _request_context(
    http_request: Request,
    payload_metadata: dict[str, Any] | None,
) -> dict[str, str | None]:
    payload_metadata = payload_metadata or {}
    headers = _request_headers(http_request)
    return {
        "request_id": str(uuid.uuid4()),
        "trace_id": str(payload_metadata.get("trace_id") or headers["trace_id"] or new_trace_id()),
        "source_app": str(
            payload_metadata.get("source_app") or headers["source_app"] or "unknown"
        ),
        "user_id": payload_metadata.get("user_id") or headers["user_id"],
        "org_id": payload_metadata.get("org_id") or headers["org_id"],
    }


def _response_headers(request_id: str, trace_id: str) -> dict[str, str]:
    return {"x-request-id": request_id, "x-trace-id": trace_id}


@router.post("/chat/completions")
async def create_chat_completion(
    http_request: Request,
    request: ChatCompletionRequest,
    use_queue: bool = Query(True),
) -> ChatCompletionResponse:
    model_registry = ModelRegistryService()
    lm_client = LMStudioClient()
    request_store = RequestStore()
    model_config = await model_registry.resolve(request.model)
    if not model_config.is_enabled:
        raise HTTPException(status_code=503, detail="Requested model is disabled")

    request_payload = request.model_dump(by_alias=True)
    request_payload["model"] = model_config.resolved_model
    sanitized_payload = _sanitize_tools_for_lmstudio(request_payload)
    payload = _strip_lm_studio_base_url_from_payload(sanitized_payload)
    context = _request_context(http_request, request.metadata)

    if request.stream and not use_queue:
        session_factory = get_session_factory()
        async with session_factory() as session:
            async with session.begin():
                await request_store.create_request(
                    session,
                    request_id=context["request_id"],
                    trace_id=context["trace_id"],
                    source_app=context["source_app"],
                    user_id=context["user_id"],
                    org_id=context["org_id"],
                    requested_model=request.model,
                    resolved_model=model_config.resolved_model,
                    backend_url=model_config.backend_url,
                    request_payload_json=request_payload,
                    input_text=_extract_input_text(request.messages),
                    status="processing",
                    event_type="processing_started",
                    event_details_json={"mode": "direct_stream"},
                )

        async def direct_stream():
            started = perf_counter()
            content_parts: list[str] = []
            finish_reason: str | None = None
            usage = _stream_usage_template()
            try:
                async for sse in lm_client.chat_completion_stream(
                    _ensure_stream_usage_payload(payload),
                    timeout_seconds=model_config.timeout_seconds,
                    lm_studio_base_url=model_config.backend_url,
                ):
                    stripped = sse.strip()
                    if stripped.startswith("data: "):
                        data = stripped.removeprefix("data: ").strip()
                        if data != "[DONE]":
                            try:
                                chunk = json.loads(data)
                            except json.JSONDecodeError:
                                chunk = None
                            if isinstance(chunk, dict):
                                _merge_usage(usage, chunk)
                                choices = chunk.get("choices") or []
                                if choices:
                                    choice = choices[0] or {}
                                    delta = choice.get("delta") or {}
                                    delta_content = delta.get("content")
                                    if isinstance(delta_content, str) and delta_content:
                                        content_parts.append(delta_content)
                                    if choice.get("finish_reason"):
                                        finish_reason = choice["finish_reason"]
                    yield sse

                response_payload = {
                    "id": f"chatcmpl-{context['request_id']}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": model_config.resolved_model,
                    "usage": usage,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "".join(content_parts),
                            },
                            "finish_reason": finish_reason or "stop",
                        }
                    ],
                }
                async with session_factory() as session:
                    db_request = await request_store.get_request(session, context["request_id"])
                    await request_store.mark_success(
                        session,
                        request=db_request,
                        response_payload_json=response_payload,
                        output_text="".join(content_parts),
                        finish_reason=finish_reason or "stop",
                        processing_time_ms=elapsed_ms(started),
                    )
            except asyncio.CancelledError:
                async with session_factory() as session:
                    await request_store.add_event(
                        session,
                        request_id=context["request_id"],
                        event_type="client_cancelled",
                        details_json={"mode": "direct_stream"},
                    )
                    await session.commit()
                raise
            except httpx.TimeoutException as exc:
                async with session_factory() as session:
                    db_request = await request_store.get_request(session, context["request_id"])
                    await request_store.mark_failure(
                        session,
                        request=db_request,
                        error_code="upstream_timeout",
                        error_message=str(exc).strip() or "LM Studio request timed out",
                        processing_time_ms=elapsed_ms(started),
                    )
                raise
            except httpx.HTTPStatusError as exc:
                async with session_factory() as session:
                    db_request = await request_store.get_request(session, context["request_id"])
                    await request_store.mark_failure(
                        session,
                        request=db_request,
                        error_code=f"http_{exc.response.status_code}",
                        error_message=exc.response.text,
                        processing_time_ms=elapsed_ms(started),
                    )
                raise
            except httpx.RequestError as exc:
                async with session_factory() as session:
                    db_request = await request_store.get_request(session, context["request_id"])
                    await request_store.mark_failure(
                        session,
                        request=db_request,
                        error_code="upstream_request_error",
                        error_message=str(exc).strip() or "LM Studio unreachable",
                        processing_time_ms=elapsed_ms(started),
                    )
                raise
            except Exception as exc:
                logger.exception("chat_completion_stream_unhandled_error")
                async with session_factory() as session:
                    db_request = await request_store.get_request(session, context["request_id"])
                    await request_store.mark_failure(
                        session,
                        request=db_request,
                        error_code="internal_proxy_error",
                        error_message=str(exc).strip() or "Internal proxy error",
                        processing_time_ms=elapsed_ms(started),
                    )
                raise

        try:
            return StreamingResponse(
                direct_stream(),
                media_type="text/event-stream",
                headers=_response_headers(context["request_id"], context["trace_id"]),
            )
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail="LM Studio request timed out") from exc
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text if exc.response is not None else str(exc)
            raise HTTPException(status_code=502, detail=detail) from exc
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail="LM Studio unreachable") from exc
        except Exception as exc:
            logger.exception("chat_completion_stream_unhandled_error")
            raise HTTPException(status_code=500, detail="Internal proxy error") from exc

    if use_queue:
        session_factory = get_session_factory()
        job_queue = JobQueueService()
        job_id = str(uuid.uuid4())

        async with session_factory() as session:
            async with session.begin():
                await request_store.create_request(
                    session,
                    request_id=context["request_id"],
                    trace_id=context["trace_id"],
                    source_app=context["source_app"],
                    user_id=context["user_id"],
                    org_id=context["org_id"],
                    requested_model=request.model,
                    resolved_model=model_config.resolved_model,
                    backend_url=model_config.backend_url,
                    request_payload_json=request_payload,
                    input_text=_extract_input_text(request.messages),
                    status="queued",
                    event_type="queued",
                    event_details_json={"job_id": job_id, "mode": "queued"},
                )

                queue_job = QueueJob(
                    job_id=job_id,
                    request_id=context["request_id"],
                    model_name=model_config.resolved_model,
                    status="queued",
                )
                session.add(queue_job)

        try:
            await job_queue.enqueue(
                model_name=model_config.resolved_model,
                job_id=job_id,
                payload={
                    "request_id": context["request_id"],
                    "job_id": job_id,
                    "trace_id": context["trace_id"],
                    "model_name": model_config.resolved_model,
                    "user_id": context["user_id"],
                    "org_id": context["org_id"],
                    "source_app": context["source_app"],
                    "request_payload_json": request_payload,
                    "stream": request.stream,
                },
                queue_limit=model_config.queue_limit or 100,
            )
        except RuntimeError as exc:
            async with session_factory() as session:
                db_request = await request_store.get_request(session, context["request_id"])
                await request_store.mark_rejected(
                    session,
                    request=db_request,
                    error_code="queue_full",
                    error_message="Queue is full for the selected model",
                    details_json={"job_id": job_id, "model_name": model_config.resolved_model},
                )
                result = await session.execute(
                    select(QueueJob).where(QueueJob.job_id == job_id)
                )
                queue_job = result.scalar_one_or_none()
                if queue_job is not None:
                    await session.delete(queue_job)
                    await session.commit()
            raise HTTPException(status_code=429, detail="Queue is full") from exc

        if request.stream:
            async def queued_event_stream():
                timeout_seconds = model_config.timeout_seconds + 300
                try:
                    while True:
                        event = await job_queue.wait_for_stream_event(
                            job_id, timeout_seconds=timeout_seconds
                        )
                        if event is None:
                            yield 'data: {"error":"stream_timeout"}\n\n'
                            yield "data: [DONE]\n\n"
                            break
                        event_type = event.get("type")
                        if event_type == "sse":
                            data = event.get("data", "")
                            if isinstance(data, str):
                                yield data
                        elif event_type == "error":
                            err_payload = {
                                "error": {
                                    "code": event.get("error_code", "stream_error"),
                                    "message": event.get("error_message", "Streaming failed"),
                                }
                            }
                            yield f"data: {json.dumps(err_payload)}\n\n"
                        elif event_type == "done":
                            break
                except asyncio.CancelledError:
                    async with session_factory() as session:
                        await request_store.add_event(
                            session,
                            request_id=context["request_id"],
                            event_type="client_cancelled",
                            details_json={"mode": "queued_stream", "job_id": job_id},
                        )
                        await session.commit()
                    raise

            return StreamingResponse(
                queued_event_stream(),
                media_type="text/event-stream",
                headers=_response_headers(context["request_id"], context["trace_id"]),
            )

        result = await job_queue.wait_for_result(
            job_id, timeout_seconds=model_config.timeout_seconds + 300
        )
        if not result:
            raise HTTPException(status_code=504, detail="Job timed out in queue")

        if result["status"] == "failed":
            raise HTTPException(
                status_code=502, detail=result.get("error_message", "Job failed")
            )

        response_payload = result["response_payload"]
    else:
        session_factory = get_session_factory()
        async with session_factory() as session:
            async with session.begin():
                await request_store.create_request(
                    session,
                    request_id=context["request_id"],
                    trace_id=context["trace_id"],
                    source_app=context["source_app"],
                    user_id=context["user_id"],
                    org_id=context["org_id"],
                    requested_model=request.model,
                    resolved_model=model_config.resolved_model,
                    backend_url=model_config.backend_url,
                    request_payload_json=request_payload,
                    input_text=_extract_input_text(request.messages),
                    status="processing",
                    event_type="processing_started",
                    event_details_json={"mode": "direct"},
                )
        started = perf_counter()
        try:
            response_payload = await lm_client.chat_completion(
                payload,
                timeout_seconds=model_config.timeout_seconds,
                lm_studio_base_url=model_config.backend_url,
            )
        except httpx.TimeoutException as exc:
            async with session_factory() as session:
                db_request = await request_store.get_request(session, context["request_id"])
                await request_store.mark_failure(
                    session,
                    request=db_request,
                    error_code="upstream_timeout",
                    error_message="LM Studio request timed out",
                    processing_time_ms=elapsed_ms(started),
                )
            raise HTTPException(status_code=504, detail="LM Studio request timed out") from exc
        except httpx.HTTPStatusError as exc:
            async with session_factory() as session:
                db_request = await request_store.get_request(session, context["request_id"])
                await request_store.mark_failure(
                    session,
                    request=db_request,
                    error_code=f"http_{exc.response.status_code}",
                    error_message=exc.response.text,
                    processing_time_ms=elapsed_ms(started),
                )
            detail = exc.response.text if exc.response is not None else str(exc)
            raise HTTPException(status_code=502, detail=detail) from exc
        except httpx.RequestError as exc:
            async with session_factory() as session:
                db_request = await request_store.get_request(session, context["request_id"])
                await request_store.mark_failure(
                    session,
                    request=db_request,
                    error_code="upstream_request_error",
                    error_message="LM Studio unreachable",
                    processing_time_ms=elapsed_ms(started),
                )
            raise HTTPException(status_code=502, detail="LM Studio unreachable") from exc
        except Exception as exc:
            logger.exception("chat_completion_unhandled_error_direct_mode")
            async with session_factory() as session:
                db_request = await request_store.get_request(session, context["request_id"])
                await request_store.mark_failure(
                    session,
                    request=db_request,
                    error_code="internal_proxy_error",
                    error_message="Internal proxy error",
                    processing_time_ms=elapsed_ms(started),
                )
            raise HTTPException(status_code=500, detail="Internal proxy error") from exc

        output_text, finish_reason = _extract_output_text(response_payload)
        async with session_factory() as session:
            db_request = await request_store.get_request(session, context["request_id"])
            await request_store.mark_success(
                session,
                request=db_request,
                response_payload_json=response_payload,
                output_text=output_text,
                finish_reason=finish_reason,
                processing_time_ms=elapsed_ms(started),
            )

    return JSONResponse(
        content=response_payload,
        headers=_response_headers(context["request_id"], context["trace_id"]),
    )
