# Architecture — Universal MCP Orchestration Hub

## 1. System Overview

The Universal MCP Orchestration Hub is a **universal capability plane** that sits between AI clients and the diverse ecosystem of tools, services, APIs, agents, and execution environments they need to operate. Rather than forcing static, manual tool configuration, the hub dynamically discovers capabilities, provisions them on demand, normalizes requests across protocol variants, enforces policy and trust boundaries, and routes work to the best available provider.

The platform is designed to be deployed as a single-node HTTP service (development), a Docker Compose multi-service stack (team environments), or a horizontally scaled cluster (enterprise). The same codebase serves all three with configuration-only changes.

---

## 2. Component Map

| Directory | Responsibility | Key Classes / Files | External Dependencies |
|---|---|---|---|
| `src/core/` | HTTP server lifecycle, MCP transport, graceful shutdown | `Server`, `RuntimeManager`, `Lifecycle` | Express, @modelcontextprotocol/sdk |
| `src/types/` | Shared TypeScript interfaces and enums | `NormalizedRequest`, `CapabilityDescriptor`, `AuditEntry`, etc. | zod |
| `src/normalization/` | Request normalization + per-protocol adapters | `RequestNormalizer`, `JsonRpcAdapter`, `RestAdapter`, `GraphQLAdapter`, `McpAdapter` | zod |
| `src/discovery/` | Registry connectors + multi-source discovery manager | `RegistryManager`, `GithubRegistry`, `OfficialRegistry`, `EnterpriseCatalog`, `LocalScanner` | axios, node-cache |
| `src/provisioning/` | Package installation, dependency resolution, runtime registrar | `Installer`, `DependencyResolver`, `RuntimeRegistrar`, `ConfigGenerator` | node:child_process |
| `src/routing/` | Provider selection, scheduling, capability matching | `ProviderRouter`, `Scheduler`, `CapabilitySelector` | — |
| `src/policy/` | Policy rule evaluation, trust scoring, approval gates | `PolicyEngine`, `TrustEvaluator`, `ApprovalGates` | zod, node:fs |
| `src/security/` | Cryptography, audit logging, credential broker, secret store | `CryptoUtils`, `AuditLogger`, `CredentialBroker`, `SecretStore` | node:crypto, jsonwebtoken |
| `src/orchestration/` | DAG task graph, multi-agent routing, workflow execution engine | `TaskGraph`, `AgentRouter`, `ExecutionPlanner`, `WorkflowEngine` | p-queue |
| `src/observability/` | Structured logging, metrics, tracing, cost monitoring | `Logger`, `Metrics`, `Tracing`, `CostMonitor` | winston, winston-daily-rotate-file |
| `src/adapters/` | Per-protocol adapters (MCP, REST, GraphQL, CLI, Events) | `MCPAdapter`, `RestAdapter`, `GraphQLAdapter`, `CliAdapter`, `EventsAdapter` | axios, @modelcontextprotocol/sdk |
| `src/api/` | Admin API, health checks, status endpoints | `adminRouter`, `healthRouter`, `statusRouter` | express, jsonwebtoken, zod |

---

## 3. Request Lifecycle

```
Client Request
    │
    ▼
[1] Transport Layer
    HTTP/REST (always on)
    MCP stdio (if MCP_TRANSPORT=stdio)
    MCP SSE   (if MCP_TRANSPORT=sse)
    │
    ▼
[2] Request Normalization
    RequestNormalizer selects the appropriate IProtocolAdapter
    (json-rpc, rest, graphql, mcp) and produces a NormalizedRequest
    │
    ▼
[3] Policy Evaluation
    PolicyEngine evaluates the request against active policy rules
    TrustEvaluator assigns a trust score to the requested tool
    If risk is HIGH: ApprovalGates may require human confirmation
    │
    ▼
[4] Capability Selection
    CapabilitySelector identifies the best registered tool/adapter
    If not found: RegistryManager triggers discovery
    If not installed: Installer provisions it
    │
    ▼
[5] Execution Planning
    ExecutionPlanner builds a DAG of steps from the request
    ProviderRouter selects the optimal AI provider
    Circuit breaker state checked per provider
    │
    ▼
[6] Execution
    WorkflowEngine or direct tool invocation
    Retry with exponential backoff on failure
    Cost events recorded by CostMonitor
    │
    ▼
[7] Response
    Result denormalized to client's expected format
    Audit entry written by AuditLogger
    Metrics updated
```

---

## 4. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         AI Client (MCP / HTTP)                       │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │    Transport Layer         │
                    │  (stdio / SSE / HTTP)      │
                    └───────────┬──────────────┘
                                │ NormalizedRequest
                    ┌───────────▼──────────────┐
                    │    Policy Engine           │
                    │    Trust Evaluator         │
                    └───────────┬──────────────┘
                                │ approved / denied
          ┌─────────────────────▼──────────────────────────┐
          │               Registry Manager                   │
          │  GitHub ▶ Official ▶ Enterprise ▶ Local         │
          └─────────────────────┬──────────────────────────┘
                                │ DiscoveredTool
          ┌─────────────────────▼──────────────────────────┐
          │               Installer / Provisioner            │
          │          + CredentialBroker injection            │
          └─────────────────────┬──────────────────────────┘
                                │ registered CapabilityDescriptor
          ┌─────────────────────▼──────────────────────────┐
          │           ProviderRouter + Scheduler             │
          │         Circuit Breaker per provider             │
          └─────────────────────┬──────────────────────────┘
                                │
          ┌─────────────────────▼──────────────────────────┐
          │         WorkflowEngine / Direct Execution        │
          │   Retry ▶ DLQ ▶ AuditLog ▶ CostMonitor         │
          └─────────────────────┬──────────────────────────┘
                                │ NormalizedResult
                    ┌───────────▼──────────────┐
                    │   Denormalization Layer    │
                    │  (protocol-specific)       │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │       Client Response      │
                    └──────────────────────────┘
```

---

## 5. Module Interfaces

### `IRegistryConnector`
```typescript
interface IRegistryConnector {
  readonly source: RegistrySource;
  readonly name: string;
  isEnabled(): boolean;
  discover(query?: string): Promise<DiscoveredTool[]>;
}
```
Implemented by: `GithubRegistryConnector`, `OfficialRegistryConnector`, `EnterpriseCatalogConnector`, `LocalScannerConnector`.

### `IProtocolAdapter`
```typescript
interface IProtocolAdapter {
  readonly protocol: string;
  normalize(raw: unknown): NormalizedRequest;
  denormalize(result: NormalizedResult): unknown;
}
```
Implemented by: `JsonRpcProtocolAdapter`, `RestProtocolAdapter`, `GraphQLProtocolAdapter`, `McpProtocolAdapter`.

### `IAdapter`
```typescript
interface IAdapter {
  readonly name: string;
  readonly protocol: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}
```
Implemented by: `MCPAdapter`, `CliAdapter`, `EventsAdapter`, `GraphQLAdapter`.

---

## 6. Extension Points

### Adding a New Registry Connector
1. Create `src/discovery/<name>-connector.ts`
2. Implement `IRegistryConnector`
3. Register in `src/discovery/registry-manager.ts` conditional on the appropriate config flag
4. Add the config flag to `src/config.ts` and `.env.example`

### Adding a New Protocol Adapter
1. Create `src/normalization/protocol-adapters/<protocol>.ts`
2. Implement `IProtocolAdapter`
3. Register in `src/normalization/request-normalizer.ts`

### Adding a New Tool Adapter
1. Create `src/adapters/<protocol>/index.ts`
2. Implement `IAdapter`
3. Register the adapter's routes in `src/core/server.ts`
4. Add any env vars to `src/config.ts` and `.env.example`

### Adding a Policy Pack
1. Create a JSON file in `policies/` following the policy schema
2. The `PolicyEngine` hot-reloads from this directory (watches for changes)
3. No restart required

---

## 7. Deployment Topologies

### Local Development
```bash
npm run dev
# Starts Express on PORT=3000, MCP_TRANSPORT=http
```

### Docker Single-Node
```bash
docker build -t mcp-hub .
docker run -p 3000:3000 --env-file .env mcp-hub
```

### Docker Compose (Recommended for Team Use)
```bash
docker compose up
# Starts hub + Redis; health checks configure readiness
```

### Kubernetes (Future)
See `docs/deployment.md` for starter manifests including Deployment, Service, ConfigMap, and HPA.
