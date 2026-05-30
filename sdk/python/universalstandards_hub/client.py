from __future__ import annotations

from typing import Any

import httpx
import requests

from .admin import AdminClient
from .auth import ApiKeyAuth, AuthBase
from .capabilities import CapabilityClient
from .exceptions import HubError, map_http_error
from .streaming import StreamClient
from .workflows import WorkflowClient


class HubClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        auth: AuthBase | None = None,
        timeout: float = 30.0,
        sync_session: requests.Session | None = None,
        async_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        if auth is None and api_key:
            auth = ApiKeyAuth(api_key)
        self.auth = auth

        self._sync_session = sync_session or requests.Session()
        self._async_client = async_client or httpx.AsyncClient(timeout=timeout)

        self.capabilities = CapabilityClient(self)
        self.workflows = WorkflowClient(self)
        self.streaming = StreamClient(self)
        self.admin = AdminClient(self)

    def _full_url(self, path: str) -> str:
        return path if path.startswith("http://") or path.startswith("https://") else f"{self.base_url}{path}"

    def _parse_body(self, response: requests.Response | httpx.Response) -> Any:
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        text = response.text
        return {"message": text} if text else {}

    def _raise_for_error(self, status_code: int, body: Any) -> None:
        if status_code < 400:
            return
        if isinstance(body, dict):
            message = str(body.get("error") or body.get("message") or f"HTTP {status_code}")
        else:
            message = f"HTTP {status_code}"
        raise map_http_error(status_code, message, body)

    def _sync_headers(self, extra_headers: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.auth:
            headers.update(self.auth.get_auth_headers_sync())
        if extra_headers:
            headers.update(extra_headers)
        return headers

    async def _async_headers(self, extra_headers: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.auth:
            headers.update(await self.auth.get_auth_headers_async())
        if extra_headers:
            headers.update(extra_headers)
        return headers

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        response = self._sync_session.request(
            method=method,
            url=self._full_url(path),
            params=params,
            json=json,
            headers=self._sync_headers(headers),
            timeout=self.timeout,
        )
        body = self._parse_body(response)
        self._raise_for_error(response.status_code, body)
        return body

    async def request_async(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        response = await self._async_client.request(
            method=method,
            url=self._full_url(path),
            params=params,
            json=json,
            headers=await self._async_headers(headers),
            timeout=self.timeout,
        )
        body = self._parse_body(response)
        self._raise_for_error(response.status_code, body)
        return body

    def close(self) -> None:
        self._sync_session.close()

    async def aclose(self) -> None:
        await self._async_client.aclose()

    def __enter__(self) -> "HubClient":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    async def __aenter__(self) -> "HubClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()


__all__ = ["HubClient", "HubError"]
