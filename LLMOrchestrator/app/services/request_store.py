from __future__ import annotations

from datetime import datetime
from time import perf_counter
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import now
from app.models.llm_request import LLMRequest
from app.models.llm_request_event import LLMRequestEvent
from app.models.llm_response import LLMResponse


def utc_now() -> datetime:
    return now()


class RequestStore:
    async def create_request(
        self,
        session: AsyncSession,
        *,
        request_id: str | None = None,
        trace_id: str,
        source_app: str | None,
        user_id: str | None,
        org_id: str | None,
        requested_model: str | None,
        resolved_model: str,
        backend_url: str,
        request_payload_json: dict[str, Any],
        input_text: str | None,
        status: str = "received",
        event_type: str = "received",
        event_details_json: dict[str, Any] | None = None,
    ) -> LLMRequest:
        entry = LLMRequest(
            request_id=request_id,
            trace_id=trace_id,
            source_app=source_app,
            user_id=user_id,
            org_id=org_id,
            requested_model=requested_model,
            resolved_model=resolved_model,
            backend_url=backend_url,
            request_payload_json=request_payload_json,
            input_text=input_text,
            status=status,
        )
        if status == "processing":
            entry.started_at = utc_now()
        if status in {"completed", "failed", "timeout"}:
            entry.completed_at = utc_now()
        session.add(entry)
        await session.flush()
        await self.add_event(
            session,
            request_id=entry.request_id,
            event_type=event_type,
            details_json={
                "resolved_model": resolved_model,
                "backend_url": backend_url,
                **(event_details_json or {}),
            }
            if event_type
            else event_details_json,
        )
        return entry

    async def get_request(
        self,
        session: AsyncSession,
        request_id: str,
    ) -> LLMRequest:
        from sqlalchemy import select

        result = await session.execute(
            select(LLMRequest).where(LLMRequest.request_id == request_id)
        )
        request = result.scalar_one_or_none()
        if request is None:
            raise LookupError("Request not found")
        return request

    async def mark_processing(
        self,
        session: AsyncSession,
        *,
        request: LLMRequest,
        event_type: str = "processing_started",
        details_json: dict[str, Any] | None = None,
    ) -> None:
        request.status = "processing"
        if request.started_at is None:
            request.started_at = utc_now()
        await self.add_event(
            session,
            request_id=request.request_id,
            event_type=event_type,
            details_json=details_json,
        )
        await session.flush()

    async def add_event(
        self,
        session: AsyncSession,
        *,
        request_id: str,
        event_type: str,
        details_json: dict[str, Any] | None = None,
    ) -> None:
        session.add(
            LLMRequestEvent(
                request_id=request_id,
                event_type=event_type,
                details_json=details_json,
            )
        )
        await session.flush()

    async def mark_success(
        self,
        session: AsyncSession,
        *,
        request: LLMRequest,
        response_payload_json: dict[str, Any],
        output_text: str | None,
        finish_reason: str | None,
        processing_time_ms: int,
    ) -> None:
        request.status = "completed"
        request.completed_at = utc_now()
        await self.add_event(
            session,
            request_id=request.request_id,
            event_type="completed",
            details_json={"processing_time_ms": processing_time_ms},
        )
        session.add(
            LLMResponse(
                request_id=request.request_id,
                response_payload_json=response_payload_json,
                output_text=output_text,
                finish_reason=finish_reason,
                success=True,
                processing_time_ms=processing_time_ms,
            )
        )
        await session.commit()

    async def mark_failure(
        self,
        session: AsyncSession,
        *,
        request: LLMRequest,
        error_code: str,
        error_message: str,
        processing_time_ms: int,
    ) -> None:
        request.status = "timeout" if "timeout" in error_code else "failed"
        request.error_code = error_code
        request.error_message = error_message
        request.completed_at = utc_now()
        await self.add_event(
            session,
            request_id=request.request_id,
            event_type=request.status,
            details_json={
                "error_code": error_code,
                "processing_time_ms": processing_time_ms,
            },
        )
        session.add(
            LLMResponse(
                request_id=request.request_id,
                response_payload_json={"error": error_message},
                output_text=None,
                finish_reason="error",
                success=False,
                processing_time_ms=processing_time_ms,
            )
        )
        await session.commit()

    async def mark_rejected(
        self,
        session: AsyncSession,
        *,
        request: LLMRequest,
        error_code: str,
        error_message: str,
        details_json: dict[str, Any] | None = None,
    ) -> None:
        request.status = "failed"
        request.error_code = error_code
        request.error_message = error_message
        request.completed_at = utc_now()
        await self.add_event(
            session,
            request_id=request.request_id,
            event_type="rejected",
            details_json={
                "error_code": error_code,
                **(details_json or {}),
            },
        )
        await session.commit()


def elapsed_ms(start_time: float) -> int:
    return int((perf_counter() - start_time) * 1000)
