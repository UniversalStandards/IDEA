from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TransportType(str, Enum):
    HTTP = "http"
    HTTP2 = "http2"
    STDIO = "stdio"
    SSE = "sse"
    WEBSOCKET = "websocket"
    GRPC = "grpc"


class RiskLevel(str, Enum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    TIMED_OUT = "timed_out"
    AUTO_APPROVED = "auto_approved"


class ProviderType(str, Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"
    AZURE = "azure"
    LOCAL = "local"
    HUGGINGFACE = "huggingface"
    OLLAMA = "ollama"
    CUSTOM = "custom"


class RegistrySource(str, Enum):
    GITHUB = "github"
    OFFICIAL_MCP = "official-mcp"
    ENTERPRISE = "enterprise"
    LOCAL = "local"
    CUSTOM = "custom"


class WorkflowStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    WAITING_APPROVAL = "waiting_approval"


class CapabilityDescriptor(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: str
    version: str
    description: str
    sources: list[RegistrySource]
    tags: list[str]
    trust_score: float = Field(alias="trustScore")
    risk_level: RiskLevel = Field(alias="riskLevel")
    provider_type: ProviderType | None = Field(default=None, alias="providerType")
    install_path: str | None = Field(default=None, alias="installPath")
    config_schema: dict[str, Any] | None = Field(default=None, alias="configSchema")
    dependencies: list[str]
    registered_at: datetime = Field(alias="registeredAt")
    last_verified_at: datetime = Field(alias="lastVerifiedAt")


class WorkflowStep(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: str
    tool_id: str = Field(alias="toolId")
    params: dict[str, Any]
    depends_on: list[str] = Field(alias="dependsOn")
    timeout_ms: int | None = Field(default=None, alias="timeoutMs")


class RetryPolicy(BaseModel):
    model_config = ConfigDict(extra="allow")

    max_retries: int = Field(alias="maxRetries")
    initial_delay_ms: int = Field(alias="initialDelayMs")
    backoff_multiplier: float = Field(alias="backoffMultiplier")
    max_delay_ms: int = Field(alias="maxDelayMs")


class WorkflowDefinition(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: str
    description: str | None = None
    steps: list[WorkflowStep]
    timeout: int | None = None


class WorkflowState(BaseModel):
    model_config = ConfigDict(extra="allow")

    workflow_id: str = Field(alias="workflowId")
    status: WorkflowStatus
    current_step_id: str | None = Field(default=None, alias="currentStepId")
    completed_steps: list[str] = Field(alias="completedSteps")
    failed_steps: list[str] = Field(alias="failedSteps")
    results: dict[str, Any]
    started_at: datetime = Field(alias="startedAt")
    updated_at: datetime = Field(alias="updatedAt")
    error: str | None = None


class HealthCheckResult(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: str
    latency_ms: float | None = Field(default=None, alias="latencyMs")
    message: str | None = None


class HealthStatus(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: str
    version: str
    node_version: str = Field(alias="nodeVersion")
    environment: str
    uptime_seconds: float = Field(alias="uptimeSeconds")
    timestamp: datetime
    checks: dict[str, HealthCheckResult]


class TenantQuota(BaseModel):
    model_config = ConfigDict(extra="allow")

    max_requests_per_minute: int = Field(alias="maxRequestsPerMinute")
    max_members: int = Field(alias="maxMembers")
    max_workspaces: int = Field(alias="maxWorkspaces")


class Tenant(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: str
    status: str
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
    quota: TenantQuota | None = None


class StreamEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    event: str = "message"
    data: Any = None
    id: str | None = None
    retry: int | None = None


class CapabilitySearchResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    tools: list[CapabilityDescriptor]
    count: int


class CapabilityListResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    tools: list[dict[str, Any]]
    count: int


class WorkflowRunResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    success: bool = True
    workflow_id: str | None = Field(default=None, alias="workflowId")
    status: str | None = None
    request_id: str | None = Field(default=None, alias="requestId")


class GenericMessageResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    message: str | None = None
    success: bool | None = None
