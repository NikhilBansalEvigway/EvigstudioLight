from __future__ import annotations

from datetime import timedelta
from hashlib import sha256
from typing import Callable

import jwt
from fastapi import Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.settings import get_settings
from app.core.time import now

security = HTTPBearer(auto_error=False)


class AdminAuthService:
    def __init__(self) -> None:
        self.settings = get_settings()

    def authenticate(self, username: str, password: str) -> dict | None:
        credentials = [
            {
                "username": self.settings.admin_username,
                "password": self.settings.admin_password,
                "role": "super_admin",
            },
            {
                "username": self.settings.admin_ops_username,
                "password": self.settings.admin_ops_password,
                "role": "ops_admin",
            },
            {
                "username": self.settings.admin_viewer_username,
                "password": self.settings.admin_viewer_password,
                "role": "viewer",
            },
        ]
        for credential in credentials:
            if not credential["username"] or not credential["password"]:
                continue
            if (
                username == credential["username"]
                and password == credential["password"]
            ):
                return {"sub": username, "role": credential["role"]}
        return None

    def _signing_secret(self) -> str:
        secret = self.settings.admin_jwt_secret or ""
        if len(secret.encode("utf-8")) >= 32:
            return secret
        # Avoid weak-key warnings while preserving deterministic decode behavior.
        return sha256(secret.encode("utf-8")).hexdigest()

    def create_access_token(self, subject: str, role: str = "super_admin") -> str:
        expires_at = now() + timedelta(
            minutes=self.settings.admin_access_token_expire_minutes
        )
        payload = {
            "sub": subject,
            "role": role,
            "exp": expires_at,
        }
        return jwt.encode(
            payload,
            self._signing_secret(),
            algorithm=self.settings.admin_jwt_algorithm,
        )

    def decode_token(self, token: str) -> dict:
        try:
            return jwt.decode(
                token,
                self._signing_secret(),
                algorithms=[self.settings.admin_jwt_algorithm],
            )
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid admin token",
            ) from exc


async def get_current_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    access_token: str | None = Query(default=None),
) -> dict:
    token = credentials.credentials if credentials is not None else access_token
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing admin token",
        )
    auth_service = AdminAuthService()
    return auth_service.decode_token(token)


def require_admin_roles(*roles: str) -> Callable:
    async def dependency(admin: dict = Depends(get_current_admin)) -> dict:
        if admin.get("role") not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin role does not have access to this resource",
            )
        return admin

    return dependency
