from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = Field(default="LLMOrchestrator", alias="APP_NAME")
    app_env: str = Field(default="development", alias="APP_ENV")
    app_timezone: str = Field(default="Asia/Kolkata", alias="APP_TIMEZONE")
    app_host: str = Field(default="0.0.0.0", alias="APP_HOST")
    app_port: int = Field(default=8100, alias="APP_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    database_url: str = Field(
        default="sqlite+aiosqlite:///./llm_orchestrator.db",
        alias="DATABASE_URL",
    )
    database_echo: bool = Field(default=False, alias="DATABASE_ECHO")
    database_pool_size: int = Field(default=10, alias="DATABASE_POOL_SIZE")
    database_max_overflow: int = Field(default=20, alias="DATABASE_MAX_OVERFLOW")
    # SQLite only: busy timeout to reduce "database is locked" at higher write concurrency.
    database_sqlite_busy_timeout_seconds: int = Field(
        default=30,
        alias="DATABASE_SQLITE_BUSY_TIMEOUT_SECONDS",
    )

    redis_url: str = Field(default="redis://127.0.0.1:6379", alias="REDIS_URL")
    redis_namespace: str = Field(default="llm_orchestrator", alias="REDIS_NAMESPACE")

    admin_jwt_secret: str = Field(default="change-me", alias="ADMIN_JWT_SECRET")
    admin_jwt_algorithm: str = Field(default="HS256", alias="ADMIN_JWT_ALGORITHM")
    admin_access_token_expire_minutes: int = Field(
        default=120,
        alias="ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES",
    )
    admin_username: str = Field(default="admin", alias="ADMIN_USERNAME")
    admin_password: str = Field(default="admin123", alias="ADMIN_PASSWORD")
    admin_ops_username: str | None = Field(default=None, alias="ADMIN_OPS_USERNAME")
    admin_ops_password: str | None = Field(default=None, alias="ADMIN_OPS_PASSWORD")
    admin_viewer_username: str | None = Field(
        default=None, alias="ADMIN_VIEWER_USERNAME"
    )
    admin_viewer_password: str | None = Field(
        default=None, alias="ADMIN_VIEWER_PASSWORD"
    )

    lm_studio_base_url: str = Field(
        default="http://172.16.16.50:1234",
        alias="LM_STUDIO_BASE_URL",
    )
    default_model: str = Field(
        default="google/gemma-4-26b-a4b", alias="DEFAULT_MODEL"
    )
    default_request_timeout_seconds: int = Field(
        default=120,
        alias="DEFAULT_REQUEST_TIMEOUT_SECONDS",
    )
    enable_streaming: bool = Field(default=True, alias="ENABLE_STREAMING")

    default_queue_timeout_seconds: int = Field(
        default=30,
        alias="DEFAULT_QUEUE_TIMEOUT_SECONDS",
    )
    default_max_retries: int = Field(default=2, alias="DEFAULT_MAX_RETRIES")
    scheduler_poll_interval_ms: int = Field(
        default=500,
        alias="SCHEDULER_POLL_INTERVAL_MS",
    )
    worker_poll_interval_ms: int = Field(default=300, alias="WORKER_POLL_INTERVAL_MS")
    worker_blocking_pop_timeout_seconds: int = Field(
        default=1,
        alias="WORKER_BLOCKING_POP_TIMEOUT_SECONDS",
    )
    worker_max_parallel_jobs: int = Field(
        default=4,
        alias="WORKER_MAX_PARALLEL_JOBS",
    )
    worker_heartbeat_ttl_seconds: int = Field(
        default=30,
        alias="WORKER_HEARTBEAT_TTL_SECONDS",
    )
    scheduler_acquire_timeout_seconds: int = Field(
        default=2,
        alias="SCHEDULER_ACQUIRE_TIMEOUT_SECONDS",
    )
    result_wait_timeout_seconds: int = Field(
        default=180,
        alias="RESULT_WAIT_TIMEOUT_SECONDS",
    )

    default_user_active_limit: int = Field(
        default=2,
        alias="DEFAULT_USER_ACTIVE_LIMIT",
    )
    default_org_active_limit: int = Field(
        default=10,
        alias="DEFAULT_ORG_ACTIVE_LIMIT",
    )
    default_user_requests_per_minute: int = Field(
        default=30,
        alias="DEFAULT_USER_REQUESTS_PER_MINUTE",
    )
    default_org_requests_per_minute: int = Field(
        default=300,
        alias="DEFAULT_ORG_REQUESTS_PER_MINUTE",
    )

    metrics_enabled: bool = Field(default=True, alias="METRICS_ENABLED")
    prompt_logging_enabled: bool = Field(default=True, alias="PROMPT_LOGGING_ENABLED")
    secret_redaction_enabled: bool = Field(
        default=True,
        alias="SECRET_REDACTION_ENABLED",
    )
    pii_redaction_enabled: bool = Field(default=False, alias="PII_REDACTION_ENABLED")
    alert_webhook_url: str | None = Field(default=None, alias="ALERT_WEBHOOK_URL")
    alert_webhook_timeout_seconds: int = Field(
        default=5,
        alias="ALERT_WEBHOOK_TIMEOUT_SECONDS",
    )
    alert_notification_cooldown_seconds: int = Field(
        default=300,
        alias="ALERT_NOTIFICATION_COOLDOWN_SECONDS",
    )
    config_cache_ttl_seconds: int = Field(
        default=15,
        alias="CONFIG_CACHE_TTL_SECONDS",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
