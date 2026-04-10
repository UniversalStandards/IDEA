# AGENTS.md — Universal MCP Orchestration Hub
## GitHub Codex Instruction Manifest

> **Audience**: AI coding agents (GitHub Codex, Copilot Workspace, Claude Code, Cursor, etc.)  
> **Authority**: This file is the single source of truth for all automated and AI-assisted work on this repository.  
> **Last updated**: 2026-04-09  
> **Status**: Active — read this file in full before touching any code.

---

## 0. GROUND RULES FOR ALL AGENTS

1. **Never commit directly to `main` for feature work.** Open a branch using the convention: `fix/<scope>`, `feat/<scope>`, `chore/<scope>`, `docs/<scope>`, `test/<scope>`.
2. **Never push a commit that breaks `npm run typecheck` or `npm run test`.** If a task cannot be completed without temporarily breaking tests, document exactly why in the PR description.
3. **Every new source file MUST have a corresponding test file** under `tests/` unless it is an entry-point (`index.ts`) or a pure type-definition file.
4. **Never introduce any `any` type without an explanatory comment.** Use `unknown` and narrow explicitly.
5. **Never store secrets, tokens, or credentials in source files.** All secrets must flow through `src/config.ts` via environment variables validated by Zod.
6. **All imports must use relative paths or the `@`-prefixed path aliases** defined in `tsconfig.json`. Do not use deep relative imports (`../../../../`).
7. **Follow Conventional Commits** for all commit messages: `<type>(<scope>): <description>`. Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`.
8. **Every PR must pass all status checks** defined in `.github/workflows/` before merge is permitted.
9. **Do not remove or modify** `AGENTS.md`, `SECURITY.md`, or `LICENSE` without explicit human approval.
10. **Language is TypeScript only.** Do not introduce JavaScript source files under `src/`. JavaScript is permitted only in root config files (e.g., `eslint.config.js`).

---

## 1. CRITICAL FIXES — MUST BE RESOLVED IMMEDIATELY

> These are blocking defects. They must be fixed before any feature work proceeds.

### 1.1 TypeScript Version — BREAKING

**File**: `package.json`  
**Problem**: `"typescript": "^6.0.2"` — TypeScript 6.x does not exist as a stable release. npm will either fail to resolve this or install a pre-release/nightly that breaks the build.  
**Fix**:
```json
"typescript": "^5.7.3"
```
Also update `tsconfig.json` to confirm no features are being used that require a non-existent version.

### 1.2 README.md License Badge — LEGAL MISMATCH

**File**: `README.md`  
**Problem**: Line 1 badge group contains `license-MIT-blue.svg` but the `LICENSE` file is Apache-2.0 and `package.json` now declares `"license": "Apache-2.0"`.  
**Fix**: Replace the MIT badge URL with:
```
https://img.shields.io/badge/license-Apache--2.0-blue.svg
```
Also add the following badges to the README badge row:
- CI status: `[![CI](https://github.com/UniversalStandards/IDEA/actions/workflows/ci.yml/badge.svg)](https://github.com/UniversalStandards/IDEA/actions/workflows/ci.yml)`
- CodeQL: `[![CodeQL](https://github.com/UniversalStandards/IDEA/actions/workflows/codeql.yml/badge.svg)](https://github.com/UniversalStandards/IDEA/actions/workflows/codeql.yml)`
- Coverage: add Codecov or Coveralls badge once integrated

### 1.3 .gitignore — Incomplete

**File**: `.gitignore`  
**Problem**: The current `.gitignore` is minimal. Many critical files are unprotected.  
**Fix**: Replace the entire file with the content listed in Section 6.1 below.

### 1.4 `ts-jest` / `jest` Version Alignment

**File**: `package.json`  
**Problem**: `ts-jest@^30.0.0` must be verified to exist as a stable release. If unavailable, pin to `^29.4.9` and pin jest to `^29.x`.  
**Action**: Run `npm info ts-jest versions --json` to confirm; align both jest and ts-jest to the same major version.

### 1.5 `dotenv` Double-Import in `config.ts`

**File**: `src/config.ts`  
**Problem**: The file imports `dotenv` as `import * as dotenv from 'dotenv'` at line 1, but `src/index.ts` also does `import 'dotenv/config'` at line 1, causing double-initialization with potentially conflicting `.env` resolution paths.  
**Fix**: Remove `import * as dotenv from 'dotenv'` and the manual `dotenv.config()` block from `src/config.ts`. Rely solely on the `import 'dotenv/config'` in `src/index.ts` which must remain as the first statement in the entry point.

### 1.6 MCP Stdio Transport in HTTP Context

**File**: `src/core/server.ts`  
**Problem**: Attaching a `StdioServerTransport` inside an HTTP server process will corrupt stdin/stdout in any non-MCP-CLI deployment (Docker, PM2, systemd, Kubernetes). The current guard (`NODE_ENV !== 'test'`) is insufficient.  
**Fix**: Gate stdio transport activation on a dedicated env var:
```typescript
if (process.env['MCP_TRANSPORT'] === 'stdio') {
  await this.mcpAdapter.connect(stdioTransport);
}
```
Add `MCP_TRANSPORT=stdio|http|sse` to `.env.example` and `src/config.ts`.

---

## 2. MISSING FILES — MUST BE CREATED

> These files do not exist. Create them exactly as specified. Each section describes the file path, purpose, and required content structure.

### 2.1 `.github/workflows/ci.yml`

**Purpose**: Primary CI pipeline. Runs on every push and pull request.  
**Required jobs** (in order):
1. `lint` — `npm run lint`
2. `typecheck` — `npm run typecheck`
3. `test` — `npm run test:ci` with Node 20.x and 22.x matrix
4. `build` — `npm run build`

**Required triggers**: `push` (branches: main, develop), `pull_request` (branches: main)

**Required setup steps for each job**:
- `actions/checkout@v4`
- `actions/setup-node@v4` with `node-version-file: '.nvmrc'` and `cache: 'npm'`
- `npm ci` (never `npm install` in CI)

**Required environment variables** (from repo secrets):
- None required for CI itself. Do not reference secret values in workflow steps.

**Artifact upload**: Upload `coverage/` directory as artifact `coverage-report` on the test job.

### 2.2 `.github/workflows/codeql.yml`

**Purpose**: Static security analysis via GitHub CodeQL.  
**Language**: `javascript-typescript`  
**Schedule**: Weekly (`cron: '0 3 * * 1'`) and on push to main.  
**Queries**: `security-and-quality`

### 2.3 `.github/workflows/release.yml`

**Purpose**: Automated release on version tag push.  
**Trigger**: `push` with `tags: ['v*.*.*']`  
**Jobs**:
1. Run full CI pipeline (lint, typecheck, test, build)
2. Create GitHub Release using `softprops/action-gh-release@v2` with auto-generated release notes
3. (Optional, no-op for now) Publish to npm — add `NPM_TOKEN` secret when ready

### 2.4 `.github/workflows/dependency-review.yml`

**Purpose**: Review dependency changes in PRs for known vulnerabilities.  
**Trigger**: `pull_request`  
**Action**: `actions/dependency-review-action@v4` with `fail-on-severity: high`

### 2.5 `.github/PULL_REQUEST_TEMPLATE.md`

**Purpose**: Enforce consistent PR descriptions.  
**Required sections**:
- `## Summary` — one paragraph description
- `## Type of Change` — checkbox list: Bug fix / New feature / Breaking change / Docs / Chore
- `## Testing` — how was this tested, what tests were added
- `## Checklist` — checkboxes: `npm run typecheck` passes, `npm run test` passes, `npm run lint` passes, docs updated if needed, `CHANGELOG.md` updated

### 2.6 `.github/ISSUE_TEMPLATE/bug_report.yml`

**Purpose**: Structured bug report form.  
**Required fields**: title, description, steps to reproduce, expected behavior, actual behavior, environment (Node version, OS, MCP Hub version), logs snippet.

### 2.7 `.github/ISSUE_TEMPLATE/feature_request.yml`

**Purpose**: Structured feature request form.  
**Required fields**: title, problem statement, proposed solution, alternatives considered, additional context.

### 2.8 `CONTRIBUTING.md`

**Purpose**: Onboarding guide for contributors.  
**Required sections**:
1. **Prerequisites** — Node >=20.0.0, npm >=10.0.0, git
2. **Local Setup** — `git clone`, `npm ci`, `cp .env.example .env`, `npm run dev`
3. **Project Structure** — map of `src/` directories to their responsibilities
4. **Development Workflow** — branch naming, commit conventions, PR process
5. **Running Tests** — `npm run test`, `npm run test:watch`, `npm run test:coverage`
6. **Code Style** — ESLint config, TypeScript strict mode, no-any policy
7. **Adding a New Module** — step-by-step: create `src/<module>/`, add `index.ts` barrel export, add test file, register in runtime if applicable
8. **Adding a New Adapter** — step-by-step: create `src/adapters/<protocol>/`, implement the `IAdapter` interface, register in `src/core/server.ts`
9. **Security** — link to `SECURITY.md`, never commit secrets, use `src/config.ts`

### 2.9 `SECURITY.md`

**Purpose**: Vulnerability disclosure policy.  
**Required sections**:
1. **Supported Versions** — table of currently supported versions with security update status
2. **Reporting a Vulnerability** — report via GitHub Security Advisories (private). Do NOT open a public issue. Response SLA: acknowledgment within 48h, resolution or workaround within 14 days.
3. **Security Architecture Overview** — brief summary of trust pipeline, credential broker, audit logging (cross-reference Section 9 of README)
4. **Dependency Policy** — automated Dependabot updates for npm, weekly CodeQL scans
5. **Hall of Fame** — placeholder for future responsible disclosure credits

### 2.10 `CHANGELOG.md`

**Purpose**: Human-readable release history.  
**Format**: Keep a Changelog (https://keepachangelog.com)  
**Initial content**:
```
# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Initial scaffold: core, discovery, provisioning, routing, policy, security, orchestration, observability, normalization, adapters modules
- MCP adapter (stdio + SSE transport)
- REST adapter with Express 5
- Zod-validated configuration with production safety guards
- Winston structured logging
- Policy engine with trust evaluator and approval gates
- Capability discovery via GitHub registry and official MCP registry
- Local workspace scanner
- Execution planner with DAG task graph
- Workflow engine with retry/recovery logic

### Fixed
- License mismatch: README badge corrected to Apache-2.0
- TypeScript version corrected from ^6.0.2 to ^5.7.3
- ts-jest aligned with Jest major version
- dotenv double-initialization removed

### Changed
- MCP stdio transport now gated on MCP_TRANSPORT=stdio env var
- tsconfig hardened with noUncheckedIndexedAccess, exactOptionalPropertyTypes, path aliases
```

### 2.11 `CODE_OF_CONDUCT.md`

**Purpose**: Community standards.  
**Use**: Contributor Covenant 2.1 verbatim (https://www.contributor-covenant.org/version/2/1/code_of_conduct/)  
**Enforcement contact**: Add `conduct@universalstandards.dev` as the reporting email placeholder.

### 2.12 `.nvmrc`

**Purpose**: Pin Node version for CI and local dev parity.  
**Content**: `20`  
(Node 20 LTS — matches `engines.node` in `package.json`)

### 2.13 `docs/architecture.md`

**Purpose**: Living architecture document.  
**Required sections**:
1. **System Overview** — high-level description of the orchestration hub and its role
2. **Component Map** — table mapping each `src/` directory to its responsibility, key classes, and external dependencies
3. **Request Lifecycle** — step-by-step walkthrough from client request → normalization → policy check → capability selection → provisioning → execution → response
4. **Data Flow Diagram** — ASCII or Mermaid diagram of data flowing between modules
5. **Module Interfaces** — list of the key exported interfaces and abstract classes each module exposes
6. **Extension Points** — how to add new adapters, registry connectors, and policy packs
7. **Deployment Topologies** — local dev, Docker single-node, Docker Compose multi-service, Kubernetes (future)

### 2.14 `docs/security.md`

**Purpose**: Technical security implementation guide.  
**Required sections**:
1. **Trust Pipeline** — detailed walkthrough of the 10-stage trust evaluation process
2. **Credential Broker** — how credentials are stored, scoped, injected, and rotated
3. **Secret Store** — in-memory store design, encryption-at-rest approach, future KMS integration path
4. **Audit Logging** — schema for audit log entries, where they are written, retention policy
5. **Network Boundaries** — egress control design, rate limiting, CORS policy
6. **Approval Gates** — synchronous vs. async approval workflows, timeout handling
7. **Key Rotation** — procedure for rotating `JWT_SECRET` and `ENCRYPTION_KEY` with zero downtime

### 2.15 `docs/api.md`

**Purpose**: REST Admin API reference.  
**Required content**: For every route in `src/api/`, document: method, path, auth required, request body schema, response schema, error codes, example curl command.

### 2.16 `docs/deployment.md`

**Purpose**: Deployment runbook.  
**Required sections**:
1. **Environment Variables Reference** — complete table of every supported env var with type, default, required flag, and description
2. **Docker** — `Dockerfile` (multi-stage, distroless final image) and `docker-compose.yml`
3. **Health Checks** — `/health` and `/health/ready` endpoint descriptions for orchestrator configuration
4. **Reverse Proxy** — nginx / Caddy / Cloudflare Tunnel example config
5. **Kubernetes** — Deployment, Service, ConfigMap, and HorizontalPodAutoscaler manifests (starter templates)
6. **Air-Gapped / Offline Mode** — how to configure with no external registry access

### 2.17 `Dockerfile`

**Purpose**: Production container image.  
**Requirements**:
- Multi-stage build: `builder` stage (node:20-slim) → `runtime` stage (node:20-slim or distroless)
- Builder: `npm ci --only=production`, `npm run build`
- Runtime: copy `dist/` and `node_modules/` only — no source files
- Run as non-root user (`UID 1001`)
- Expose port `3000`
- `HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1`
- Labels: `org.opencontainers.image.*` standard labels

### 2.18 `docker-compose.yml`

**Purpose**: Local multi-service development environment.  
**Services**:
- `hub` — the orchestration hub, built from `Dockerfile`
- `redis` — `redis:7-alpine` for future distributed caching (mount volume, expose 6379 internally only)
- Volumes: `hub-data` for runtime persistence
- Networks: `hub-net` bridge
- `hub` must declare healthcheck using `/health` endpoint

### 2.19 `.github/dependabot.yml`

**Purpose**: Automated dependency update PRs.  
**Required config**:
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "03:00"
    open-pull-requests-limit: 10
    groups:
      development-dependencies:
        dependency-type: development
      production-dependencies:
        dependency-type: production
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

---

## 3. MISSING SOURCE MODULES — MUST BE IMPLEMENTED

> These modules are referenced in the README architecture but do not exist in `src/`. Each must be implemented to production quality — no stubs, no `TODO` comments, no placeholder returns.

### 3.1 `src/discovery/enterprise-catalog.ts`

**Purpose**: Discovery connector for internal/private enterprise tool catalogs.  
**Interface**: Must implement the same `IRegistryConnector` interface used by `github-registry.ts` and `official-registry.ts`.  
**Required capabilities**:
- Connect to a catalog endpoint defined by `ENTERPRISE_CATALOG_URL` env var
- Support both JSON-over-HTTP and local file-based catalogs (file path via `ENTERPRISE_CATALOG_PATH`)
- Validate catalog schema with Zod
- Cache results using `node-cache` with TTL from `config.CACHE_TTL`
- Emit structured log entries for every discovery operation

### 3.2 `src/observability/cost-monitor.ts`

**Purpose**: Track and report per-provider AI and tool execution costs.  
**Required capabilities**:
- Record cost events: `{ provider, model, inputTokens, outputTokens, costUsd, requestId, timestamp }`
- Aggregate costs by provider, by model, by time window (hourly, daily)
- Expose `getCostSummary(windowMs: number)` method
- Expose `getCostByProvider()` and `getCostByModel()` methods
- Integrate with `metrics.ts` to emit cost metrics
- Write cost events to audit log via `audit.ts`
- Must be registered in `src/core/runtime-manager.ts`

### 3.3 `src/adapters/graphql/index.ts`

**Purpose**: Adapter exposing GraphQL API endpoints as MCP tools.  
**Required capabilities**:
- Accept a GraphQL endpoint URL and optional schema SDL string or introspection URL
- Perform schema introspection if SDL not provided
- Map each GraphQL query and mutation to an MCP tool definition
- Execute operations with variable injection
- Handle auth headers via `credential-broker.ts`
- Return normalized responses compatible with `request-normalizer.ts`

### 3.4 `src/adapters/cli/index.ts`

**Purpose**: Adapter exposing local CLI tools as MCP tools.  
**Required capabilities**:
- Accept a CLI command definition: `{ command: string, args: string[], description: string, inputSchema: ZodSchema }`
- Spawn child processes using Node.js `child_process.spawn` (never `exec` — avoid shell injection)
- Capture stdout, stderr, and exit code
- Enforce a configurable timeout (default 30s, max 300s)
- Sandbox: do not allow commands that contain shell metacharacters unless explicitly whitelisted
- Return structured `{ stdout, stderr, exitCode, duration }` results

### 3.5 `src/adapters/events/index.ts`

**Purpose**: Event-driven trigger adapter — receive webhook/SSE events and map them to orchestration workflow triggers.  
**Required capabilities**:
- HTTP webhook receiver endpoint (`POST /adapters/events/webhook`)
- Server-Sent Events (SSE) stream endpoint (`GET /adapters/events/stream`)
- Event schema validation with Zod
- Event routing table: map event type patterns to workflow IDs
- Idempotency: deduplicate events by `event-id` header within a configurable window
- Emit to audit log on every received event

### 3.6 `src/normalization/protocol-adapters/`

**Purpose**: Per-protocol normalization adapters referenced in `request-normalizer.ts`.  
**Required files**:
- `src/normalization/protocol-adapters/json-rpc.ts` — normalize JSON-RPC 2.0 requests to internal format
- `src/normalization/protocol-adapters/rest.ts` — normalize REST requests to internal format
- `src/normalization/protocol-adapters/graphql.ts` — normalize GraphQL operation requests to internal format
- `src/normalization/protocol-adapters/mcp.ts` — normalize MCP protocol variants to internal format

Each adapter must export a class implementing:
```typescript
interface IProtocolAdapter {
  readonly protocol: string;
  normalize(raw: unknown): NormalizedRequest;
  denormalize(result: NormalizedResult): unknown;
}
```

### 3.7 `src/types/index.ts`

**Purpose**: Shared TypeScript type definitions used across all modules.  
**Required exports** (currently scattered or duplicated across modules):
- `NormalizedRequest` — canonical request shape post-normalization
- `NormalizedResult` — canonical result shape post-execution
- `CapabilityDescriptor` — unified tool/capability metadata shape
- `ProviderConfig` — AI provider configuration shape
- `PolicyDecision` — result of policy engine evaluation
- `TrustScore` — numeric trust evaluation result with breakdown
- `AuditEntry` — audit log record shape
- `HealthStatus` — server health check response shape
- `ExecutionContext` — runtime context passed through execution chain
- All enums: `TransportType`, `RiskLevel`, `ApprovalStatus`, `ProviderType`, `RegistrySource`

---

## 4. ENHANCEMENTS TO EXISTING SOURCE FILES

> These files exist and are functional but require specific improvements to reach production quality.

### 4.1 `src/config.ts`

**Add the following env vars to `ConfigSchema`**:
```typescript
// Transport
MCP_TRANSPORT: z.enum(['stdio', 'http', 'sse']).default('http'),

// Enterprise catalog
ENTERPRISE_CATALOG_URL: z.string().url().optional(),
ENTERPRISE_CATALOG_PATH: z.string().optional(),

// Rate limiting
RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(300),

// Webhook / Events adapter
WEBHOOK_SECRET: z.string().optional(),
EVENT_DEDUP_WINDOW_MS: z.coerce.number().int().default(300_000),

// Cost monitoring
COST_TRACKING_ENABLED: boolEnv(true),
COST_BUDGET_DAILY_USD: z.coerce.number().nonnegative().default(0), // 0 = no limit

// Redis (future distributed caching)
REDIS_URL: z.string().url().optional(),
```

**Also fix**:
- Remove the manual `dotenv` import and initialization block (see Section 1.5)
- Add `INSECURE_DEFAULT` check for `WEBHOOK_SECRET` when `NODE_ENV === 'production'` if webhook adapter is enabled

### 4.2 `src/core/server.ts`

**Required changes**:
1. Gate stdio transport on `config.MCP_TRANSPORT === 'stdio'` (see Section 1.6)
2. Add SSE transport option: when `config.MCP_TRANSPORT === 'sse'`, attach `SSEServerTransport` to the Express app at `GET /mcp/sse`
3. Move rate-limit config to use `config.RATE_LIMIT_WINDOW_MS` and `config.RATE_LIMIT_MAX_REQUESTS` instead of hardcoded values
4. Add 404 and global error-handling middleware after route registration:
```typescript
this.app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled request error', { err });
  res.status(500).json({ error: 'Internal server error' });
});
```
5. Track server uptime start timestamp for use by `/health/ready`

### 4.3 `src/observability/logger.ts`

**Required changes**:
1. Add `winston-daily-rotate-file` transport for production environments — rotate daily, keep 30 days, compress with gzip
2. Add `requestId` field to all log entries (propagated from Express request context)
3. Add `redact` field list to strip sensitive keys (`password`, `token`, `secret`, `key`, `authorization`) from log output
4. Ensure `LOG_LEVEL=silly` is blocked in `NODE_ENV=production`

### 4.4 `src/security/crypto.ts`

**Required changes**:
1. Add `generateSecureToken(bytes: number): string` — uses `crypto.randomBytes`, returns hex
2. Add `constantTimeEqual(a: string, b: string): boolean` — uses `crypto.timingSafeEqual` to prevent timing attacks
3. Add `deriveKey(secret: string, salt: Buffer): Promise<Buffer>` — uses `crypto.scrypt` for key derivation (not PBKDF2)
4. Ensure all encryption uses AES-256-GCM with a random IV per operation — never reuse IV
5. Add explicit type annotations on every function — no implicit return types

### 4.5 `src/security/audit.ts`

**Required changes**:
1. Enforce `AuditEntry` type from `src/types/index.ts`
2. Add `correlationId` field to every audit entry
3. Add HMAC signature to each audit entry to detect tampering (using `ENCRYPTION_KEY` via `crypto.ts`)
4. Add async `flush()` method to drain buffered entries before process exit
5. Register `flush()` in `lifecycle.ts` shutdown sequence

### 4.6 `src/discovery/registry-manager.ts`

**Required changes**:
1. Add `enterprise-catalog` connector registration (conditional on `config.ENABLE_ENTERPRISE_CATALOG`)
2. Add parallel discovery with `Promise.allSettled` — a single failing registry must not block results from others
3. Add deduplication: if two registries return the same tool (matched by `name` + `version`), merge metadata and mark `sources: string[]`
4. Add discovery result caching at the manager level (separate from per-connector caching)
5. Emit a `discovery:complete` event with result count and duration after each discovery cycle

### 4.7 `src/orchestration/workflow-engine.ts`

**Required changes**:
1. Add dead-letter queue for permanently failed workflow steps — write to a `workflow-dlq.jsonl` file in the runtime directory
2. Add configurable retry with exponential backoff: `maxRetries`, `initialDelayMs`, `backoffMultiplier`
3. Add workflow state persistence: serialize/deserialize workflow state to/from JSON files in `runtime/workflows/`
4. Add `cancelWorkflow(workflowId: string): Promise<void>` method
5. Add event emission for every state transition: `workflow:started`, `workflow:step:complete`, `workflow:step:failed`, `workflow:complete`, `workflow:cancelled`

### 4.8 `src/api/health.ts`

**Required changes**:
1. Add `/health/ready` endpoint — returns 200 only when runtime manager is fully initialized, 503 otherwise
2. Add `/health/live` endpoint — always returns 200 (liveness probe)
3. Current `/health` endpoint should become a combined check (backward compatible)
4. Include `uptime`, `version` (from `package.json`), `nodeVersion`, `environment` in the response body
5. Add `X-Request-ID` response header populated from `uuid.v4()` for traceability

### 4.9 `src/api/admin-api.ts`

**Required changes**:
1. Add JWT authentication middleware — all admin routes must require a valid `Authorization: Bearer <token>` header signed with `config.JWT_SECRET`
2. Add `GET /admin/capabilities` — list all currently registered capabilities with metadata
3. Add `DELETE /admin/capabilities/:id` — deregister a capability from the runtime
4. Add `GET /admin/policies` — list active policy rules
5. Add `GET /admin/costs` — return cost summary from `cost-monitor.ts`
6. Add `GET /admin/audit` — return recent audit log entries (paginated, `?limit=50&offset=0`)
7. Add input validation with Zod for all request bodies and query params

### 4.10 `src/policy/policy-engine.ts`

**Required changes**:
1. Add JSON-based policy pack loading from `policies/` directory at startup
2. Add hot-reload: watch `policies/` directory for changes and reload without restart
3. Add `explainDecision(context: PolicyContext): PolicyExplanation` — returns human-readable reasoning for a decision
4. Expose policy evaluation metrics: decisions per second, allow/deny ratio

### 4.11 `src/provisioning/installer.ts`

**Required changes**:
1. Add rollback capability: if installation fails mid-way, clean up partial installs
2. Add checksum verification for downloaded packages (SHA-256)
3. Add install lock file to prevent concurrent installs of the same package
4. Add `dryRun` option: validate installation steps without executing them
5. Emit structured events at each install stage for observability

### 4.12 `src/routing/provider-router.ts`

**Required changes**:
1. Add circuit breaker per provider: after N consecutive failures, mark provider as `OPEN` and skip for a cooldown period
2. Add provider health check background task: ping each configured provider every 60s
3. Add routing metrics: request count, failure count, latency p50/p95/p99 per provider
4. Add fallback chain: `PRIMARY → FALLBACK → LOCAL` with automatic escalation

---

## 5. ADDITIONS TO TEST SUITE

> New test files that must be created. Every test file must use `jest` + `ts-jest`. No external test dependencies beyond `jest`.

### 5.1 `tests/config.test.ts`
- Test: valid config parses successfully
- Test: missing required fields throw with descriptive error
- Test: insecure defaults in production throw
- Test: boolean env var transformation (`'false'`, `'0'`, `'true'`, `'1'`, undefined)
- Test: PORT valid range enforcement (1–65535)
- Test: CORS_ORIGIN validation (wildcard, valid URL list, invalid URL list)

### 5.2 `tests/registry-manager.test.ts`
- Test: initialization registers all enabled connectors
- Test: `discover()` returns merged results from all connectors
- Test: single failing connector does not propagate error to caller
- Test: duplicate tools across registries are deduplicated
- Test: results are cached and not re-fetched within TTL window

### 5.3 `tests/installer.test.ts`
- Test: successful install flow (mock npm subprocess)
- Test: failed install triggers rollback
- Test: concurrent installs of same package are serialized (lock)
- Test: dry-run returns plan without executing
- Test: checksum mismatch throws and cleans up

### 5.4 `tests/workflow-engine.test.ts`
- Test: simple sequential workflow executes all steps in order
- Test: step failure triggers retry up to maxRetries
- Test: workflow cancellation stops further step execution
- Test: failed workflow after retries writes to DLQ
- Test: workflow state is persisted and restorable

### 5.5 `tests/provider-router.test.ts`
- Test: routes to primary provider by default
- Test: falls back to fallback provider on primary failure
- Test: circuit breaker opens after N failures
- Test: circuit breaker half-opens and retries after cooldown

### 5.6 `tests/cost-monitor.test.ts`
- Test: records cost events correctly
- Test: `getCostSummary` returns correct aggregates for given window
- Test: `getCostByProvider` groups correctly
- Test: daily budget limit emits warning when exceeded

### 5.7 `tests/admin-api.test.ts`
- Test: unauthenticated requests to admin routes return 401
- Test: requests with invalid JWT return 401
- Test: `GET /admin/capabilities` returns capability list with valid token
- Test: `GET /health/ready` returns 503 before runtime init, 200 after
- Test: `GET /health/live` always returns 200

### 5.8 `tests/cli-adapter.test.ts`
- Test: executes safe command and captures stdout
- Test: shell metacharacter in command input is rejected
- Test: command timeout is enforced
- Test: non-zero exit code is reflected in result

---

## 6. CONFIGURATION FILE FIXES

### 6.1 `.gitignore` — Replace Entire File

The replacement content must include:
```
# Build output
dist/
.tsbuildinfo

# Dependencies
node_modules/

# Environment
.env
.env.local
.env.*.local

# Test & Coverage
coverage/
*.lcov

# Logs
logs/
*.log
npm-debug.log*

# Runtime data
runtime/
cache/

# OS
.DS_Store
Thumbs.db

# Editor
.vscode/
.idea/
*.swp
*.swo

# TypeScript incremental
*.tsbuildinfo

# Package manager
.npm/
.pnpm-store/

# Temporary
tmp/
temp/
```

### 6.2 `.env.example` — Add Missing Variables

Add the following to the existing `.env.example`:
```
# =========================================================
# Transport
# =========================================================
MCP_TRANSPORT=http
# Options: http | stdio | sse

# =========================================================
# Enterprise Catalog (only when ENABLE_ENTERPRISE_CATALOG=true)
# =========================================================
ENTERPRISE_CATALOG_URL=
ENTERPRISE_CATALOG_PATH=

# =========================================================
# Rate Limiting
# =========================================================
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=300

# =========================================================
# Webhooks / Events Adapter
# =========================================================
WEBHOOK_SECRET=replace_with_hex_secret
EVENT_DEDUP_WINDOW_MS=300000

# =========================================================
# Cost Monitoring
# =========================================================
COST_TRACKING_ENABLED=true
COST_BUDGET_DAILY_USD=0

# =========================================================
# Redis (optional — for future distributed mode)
# =========================================================
REDIS_URL=

# =========================================================
# CORS
# =========================================================
CORS_ORIGIN=*
# For production: CORS_ORIGIN=https://your-domain.com,https://admin.your-domain.com
```

### 6.3 `eslint.config.js` — Harden Rules

**Add the following rules** to the existing config:
```javascript
'@typescript-eslint/no-explicit-any': 'error',
'@typescript-eslint/explicit-function-return-type': 'warn',
'@typescript-eslint/no-floating-promises': 'error',
'@typescript-eslint/await-thenable': 'error',
'@typescript-eslint/no-misused-promises': 'error',
'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
'no-console': 'error',   // Use logger, never console.*
'no-debugger': 'error',
'eqeqeq': ['error', 'always'],
```

---

## 7. THINGS TO REMOVE

> These are patterns, files, or code constructs that must be eliminated. Do not retain them as comments.

| # | What | Where | Why |
|---|---|---|---|
| 7.1 | `import * as dotenv from 'dotenv'` + `dotenv.config()` block | `src/config.ts` | Double-init with entry point; see Section 1.5 |
| 7.2 | Hardcoded rate limit values (`windowMs: 60 * 1000`, `max: 300`) | `src/core/server.ts` | Must come from config; see Section 4.2 |
| 7.3 | `console.error` in `src/index.ts` | `src/index.ts` | Replace with logger; `no-console` rule |
| 7.4 | Any `as any` type assertions in source files | Entire `src/` | Violates no-any policy |
| 7.5 | MIT badge in README | `README.md` | License is Apache-2.0; see Section 1.2 |
| 7.6 | `setTimeout(() => resolve(), 10_000)` without typed ref in server stop | `src/core/server.ts` | Replace with `AbortController`-based graceful drain |
| 7.7 | Empty adapter sub-directories (`src/adapters/graphql`, `src/adapters/cli`, `src/adapters/events`) | — | Fill with implementations per Section 3.3–3.5 or remove dirs until ready |
| 7.8 | `"version": "1.0.0"` | `package.json` | Pre-release software must use `"0.1.0"` per semver; already fixed in previous commit |

---

## 8. QUALITY STANDARDS ALL CODE MUST MEET

Every file produced by an agent in this repository must comply with the following before a PR is opened:

### TypeScript
- `npm run typecheck` exits with code 0 — no exceptions
- No `@ts-ignore` or `@ts-expect-error` comments unless paired with a GitHub issue reference in the same comment
- All exported functions have explicit return type annotations
- All async functions return `Promise<T>` explicitly
- `unknown` is used in catch blocks, not `any`

### Testing
- `npm run test` exits with code 0
- New modules must have ≥70% line coverage
- Tests must be deterministic — no `Date.now()` or `Math.random()` without mocking
- Tests must not make real network calls — mock all HTTP with jest mock or `nock`
- Each test describes exactly one behavior in its name: `'returns 401 when Authorization header is missing'`, not `'auth test'`

### Logging
- Never use `console.*` — always use the logger from `src/observability/logger.ts`
- Every log entry must include at least: `message`, `level`, `module`, `timestamp`
- Sensitive fields (`token`, `secret`, `password`, `key`) must never appear in log output

### Error Handling
- Every `async` function must handle its errors explicitly — no fire-and-forget `Promise`s
- All Express route handlers must be wrapped in try/catch or use an async error-catching wrapper
- All errors thrown must be typed: create domain-specific error classes in `src/types/errors.ts`

### Security
- Never call `child_process.exec` or `child_process.execSync` — use `spawn` with explicit arg arrays
- Never use `eval()` or `new Function()`
- Never log request bodies in production (`NODE_ENV === 'production'`)
- All user-supplied input that touches the filesystem must be sanitized via `path.resolve` and checked to be within an allowed base directory

---

## 9. WORK PRIORITY ORDER FOR AGENTS

If working sequentially, execute tasks in this order:

```
Priority 1 — BLOCKING FIXES (do these first, in order)
  1.1  Fix TypeScript version in package.json (^5.7.3)
  1.3  Harden .gitignore
  1.5  Remove dotenv double-import from src/config.ts
  1.6  Gate MCP stdio transport on MCP_TRANSPORT env var
  1.2  Fix README.md license badge + add CI badges

Priority 2 — INFRASTRUCTURE (do before adding features)
  2.12 .nvmrc
  2.1  .github/workflows/ci.yml
  2.2  .github/workflows/codeql.yml
  2.4  .github/workflows/dependency-review.yml
  2.19 .github/dependabot.yml
  2.5  .github/PULL_REQUEST_TEMPLATE.md
  2.6  .github/ISSUE_TEMPLATE/bug_report.yml
  2.7  .github/ISSUE_TEMPLATE/feature_request.yml

Priority 3 — COMMUNITY DOCS
  2.8  CONTRIBUTING.md
  2.9  SECURITY.md
  2.10 CHANGELOG.md
  2.11 CODE_OF_CONDUCT.md

Priority 4 — DEPLOYMENT ARTIFACTS
  2.17 Dockerfile
  2.18 docker-compose.yml

Priority 5 — SHARED TYPES
  3.7  src/types/index.ts

Priority 6 — CONFIG ENHANCEMENTS
  4.1  src/config.ts additions
  6.2  .env.example additions
  6.3  eslint.config.js hardening

Priority 7 — CORE ENHANCEMENTS
  4.2  src/core/server.ts
  4.3  src/observability/logger.ts
  4.4  src/security/crypto.ts
  4.5  src/security/audit.ts
  4.8  src/api/health.ts
  4.9  src/api/admin-api.ts

Priority 8 — MODULE ENHANCEMENTS
  4.6  src/discovery/registry-manager.ts
  4.7  src/orchestration/workflow-engine.ts
  4.10 src/policy/policy-engine.ts
  4.11 src/provisioning/installer.ts
  4.12 src/routing/provider-router.ts

Priority 9 — NEW SOURCE MODULES
  3.6  src/normalization/protocol-adapters/ (all 4 files)
  3.1  src/discovery/enterprise-catalog.ts
  3.2  src/observability/cost-monitor.ts
  3.4  src/adapters/cli/index.ts
  3.5  src/adapters/events/index.ts
  3.3  src/adapters/graphql/index.ts

Priority 10 — TEST SUITE EXPANSION
  5.1–5.8 (all new test files, in any order)

Priority 11 — TECHNICAL DOCS
  2.13 docs/architecture.md
  2.14 docs/security.md
  2.15 docs/api.md
  2.16 docs/deployment.md
```

---

## 10. OUT OF SCOPE — DO NOT DO

The following are explicitly excluded from agent scope until human authorization is given:

- Publishing to npm (`npm publish`)
- Creating or modifying GitHub Releases
- Changing the `main` branch protection rules
- Adding or removing repository collaborators
- Modifying this `AGENTS.md` file
- Merging PRs without passing all CI checks
- Adding any third-party analytics, telemetry, or tracking SDKs
- Removing the Apache-2.0 `LICENSE` file or changing the license
- Introducing any AI model API calls in the core runtime without a corresponding cost-monitoring hook

---

## 11. VALIDATION CHECKLIST — BEFORE OPENING ANY PR

An agent must verify every item below passes before opening a PR:

```
[ ] npm run typecheck           — exits 0
[ ] npm run lint                — exits 0
[ ] npm run test:ci             — exits 0, all tests pass
[ ] npm run build               — exits 0, dist/ created
[ ] No new console.* calls introduced
[ ] No any type introduced without justification comment
[ ] New files have corresponding test files
[ ] .env.example updated if new env vars added to config.ts
[ ] CHANGELOG.md updated under [Unreleased]
[ ] Commit messages follow Conventional Commits format
[ ] Branch name follows convention: type/scope
```

---

*This document is maintained by the Universal Standards engineering team.*  
*For questions or clarifications, open a GitHub Discussion in this repository.*
