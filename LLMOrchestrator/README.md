# LLMOrchestrator

`LLMOrchestrator` is a production-oriented LLM gateway service for teams that want a controlled, observable layer between client applications and local/hosted model backends (currently LM Studio compatible).

It exposes OpenAI-style endpoints, applies queueing and guardrails, and provides admin controls for runtime configuration and model operations.

## Key Features

- OpenAI-compatible chat API (`POST /v1/chat/completions`)
- Model catalog endpoint (`GET /v1/models`)
- Redis-backed job queue with worker-based execution
- Per-model concurrency and queue depth controls
- Per-user and per-org active-request quotas
- Per-user and per-org request-per-minute rate limiting
- Request tracing with lifecycle events and persisted responses
- Admin JWT authentication and protected admin APIs
- Admin web dashboard at `/admin-ui`
- Health, readiness, and Prometheus-style metrics endpoints

## High-Level Architecture

1. Client sends request to `LLMOrchestrator` (`/v1/chat/completions`).
2. API validates model and policy limits (quota/rate limits).
3. Request is persisted and enqueued in Redis.
4. Worker process consumes job and calls LM Studio backend.
5. Response and events are stored, then returned to client.
6. Admin and observability endpoints expose operational state.

## Tech Stack

- Python 3.11+
- FastAPI + Uvicorn
- SQLAlchemy + Alembic
- Redis
- JWT authentication (`PyJWT`)

## Quick Start (Local Development)

### 1) Prerequisites

- Python `3.11+`
- Redis running locally on `6379`
- LM Studio serving an OpenAI-compatible API (default `http://localhost:1234`)

### 2) Configure environment

```bash
cp .env.example .env
```

Update important values in `.env`:

- `LM_STUDIO_BASE_URL`
- `ADMIN_JWT_SECRET`
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- `DEFAULT_MODEL`

### 3) Install dependencies

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -e .
```

### 4) Run database migrations

```bash
alembic upgrade head
```

### 5) Start API server

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

### 6) Start worker (separate terminal)

```bash
python app/worker.py
```

The service is now available at `http://localhost:8100`.

## Run with Docker Compose

```bash
docker compose up --build
```

This starts:

- `llm-orchestrator` (API server on `8100`)
- `llm-orchestrator-worker` (worker process)
- `redis` (cache/queue backend)

## Core Endpoints

### Public API

- `POST /v1/chat/completions` - OpenAI-compatible chat completions
- `GET /v1/models` - List available models and operational constraints

### Operations

- `GET /health` - Liveness probe
- `GET /ready` - Dependency readiness (DB + Redis)
- `GET /metrics` - Prometheus-style metrics

### Admin API

- `POST /admin/login` - Obtain JWT token
- `GET /admin/config` / `PUT /admin/config/{key}` - Runtime config management
- `GET /admin/models` / `PUT /admin/models/{model_name}` - Model control plane
- `GET /admin/requests` / `GET /admin/requests/{request_id}` - Request inspection
- `GET /admin/audit-logs` - Admin action audit trail

### Admin UI

- `GET /admin-ui` - Lightweight operational dashboard

## Request Headers (Recommended)

For tenant-aware controls and observability, pass:

- `x-user-id`
- `x-org-id`
- `x-source-app`

These values are used for quota/rate enforcement, tracing, and auditability.

## Configuration Model

Configuration is resolved in this order:

1. Built-in defaults
2. `.env` values
3. Database runtime overrides (admin-editable)

This allows safe defaults while enabling operational tuning without redeploying the service.

## Observability and Governance

- Trace IDs generated per request
- Request lifecycle events (`queued`, timeout, rejection, completion, etc.)
- Persisted request/response metadata for diagnostics
- Queue depth and active-request metrics by model
- Admin audit logs for configuration and model changes

## Security Notes

- Change default admin credentials before non-local usage.
- Set a strong `ADMIN_JWT_SECRET`.
- Restrict admin API/UI exposure behind network controls or an API gateway.

## Current Limitations

- Streaming mode is compatibility-oriented and not full token-by-token passthrough.
- Worker scheduling uses polling-based orchestration.
- Admin UI is intentionally lightweight for operations use cases.
- SQLite is supported for local/offline use, but it is still single-writer; for higher throughput or multiple workers, use Postgres.

## License

Add your project license details here (for example, MIT, Apache-2.0, or proprietary internal use).
