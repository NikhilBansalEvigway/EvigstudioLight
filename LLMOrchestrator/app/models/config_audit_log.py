from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.time import now
from app.db.base import Base


def utc_now() -> datetime:
    return now()


class ConfigAuditLog(Base):
    __tablename__ = "config_audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(String(255), index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(64), index=True)
    target_key: Mapped[str] = mapped_column(String(255), index=True)
    before_value_json: Mapped[dict | list | str | int | float | bool | None] = (
        mapped_column(JSON, nullable=True)
    )
    after_value_json: Mapped[dict | list | str | int | float | bool | None] = (
        mapped_column(JSON, nullable=True)
    )
    details_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
