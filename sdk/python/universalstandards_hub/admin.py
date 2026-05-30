from __future__ import annotations

from typing import Any

from .types import GenericMessageResponse, HealthStatus, Tenant, TenantQuota


class AdminClient:
    def __init__(self, hub: Any) -> None:
        self._hub = hub

    def list_tenants(self) -> list[Tenant]:
        response = self._hub.request("GET", "/admin/tenants")
        tenants = response.get("tenants", response)
        return [Tenant.model_validate(item) for item in tenants]

    async def list_tenants_async(self) -> list[Tenant]:
        response = await self._hub.request_async("GET", "/admin/tenants")
        tenants = response.get("tenants", response)
        return [Tenant.model_validate(item) for item in tenants]

    def get_tenant(self, tenant_id: str) -> Tenant:
        response = self._hub.request("GET", f"/admin/tenants/{tenant_id}")
        return Tenant.model_validate(response)

    async def get_tenant_async(self, tenant_id: str) -> Tenant:
        response = await self._hub.request_async("GET", f"/admin/tenants/{tenant_id}")
        return Tenant.model_validate(response)

    def create_tenant(self, payload: dict[str, Any]) -> Tenant:
        response = self._hub.request("POST", "/admin/tenants", json=payload)
        return Tenant.model_validate(response)

    async def create_tenant_async(self, payload: dict[str, Any]) -> Tenant:
        response = await self._hub.request_async("POST", "/admin/tenants", json=payload)
        return Tenant.model_validate(response)

    def update_tenant(self, tenant_id: str, payload: dict[str, Any]) -> Tenant:
        response = self._hub.request("PUT", f"/admin/tenants/{tenant_id}", json=payload)
        return Tenant.model_validate(response)

    async def update_tenant_async(self, tenant_id: str, payload: dict[str, Any]) -> Tenant:
        response = await self._hub.request_async("PUT", f"/admin/tenants/{tenant_id}", json=payload)
        return Tenant.model_validate(response)

    def delete_tenant(self, tenant_id: str) -> GenericMessageResponse:
        response = self._hub.request("DELETE", f"/admin/tenants/{tenant_id}")
        return GenericMessageResponse.model_validate(response)

    async def delete_tenant_async(self, tenant_id: str) -> GenericMessageResponse:
        response = await self._hub.request_async("DELETE", f"/admin/tenants/{tenant_id}")
        return GenericMessageResponse.model_validate(response)

    def update_quota(self, tenant_id: str, quota: TenantQuota | dict[str, Any]) -> TenantQuota:
        payload = quota.model_dump(by_alias=True) if isinstance(quota, TenantQuota) else quota
        response = self._hub.request("PUT", f"/admin/tenants/{tenant_id}/quota", json=payload)
        return TenantQuota.model_validate(response)

    async def update_quota_async(self, tenant_id: str, quota: TenantQuota | dict[str, Any]) -> TenantQuota:
        payload = quota.model_dump(by_alias=True) if isinstance(quota, TenantQuota) else quota
        response = await self._hub.request_async("PUT", f"/admin/tenants/{tenant_id}/quota", json=payload)
        return TenantQuota.model_validate(response)

    def health(self) -> HealthStatus:
        response = self._hub.request("GET", "/status")
        return HealthStatus.model_validate(response)

    async def health_async(self) -> HealthStatus:
        response = await self._hub.request_async("GET", "/status")
        return HealthStatus.model_validate(response)
