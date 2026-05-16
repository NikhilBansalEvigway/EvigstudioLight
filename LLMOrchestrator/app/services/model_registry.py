from __future__ import annotations

from dataclasses import dataclass
import re

import httpx
from sqlalchemy import select

from app.core.runtime_config import RuntimeConfigService
from app.core.settings import get_settings
from app.db.session import get_session_factory
from app.models.model_config import ModelConfig
from app.services.lm_studio_client import _remap_loopback_lm_studio_base

LEGACY_DEFAULT_MODEL = "google/gemma-4-26b-a4b"


@dataclass
class ResolvedModelConfig:
    requested_model: str | None
    resolved_model: str
    backend_url: str
    timeout_seconds: int
    concurrency_limit: int
    queue_limit: int
    is_enabled: bool


class ModelRegistryService:
    async def _get_runtime_value(self, key: str, fallback: str) -> str:
        runtime_config = RuntimeConfigService()
        if runtime_config.is_stale():
            await runtime_config.refresh()
        value = runtime_config.get(key, fallback)
        return str(value).strip() or fallback

    async def _get_effective_base_url(self) -> str:
        settings = get_settings()
        return await self._get_runtime_value(
            "lm_studio_base_url", settings.lm_studio_base_url
        )

    async def _get_runtime_default_model(self) -> str:
        settings = get_settings()
        return await self._get_runtime_value("default_model", settings.default_model)

    def _normalize_requested_model(self, model_name: str | None) -> str | None:
        if model_name and model_name.startswith("openai/"):
            return model_name.removeprefix("openai/")
        return model_name

    def _extract_model_name(self, raw: dict) -> str | None:
        name = raw.get("key") or raw.get("id") or raw.get("model")
        if not isinstance(name, str) or not name.strip():
            return None
        return name.strip()

    def _is_loaded_lm_studio_model(self, raw: dict) -> bool:
        loaded_instances = raw.get("loaded_instances")
        return isinstance(loaded_instances, list) and len(loaded_instances) > 0

    async def _fetch_lm_studio_models(self) -> list[dict]:
        base_setting = await self._get_effective_base_url()
        base_url = _remap_loopback_lm_studio_base(
            base_setting.rstrip("/")
        )

        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/api/v1/models")
            response.raise_for_status()
            payload = response.json()

        raw_models = payload.get("models", payload.get("data", []))
        if not isinstance(raw_models, list):
            return []
        return [raw for raw in raw_models if isinstance(raw, dict)]

    async def _select_lm_studio_default_model(self) -> str | None:
        raw_models = await self._fetch_lm_studio_models()
        if not raw_models:
            return None

        for raw in raw_models:
            if self._is_loaded_lm_studio_model(raw):
                name = self._extract_model_name(raw)
                if name:
                    return name

        for raw in raw_models:
            name = self._extract_model_name(raw)
            if name:
                return name
        return None

    async def _get_effective_default_model(self, configured_default: str) -> str:
        normalized_default = self._normalize_requested_model(configured_default)
        if normalized_default != LEGACY_DEFAULT_MODEL:
            return normalized_default or configured_default

        try:
            lm_studio_default = await self._select_lm_studio_default_model()
        except Exception:
            lm_studio_default = None
        return lm_studio_default or normalized_default or configured_default

    def _parse_size_bytes(self, value: object) -> int | None:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str):
            text = value.strip().lower()
            if not text:
                return None
            try:
                return int(float(text))
            except ValueError:
                pass
            match = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?b)\s*$", text)
            if not match:
                return None
            number = float(match.group(1))
            unit = match.group(2)
            factor = {
                "kb": 1024,
                "mb": 1024**2,
                "gb": 1024**3,
                "tb": 1024**4,
                "b": 1,
            }.get(unit)
            if factor is None:
                return None
            return int(number * factor)
        return None

    async def _sync_models_from_lm_studio(self, max_size_gb: float) -> None:
        settings = get_settings()
        effective_base_url = await self._get_effective_base_url()
        max_size_bytes = int(max_size_gb * (1024**3))
        raw_models = await self._fetch_lm_studio_models()

        discovered: set[str] = set()
        for raw in raw_models:
            name = self._extract_model_name(raw)
            if not name:
                continue

            size_bytes = (
                self._parse_size_bytes(raw.get("size_bytes"))
                or self._parse_size_bytes(raw.get("size"))
                or self._parse_size_bytes(raw.get("model_size"))
                or self._parse_size_bytes(raw.get("file_size"))
            )
            if size_bytes is not None and size_bytes > max_size_bytes:
                continue
            discovered.add(name)

        if not discovered:
            return

        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(select(ModelConfig))
            existing = {m.name: m for m in result.scalars().all()}
            for name in sorted(discovered):
                if name in existing:
                    continue
                session.add(
                    ModelConfig(
                        name=name,
                        alias=name,
                        backend_url=effective_base_url,
                        timeout_seconds=settings.default_request_timeout_seconds,
                        concurrency_limit=1,
                        queue_limit=100,
                        is_enabled=True,
                    )
                )
            await session.commit()

    async def list_models(self, *, sync_remote: bool = False) -> list[ModelConfig]:
        if sync_remote:
            try:
                await self._sync_models_from_lm_studio(max_size_gb=100.0)
            except Exception:
                # Model listing should still work even if LM Studio probing fails.
                pass

        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(
                select(ModelConfig).order_by(ModelConfig.name.asc())
            )
            return list(result.scalars().all())

    async def resolve(self, model_name: str | None) -> ResolvedModelConfig:
        settings = get_settings()
        # Requests are pinned to the runtime default model to keep routing policy strict.
        requested_model = await self._get_runtime_default_model()
        effective_base_url = await self._get_effective_base_url()
        requested_model = await self._get_effective_default_model(requested_model)
        session_factory = get_session_factory()

        async with session_factory() as session:
            # Prefer row where `name` matches — prevents MultipleResultsFound when
            # another row matches only via `alias` (same string as name on one row
            # and alias on another).
            name_match = await session.execute(
                select(ModelConfig)
                .where(ModelConfig.name == requested_model)
                .limit(1)
            )
            model = name_match.scalar_one_or_none()
            if model is None:
                alias_match = await session.execute(
                    select(ModelConfig)
                    .where(ModelConfig.alias == requested_model)
                    .limit(1)
                )
                model = alias_match.scalar_one_or_none()

        if model is None:
            fallback_model = requested_model
            return ResolvedModelConfig(
                requested_model=model_name,
                resolved_model=fallback_model,
                backend_url=effective_base_url,
                timeout_seconds=settings.default_request_timeout_seconds,
                concurrency_limit=1,
                queue_limit=100,
                is_enabled=True,
            )

        return ResolvedModelConfig(
            requested_model=model_name,
            resolved_model=model.name,
            backend_url=effective_base_url,
            timeout_seconds=model.timeout_seconds,
            concurrency_limit=model.concurrency_limit,
            queue_limit=model.queue_limit,
            is_enabled=model.is_enabled,
        )
