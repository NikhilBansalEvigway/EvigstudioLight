from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.time import now
from app.db.base import Base


def utc_now() -> datetime:
    return now()


class LLMRequestEvent(Base):
    __tablename__ = "llm_request_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("llm_requests.request_id"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    details_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
