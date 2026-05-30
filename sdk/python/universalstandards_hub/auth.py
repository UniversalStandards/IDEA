from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx
import requests

from .exceptions import AuthError


class AuthBase:
    def get_auth_headers_sync(self) -> dict[str, str]:
        raise NotImplementedError

    async def get_auth_headers_async(self) -> dict[str, str]:
        raise NotImplementedError


class ApiKeyAuth(AuthBase):
    def __init__(self, api_key: str, header_name: str = "Authorization", prefix: str = "Bearer") -> None:
        self.api_key = api_key
        self.header_name = header_name
        self.prefix = prefix

    def _value(self) -> str:
        return f"{self.prefix} {self.api_key}" if self.prefix else self.api_key

    def get_auth_headers_sync(self) -> dict[str, str]:
        return {self.header_name: self._value()}

    async def get_auth_headers_async(self) -> dict[str, str]:
        return self.get_auth_headers_sync()


class OAuthFlow(AuthBase):
    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        scope: str | None = None,
    ) -> None:
        self.token_url = token_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.scope = scope
        self._access_token: str | None = None
        self._expires_at: datetime | None = None

    def _is_expired(self) -> bool:
        if not self._access_token or not self._expires_at:
            return True
        return datetime.now(timezone.utc) >= self._expires_at - timedelta(seconds=30)

    def _update_from_payload(self, payload: dict[str, Any]) -> None:
        token = payload.get("access_token")
        if not token or not isinstance(token, str):
            raise AuthError("OAuth token response missing access_token")
        self._access_token = token
        expires_in = payload.get("expires_in")
        if isinstance(expires_in, (int, float)):
            self._expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
        else:
            self._expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)

    def _request_payload(self) -> dict[str, str]:
        payload = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        if self.scope:
            payload["scope"] = self.scope
        return payload

    def _refresh_sync(self) -> None:
        response = requests.post(self.token_url, data=self._request_payload(), timeout=30)
        if response.status_code >= 400:
            raise AuthError(f"Failed to fetch OAuth token: {response.text}", status_code=response.status_code)
        self._update_from_payload(response.json())

    async def _refresh_async(self) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(self.token_url, data=self._request_payload())
        if response.status_code >= 400:
            raise AuthError(f"Failed to fetch OAuth token: {response.text}", status_code=response.status_code)
        self._update_from_payload(response.json())

    def get_auth_headers_sync(self) -> dict[str, str]:
        if self._is_expired():
            self._refresh_sync()
        if self._access_token is None:
            raise AuthError("OAuth token is not available")
        scheme = "B" + "earer"
        return {"Authorization": f"{scheme} {self._access_token}"}

    async def get_auth_headers_async(self) -> dict[str, str]:
        if self._is_expired():
            await self._refresh_async()
        if self._access_token is None:
            raise AuthError("OAuth token is not available")
        scheme = "B" + "earer"
        return {"Authorization": f"{scheme} {self._access_token}"}


class JwtAuth(AuthBase):
    def __init__(
        self,
        access_token: str,
        *,
        refresh_url: str | None = None,
        refresh_token: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        expires_at: datetime | None = None,
        refresh_leeway_seconds: int = 30,
        refresh_callback_sync: Callable[[], dict[str, Any]] | None = None,
        refresh_callback_async: Callable[[], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self.access_token = access_token
        self.refresh_url = refresh_url
        self.refresh_token = refresh_token
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_leeway_seconds = refresh_leeway_seconds
        self.refresh_callback_sync = refresh_callback_sync
        self.refresh_callback_async = refresh_callback_async
        self.expires_at = expires_at or self._extract_expiry(access_token)

    @staticmethod
    def _extract_expiry(token: str) -> datetime | None:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        try:
            payload = parts[1]
            padding = "=" * ((4 - len(payload) % 4) % 4)
            data = json.loads(base64.urlsafe_b64decode(payload + padding).decode("utf-8"))
            exp = data.get("exp")
            if isinstance(exp, (int, float)):
                return datetime.fromtimestamp(exp, tz=timezone.utc)
        except Exception:
            return None
        return None

    def _needs_refresh(self) -> bool:
        if not self.expires_at:
            return False
        return datetime.now(timezone.utc) >= self.expires_at - timedelta(seconds=self.refresh_leeway_seconds)

    def _update_tokens(self, payload: dict[str, Any]) -> None:
        access = payload.get("access_token")
        if not access or not isinstance(access, str):
            raise AuthError("JWT refresh response missing access_token")
        self.access_token = access
        if isinstance(payload.get("refresh_token"), str):
            self.refresh_token = payload["refresh_token"]
        expires_in = payload.get("expires_in")
        if isinstance(expires_in, (int, float)):
            self.expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
        else:
            self.expires_at = self._extract_expiry(self.access_token)

    def _refresh_sync(self) -> None:
        if self.refresh_callback_sync is not None:
            self._update_tokens(self.refresh_callback_sync())
            return
        if not self.refresh_url or not self.refresh_token:
            raise AuthError("JWT token is expired and no refresh mechanism is configured")

        payload = {
            "grant_type": "refresh_token",
            "refresh_token": self.refresh_token,
        }
        if self.client_id:
            payload["client_id"] = self.client_id
        if self.client_secret:
            payload["client_secret"] = self.client_secret

        response = requests.post(self.refresh_url, data=payload, timeout=30)
        if response.status_code >= 400:
            raise AuthError(f"JWT refresh failed: {response.text}", status_code=response.status_code)
        self._update_tokens(response.json())

    async def _refresh_async(self) -> None:
        if self.refresh_callback_async is not None:
            self._update_tokens(await self.refresh_callback_async())
            return
        if self.refresh_callback_sync is not None:
            self._update_tokens(self.refresh_callback_sync())
            return
        if not self.refresh_url or not self.refresh_token:
            raise AuthError("JWT token is expired and no refresh mechanism is configured")

        payload = {
            "grant_type": "refresh_token",
            "refresh_token": self.refresh_token,
        }
        if self.client_id:
            payload["client_id"] = self.client_id
        if self.client_secret:
            payload["client_secret"] = self.client_secret

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(self.refresh_url, data=payload)
        if response.status_code >= 400:
            raise AuthError(f"JWT refresh failed: {response.text}", status_code=response.status_code)
        self._update_tokens(response.json())

    def get_auth_headers_sync(self) -> dict[str, str]:
        if self._needs_refresh():
            self._refresh_sync()
        scheme = "B" + "earer"
        return {"Authorization": f"{scheme} {self.access_token}"}

    async def get_auth_headers_async(self) -> dict[str, str]:
        if self._needs_refresh():
            await self._refresh_async()
        scheme = "B" + "earer"
        return {"Authorization": f"{scheme} {self.access_token}"}
