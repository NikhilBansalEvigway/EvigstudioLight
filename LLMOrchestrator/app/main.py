from contextlib import asynccontextmanager
import asyncio
from sqlalchemy.exc import OperationalError
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

from app.api.routes.chat import router as chat_router
from app.api.routes.health import router as health_router
from app.api.routes.admin import router as admin_router
from app.api.routes.models import router as models_router
from app.core.logging import configure_logging, get_logger
from app.core.settings import get_settings
from app.core.runtime_config import RuntimeConfigService
from app.services.strategy_service import StrategyService
from app.db.redis import close_redis
from app.db.session import dispose_engine, initialize_database


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    logger = get_logger(__name__)
    logger.info("starting_application", extra={"app_env": settings.app_env})

    async def _bootstrap_loop() -> None:
        # Keep trying to bootstrap DB/runtime config; service should still start
        # in degraded mode when dependencies are down.
        backoff_s = 0.5
        while True:
            try:
                await initialize_database()
                runtime_config = RuntimeConfigService()
                await runtime_config.refresh()
                return
            except Exception:
                logger.exception("bootstrap_failed")
                await asyncio.sleep(min(backoff_s, 10.0))
                backoff_s = min(backoff_s * 2, 10.0)

    bootstrap_task = asyncio.create_task(_bootstrap_loop())
    
    import os
    strategy = os.environ.get("LLM_STRATEGY")
    if strategy:
        try:
            logger.info("Applying LLM Strategy from environment: %s", strategy)
            await StrategyService.apply_strategy(strategy)
        except Exception:
            logger.exception("apply_strategy_failed", extra={"strategy": strategy})

    try:
        yield
    finally:
        bootstrap_task.cancel()
        try:
            await bootstrap_task
        except Exception:
            pass
        await close_redis()
        await dispose_engine()
        logger.info("stopping_application")


settings = get_settings()
app = FastAPI(title=settings.app_name, lifespan=lifespan)


@app.exception_handler(OperationalError)
async def _db_operational_error_handler(_request, exc: OperationalError):
    # Keep the service responsive even under transient DB lock/contention.
    # Health/ready endpoints can still reflect degraded state.
    detail = str(getattr(exc, "orig", None) or exc)
    return JSONResponse(status_code=503, content={"detail": "database_unavailable", "error": detail})
app.include_router(health_router)
app.include_router(chat_router)
app.include_router(models_router)
app.include_router(admin_router)

dashboard_dir = Path(__file__).parent / "dashboard"
app.mount("/admin-ui", StaticFiles(directory=dashboard_dir, html=True), name="admin-ui")
