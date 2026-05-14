from __future__ import annotations

import json
from datetime import datetime
from hashlib import sha256
from typing import Any

import httpx

from app.core.logging import get_logger
from app.core.runtime_config import RuntimeConfigService
from app.core.settings import get_settings
from app.core.time import now
from app.db.redis import get_redis

logger = get_logger(__name__)


class AlertingService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.runtime_config = RuntimeConfigService()
        self._redis = get_redis()
        self._namespace = self.settings.redis_namespace

    def _state_key(self) -> str:
        return f"{self._namespace}:alerting:last-state"

    def _active_signature(self, alerts: list[dict[str, Any]]) -> str:
        active = [
            {
                "code": alert.get("code"),
                "severity": alert.get("severity"),
                "observed_value": alert.get("observed_value"),
            }
            for alert in alerts
            if alert.get("active")
        ]
        payload = json.dumps(active, sort_keys=True)
        return sha256(payload.encode("utf-8")).hexdigest()

    async def notify_if_needed(self, alerts: list[dict[str, Any]]) -> None:
        webhook_url = self.runtime_config.get("alert_webhook_url") or self.settings.alert_webhook_url
        if not webhook_url:
            return

        timeout_seconds = int(
            self.runtime_config.get("alert_webhook_timeout_seconds", self.settings.alert_webhook_timeout_seconds)
        )
        cooldown_seconds = int(
            self.runtime_config.get(
                "alert_notification_cooldown_seconds",
                self.settings.alert_notification_cooldown_seconds,
            )
        )
        state_key = self._state_key()
        previous_raw = await self._redis.get(state_key)
        previous = json.loads(previous_raw) if previous_raw else {}
        active_alerts = [alert for alert in alerts if alert.get("active")]
        signature = self._active_signature(alerts)
        now = now()
        last_sent_at = previous.get("last_sent_at")
        signature_changed = previous.get("signature") != signature
        cooldown_elapsed = True
        if isinstance(last_sent_at, str):
            try:
                cooldown_elapsed = (now - datetime.fromisoformat(last_sent_at)).total_seconds() >= cooldown_seconds
            except ValueError:
                cooldown_elapsed = True

        if not active_alerts and previous.get("signature") in (None, signature):
            return
        if not signature_changed and not cooldown_elapsed:
            return

        payload = {
            "timestamp": now.isoformat(),
            "active_alerts": active_alerts,
            "all_alerts": alerts,
        }
        try:
            async with httpx.AsyncClient(timeout=max(timeout_seconds, 1)) as client:
                await client.post(webhook_url, json=payload)
            await self._redis.set(
                state_key,
                json.dumps({"signature": signature, "last_sent_at": now.isoformat()}),
                ex=max(cooldown_seconds * 4, 300),
            )
        except Exception:
            logger.exception("alert_webhook_send_failed")
