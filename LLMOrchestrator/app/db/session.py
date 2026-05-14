from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy import event
from sqlalchemy.pool import NullPool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.settings import get_settings
from app.db.base import Base
from app.models.config_entry import ConfigEntry
from app.models.config_audit_log import ConfigAuditLog
from app.models.llm_request import LLMRequest
from app.models.llm_request_event import LLMRequestEvent
from app.models.llm_response import LLMResponse
from app.models.model_config import ModelConfig
from app.models.queue_job import QueueJob

engine = None
session_factory = None


def _engine_kwargs(settings) -> dict:
    kwargs = {"echo": settings.database_echo}
    if settings.database_url.startswith("sqlite"):
        kwargs["poolclass"] = NullPool
        # aiosqlite respects sqlite3 connect timeout (seconds).
        kwargs["connect_args"] = {
            "timeout": float(getattr(settings, "database_sqlite_busy_timeout_seconds", 30)),
        }
    else:
        kwargs["pool_size"] = settings.database_pool_size
        kwargs["max_overflow"] = settings.database_max_overflow
    return kwargs


def get_engine():
    global engine
    if engine is None:
        settings = get_settings()
        engine = create_async_engine(settings.database_url, **_engine_kwargs(settings))
        # SQLite tuning: WAL improves concurrency for write-heavy workloads.
        if settings.database_url.startswith("sqlite"):
            @event.listens_for(engine.sync_engine, "connect")
            def _sqlite_pragmas(dbapi_connection, _):  # type: ignore[no-redef]
                try:
                    cursor = dbapi_connection.cursor()
                    cursor.execute("PRAGMA journal_mode=WAL")
                    cursor.execute("PRAGMA synchronous=NORMAL")
                    cursor.execute(
                        f"PRAGMA busy_timeout={int(float(getattr(settings, 'database_sqlite_busy_timeout_seconds', 30)) * 1000)}"
                    )
                    cursor.close()
                except Exception:
                    # Best-effort; do not block startup.
                    pass
    return engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global session_factory
    if session_factory is None:
        session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return session_factory


async def initialize_database() -> None:
    async with get_engine().begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    await seed_defaults()


async def seed_defaults() -> None:
    settings = get_settings()
    session_factory = get_session_factory()
    legacy_lm_studio_urls = {
        "http://172.16.16.21",
        "http://172.16.16.21:1234",
    }
    editable_defaults = {
        "lm_studio_base_url": settings.lm_studio_base_url,
        "default_model": settings.default_model,
        "default_request_timeout_seconds": settings.default_request_timeout_seconds,
        "enable_streaming": settings.enable_streaming,
        "default_queue_timeout_seconds": settings.default_queue_timeout_seconds,
        "default_max_retries": settings.default_max_retries,
        "metrics_enabled": settings.metrics_enabled,
        "prompt_logging_enabled": settings.prompt_logging_enabled,
        "secret_redaction_enabled": settings.secret_redaction_enabled,
        "pii_redaction_enabled": settings.pii_redaction_enabled,
        "alert_webhook_url": settings.alert_webhook_url,
        "alert_webhook_timeout_seconds": settings.alert_webhook_timeout_seconds,
        "alert_notification_cooldown_seconds": settings.alert_notification_cooldown_seconds,
    }

    async with session_factory() as session:
        for key, value in editable_defaults.items():
            result = await session.execute(
                select(ConfigEntry).where(ConfigEntry.key == key)
            )
            entry = result.scalar_one_or_none()
            if entry is None:
                session.add(
                    ConfigEntry(
                        key=key,
                        value_json=value,
                        editable_from_ui=True,
                        description=f"Seeded editable setting for {key}",
                        updated_by="system_bootstrap",
                    )
                )
                continue

            if (
                key == "lm_studio_base_url"
                and isinstance(entry.value_json, str)
                and entry.value_json.strip() in legacy_lm_studio_urls
            ):
                entry.value_json = settings.lm_studio_base_url
                entry.editable_from_ui = True
                entry.updated_by = "system_bootstrap"
                continue

            # Keep admin UI overrides, but migrate legacy bootstrap defaults.
            if entry.updated_by in (None, "", "system_bootstrap"):
                entry.value_json = value
                entry.editable_from_ui = True
                entry.updated_by = "system_bootstrap"

        result = await session.execute(
            select(ModelConfig).where(ModelConfig.name == settings.default_model)
        )
        model = result.scalar_one_or_none()
        if model is None:
            session.add(
                ModelConfig(
                    name=settings.default_model,
                    alias=settings.default_model,
                    backend_url=settings.lm_studio_base_url,
                    timeout_seconds=settings.default_request_timeout_seconds,
                    concurrency_limit=1,
                    queue_limit=100,
                    is_enabled=True,
                )
            )

        try:
            await session.commit()
        except IntegrityError:
            # API and worker can bootstrap in parallel; ignore duplicate seed inserts.
            await session.rollback()


async def dispose_engine() -> None:
    global engine, session_factory
    if engine is not None:
        await engine.dispose()
    engine = None
    session_factory = None
