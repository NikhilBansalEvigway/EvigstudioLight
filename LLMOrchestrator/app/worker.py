import asyncio

from app.core.logging import configure_logging, get_logger
from app.core.settings import get_settings
from app.db.redis import close_redis
from app.db.session import dispose_engine, initialize_database
from app.services.worker_service import WorkerService


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    logger = get_logger(__name__)
    logger.info("starting_worker")
    await initialize_database()
    worker = WorkerService()
    try:
        await worker.run_forever()
    finally:
        await close_redis()
        await dispose_engine()
        logger.info("stopping_worker")


if __name__ == "__main__":
    asyncio.run(main())
