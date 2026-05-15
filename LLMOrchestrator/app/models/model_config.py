from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.time import now
from app.db.base import Base


def utc_now() -> datetime:
    return now()


class ModelConfig(Base):
    __tablename__ = "model_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    alias: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    backend_url: Mapped[str] = mapped_column(String(1024))
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=120)
    concurrency_limit: Mapped[int] = mapped_column(Integer, default=1)
    queue_limit: Mapped[int] = mapped_column(Integer, default=100)
    fallback_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
