# 🗺️ MASTER BUILD TRACKER
## Universal MCP Orchestration Hub — `UniversalStandards/IDEA`

> **This is the single source of truth for the entire build.**  
> Updated after every work session. Reflects the exact state of `main` as of the last commit.  
> Last updated: **2026-09-10** | Last commit: [`b77990f`](../../commit/b77990fecc2540eedd7ef61f2180ba8e495ba380)

---

## 📊 Overall Completion

| Area | Done | Total | % |
|---|---|---|---|
| Root config & project files | 18 | 18 | **100%** |
| GitHub infrastructure | 16 | 16 | **100%** |
| Source modules (`src/`) | 35 | 38 | **92%** |
| Source enhancements (existing files) | 8 | 12 | **67%** |
| New protocol adapters | 4 | 4 | **100%** |
| New adapter implementations | 3 | 3 | **100%** |
| Test files | 16 | 20 | **80%** |
| Documentation (`docs/`) | 4 | 4 | **100%** |
| Project boards | 3 | 6 | **50%** |
| Open issues resolved | 3 | 16 | **19%** |
| **TOTAL** | **107** | **121** | **88%** |

> **Session note (2026-09-10)**: Verified this tracker's Section 2 "❌ Pending / workflow-scope PAT" claims were stale — `ci.yml`, `codeql.yml`, `dependency-review.yml`, `release.yml`, plus previously-undocumented `deploy-preview.yml`, `deploy-production.yml`, `scorecard.yml`, `stale.yml` are all live in `.github/workflows/` with real content. Added the remaining four GitHub infra files (`dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`, two `ISSUE_TEMPLATE/*.yml`), closing Section 2 to 100%. Implemented `secret-store.ts` + `credential-broker.ts` (Issue #13) and `approval-gates.ts` (Issue #15) in full, wired `eventsAdapter` / `graphqlAdapter` / `cliAdapter` / `credentialBroker` into `runtime-manager.ts` init/shutdown and `auditLog.flush()` + `secretStore.clear()` into `lifecycle` shutdown hooks (Issue #9), mounted the events-adapter router in `transport/http.ts`, and wired `/admin/policies`, `/admin/costs`, `/admin/audit` to real `policyEngine` / `costMonitor` / `auditLog` data instead of stub responses. Replaced the last `console.error` in `src/index.ts` with the structured logger. Issues #4 #5 #6 #7 #8 remain genuinely open — not touched this session.

---

## ✅ Section 1 — Root & Config Files

> Every file that lives at the repository root or is a project-level config.

| File | Status | Commit | Notes |
|---|---|---|---|
| `package.json` | ✅ Done | `fa095e4` | TS `^5.7.3`, jest/ts-jest `^29.x`, zod `^3.24.0`, jsonwebtoken added, dotenv `^16.4.5` |
| `tsconfig.json` | ✅ Done | `2778f70` | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, path aliases, incremental |
| `tsconfig.test.json` | ✅ Done | pre-existing | Separate test tsconfig |
| `eslint.config.js` | ✅ Done | `fa095e4` | ESLint 9 flat config, `no-explicit-any: error`, `no-console: error`, `eqeqeq`, consistent-type-imports |
| `.gitignore` | ✅ Done | `fa095e4` | `dist/`, `.tsbuildinfo`, `runtime/`, `cache/`, secrets, OS artifacts, editor dirs |
| `.nvmrc` | ✅ Done | `fa095e4` | Node 20 LTS |
| `.env.example` | ✅ Done | `fa095e4` | All env vars documented: `MCP_TRANSPORT`, `RATE_LIMIT_*`, `ENTERPRISE_CATALOG_*`, `WEBHOOK_SECRET`, `COST_*`, `REDIS_URL` |
| `README.md` | ✅ Done | `fa095e4` | Apache-2.0 + CI + CodeQL badges, Quick Start, project structure, fixed section 16 |
| `LICENSE` | ✅ Done | pre-existing | Apache-2.0 |
| `Dockerfile` | ✅ Done | `a2f4075` | Multi-stage (builder→runtime), node:20-slim, UID 1001 non-root, HEALTHCHECK, OCI labels |
| `docker-compose.yml` | ✅ Done | `a2f4075` | hub + Redis, healthchecks, volumes, hub-net bridge |
| `AGENTS.md` | ✅ Done | `56140b8` | 11-section AI coding agent instruction manifest |
| `CONTRIBUTING.md` | ✅ Done | `44bf67f` | Full contributor guide, module/adapter extension workflow |
| `SECURITY.md` | ✅ Done | `44bf67f` | Vulnerability disclosure, trust pipeline overview, dependency policy |
| `CHANGELOG.md` | ✅ Done | `44bf67f` + `b77990f` | Keep a Changelog format, all sessions documented |
| `CODE_OF_CONDUCT.md` | ✅ Done | `44bf67f` | Contributor Covenant 2.1 |
| `package-lock.json` | ✅ Done | auto | Generated from package.json |

---

## 🏗️ Section 2 — GitHub Infrastructure

> Workflows, templates, and repo configuration. **100% — this section was previously mis-tracked as blocked; verified live 2026-09-10.**

| File | Status | Notes |
|---|---|---|
| `.github/workflows/ci.yml` | ✅ Done | Live in repo, 6969 bytes |
| `.github/workflows/codeql.yml` | ✅ Done | Live in repo, 1210 bytes |
| `.github/workflows/release.yml` | ✅ Done | Live in repo, 1342 bytes |
| `.github/workflows/dependency-review.yml` | ✅ Done | Live in repo, 760 bytes |
| `.github/workflows/deploy-preview.yml` | ✅ Done | Live in repo, 2909 bytes (not previously documented in this tracker) |
| `.github/workflows/deploy-production.yml` | ✅ Done | Live in repo, 6266 bytes (not previously documented in this tracker) |
| `.github/workflows/scorecard.yml` | ✅ Done | Live in repo, 928 bytes — OpenSSF Scorecard |
| `.github/workflows/stale.yml` | ✅ Done | Live in repo, 1716 bytes |
| `.github/dependabot.yml` | ✅ Done | `b77990f` — npm (grouped dev/prod), github-actions, docker ecosystems, weekly |
| `.github/PULL_REQUEST_TEMPLATE.md` | ✅ Done | `b77990f` |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | ✅ Done | `b77990f` |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | ✅ Done | `b77990f` |
| `.github/PROJECT_BOARD_PLATFORM.md` | ✅ Done | `da1ced1` — Platform Build board |
| `.github/PROJECT_BOARD_SECURITY.md` | ✅ Done | `da1ced1` — Security & Compliance board |
| `.github/MASTER_TRACKER.md` | ✅ Done | this commit |
| Branch protection on `main` | ❌ Pending | Issue #12 — human action required (repo admin setting, not file-based) |

---

## 🧠 Section 3 — Source Modules (`src/`)

### 3.1 Core

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/index.ts` | ✅ Enhanced | `b77990f` | `console.error` replaced with structured logger; registers `audit-log` and `secret-store` shutdown hooks alongside `http-server` |
| `src/config.ts` | ✅ Enhanced | `e41a252` | dotenv removed, 10 new vars: `MCP_TRANSPORT`, `RATE_LIMIT_*`, `ENTERPRISE_CATALOG_*`, `WEBHOOK_SECRET`, `COST_*`, `REDIS_URL`, production guard for `silly` log level |
| `src/core/server.ts` | ✅ Enhanced | `c85d981` | MCP_TRANSPORT gate (not NODE_ENV), SSE endpoint, config-driven rate limits, 404 + error middleware, uptime tracking |
| `src/core/runtime-manager.ts` | ✅ Enhanced | `b77990f` | `eventsAdapter` / `graphqlAdapter` / `cliAdapter` / `credentialBroker` now initialized in `initialize()` and shut down in `shutdown()`; added as subsystems in `getStatus()` |
| `src/core/lifecycle.ts` | ✅ Wired | `b77990f` | `auditLog.flush()` and `secretStore.clear()` now registered as shutdown hooks from `src/index.ts` (lifecycle.ts itself is a generic hook runner and needed no code change) |

### 3.2 Types

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/types/index.ts` | ✅ Done | `a2f4075` | All shared types: 8 enums, `NormalizedRequest/Result`, `CapabilityDescriptor`, `ProviderConfig`, `PolicyDecision/Context`, `TrustScore`, `AuditEntry`, `HealthStatus`, `ExecutionContext`, `CostEvent/Summary`, `IAdapter`, `IProtocolAdapter`, `IRegistryConnector`, `CliToolDefinition/Result`, `WorkflowStep/State/Definition`, `RetryPolicy` |

### 3.3 Normalization

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/normalization/request-normalizer.ts` | ✅ Done | pre-existing | Exists |
| `src/normalization/schema-reconciler.ts` | ✅ Done | pre-existing | Exists |
| `src/normalization/protocol-adapters/json-rpc.ts` | ✅ Done | `8d52e35` | JSON-RPC 2.0 normalize/denormalize, array params wrapped |
| `src/normalization/protocol-adapters/rest.ts` | ✅ Done | `8d52e35` | HTTP REST normalize/denormalize |
| `src/normalization/protocol-adapters/graphql.ts` | ✅ Done | `8d52e35` | GraphQL operation normalize/denormalize, operation type detection |
| `src/normalization/protocol-adapters/mcp.ts` | ✅ Done | `8d52e35` | MCP protocol normalize/denormalize, `_meta` passthrough |

### 3.4 Discovery

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/discovery/registry-manager.ts` | ⚠️ Needs enhancement | pre-existing | Still needs: `Promise.allSettled`, deduplication, enterprise-catalog registration, `discovery:complete` event — Issue #4 (not touched this session) |
| `src/discovery/github-registry.ts` | ✅ Done | pre-existing | Exists |
| `src/discovery/official-registry.ts` | ✅ Done | pre-existing | Exists |
| `src/discovery/local-scanner.ts` | ✅ Done | pre-existing | Exists |
| `src/discovery/enterprise-catalog.ts` | ✅ Done | `8d52e35` | HTTP + file-based catalog, Zod schema validation, node-cache TTL |

### 3.5 Provisioning

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/provisioning/installer.ts` | ⚠️ Needs enhancement | pre-existing | Still needs: rollback, SHA-256 checksum, install lock, dry-run — Issue #7 (not touched this session) |
| `src/provisioning/dependency-resolver.ts` | ✅ Done | pre-existing | Exists |
| `src/provisioning/runtime-registrar.ts` | ✅ Done | pre-existing | Exists |
| `src/provisioning/config-generator.ts` | ✅ Done | pre-existing | Exists |

### 3.6 Routing

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/routing/provider-router.ts` | ⚠️ Needs enhancement | pre-existing | Still needs: circuit breaker, background health checks, routing metrics — Issue #6 (not touched this session) |
| `src/routing/scheduler.ts` | ✅ Done | pre-existing | Exists |
| `src/routing/capability-selector.ts` | ✅ Done | pre-existing | Exists |

### 3.7 Policy

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/policy/policy-engine.ts` | ⚠️ Needs enhancement | pre-existing | Still needs: JSON pack loading from `policies/`, hot-reload, `explainDecision`, metrics — Issue #8 (not touched this session) |
| `src/policy/trust-evaluator.ts` | ⚠️ Needs full implementation | pre-existing | Still needs: full 10-stage pipeline, structured TrustScore breakdown — Issue #14 (not touched this session) |
| `src/policy/approval-gates.ts` | ✅ Done | `b77990f` | Sync (`waitForDecision` with timeout → `TIMED_OUT`) + async (`decide()`) flows, Admin API sub-router mounted at `/admin/approvals`, audit-logged on request/approve/reject/timeout |

### 3.8 Security

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/security/crypto.ts` | ✅ Done | `e41a252` | AES-256-GCM, random IV per op, scrypt key derivation, `generateSecureToken`, `constantTimeEqual`, `hmac`, `verifyHmac` |
| `src/security/audit.ts` | ✅ Enhanced | `b77990f` | HMAC-signed entries, `correlationId`, async `writeLine`, `flush()`; added bounded in-memory ring buffer + `getRecent(limit, offset, action?)` for Admin API reads |
| `src/security/credential-broker.ts` | ✅ Done | `b77990f` | Scope-enforced issue/retrieve/rotate/revoke, audit hooks on every operation, `IAdapter`-compliant init/shutdown, wired into `runtime-manager.ts` |
| `src/security/secret-store.ts` | ✅ Done | `b77990f` | In-memory AES-256-GCM store with TTL expiry, `rotateEncryption()` for zero-downtime key rotation, wired into `lifecycle` shutdown |

### 3.9 Orchestration

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/orchestration/task-graph.ts` | ✅ Done | pre-existing | Exists |
| `src/orchestration/agent-router.ts` | ✅ Done | pre-existing | Exists |
| `src/orchestration/execution-planner.ts` | ✅ Done | pre-existing | Exists |
| `src/orchestration/workflow-engine.ts` | ⚠️ Needs enhancement | pre-existing | Still needs: DLQ, exponential backoff, state persistence, `cancelWorkflow()`, event emission — Issue #5 (not touched this session) |

### 3.10 Observability

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/observability/logger.ts` | ✅ Done | `e41a252` | Daily rotation (winston-daily-rotate-file), sensitive field redaction, requestId/correlationId child loggers, silent in test |
| `src/observability/metrics.ts` | ✅ Done | pre-existing | Exists |
| `src/observability/tracing.ts` | ✅ Done | pre-existing | Exists |
| `src/observability/cost-monitor.ts` | ✅ Done | `8d52e35` | `record()`, `getCostSummary()`, `getCostByProvider()`, `getCostByModel()`, daily budget alert, audit integration; now live behind `GET /admin/costs` |

### 3.11 Adapters

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/adapters/mcp/index.ts` | ✅ Done | pre-existing | MCP protocol adapter |
| `src/adapters/rest/index.ts` | ✅ Done | pre-existing | REST adapter |
| `src/adapters/graphql/index.ts` | ✅ Done | `ec4a88` | Execute + introspect, per-endpoint auth headers, audit logging; `initialize()`/`shutdown()` now called from `runtime-manager.ts` |
| `src/adapters/cli/index.ts` | ✅ Done | `ec4a88` | `spawn` (not exec), shell metacharacter guard, timeout + SIGTERM/SIGKILL, restricted env; `initialize()`/`shutdown()` now called from `runtime-manager.ts` |
| `src/adapters/events/index.ts` | ✅ Done | `ec4a88` | Webhook receiver + HMAC-SHA256 sig verification + dedup, SSE stream, heartbeat, event handlers; router now mounted at `/adapters/events` in `transport/http.ts`, `initialize()`/`shutdown()` called from `runtime-manager.ts` |

### 3.12 API

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/api/health.ts` | ✅ Done | `e41a252` | `GET /health`, `GET /health/live`, `GET /health/ready`, `X-Request-ID` header |
| `src/api/admin-api.ts` | ✅ Enhanced | `b77990f` | JWT Bearer auth on all routes; `/policies` now returns `policyEngine.listPolicies()`, `/costs` now returns `costMonitor.getCostSummary()`, `/audit` now returns `auditLog.getRecent()` — all three were previously hardcoded stub responses; `/approvals/*` mounted from `approval-gates.ts` |
| `src/api/status.ts` | ✅ Done | pre-existing | Exists |

---

## 🧪 Section 4 — Test Files (`tests/`)

| File | Status | Commit | Coverage Focus |
|---|---|---|---|
| `tests/crypto.test.ts` | ✅ Done | pre-existing | AES-256-GCM, hmac, token generation |
| `tests/metrics.test.ts` | ✅ Done | pre-existing | Metrics collection |
| `tests/policy-engine.test.ts` | ✅ Done | pre-existing | Policy evaluation |
| `tests/request-normalizer.test.ts` | ✅ Done | pre-existing | Request normalization |
| `tests/scheduler.test.ts` | ✅ Done | pre-existing | Task scheduling |
| `tests/schema-reconciler.test.ts` | ✅ Done | pre-existing | Schema reconciliation |
| `tests/task-graph.test.ts` | ✅ Done | pre-existing | DAG task graph |
| `tests/trust-evaluator.test.ts` | ✅ Done | pre-existing | Trust scoring |
| `tests/config.test.ts` | ✅ Done | `fca8e4b` | 14 cases: valid parse, PORT range, bool transform, CORS, production guards, MCP_TRANSPORT, rate limit vars |
| `tests/cost-monitor.test.ts` | ✅ Done | `fca8e4b` | 8 cases: record, aggregate, by-provider, by-model, window, clear, capacity, disabled mode |
| `tests/cli-adapter.test.ts` | ✅ Done | `fca8e4b` | 10 cases: execute, unknown tool, schema validation, metachar injection ×2, timeout, non-zero exit, stderr, deregister, list |
| `tests/admin-api.test.ts` | ✅ Done | `fca8e4b` | JWT validation: missing header, wrong secret, expired token, router structure |
| `tests/protocol-adapters.test.ts` | ✅ Done | `fca8e4b` | 20 cases across all 4 adapters (json-rpc, rest, graphql, mcp) |
| `tests/secret-store.test.ts` | ✅ Done | `b77990f` | 7 cases: round-trip, missing key, no-plaintext-in-memory, TTL expiry, delete, encryption rotation, size/clear |
| `tests/credential-broker.test.ts` | ✅ Done | `b77990f` | 7 cases: issue/retrieve, scope mismatch, not-found, rotate, revoke, revoke-unknown, handles never leak plaintext |
| `tests/approval-gates.test.ts` | ✅ Done | `b77990f` | 8 cases: request, approve, reject, double-decide throws, unknown-id throws, waitForDecision resolves, waitForDecision times out, unknown get() |
| `tests/registry-manager.test.ts` | ❌ Not created | — | Parallel discovery, dedup, single-failure isolation, cache — Issue #10 |
| `tests/installer.test.ts` | ❌ Not created | — | Success, rollback, lock, dry-run, checksum — Issue #10 |
| `tests/workflow-engine.test.ts` | ❌ Not created | — | Sequential steps, retry, cancel, DLQ, state — Issue #10 |
| `tests/provider-router.test.ts` | ❌ Not created | — | Primary, fallback, circuit breaker open/half-open — Issue #10 |
| `tests/events-adapter.test.ts` | ❌ Not created | — | HMAC sig verify, dedup, SSE, bad payload — Issue #19 |

---

## 📚 Section 5 — Documentation (`docs/`)

| File | Status | Commit | Sections |
|---|---|---|---|
| `docs/architecture.md` | ✅ Done | `a71f208` | System overview, component map, 7-stage request lifecycle, data flow diagram, module interfaces, extension points, deployment topologies |
| `docs/security.md` | ✅ Done | `a71f208` | Trust pipeline, credential broker, secret store, audit log schema, network boundaries, approval gates, key rotation procedure |
| `docs/api.md` | ✅ Done | `a71f208` | All endpoints: /health, /health/live, /health/ready, all /admin/* routes, /adapters/events/webhook, /adapters/events/stream |
| `docs/deployment.md` | ✅ Done | `a71f208` | Full env var table, Docker, Docker Compose, health check config, nginx/Cloudflare Tunnel, Kubernetes manifests + HPA, air-gap mode |

> ⚠️ `docs/security.md` and `docs/api.md` describe `credential-broker.ts` and `/admin/approvals` respectively — those descriptions now match real code as of this session, but were written before the implementation existed. Worth a pass to confirm no drift between the doc's described behavior and the actual implementation above.

---

## 📋 Section 6 — Open Issues

> Tracker-level status. Actual GitHub Issues #2–#19 need to be closed manually by a maintainer with issue-write access — this tracker cannot close them.

| # | Title | Board | Priority | Status |
|---|---|---|---|---|
| [#2](../../issues/2) | Create GitHub Actions workflow files | Platform | 🔴 Critical | ✅ Resolved — workflows verified live; recommend closing |
| [#4](../../issues/4) | registry-manager: parallel discovery + dedup | Platform | 🔴 High | Still open |
| [#5](../../issues/5) | workflow-engine: DLQ, retry, state, cancel | Platform | 🔴 High | Still open |
| [#6](../../issues/6) | provider-router: circuit breaker + health checks | Platform | 🔴 High | Still open |
| [#7](../../issues/7) | installer: rollback, checksum, lock, dry-run | Platform | 🔴 High | Still open |
| [#8](../../issues/8) | policy-engine: JSON packs, hot-reload, explainDecision | Platform | 🟡 Medium | Still open |
| [#9](../../issues/9) | wire adapters + monitors into runtime lifecycle | Platform | 🔴 High | ✅ Resolved in `b77990f` — recommend closing |
| [#10](../../issues/10) | complete 4 remaining test files | Platform | 🟡 Medium | Still open (registry-manager, installer, workflow-engine, provider-router tests — blocked on #4 #5 #6 #7) |
| [#11](../../issues/11) | create all GitHub Actions workflow files | Platform | 🔴 Critical | ✅ Resolved — duplicate of #2; recommend closing |
| [#12](../../issues/12) | configure branch protection on main | Platform | 🔴 High | Still open — human action, CI is now live so this is unblocked |
| [#13](../../issues/13) | credential-broker: scoped access + rotation | Security | 🔴 Critical | ✅ Resolved in `b77990f` — recommend closing |
| [#14](../../issues/14) | trust-evaluator: full 10-stage pipeline | Security | 🔴 Critical | Still open |
| [#15](../../issues/15) | approval-gates: sync/async + Admin API | Security | 🔴 High | ✅ Resolved in `b77990f` — recommend closing |
| [#16](../../issues/16) | audit log retention + HMAC verify script | Security | 🟡 Medium | Still open — `getRecent()` ring buffer added this session, but the standalone `scripts/verify-audit-log.ts` HMAC checker is not written yet |
| [#17](../../issues/17) | production hardening: helmet, CORS, headers | Security | 🔴 High | Still open |
| [#18](../../issues/18) | zero-downtime key rotation procedure | Security | 🔴 High | Partially unblocked — `secretStore.rotateEncryption()` now exists; the operational runbook script (`scripts/rotate-encryption-key.ts`) is not written yet |
| [#19](../../issues/19) | events-adapter E2E webhook + SSE tests | Security | 🟡 Medium | Still open |

---

## 📁 Section 7 — Project Boards

| Board | File | Status | Issues Tracked |
|---|---|---|---|
| 🚀 Platform Build | [PROJECT_BOARD_PLATFORM.md](PROJECT_BOARD_PLATFORM.md) | ✅ Live | #2 #4 #5 #6 #7 #8 #9 #10 #11 #12 |
| 🔒 Security & Compliance | [PROJECT_BOARD_SECURITY.md](PROJECT_BOARD_SECURITY.md) | ✅ Live | #13 #14 #15 #16 #17 #18 #19 |
| 🗺️ Master Tracker | [MASTER_TRACKER.md](MASTER_TRACKER.md) | ✅ Live | All |
| 🧹 Quality & Technical Debt | — | ❌ Not created | — |
| 📖 Docs & Developer Experience | — | ❌ Not created | — |
| 🗓️ Release & Ecosystem Roadmap | — | ❌ Not created | — |

---

## 🔢 Section 8 — Commit History (All Sessions)

> Every commit to `main` in chronological order.

| SHA | Message | Key Changes |
|---|---|---|
| `499128c` | fix: ts-jest aligned, license Apache-2.0, deps | First batch of bug fixes |
| `2778f70` | chore: tsconfig hardened | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, path aliases |
| `56140b8` | docs: AGENTS.md | 11-section AI agent instruction manifest |
| `fa095e4` | fix(p1): TS `^5.7.3`, harden configs, fix README | TypeScript version, gitignore, eslint, env.example, nvmrc, README badges |
| `44bf67f` | docs: CONTRIBUTING, SECURITY, CHANGELOG, CoC | All community docs |
| `a2f4075` | feat: Dockerfile, docker-compose, types | Multi-stage Docker, Redis compose, all shared types |
| `e41a252` | fix+feat: config, logger, crypto, audit, health | dotenv fix, daily log rotation, AES-256-GCM, HMAC audit, /live /ready |
| `c85d981` | feat: server.ts + admin-api.ts | MCP_TRANSPORT gate, SSE, JWT auth on admin routes |
| `8d52e35` | feat: enterprise-catalog, cost-monitor, protocol adapters | 4 new modules + 4 protocol normalizers |
| `ec4a88` | feat: CLI, Events, GraphQL adapters | Spawn-based CLI, HMAC webhook, SSE stream, GraphQL introspect |
| `fca8e4b` | test: 5 new test files | config, cost-monitor, cli-adapter, admin-api, protocol-adapters |
| `a71f208` | docs: architecture, security, api, deployment | Full docs suite |
| `da1ced1` | docs: project boards | Platform Build board, Security board |
| `586ebd9` | feat: consolidate Universal MCP Hub work | GitHub OpenAPI adapters migrated from `mcp` repo, `evolution/` types scaffold, `docs/CONSOLIDATION.md` |
| `b77990f` | feat(security,policy): credential-broker, secret-store, approval-gates | Issues #9 #13 #15 addressed; admin-api wired to live data; GitHub scaffolding completed; `console.error` removed from `src/index.ts` |

---

## 🚦 Section 9 — What Needs To Happen Next

> Ordered by impact. Do these in sequence.

### Immediate

- [ ] **Issue #12** — configure branch protection on `main` (CI is confirmed live, so this is no longer blocked)
- [ ] Close issues #2, #9, #11, #13, #15 (resolved this session or found already resolved — needs a maintainer with issue-write access)

### High Priority (Core Platform Gaps)

- [ ] **Issue #4** — registry-manager parallel discovery + dedup
- [ ] **Issue #5** — workflow-engine DLQ + retry + state persistence + cancellation
- [ ] **Issue #6** — provider-router circuit breaker + background health checks
- [ ] **Issue #7** — installer rollback + checksum + lock + dry-run

### Security (Pre-Production Traffic Gate)

- [ ] **Issue #14** — full 10-stage trust pipeline
- [ ] **Issue #17** — production hardening pass
- [ ] **Issue #18** — write `scripts/rotate-encryption-key.ts` runbook script (the underlying `secretStore.rotateEncryption()` primitive now exists)
- [ ] **Issue #16** — write `scripts/verify-audit-log.ts` HMAC integrity checker (the underlying `auditLog.getRecent()` read path now exists)

### Medium Priority

- [ ] **Issue #8** — policy-engine JSON pack loading + hot-reload
- [ ] **Issue #10** — 4 missing test files (registry-manager, installer, workflow-engine, provider-router) — blocked on #4 #5 #6 #7
- [ ] **Issue #19** — events-adapter E2E webhook + SSE tests

### Deferred (Post `v0.1.0`)

- [ ] Quality & Technical Debt board (create)
- [ ] Docs & Developer Experience board (create)
- [ ] Release & Ecosystem Roadmap board (create)
- [ ] `policies/default.json` — example policy pack file (needed once #8 lands)
- [ ] Coverage threshold raise: 60% → 80%
- [ ] npm publish checklist
- [ ] Confirm `docs/security.md` and `docs/api.md` still accurately describe `credential-broker.ts` / `/admin/approvals` now that both are implemented (flagged in Section 5)

---

## 🏁 Section 10 — Release Gates

### `v0.1.0` Gate — Platform Stable

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run test:ci` exits 0, all test files present and passing
- [ ] `npm run build` exits 0, `dist/index.js` present
- [ ] Docker image builds and container starts without error
- [ ] `GET /health/live` returns 200
- [ ] `GET /health/ready` returns 200 after runtime init
- [ ] `GET /admin/capabilities` returns 401 without token, 200 with valid token
- [x] All GitHub Actions workflows live on `main`
- [ ] Branch protection rules active on `main`
- [ ] No open issues labelled `priority-critical`
- [ ] Issues #4 #5 #6 #7 closed (note: #9 addressed this session, pending manual close)

### Pre-Production Traffic Gate — Security

- [ ] Issue #14 closed
- [x] Issue #13 addressed (pending manual close)
- [x] Issue #15 addressed (pending manual close)
- [ ] Issue #17 closed (hardening pass)
- [ ] CodeQL scan: no high/critical findings
- [ ] OpenSSF Scorecard score ≥ 7.0
- [ ] `npm audit --audit-level=high` clean
- [ ] All admin routes returning correct responses for all documented scenarios
- [ ] Audit log HMAC verification script passing on `runtime/audit.jsonl`

---

*This tracker is maintained by the US-SPURS / UniversalStandards engineering team.*  
*Update this file at the end of every work session before closing context.*
