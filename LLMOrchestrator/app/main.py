from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

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
    await initialize_database()
    
    import os
    strategy = os.environ.get("LLM_STRATEGY")
    if strategy:
        logger.info("Applying LLM Strategy from environment: %s", strategy)
        await StrategyService.apply_strategy(strategy)

    runtime_config = RuntimeConfigService()
    await runtime_config.refresh()
    try:
        yield
    finally:
        await close_redis()
        await dispose_engine()
        logger.info("stopping_application")


settings = get_settings()
app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.include_router(health_router)
app.include_router(chat_router)
app.include_router(models_router)
app.include_router(admin_router)

dashboard_dir = Path(__file__).parent / "dashboard"
app.mount("/admin-ui", StaticFiles(directory=dashboard_dir, html=True), name="admin-ui")
