from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest

from universalstandards_hub.client import HubClient


class FakeSSE:
    def __init__(self, event: str, data: str, event_id: str | None = None) -> None:
        self.event = event
        self.data = data
        self.id = event_id
        self.retry = None


class FakeEventSource:
    def __init__(self, events: list[FakeSSE]) -> None:
        self.events = events

    async def __aenter__(self) -> "FakeEventSource":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    async def aiter_sse(self):
        for event in self.events:
            yield event


@pytest.mark.asyncio
async def test_stream_reconnects_once(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}

    @asynccontextmanager
    async def fake_connect_sse(*args: Any, **kwargs: Any):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("temporary network drop")
        yield FakeEventSource([FakeSSE("message", '{"ok": true}', "abc")])

    hub = HubClient(base_url="https://example.com", async_client=httpx.AsyncClient())

    monkeypatch.setattr(hub.streaming, "_connect_sse", fake_connect_sse)
    stream = hub.streaming.subscribe(reconnect_attempts=1, reconnect_delay=0)
    first = await anext(stream)

    assert first.data == {"ok": True}
    assert attempts["count"] == 2
    await stream.aclose()
    await hub.aclose()
