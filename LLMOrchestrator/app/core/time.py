from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

from app.core.settings import get_settings


@lru_cache(maxsize=1)
def current_timezone() -> ZoneInfo:
    return ZoneInfo(get_settings().app_timezone)


def now() -> datetime:
    return datetime.now(current_timezone())


def start_of_day(value: datetime | None = None) -> datetime:
    current = value or now()
    return datetime(
        current.year,
        current.month,
        current.day,
        tzinfo=current_timezone(),
    )
