from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import websockets
from httpx_sse import aconnect_sse

from .exceptions import HubError
from .types import StreamEvent


class StreamClient:
    def __init__(self, hub: Any) -> None:
        self._hub = hub

    @asynccontextmanager
    async def _connect_sse(
        self,
        endpoint: str,
        *,
        headers: dict[str, str],
        params: dict[str, Any] | None,
    ) -> Any:
        async with aconnect_sse(
            self._hub._async_client,
            method="GET",
            url=self._hub._full_url(endpoint),
            headers=headers,
            params=params,
        ) as event_source:
            yield event_source

    async def subscribe(
        self,
        endpoint: str = "/api/v1/stream",
        *,
        params: dict[str, Any] | None = None,
        reconnect_attempts: int = 3,
        reconnect_delay: float = 0.2,
    ) -> AsyncGenerator[StreamEvent, None]:
        last_event_id: str | None = None
        attempt = 0

        while True:
            headers = await self._hub._async_headers()
            if last_event_id:
                headers["Last-Event-ID"] = last_event_id

            try:
                async with self._connect_sse(endpoint, headers=headers, params=params) as event_source:
                    async for event in event_source.aiter_sse():
                        attempt = 0
                        data: Any = event.data
                        if isinstance(data, str):
                            try:
                                data = json.loads(data)
                            except json.JSONDecodeError:
                                pass
                        stream_event = StreamEvent(
                            event=event.event or "message",
                            data=data,
                            id=event.id,
                            retry=event.retry,
                        )
                        if stream_event.id:
                            last_event_id = stream_event.id
                        yield stream_event
                    return
            except Exception as exc:
                attempt += 1
                if attempt > reconnect_attempts:
                    raise HubError("SSE subscription failed after retries", details=str(exc)) from exc
                await asyncio.sleep(reconnect_delay * attempt)

    async def subscribe_websocket(
        self,
        websocket_url: str,
        *,
        reconnect_attempts: int = 3,
        reconnect_delay: float = 0.2,
    ) -> AsyncGenerator[StreamEvent, None]:
        attempt = 0

        while True:
            try:
                async with websockets.connect(websocket_url) as ws:
                    attempt = 0
                    async for payload in ws:
                        data: Any = payload
                        if isinstance(payload, str):
                            try:
                                data = json.loads(payload)
                            except json.JSONDecodeError:
                                pass
                        yield StreamEvent(event="message", data=data)
                    return
            except Exception as exc:
                attempt += 1
                if attempt > reconnect_attempts:
                    raise HubError("WebSocket subscription failed after retries", details=str(exc)) from exc
                await asyncio.sleep(reconnect_delay * attempt)
