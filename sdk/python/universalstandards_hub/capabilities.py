from __future__ import annotations

from typing import Any

from .types import CapabilityListResponse, CapabilitySearchResponse, GenericMessageResponse


class CapabilityClient:
    def __init__(self, hub: Any) -> None:
        self._hub = hub

    def search(self, query: str, *, tags: list[str] | None = None, limit: int | None = None) -> CapabilitySearchResponse:
        body: dict[str, Any] = {"query": query}
        if tags is not None:
            body["tags"] = tags
        if limit is not None:
            body["limit"] = limit
        response = self._hub.request("POST", "/api/v1/tools/search", json=body)
        return CapabilitySearchResponse.model_validate(response)

    async def search_async(
        self, query: str, *, tags: list[str] | None = None, limit: int | None = None
    ) -> CapabilitySearchResponse:
        body: dict[str, Any] = {"query": query}
        if tags is not None:
            body["tags"] = tags
        if limit is not None:
            body["limit"] = limit
        response = await self._hub.request_async("POST", "/api/v1/tools/search", json=body)
        return CapabilitySearchResponse.model_validate(response)

    def install(self, capability_id: str) -> GenericMessageResponse:
        response = self._hub.request("POST", f"/api/v1/tools/{capability_id}/install")
        return GenericMessageResponse.model_validate(response)

    async def install_async(self, capability_id: str) -> GenericMessageResponse:
        response = await self._hub.request_async("POST", f"/api/v1/tools/{capability_id}/install")
        return GenericMessageResponse.model_validate(response)

    def list(self) -> CapabilityListResponse:
        response = self._hub.request("GET", "/api/v1/tools/installed")
        return CapabilityListResponse.model_validate(response)

    async def list_async(self) -> CapabilityListResponse:
        response = await self._hub.request_async("GET", "/api/v1/tools/installed")
        return CapabilityListResponse.model_validate(response)

    def invoke(self, tool_id: str, action: str, *, params: dict[str, Any] | None = None) -> GenericMessageResponse:
        response = self._hub.request(
            "POST",
            "/api/v1/execute",
            json={"toolId": tool_id, "action": action, "params": params or {}},
        )
        return GenericMessageResponse.model_validate(response)

    async def invoke_async(
        self, tool_id: str, action: str, *, params: dict[str, Any] | None = None
    ) -> GenericMessageResponse:
        response = await self._hub.request_async(
            "POST",
            "/api/v1/execute",
            json={"toolId": tool_id, "action": action, "params": params or {}},
        )
        return GenericMessageResponse.model_validate(response)
