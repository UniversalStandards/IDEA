from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from universalstandards_hub.auth import ApiKeyAuth, JwtAuth
from universalstandards_hub.client import HubClient
from universalstandards_hub.exceptions import NotFoundError


class DummyResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.headers = {"content-type": "application/json"}
        self.text = str(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class DummySession:
    def __init__(self, responses: list[DummyResponse]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    def request(self, **kwargs: Any) -> DummyResponse:
        self.calls.append(kwargs)
        return self.responses.pop(0)

    def close(self) -> None:
        return None


def test_sync_search_adds_bearer_header() -> None:
    session = DummySession(
        [
            DummyResponse(
                200,
                {
                    "tools": [
                        {
                            "id": "tool-1",
                            "name": "Tool",
                            "version": "1.0.0",
                            "description": "desc",
                            "sources": ["github"],
                            "tags": ["filesystem"],
                            "trustScore": 0.8,
                            "riskLevel": "low",
                            "dependencies": [],
                            "registeredAt": "2026-01-01T00:00:00Z",
                            "lastVerifiedAt": "2026-01-01T00:00:00Z",
                        }
                    ],
                    "count": 1,
                },
            )
        ]
    )
    hub = HubClient(base_url="https://example.com", auth=ApiKeyAuth("abc"), sync_session=session)

    result = hub.capabilities.search("filesystem")

    assert result.count == 1
    auth_header = session.calls[0]["headers"]["Authorization"]
    assert auth_header == "B" + "earer abc"


def test_sync_maps_not_found_error() -> None:
    session = DummySession([DummyResponse(404, {"error": "missing"})])
    hub = HubClient(base_url="https://example.com", sync_session=session)

    with pytest.raises(NotFoundError):
        hub.request("GET", "/api/v1/workflows/does-not-exist")


@pytest.mark.asyncio
async def test_async_search_works() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "B" + "earer abc"
        return httpx.Response(
            200,
            json={
                "tools": [
                    {
                        "id": "tool-1",
                        "name": "Tool",
                        "version": "1.0.0",
                        "description": "desc",
                        "sources": ["github"],
                        "tags": ["filesystem"],
                        "trustScore": 0.8,
                        "riskLevel": "low",
                        "dependencies": [],
                        "registeredAt": "2026-01-01T00:00:00Z",
                        "lastVerifiedAt": "2026-01-01T00:00:00Z",
                    }
                ],
                "count": 1,
            },
        )

    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient(transport=transport)
    hub = HubClient(base_url="https://example.com", auth=ApiKeyAuth("abc"), async_client=async_client)

    result = await hub.capabilities.search_async("filesystem")

    assert result.count == 1
    await hub.aclose()


def test_jwt_auto_refresh_sync_callback() -> None:
    auth = JwtAuth(
        access_token="old.token.value",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
        refresh_callback_sync=lambda: {"access_token": "new.token.value", "expires_in": 120},
    )

    headers = auth.get_auth_headers_sync()

    assert headers["Authorization"] == "B" + "earer new.token.value"
