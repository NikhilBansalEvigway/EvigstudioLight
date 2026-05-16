from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
from redis.exceptions import RedisError
from sqlalchemy import text

from app.core.runtime_config import RuntimeConfigService
from app.core.settings import get_settings
from app.db.redis import get_redis
from app.db.session import get_session_factory
from app.services.scheduler import RedisScheduler
from app.services.worker_monitor import WorkerMonitorService

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.app_env,
    }


@router.get("/ready")
async def ready() -> dict[str, object]:
    db_ok = False
    redis_ok = False
    async_session_factory = get_session_factory()
    try:
        async with async_session_factory() as session:
            await session.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    try:
        await get_redis().ping()
        redis_ok = True
    except RedisError:
        redis_ok = False

    runtime_config = RuntimeConfigService()
    return {
        "status": "ready" if db_ok and redis_ok else "degraded",
        "database": "up" if db_ok else "down",
        "redis": "up" if redis_ok else "down",
        "runtime_config_loaded": runtime_config.is_loaded,
    }


@router.get("/metrics", response_class=PlainTextResponse)
async def metrics() -> str:
    runtime_config = RuntimeConfigService()
    settings = get_settings()
    scheduler = RedisScheduler()
    workers = await WorkerMonitorService().list_workers()
    snapshots = await scheduler.snapshot()
    lines = [
        "# HELP llm_orchestrator_info Basic service metadata",
        "# TYPE llm_orchestrator_info gauge",
        f'llm_orchestrator_info{{service="{settings.app_name}",environment="{settings.app_env}"}} 1',
        "# HELP llm_orchestrator_runtime_config_loaded Whether runtime config is loaded",
        "# TYPE llm_orchestrator_runtime_config_loaded gauge",
        f"llm_orchestrator_runtime_config_loaded {1 if runtime_config.is_loaded else 0}",
    ]
    lines.extend(
        [
            "# HELP llm_orchestrator_active_requests Active requests by model",
            "# TYPE llm_orchestrator_active_requests gauge",
        ]
    )
    for model_name, snapshot in snapshots.items():
        lines.append(
            f'llm_orchestrator_active_requests{{model="{model_name}"}} {snapshot.active}'
        )
    lines.extend(
        [
            "# HELP llm_orchestrator_waiting_requests Waiting queued requests by model",
            "# TYPE llm_orchestrator_waiting_requests gauge",
        ]
    )
    for model_name, snapshot in snapshots.items():
        lines.append(
            f'llm_orchestrator_waiting_requests{{model="{model_name}"}} {snapshot.waiting}'
        )
    lines.extend(
        [
            "# HELP llm_orchestrator_workers_active Active worker heartbeats",
            "# TYPE llm_orchestrator_workers_active gauge",
            f"llm_orchestrator_workers_active {len(workers)}",
        ]
    )
    return "\n".join(lines) + "\n"
