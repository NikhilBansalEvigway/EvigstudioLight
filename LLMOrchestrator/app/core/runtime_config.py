from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select

from app.core.settings import Settings, get_settings
from app.core.time import now
from app.db.session import get_session_factory
from app.models.config_entry import ConfigEntry


class RuntimeConfigService:
    _instance: "RuntimeConfigService | None" = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._cache = {}
            cls._instance._loaded_at = None
        return cls._instance

    @property
    def is_loaded(self) -> bool:
        return self._loaded_at is not None

    async def refresh(self) -> None:
        settings = get_settings()
        session_factory = get_session_factory()
        overrides: dict[str, Any] = {}
        try:
            async with session_factory() as session:
                result = await session.execute(
                    select(ConfigEntry).where(ConfigEntry.is_active.is_(True))
                )
                for entry in result.scalars().all():
                    overrides[entry.key] = entry.value_json
        except Exception:
            overrides = {}

        self._cache = self._merge(settings, overrides)
        self._loaded_at = now()

    def get(self, key: str, default: Any = None) -> Any:
        return self._cache.get(key, default)

    def as_dict(self) -> dict[str, Any]:
        return dict(self._cache)

    def is_stale(self) -> bool:
        settings = get_settings()
        if self._loaded_at is None:
            return True
        max_age = timedelta(seconds=settings.config_cache_ttl_seconds)
        return now() - self._loaded_at > max_age

    def _merge(self, settings: Settings, overrides: dict[str, Any]) -> dict[str, Any]:
        base = settings.model_dump()
        editable_keys = {
            "lm_studio_base_url",
            "default_model",
            "default_request_timeout_seconds",
            "enable_streaming",
            "default_queue_timeout_seconds",
            "default_max_retries",
            "metrics_enabled",
            "prompt_logging_enabled",
            "secret_redaction_enabled",
            "pii_redaction_enabled",
            "alert_webhook_url",
            "alert_webhook_timeout_seconds",
            "alert_notification_cooldown_seconds",
        }
        for key, value in overrides.items():
            if key in editable_keys:
                base[key] = value
        return base
