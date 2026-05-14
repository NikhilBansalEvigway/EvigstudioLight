import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.core.runtime_config import RuntimeConfigService
from app.schemas.admin import (
    AdminLoginRequest,
    AdminLoginResponse,
    AdminOverviewResponse,
    AuditLogResponse,
    ClearRequestsResponse,
    ConfigEntryResponse,
    ConfigEntryUpdateRequest,
    ErrorCategoryResponse,
    ModelConfigResponse,
    ModelConfigUpdateRequest,
    QueueOverviewResponse,
    RequestDetailResponse,
    RequestSummaryResponse,
    WorkerStatusResponse,
)
from app.services.admin_auth import AdminAuthService, require_admin_roles
from app.services.admin_service import AdminService
from app.services.audit_log import AuditLogService

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login", response_model=AdminLoginResponse)
async def admin_login(request: AdminLoginRequest) -> AdminLoginResponse:
    auth_service = AdminAuthService()
    actor = auth_service.authenticate(request.username, request.password)
    if not actor:
        raise HTTPException(status_code=401, detail="Invalid admin credentials")
    token = auth_service.create_access_token(
        subject=actor["sub"],
        role=actor["role"],
    )
    await AuditLogService().log(
        actor=actor["sub"],
        action="login",
        target_type="admin_session",
        target_key=actor["role"],
    )
    return AdminLoginResponse(
        access_token=token,
        expires_in_minutes=auth_service.settings.admin_access_token_expire_minutes,
        role=actor["role"],
    )


@router.get("/overview", response_model=AdminOverviewResponse)
async def admin_overview(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> AdminOverviewResponse:
    service = AdminService()
    return AdminOverviewResponse.model_validate(await service.get_overview())


@router.get("/stream")
async def admin_stream(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
):
    service = AdminService()

    async def event_stream():
        while True:
            overview = await service.get_overview()
            errors = await service.list_error_categories()
            payload = {
                "overview": overview,
                "errors": errors,
            }
            yield f"event: snapshot\ndata: {json.dumps(payload, default=str)}\n\n"
            # Faster refresh for live queue visualization.
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/queue", response_model=QueueOverviewResponse)
async def admin_queue(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> QueueOverviewResponse:
    service = AdminService()
    return QueueOverviewResponse.model_validate(await service.get_queue_overview())


@router.get("/workers", response_model=list[WorkerStatusResponse])
async def admin_workers(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> list[WorkerStatusResponse]:
    service = AdminService()
    return [WorkerStatusResponse.model_validate(item) for item in await service.get_worker_overview()]


@router.get("/errors", response_model=list[ErrorCategoryResponse])
async def admin_errors(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> list[ErrorCategoryResponse]:
    service = AdminService()
    return [
        ErrorCategoryResponse.model_validate(item)
        for item in await service.list_error_categories()
    ]


@router.get("/config", response_model=list[ConfigEntryResponse])
async def list_config(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> list[ConfigEntryResponse]:
    service = AdminService()
    entries = await service.list_config_entries()
    return [
        ConfigEntryResponse.model_validate(entry, from_attributes=True)
        for entry in entries
    ]


@router.put("/config/{key}", response_model=ConfigEntryResponse)
async def update_config(
    key: str,
    request: ConfigEntryUpdateRequest,
    admin: dict = Depends(require_admin_roles("ops_admin", "super_admin")),
) -> ConfigEntryResponse:
    service = AdminService()
    audit_service = AuditLogService()
    try:
        entry, before = await service.update_config_entry(
            key, request.value_json, admin["sub"]
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await audit_service.log(
        actor=admin["sub"],
        action="update",
        target_type="config_entry",
        target_key=key,
        before_value_json=before,
        after_value_json=entry.value_json,
    )
    await RuntimeConfigService().refresh()
    return ConfigEntryResponse.model_validate(entry, from_attributes=True)


@router.get("/models", response_model=list[ModelConfigResponse])
async def admin_list_models(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> list[ModelConfigResponse]:
    service = AdminService()
    models = await service.list_models()
    return [
        ModelConfigResponse.model_validate(model, from_attributes=True)
        for model in models
    ]


@router.put("/models/{model_name:path}", response_model=ModelConfigResponse)
async def admin_update_model(
    model_name: str,
    request: ModelConfigUpdateRequest,
    admin: dict = Depends(require_admin_roles("ops_admin", "super_admin")),
) -> ModelConfigResponse:
    service = AdminService()
    audit_service = AuditLogService()
    updates = request.model_dump(exclude_unset=True)
    try:
        model, before = await service.update_model(model_name, updates)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    await audit_service.log(
        actor=admin["sub"],
        action="update",
        target_type="model_config",
        target_key=model_name,
        before_value_json=before,
        after_value_json=updates,
    )
    return ModelConfigResponse.model_validate(model, from_attributes=True)


@router.get("/requests", response_model=list[RequestSummaryResponse])
async def list_requests(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    status: str | None = Query(None),
    source_app: str | None = Query(None),
    model: str | None = Query(None),
    search: str | None = Query(None),
    error_only: bool = Query(False),
    sort_by: str = Query("created_at"),
    sort_dir: str = Query("desc"),
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> list[RequestSummaryResponse]:
    service = AdminService()
    requests = await service.list_requests(
        limit=limit,
        offset=offset,
        status=status,
        source_app=source_app,
        model=model,
        search=search,
        error_only=error_only,
        sort_by=sort_by,
        sort_dir=sort_dir,
    )
    return [RequestSummaryResponse.model_validate(item) for item in requests]


@router.delete("/requests", response_model=ClearRequestsResponse)
async def clear_requests(
    admin: dict = Depends(require_admin_roles("ops_admin", "super_admin")),
) -> ClearRequestsResponse:
    service = AdminService()
    audit_service = AuditLogService()
    deleted = await service.clear_all_requests()
    await audit_service.log(
        actor=admin["sub"],
        action="delete",
        target_type="request_history",
        target_key="all",
        before_value_json=deleted,
        after_value_json={"cleared": True},
    )
    return ClearRequestsResponse(**deleted)


@router.get("/requests/{request_id}", response_model=RequestDetailResponse)
async def get_request_detail(
    request_id: str,
    admin: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> RequestDetailResponse:
    service = AdminService()
    audit_service = AuditLogService()
    try:
        request, responses, events, queue_jobs, metrics, diagnostics = await service.get_request_detail(
            request_id
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    await audit_service.log(
        actor=admin["sub"],
        action="view",
        target_type="request_detail",
        target_key=request_id,
    )

    return RequestDetailResponse(
        request_id=request.request_id,
        trace_id=request.trace_id,
        source_app=request.source_app,
        user_id=request.user_id,
        org_id=request.org_id,
        requested_model=request.requested_model,
        resolved_model=request.resolved_model,
        backend_url=request.backend_url,
        request_payload_json=service.redact_payload(request.request_payload_json),
        input_text=request.input_text,
        status=request.status,
        error_code=request.error_code,
        error_message=request.error_message,
        total_tokens=metrics["total_tokens"],
        prompt_tokens=metrics["prompt_tokens"],
        completion_tokens=metrics["completion_tokens"],
        processing_time_ms=metrics["processing_time_ms"],
        queue_wait_ms=diagnostics["queue_wait_ms"],
        end_to_end_ms=diagnostics["end_to_end_ms"],
        retry_count=diagnostics["retry_count"],
        final_attempts=diagnostics["final_attempts"],
        was_retried=diagnostics["was_retried"],
        dead_lettered=diagnostics["dead_lettered"],
        dropped=diagnostics["dropped"],
        dropped_reason=diagnostics["dropped_reason"],
        client_cancelled=diagnostics["client_cancelled"],
        failure_stage=diagnostics["failure_stage"],
        mode=diagnostics["mode"],
        created_at=request.created_at,
        started_at=request.started_at,
        completed_at=request.completed_at,
        responses=[
            {
                "response_payload_json": service.redact_payload(response.response_payload_json),
                "output_text": response.output_text,
                "finish_reason": response.finish_reason,
                "success": response.success,
                "processing_time_ms": response.processing_time_ms,
                "usage": service.extract_usage(response.response_payload_json),
                "created_at": response.created_at,
            }
            for response in responses
        ],
        events=[
            {
                "event_type": event.event_type,
                "details_json": service.redact_payload(event.details_json),
                "created_at": event.created_at,
            }
            for event in events
        ],
        queue_jobs=[
            {
                "job_id": job.job_id,
                "model_name": job.model_name,
                "status": job.status,
                "attempts": job.attempts,
                "error_message": job.error_message,
                "queued_at": job.queued_at,
                "started_at": job.started_at,
                "completed_at": job.completed_at,
            }
            for job in queue_jobs
        ],
    )


@router.get("/audit-logs", response_model=list[AuditLogResponse])
async def list_audit_logs(
    _: dict = Depends(require_admin_roles("viewer", "ops_admin", "super_admin")),
) -> list[AuditLogResponse]:
    service = AuditLogService()
    logs = await service.list_logs()
    return [AuditLogResponse.model_validate(log, from_attributes=True) for log in logs]
