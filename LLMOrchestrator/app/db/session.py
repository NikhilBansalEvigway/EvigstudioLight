from __future__ import annotations

import asyncio
import os
import random
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
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


_sqlite_process_write_lock: asyncio.Lock = asyncio.Lock()


_sqlite_pragmas_initialized: bool = False


_sqlite_write_lock_held: ContextVar[bool] = ContextVar(
    "sqlite_write_lock_held", default=False
)


def _is_sqlite_url(url: str) -> bool:
    return url.strip().lower().startswith("sqlite")


def _looks_like_sqlite_lock_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return (
        "database is locked" in text
        or "database is busy" in text
        or "sqlite_busy" in text
        or "sqlite_locked" in text
    )


def _sqlite_lock_file_path(database_url: str) -> str | None:
    # Only meaningful for file-backed sqlite URLs.
    url = database_url.strip()
    if not _is_sqlite_url(url):
        return None

    # Examples:
    # sqlite+aiosqlite:////data/llm_orchestrator.db
    # sqlite+aiosqlite:///./llm_orchestrator.db
    # sqlite:///relative.db
    # sqlite:///:memory:
    lower = url.lower()
    if ":memory:" in lower:
        return None

    # Strip optional driver prefix (sqlite+aiosqlite -> sqlite)
    # and then parse the path part after '///' or '////'.
    # This is intentionally simple and avoids pulling in sqlalchemy URL parsing.
    if "///" not in url:
        return None
    path_part = url.split("///", 1)[1]
    # For absolute paths, SQLAlchemy URLs usually look like '////abs/path'.
    if path_part.startswith("/"):
        db_path = path_part
    else:
        db_path = os.path.abspath(path_part)
    try:
        p = Path(db_path)
    except Exception:
        return None
    return str(p.with_suffix(p.suffix + ".lock"))


@asynccontextmanager
async def _sqlite_interprocess_write_lock(database_url: str):
    """Best-effort cross-process lock for SQLite writes.

    SQLite already serializes writers, but under high concurrency (API + worker +
    multiple tasks) it's easy to hit SQLITE_BUSY timeouts. A coarse file lock
    reduces lock thrashing across processes.
    """

    lock_path = _sqlite_lock_file_path(database_url)
    if not lock_path:
        async with _sqlite_process_write_lock:
            yield
        return

    # Re-entrant for the current task: commit() -> flush() should not deadlock.
    if _sqlite_write_lock_held.get():
        yield
        return

    token = _sqlite_write_lock_held.set(True)
    try:
        # Serialize writes in-process, and also coordinate across processes when possible.
        async with _sqlite_process_write_lock:
            # File locks are advisory; this is still a big improvement for our use.
            if os.name == "posix":
                import fcntl  # type: ignore

                fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o666)
                try:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(
                        None, lambda: fcntl.flock(fd, fcntl.LOCK_EX)
                    )
                    yield
                finally:
                    try:
                        await loop.run_in_executor(
                            None, lambda: fcntl.flock(fd, fcntl.LOCK_UN)
                        )
                    finally:
                        os.close(fd)
            else:
                # Non-posix: fall back to in-process locking only.
                yield
    finally:
        _sqlite_write_lock_held.reset(token)


class ResilientAsyncSession(AsyncSession):
    """AsyncSession with pragmatic retries for transient DB lock/contention."""

    async def _run_with_sqlite_retry(self, fn, *, operation: str):
        settings = get_settings()
        url = settings.database_url
        if not _is_sqlite_url(url):
            return await fn()

        attempts = int(getattr(settings, "database_sqlite_lock_retry_attempts", 8) or 0)
        base_ms = int(getattr(settings, "database_sqlite_lock_retry_base_delay_ms", 40) or 0)
        max_ms = int(getattr(settings, "database_sqlite_lock_retry_max_delay_ms", 2000) or 0)
        # If misconfigured, behave like normal.
        if attempts <= 1 or base_ms <= 0 or max_ms <= 0:
            return await fn()

        last_exc: Exception | None = None
        for i in range(attempts):
            try:
                async with _sqlite_interprocess_write_lock(url):
                    return await fn()
            except OperationalError as exc:
                last_exc = exc
                if not _looks_like_sqlite_lock_error(exc):
                    raise

                # For SQLITE_BUSY/LOCKED, the write typically did not happen.
                # Rolling back here can discard in-memory pending changes; prefer
                # waiting and retrying the same unit of work.
                # If the transaction is marked inactive by SQLAlchemy, the next
                # retry will raise and surface the root error.

                if i >= attempts - 1:
                    raise
                delay = min(max_ms, base_ms * (2**i))
                # Jitter prevents stampedes when API + worker collide.
                delay = int(delay * (0.75 + random.random() * 0.5))
                await asyncio.sleep(delay / 1000)

        if last_exc is not None:
            raise last_exc

    async def commit(self) -> None:
        await self._run_with_sqlite_retry(
            lambda: AsyncSession.commit(self),
            operation="commit",
        )

    async def flush(self, objects=None) -> None:  # type: ignore[override]
        await self._run_with_sqlite_retry(
            lambda: AsyncSession.flush(self, objects),
            operation="flush",
        )


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
                global _sqlite_pragmas_initialized
                try:
                    cursor = dbapi_connection.cursor()
                    # Avoid doing WAL toggles concurrently across many new connections.
                    # PRAGMA journal_mode needs a lock and can become a hotspot.
                    if not _sqlite_pragmas_initialized:
                        cursor.execute("PRAGMA journal_mode=WAL")
                        _sqlite_pragmas_initialized = True
                    cursor.execute("PRAGMA synchronous=NORMAL")
                    cursor.execute("PRAGMA foreign_keys=ON")
                    cursor.execute("PRAGMA temp_store=MEMORY")
                    cursor.execute("PRAGMA wal_autocheckpoint=1000")
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
        session_factory = async_sessionmaker(
            get_engine(),
            class_=ResilientAsyncSession,
            expire_on_commit=False,
        )
    return session_factory


async def initialize_database() -> None:
    settings = get_settings()
    # In sqlite mode, API + worker may start together; serialize init/migrations-lite.
    if settings.database_url.startswith("sqlite"):
        async with _sqlite_interprocess_write_lock(settings.database_url):
            async with get_engine().begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            await seed_defaults()
        return

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
