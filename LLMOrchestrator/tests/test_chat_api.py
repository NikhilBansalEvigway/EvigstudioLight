from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


class DummySession:
    def begin(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, *args, **kwargs):
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        return result

    async def delete(self, *args, **kwargs):
        return None

    async def commit(self):
        return None


class DummySessionFactory:
    def __call__(self):
        return DummySession()


@pytest.fixture
def client():
    return TestClient(app)


def test_create_chat_completion_forces_queue_and_tracks_headers(client):
    mock_model = MagicMock()
    mock_model.is_enabled = True
    mock_model.resolved_model = "test-model"
    mock_model.timeout_seconds = 30
    mock_model.backend_url = "http://lmstudio.local"

    request_store = MagicMock()
    request_store.create_request = AsyncMock()

    with patch("app.api.routes.chat.ModelRegistryService", MagicMock()) as mock_registry, patch(
        "app.api.routes.chat.JobQueueService", MagicMock()
    ) as mock_job_queue, patch(
        "app.api.routes.chat.RequestStore", MagicMock(return_value=request_store)
    ), patch(
        "app.api.routes.chat.get_session_factory", MagicMock(return_value=DummySessionFactory())
    ):
        mock_registry.return_value.resolve = AsyncMock(return_value=mock_model)
        mock_job_queue.return_value.enqueue = AsyncMock()
        mock_job_queue.return_value.wait_for_result = AsyncMock(
            return_value={
                "status": "completed",
                "response_payload": {
                    "id": "chatcmpl-123",
                    "object": "chat.completion",
                    "created": 1677652288,
                    "model": "test-model",
                    "choices": [
                        {
                            "message": {"role": "assistant", "content": "Hello!"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            }
        )

        response = client.post(
            "/v1/chat/completions?use_queue=false",
            json={"model": "test-model", "messages": [{"role": "user", "content": "Hi"}]},
            headers={
                "x-source-app": "Evigstudio",
                "x-user-id": "user-direct",
                "x-org-id": "org-direct",
                "x-trace-id": "trace-direct",
            },
        )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello!"
    assert response.headers["x-trace-id"] == "trace-direct"
    assert response.headers["x-request-id"]
    enqueue_kwargs = mock_job_queue.return_value.enqueue.await_args.kwargs
    assert enqueue_kwargs["payload"]["trace_id"] == "trace-direct"
    assert enqueue_kwargs["payload"]["source_app"] == "Evigstudio"
    assert enqueue_kwargs["payload"]["user_id"] == "user-direct"
    assert enqueue_kwargs["payload"]["org_id"] == "org-direct"


def test_create_chat_completion_queued_propagates_headers_into_job_payload(client):
    mock_model = MagicMock()
    mock_model.is_enabled = True
    mock_model.resolved_model = "test-model"
    mock_model.timeout_seconds = 30
    mock_model.queue_limit = 100
    mock_model.backend_url = "http://lmstudio.local"

    request_store = MagicMock()
    request_store.create_request = AsyncMock()

    with patch("app.api.routes.chat.ModelRegistryService", MagicMock()) as mock_registry, patch(
        "app.api.routes.chat.JobQueueService", MagicMock()
    ) as mock_job_queue, patch(
        "app.api.routes.chat.RequestStore", MagicMock(return_value=request_store)
    ), patch(
        "app.api.routes.chat.get_session_factory", MagicMock(return_value=DummySessionFactory())
    ):
        mock_registry.return_value.resolve = AsyncMock(return_value=mock_model)
        mock_job_queue.return_value.enqueue = AsyncMock()
        mock_job_queue.return_value.wait_for_result = AsyncMock(
            return_value={
                "status": "completed",
                "response_payload": {
                    "id": "chatcmpl-queued",
                    "object": "chat.completion",
                    "created": 1677652288,
                    "model": "test-model",
                    "choices": [
                        {
                            "message": {"role": "assistant", "content": "Hello from queue!"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            }
        )

        response = client.post(
            "/v1/chat/completions?use_queue=true",
            json={"model": "test-model", "messages": [{"role": "user", "content": "Hi"}]},
            headers={
                "x-source-app": "EvigstudioLight",
                "x-user-id": "user-queued",
                "x-org-id": "org-queued",
                "x-trace-id": "trace-queued",
            },
        )

    assert response.status_code == 200
    assert response.headers["x-trace-id"] == "trace-queued"
    enqueue_kwargs = mock_job_queue.return_value.enqueue.await_args.kwargs
    assert enqueue_kwargs["payload"]["source_app"] == "EvigstudioLight"
    assert enqueue_kwargs["payload"]["user_id"] == "user-queued"
    assert enqueue_kwargs["payload"]["org_id"] == "org-queued"
    assert enqueue_kwargs["payload"]["trace_id"] == "trace-queued"


def test_create_chat_completion_queued_timeout_returns_504(client):
    mock_model = MagicMock()
    mock_model.is_enabled = True
    mock_model.resolved_model = "test-model"
    mock_model.timeout_seconds = 30
    mock_model.queue_limit = 100
    mock_model.backend_url = "http://lmstudio.local"

    request_store = MagicMock()
    request_store.create_request = AsyncMock()

    with patch("app.api.routes.chat.ModelRegistryService", MagicMock()) as mock_registry, patch(
        "app.api.routes.chat.JobQueueService", MagicMock()
    ) as mock_job_queue, patch(
        "app.api.routes.chat.RequestStore", MagicMock(return_value=request_store)
    ), patch(
        "app.api.routes.chat.get_session_factory", MagicMock(return_value=DummySessionFactory())
    ):
        mock_registry.return_value.resolve = AsyncMock(return_value=mock_model)
        mock_job_queue.return_value.enqueue = AsyncMock()
        mock_job_queue.return_value.wait_for_result = AsyncMock(return_value=None)

        response = client.post(
            "/v1/chat/completions?use_queue=true",
            json={"model": "test-model", "messages": [{"role": "user", "content": "Hi"}]},
        )

    assert response.status_code == 504
