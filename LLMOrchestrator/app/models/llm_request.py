from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.time import now
from app.db.base import Base


def utc_now() -> datetime:
    return now()


class LLMRequest(Base):
    __tablename__ = "llm_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, default=lambda: str(uuid4())
    )
    trace_id: Mapped[str] = mapped_column(String(64), index=True)
    source_app: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    org_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    requested_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resolved_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    backend_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    request_payload_json: Mapped[dict] = mapped_column(JSON)
    input_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="received", index=True)
    error_code: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
