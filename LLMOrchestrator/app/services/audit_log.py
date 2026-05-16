from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.db.session import get_session_factory
from app.models.config_audit_log import ConfigAuditLog


class AuditLogService:
    async def log(
        self,
        *,
        actor: str,
        action: str,
        target_type: str,
        target_key: str,
        before_value_json: Any = None,
        after_value_json: Any = None,
        details_json: dict[str, Any] | None = None,
    ) -> None:
        session_factory = get_session_factory()
        async with session_factory() as session:
            session.add(
                ConfigAuditLog(
                    actor=actor,
                    action=action,
                    target_type=target_type,
                    target_key=target_key,
                    before_value_json=before_value_json,
                    after_value_json=after_value_json,
                    details_json=details_json,
                )
            )
            await session.commit()

    async def list_logs(self, limit: int = 100) -> list[ConfigAuditLog]:
        session_factory = get_session_factory()
        async with session_factory() as session:
            result = await session.execute(
                select(ConfigAuditLog)
                .order_by(ConfigAuditLog.created_at.desc())
                .limit(limit)
            )
            return list(result.scalars().all())
