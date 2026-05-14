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

    async def bootstrap_loop() -> None:
        # Keep trying to initialize DB; worker should stay alive even if the DB is
        # temporarily unavailable/locked.
        backoff_s = 0.5
        while True:
            try:
                await initialize_database()
                return
            except Exception:
                logger.exception("worker_bootstrap_failed")
                await asyncio.sleep(min(backoff_s, 10.0))
                backoff_s = min(backoff_s * 2, 10.0)

    bootstrap_task = asyncio.create_task(bootstrap_loop())

    # If the worker loop ever fails unexpectedly, restart it with backoff.
    run_backoff_s = 0.5
    try:
        while True:
            worker = WorkerService()
            try:
                await worker.run_forever()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("worker_run_failed")
                await asyncio.sleep(min(run_backoff_s, 10.0))
                run_backoff_s = min(run_backoff_s * 2, 10.0)
            else:
                run_backoff_s = 0.5
    finally:
        bootstrap_task.cancel()
        try:
            await bootstrap_task
        except Exception:
            pass
        await close_redis()
        await dispose_engine()
        logger.info("stopping_worker")


if __name__ == "__main__":
    asyncio.run(main())
