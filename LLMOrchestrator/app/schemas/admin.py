from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel


class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_minutes: int
    role: str


class ConfigEntryResponse(BaseModel):
    key: str
    value_json: Any
    scope: str
    editable_from_ui: bool
    validation_schema_name: str | None
    description: str | None
    is_active: bool
    updated_by: str | None
    updated_at: datetime


class ConfigEntryUpdateRequest(BaseModel):
    value_json: Any


class ModelConfigResponse(BaseModel):
    id: int
    name: str
    alias: str | None
    backend_url: str
    timeout_seconds: int
    concurrency_limit: int
    queue_limit: int
    fallback_model: str | None
    is_enabled: bool
    created_at: datetime
    updated_at: datetime


class ModelConfigUpdateRequest(BaseModel):
    alias: str | None = None
    backend_url: str | None = None
    timeout_seconds: int | None = None
    concurrency_limit: int | None = None
    queue_limit: int | None = None
    fallback_model: str | None = None
    is_enabled: bool | None = None


class RequestSummaryResponse(BaseModel):
    request_id: str
    trace_id: str
    source_app: str | None
    user_id: str | None = None
    org_id: str | None = None
    requested_model: str | None
    resolved_model: str | None
    status: str
    error_code: str | None
    total_tokens: int = 0
    processing_time_ms: int | None = None
    created_at: datetime
    completed_at: datetime | None


class RequestResponseEntry(BaseModel):
    response_payload_json: dict[str, Any]
    output_text: str | None
    finish_reason: str | None
    success: bool
    processing_time_ms: int | None
    usage: dict[str, int]
    created_at: datetime


class RequestEventEntry(BaseModel):
    event_type: str
    details_json: dict[str, Any] | None
    created_at: datetime


class QueueJobEntry(BaseModel):
    job_id: str
    model_name: str
    status: str
    attempts: int
    error_message: str | None
    queued_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class RequestDetailResponse(BaseModel):
    request_id: str
    trace_id: str
    source_app: str | None
    user_id: str | None
    org_id: str | None
    requested_model: str | None
    resolved_model: str | None
    backend_url: str | None
    request_payload_json: dict
    input_text: str | None
    status: str
    error_code: str | None
    error_message: str | None
    total_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    processing_time_ms: int | None = None
    queue_wait_ms: int | None = None
    end_to_end_ms: int | None = None
    retry_count: int = 0
    final_attempts: int = 0
    was_retried: bool = False
    dead_lettered: bool = False
    dropped: bool = False
    dropped_reason: str | None = None
    client_cancelled: bool = False
    failure_stage: str | None = None
    mode: str | None = None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    responses: list[RequestResponseEntry]
    events: list[RequestEventEntry]
    queue_jobs: list[QueueJobEntry]


class MetricPoint(BaseModel):
    label: str
    value: float


class MetricBreakdownItem(BaseModel):
    key: str
    value: int


class QueueStatusResponse(BaseModel):
    model_name: str
    active: int
    waiting: int
    concurrency_limit: int | None = None
    queue_limit: int | None = None
    utilization_pct: float = 0
    avg_wait_ms: float = 0
    p95_wait_ms: float = 0
    oldest_waiting_age_ms: int = 0
    retrying_jobs: int = 0
    dead_lettered_recent: int = 0


class QueueOverviewResponse(BaseModel):
    total_active: int
    total_waiting: int
    avg_wait_ms: float = 0
    p95_wait_ms: float = 0
    max_wait_ms: int = 0
    oldest_waiting_age_ms: int = 0
    models: list[QueueStatusResponse]


class WorkerStatusResponse(BaseModel):
    worker_id: str
    active_tasks: int
    max_parallel_jobs: int
    utilization_pct: float
    status: str
    last_seen_at: str


class OverviewSummaryResponse(BaseModel):
    total_requests: int
    requests_today: int
    requests_week: int
    tokens_today: int
    tokens_week: int
    average_latency_ms: float
    error_rate: float
    queue_depth: int
    active_requests: int
    queue_wait_avg_ms: float = 0
    queue_wait_p95_ms: float = 0
    slow_request_rate: float = 0
    retry_rate: float = 0
    timeout_rate: float = 0


class AlertSummaryResponse(BaseModel):
    code: str
    severity: str
    active: bool
    message: str
    observed_value: float | int | str


class RetrySummaryResponse(BaseModel):
    retried_requests: int
    retry_rate: float
    eventual_success_after_retry: int
    dead_lettered_requests: int
    currently_retrying_jobs: int
    total_retry_events: int


class PerformanceBreakdownResponse(BaseModel):
    key: str
    request_count: int
    average_latency_ms: float
    error_rate: float
    timeout_rate: float
    retry_rate: float


class SlowRequestResponse(BaseModel):
    request_id: str
    source_app: str | None
    resolved_model: str | None
    processing_time_ms: int
    queue_wait_ms: int | None = None
    status: str
    created_at: datetime


class ErrorCategoryResponse(BaseModel):
    error_code: str
    count: int


class AdminOverviewResponse(BaseModel):
    summary: OverviewSummaryResponse
    queue: QueueOverviewResponse
    workers: list[WorkerStatusResponse]
    alerts: list[AlertSummaryResponse]
    retry_summary: RetrySummaryResponse
    status_breakdown: list[MetricBreakdownItem]
    source_breakdown: list[MetricBreakdownItem]
    model_breakdown: list[MetricBreakdownItem]
    model_performance: list[PerformanceBreakdownResponse]
    source_performance: list[PerformanceBreakdownResponse]
    slow_requests: list[SlowRequestResponse]
    requests_series: list[MetricPoint]
    tokens_series: list[MetricPoint]
    errors_series: list[MetricPoint]
    latency_series: list[MetricPoint]
    recent_requests: list[RequestSummaryResponse]


class AuditLogResponse(BaseModel):
    actor: str
    action: str
    target_type: str
    target_key: str
    before_value_json: Any = None
    after_value_json: Any = None
    details_json: dict[str, Any] | None = None
    created_at: datetime


class ClearRequestsResponse(BaseModel):
    requests: int
    responses: int
    events: int
    jobs: int


AdminRole = Literal["super_admin", "ops_admin", "viewer"]
