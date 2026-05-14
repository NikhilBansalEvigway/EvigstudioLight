# LLMOrchestrator Phase Plan

## Purpose

This document tracks the planned rollout for the `LLMOrchestrator` admin, observability, and operations platform.

It includes:

- the phased roadmap
- what is implemented now
- what is still left to build

## Status Summary

Current status: `Phase 1` is functionally implemented across backend telemetry, admin APIs, live admin updates, and the admin UI.

## Phase Breakdown

### Phase 1: Foundation + Must-Have Visibility

Goal: make the orchestrator observable and immediately useful to admins.

#### Planned scope

- Request logging pipeline
- Token usage tracking
- Basic status tracking
  - `success`
  - `failure`
  - `timeout`
  - `queued`
  - `processing`
- Source tagging
  - `EvigstudioLight`
  - `Evigstudio`
- Model tagging
- Correlation ID per request
- Timestamps for lifecycle stages
- Basic admin dashboard
- Core KPIs
  - total requests
  - daily requests
  - weekly requests
  - daily tokens
  - weekly tokens
  - average latency
  - error rate
  - queue depth
- Real-time request stream
- Real-time queue monitor
- Basic charts
  - requests over time
  - tokens over time
  - errors over time
  - latency over time
- Request explorer with filters
- Error list with reason categories
- Basic admin auth and RBAC
- Audit logging for admin actions

#### Implemented

- Request persistence now covers queued requests and direct requests
- Request metadata capture includes:
  - `request_id`
  - `trace_id`
  - `source_app`
  - `user_id`
  - `org_id`
  - requested/resolved model
  - backend URL
- Request lifecycle timestamps are persisted
- Request lifecycle events are persisted more consistently
- Queue-full rejections are persisted instead of being invisible failures
- Timeout is tracked separately from generic failure
- Admin APIs added for:
  - overview metrics
  - queue snapshot
  - error category summary
  - SSE live admin stream
  - filtered request listing
  - richer request detail
- Admin UI upgraded with:
  - KPI cards
  - daily trend charts
  - queue monitor
  - request explorer filters
  - request explorer pagination and sorting
  - error dashboard view
  - request detail drawer
  - server-push live refresh with SSE fallback polling
- Basic RBAC added with roles:
  - `super_admin`
  - `ops_admin`
  - `viewer`
- Audit logging now includes:
  - login events
  - request detail views
  - config/model updates
  - request history deletion
- Streamed response aggregation now captures token usage when upstream streaming chunks include `usage`
- Test coverage files were added for:
  - chat route telemetry behavior
  - admin login/auth
  - filtered admin requests
  - admin SSE stream

#### Still left in Phase 1

- Stronger admin user management
  - current RBAC is env-credential based, not DB-backed
- Optional UI polish for clearer health states and denser request triage workflows

### Phase 2: Operational Debugging + Queue Intelligence

<!-- Phase 2 operations dashboard with queue intelligence, retries, slow-request diagnostics, and active alert surfacing. -->

Goal: help developers and operators diagnose issues fast.

#### Planned scope

- Request lifecycle tracing
- Queue wait time metrics
- Retry tracking
- Cancelled / dropped request tracking
- Slow request analysis
- Per-model performance metrics
- Per-source performance metrics
- Worker utilization
- Concurrency and backlog insights
- Detailed request detail page
- Response inspection with masking
- Failure diagnostics
- Timeout diagnostics
- Top recurring errors
- Alerting for:
  - high error rate
  - queue backlog
  - latency spike
  - LM Studio unavailable
- Slack/email/webhook notifications

#### Implemented

- Request lifecycle tracing is visible in request detail
- Queue wait analytics are available in overview, queue view, and request detail
- Retry analytics are available in overview and per-request diagnostics
- Cancelled/dropped tracking is surfaced through:
  - client-cancelled stream events
  - dropped/dead-lettered diagnostics
  - dropped reason classification
- Slow request analysis is available with top slow-request visibility
- Per-model performance metrics are available
- Per-source performance metrics are available
- Worker heartbeat and utilization visibility are available
- Concurrency and backlog insights are available through:
  - saturation percentage
  - oldest waiting age
  - retrying jobs
  - dead-letter counts
- Failure and timeout diagnostics are available in summaries and request detail
- Top recurring errors are available in error dashboards
- Alert surfaces are available for:
  - high error rate
  - queue backlog
  - queue wait spike
  - latency spike
  - worker unavailable
- Webhook-based alert notifications are available
- Response and event inspection now includes secret-aware redaction

#### Still left after Phase 2

- Native Slack and email alert channels beyond webhook delivery
- Rich incident acknowledgment/workflow management
- Deeper worker-instance telemetry beyond heartbeat/task utilization

### Phase 3: Usage Analytics + Cost Intelligence

Goal: make the orchestrator a decision-making system, not just a monitor.

#### Planned scope

- Monthly reporting
- Per-user usage
- Per-team usage
- Per-app usage
- Per-model usage
- Session analytics
- Prompt/response size distribution
- Token efficiency metrics
- Cost estimation by:
  - user
  - app
  - model
  - day/week/month
- Cost spike detection
- Budget thresholds
- Top consumers
- Peak usage analysis
- Scheduled reports
- CSV/JSON export
- Executive summary dashboards

#### Implemented so far

- Daily and weekly request/token rollups
- Source/model breakdowns
- Per-request token totals where usage exists

#### Left to build

- Monthly and custom-range analytics
- Per-user and per-org aggregate dashboards
- Cost estimation model
- Peak load and top-consumer reporting
- Exports and scheduled reports

### Phase 4: Control Plane + Admin Actions

Goal: let admins act directly from the orchestrator.

#### Planned scope

- Pause/resume queue
- Safe queue drain
- Retry failed requests
- Cancel stuck requests
- Change priority
- Throttle clients
- Quotas and rate limits
- Routing rule management
- Fallback model configuration
- Model enable/disable
- Maintenance mode
- API key management
- Retention configuration

#### Implemented so far

- Existing model config editing remains available
- Basic runtime config editing remains available

#### Left to build

- Queue control actions
- Request retry/cancel actions
- Throttling and quota controls in admin UI
- Maintenance workflows
- Admin controls for retention and API key management

### Phase 5: Advanced Observability + Ecosystem Integration

Goal: make the platform production-grade for larger teams.

#### Planned scope

- Distributed tracing
- OpenTelemetry support
- Prometheus metrics expansion
- Grafana integration
- Sentry/error tracker integration
- Deployment markers on charts
- Version-aware client analytics
- Infra metrics
  - CPU
  - RAM
  - GPU
  - model memory
- External webhook events
- Status page integration
- Data retention / archival tooling
- Backfill / reprocessing support

#### Implemented so far

- Existing `/metrics` endpoint remains available
- Request trace IDs are stronger and more visible now

#### Left to build

- Real tracing integration
- Broader metrics export surface
- Infra telemetry ingestion
- External observability integrations
- archival/backfill tooling

### Phase 6: Predictive + AI-Assisted Intelligence

Goal: move from reporting to proactive optimization.

#### Planned scope

- Anomaly detection
- Forecasting for load and cost
- Capacity planning suggestions
- Regression detection after releases
- Smart optimization recommendations
- AI-generated incident summaries
- AI-generated daily usage summaries
- Natural language analytics search
- "Why is latency high?" assistant
- "What changed this week?" insights

#### Implemented so far

- Nothing yet beyond the Phase 1 data foundation.

#### Left to build

- All predictive and AI-assisted analytics features

## Recommended Release Mapping

### V1

- Complete Phase 1
- Pull in a few high-value parts of Phase 2:
  - queue wait time
  - retry metrics
  - basic alerting

### V2

- Finish Phase 2
- Deliver most of Phase 3

### V3

- Deliver Phase 4
- Deliver key production-grade parts of Phase 5

### V4

- Finish Phase 5
- Deliver Phase 6

## Files Touched For Current Implementation

- `app/api/routes/admin.py`
- `app/api/routes/chat.py`
- `app/core/settings.py`
- `app/dashboard/app.js`
- `app/dashboard/index.html`
- `app/dashboard/styles.css`
- `app/schemas/admin.py`
- `app/services/admin_auth.py`
- `app/services/admin_service.py`
- `app/services/request_store.py`

## Current Verification Notes

- Python syntax for edited backend files was validated via AST parsing
- Dashboard JavaScript syntax was validated with `node --check`
- Full `pytest` execution could not be run in this environment because `pytest` is not installed
- `compileall` was limited by workspace `__pycache__` permission issues

## Next Recommended Work

1. Finish the remaining Phase 1 gaps
2. Add Phase 2 queue intelligence and retry analytics
3. Add tests for request telemetry and admin APIs
4. Decide whether admin auth should remain env-based or move to DB-backed users
