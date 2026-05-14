from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _login(client: TestClient) -> str:
    response = client.post(
        "/admin/login",
        json={"username": "admin", "password": "admin123"},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def test_admin_login_returns_role_and_token(client):
    response = client.post(
        "/admin/login",
        json={"username": "admin", "password": "admin123"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["access_token"]
    assert payload["role"] == "super_admin"


def test_admin_overview_requires_auth(client):
    response = client.get("/admin/overview")
    assert response.status_code == 401


def test_admin_requests_passes_pagination_and_sorting(client):
    token = _login(client)
    with patch("app.api.routes.admin.AdminService", MagicMock()) as mock_service:
        mock_service.return_value.list_requests = AsyncMock(return_value=[])

        response = client.get(
            "/admin/requests?limit=25&offset=50&status=processing&sort_by=status&sort_dir=asc",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    mock_service.return_value.list_requests.assert_awaited_once_with(
        limit=25,
        offset=50,
        status="processing",
        source_app=None,
        model=None,
        search=None,
        error_only=False,
        sort_by="status",
        sort_dir="asc",
    )


def test_admin_stream_accepts_query_token_and_returns_sse(client):
    token = _login(client)
    overview_payload = {
        "summary": {
            "total_requests": 1,
            "requests_today": 1,
            "requests_week": 1,
            "tokens_today": 10,
            "tokens_week": 10,
            "average_latency_ms": 12.5,
            "error_rate": 0,
            "queue_depth": 0,
            "active_requests": 0,
            "queue_wait_avg_ms": 5,
            "queue_wait_p95_ms": 8,
            "slow_request_rate": 0,
            "retry_rate": 0,
            "timeout_rate": 0,
        },
        "queue": {
            "total_active": 0,
            "total_waiting": 0,
            "avg_wait_ms": 0,
            "p95_wait_ms": 0,
            "max_wait_ms": 0,
            "oldest_waiting_age_ms": 0,
            "models": [],
        },
        "workers": [],
        "alerts": [],
        "retry_summary": {
            "retried_requests": 0,
            "retry_rate": 0,
            "eventual_success_after_retry": 0,
            "dead_lettered_requests": 0,
            "currently_retrying_jobs": 0,
            "total_retry_events": 0,
        },
        "status_breakdown": [],
        "source_breakdown": [],
        "model_breakdown": [],
        "model_performance": [],
        "source_performance": [],
        "slow_requests": [],
        "requests_series": [],
        "tokens_series": [],
        "errors_series": [],
        "latency_series": [],
        "recent_requests": [],
    }

    with patch("app.api.routes.admin.AdminService", MagicMock()) as mock_service:
        mock_service.return_value.get_overview = AsyncMock(return_value=overview_payload)
        mock_service.return_value.list_error_categories = AsyncMock(return_value=[])

        with client.stream("GET", f"/admin/stream?access_token={token}") as response:
            line_iter = response.iter_lines()
            lines = [next(line_iter), next(line_iter)]

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert any("event: snapshot" in line for line in lines)


def test_admin_workers_returns_worker_statuses(client):
    token = _login(client)
    workers = [
        {
            "worker_id": "worker-1",
            "active_tasks": 1,
            "max_parallel_jobs": 4,
            "utilization_pct": 25.0,
            "status": "running",
            "last_seen_at": "2026-01-01T00:00:00+00:00",
        }
    ]
    with patch("app.api.routes.admin.AdminService", MagicMock()) as mock_service:
        mock_service.return_value.get_worker_overview = AsyncMock(return_value=workers)

        response = client.get(
            "/admin/workers",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json()[0]["worker_id"] == "worker-1"


def test_request_detail_returns_phase2_diagnostics(client):
    token = _login(client)
    request = MagicMock(
        request_id="req-1",
        trace_id="trace-1",
        source_app="Evigstudio",
        user_id="user-1",
        org_id="org-1",
        requested_model="model-a",
        resolved_model="model-a",
        backend_url="http://lmstudio.local",
        request_payload_json={"model": "model-a"},
        input_text="hello",
        status="completed",
        error_code=None,
        error_message=None,
        created_at="2026-01-01T00:00:00Z",
        started_at="2026-01-01T00:00:01Z",
        completed_at="2026-01-01T00:00:02Z",
    )
    diagnostics = {
        "queue_wait_ms": 250,
        "end_to_end_ms": 2000,
        "retry_count": 1,
        "final_attempts": 2,
        "was_retried": True,
        "dead_lettered": False,
        "dropped": False,
        "dropped_reason": None,
        "client_cancelled": False,
        "failure_stage": None,
        "mode": "queued",
    }
    metrics = {
        "total_tokens": 20,
        "prompt_tokens": 12,
        "completion_tokens": 8,
        "processing_time_ms": 1000,
    }

    with patch("app.api.routes.admin.AdminService", MagicMock()) as mock_service:
        mock_service.return_value.get_request_detail = AsyncMock(
            return_value=(request, [], [], [], metrics, diagnostics)
        )

        response = client.get(
            "/admin/requests/req-1",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["queue_wait_ms"] == 250
    assert payload["end_to_end_ms"] == 2000
    assert payload["retry_count"] == 1
    assert payload["final_attempts"] == 2
    assert payload["was_retried"] is True
    assert payload["dropped"] is False
    assert payload["client_cancelled"] is False
    assert payload["mode"] == "queued"
