from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from .types import GenericMessageResponse, StreamEvent, WorkflowRunResponse


class _WorkflowStreamContext:
    def __init__(self, stream: AsyncGenerator[StreamEvent, None]) -> None:
        self._stream = stream

    async def __aenter__(self) -> AsyncGenerator[StreamEvent, None]:
        return self._stream

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self._stream.aclose()


class WorkflowClient:
    def __init__(self, hub: Any) -> None:
        self._hub = hub

    def run(self, workflow_id: str, *, input: dict[str, Any] | None = None) -> WorkflowRunResponse:
        response = self._hub.request("POST", f"/api/v1/workflows/{workflow_id}/trigger", json=input or {})
        return WorkflowRunResponse.model_validate(response)

    async def run_async(self, workflow_id: str, *, input: dict[str, Any] | None = None) -> WorkflowRunResponse:
        response = await self._hub.request_async(
            "POST", f"/api/v1/workflows/{workflow_id}/trigger", json=input or {}
        )
        return WorkflowRunResponse.model_validate(response)

    def list(self) -> GenericMessageResponse:
        response = self._hub.request("GET", "/api/v1/workflows")
        return GenericMessageResponse.model_validate(response)

    async def list_async(self) -> GenericMessageResponse:
        response = await self._hub.request_async("GET", "/api/v1/workflows")
        return GenericMessageResponse.model_validate(response)

    def cancel(self, run_id: str) -> GenericMessageResponse:
        response = self._hub.request("POST", f"/api/v1/workflows/{run_id}/cancel")
        return GenericMessageResponse.model_validate(response)

    async def cancel_async(self, run_id: str) -> GenericMessageResponse:
        response = await self._hub.request_async("POST", f"/api/v1/workflows/{run_id}/cancel")
        return GenericMessageResponse.model_validate(response)

    def get_status(self, run_id: str) -> WorkflowRunResponse:
        response = self._hub.request("GET", f"/api/v1/workflows/{run_id}")
        return WorkflowRunResponse.model_validate(response)

    async def get_status_async(self, run_id: str) -> WorkflowRunResponse:
        response = await self._hub.request_async("GET", f"/api/v1/workflows/{run_id}")
        return WorkflowRunResponse.model_validate(response)

    def run_stream(
        self,
        workflow_id: str,
        *,
        input: dict[str, Any] | None = None,
        reconnect_attempts: int = 3,
        reconnect_delay: float = 0.2,
    ) -> _WorkflowStreamContext:
        params: dict[str, Any] = {}
        if input:
            params["input"] = input
        stream = self._hub.streaming.subscribe(
            f"/api/v1/workflows/{workflow_id}/stream",
            params=params,
            reconnect_attempts=reconnect_attempts,
            reconnect_delay=reconnect_delay,
        )
        return _WorkflowStreamContext(stream)
