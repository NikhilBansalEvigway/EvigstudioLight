from __future__ import annotations

import logging
from typing import Dict

from app.db.session import get_session_factory
from app.models.model_config import ModelConfig
from app.core.settings import get_settings
from sqlalchemy import update

logger = logging.getLogger(__name__)

class StrategyService:
    STRATEGIES = {
        "SEQUENTIAL": {"concurrency": 1, "queue": 100},
        "BALANCED": {"concurrency": 3, "queue": 500},
        "AGGRESSIVE": {"concurrency": 8, "queue": 1000},
    }

    @classmethod
    async def apply_strategy(cls, strategy_name: str) -> None:
        """Applies a predefined concurrency/queue strategy to all enabled models."""
        if strategy_name not in cls.STRATEGIES:
            logger.warning("Unknown strategy %s. No changes applied.", strategy_name)
            return

        strategy = cls.STRATEGIES[strategy_name]
        concurrency = strategy["concurrency"]
        queue_limit = strategy["queue"]

        logger.info("Applying strategy '%s' (concurrency=%d, queue=%d) to all models", 
                    strategy_name, concurrency, queue_limit)

        session_factory = get_session_factory()
        async with session_factory() as session:
            # Update all enabled models in one batch
            stmt = (
                update(ModelConfig)
                .where(ModelConfig.is_enabled == True)
                .values(
                    concurrency_limit=concurrency,
                    queue_limit=queue_limit
                )
            )
            await session.execute(stmt)
            await session.commit()
            logger.info("Successfully applied strategy '%s' to database", strategy_name)

