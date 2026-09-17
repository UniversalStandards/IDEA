# 🗺️ MASTER BUILD TRACKER
## Universal MCP Orchestration Hub — `UniversalStandards/IDEA`

> **This is the single source of truth for the entire build.**  
> Updated after every work session. Reflects the exact state of `main` as of the last commit.  
> Last updated: **2026-09-16** | Last commit: [`6643e8a`](../../commit/6643e8ac95007af1f0d2d979355be6bb6f9b815d)

---

## 📊 Overall Completion

| Area | Done | Total | % |
|---|---|---|---|
| Root config & project files | 18 | 18 | **100%** |
| GitHub infrastructure | 16 | 16 | **100%** |
| Source modules (`src/`) | 36 | 38 | **95%** |
| Source enhancements (existing files) | 11 | 12 | **92%** |
| New protocol adapters | 4 | 4 | **100%** |
| New adapter implementations | 3 | 3 | **100%** |
| Test files | 19 | 20 | **95%** |
| Documentation (`docs/`) | 4 | 4 | **100%** |
| Project boards | 3 | 6 | **50%** |
| Open issues resolved | 6 | 16 | **38%** |
| **TOTAL** | **114** | **121** | **94%** |

> **Session note (2026-09-16)**: Closed Issues #4, #5, #6 in full. `registry-manager.ts` already had `Promise.allSettled` + dedup from a prior session (Issue #4 was stale on that point) — what was genuinely missing was enterprise-catalog registration (blocked by a real interface mismatch: `EnterpriseCatalogConnector` implements `IRegistryConnector` from `types/index.ts`, but `registry-manager.ts` consumes the unrelated `Registry` interface from `discovery/types.ts` — fixed via a new `enterprise-catalog-adapter.ts` bridge), manager-level caching, and `discovery:complete` event emission. `workflow-engine.ts` got the full Issue #5 treatment: DLQ (`runtime/workflow-dlq.jsonl`), exponential backoff retry per step, JSON state persistence per run, `cancelWorkflow(runId)`, and the full event set. `provider-router.ts` got the full Issue #6 treatment: a real CLOSED/OPEN/HALF_OPEN circuit breaker, a start/stop-able background health-check loop, and p50/p95/p99 latency + request/failure counters per provider; wired into `runtime-manager.ts` start/stop. **Also found and fixed a real, pre-existing compile-blocking bug**: `src/provisioning/installer.ts` imported a nonexistent `auditLogger` export and called a nonexistent `.log({...})` method — the actual module exports `auditLog` with `.record(action, actor, resource, outcome, correlationId?, meta?)`. Fixed the three call sites. Installer.ts also called `approvalGate.request(...)` (singular, 5-arg, blocking) against what was a non-blocking `approvalGates` (plural) API — added a `requestAndWait()` method and an `approvalGate` facade object that preserves the blocking-until-decided-or-throw contract installer.ts depends on for its safety-critical approval gate. **Issue #7 (installer rollback/checksum/lock/dry-run) is still open** — only the compile-blocking audit/approval bugs were fixed, not the feature work, and `trustEvaluator.evaluate()/getMinimumRequired()`, `policyEngine.evaluate()`, `dependencyResolver.resolve()`, `configGenerator.generate()`, and `runtimeRegistrar.register()/unregister()/list()` were NOT independently verified this session — installer.ts may still have other integration issues against those five modules that weren't checked.

---

## ✅ Section 1 — Root & Config Files

| File | Status | Commit | Notes |
|---|---|---|---|
| `package.json` | ✅ Done | `fa095e4` | TS `^5.7.3`, jest/ts-jest `^29.x`, zod `^3.24.0`, jsonwebtoken added, dotenv `^16.4.5` |
| `tsconfig.json` | ✅ Done | `2778f70` | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, path aliases, incremental |
| `tsconfig.test.json` | ✅ Done | pre-existing | Separate test tsconfig |
| `eslint.config.js` | ✅ Done | `fa095e4` | ESLint 9 flat config, `no-explicit-any: error`, `no-console: error`, `eqeqeq`, consistent-type-imports |
| `.gitignore` | ✅ Done | `fa095e4` | `dist/`, `.tsbuildinfo`, `runtime/`, `cache/`, secrets, OS artifacts, editor dirs |
| `.nvmrc` | ✅ Done | `fa095e4` | Node 20 LTS |
| `.env.example` | ✅ Done | `fa095e4` | All env vars documented |
| `README.md` | ✅ Done | `fa095e4` | Apache-2.0 + CI + CodeQL badges, Quick Start, project structure |
| `LICENSE` | ✅ Done | pre-existing | Apache-2.0 |
| `Dockerfile` | ✅ Done | `a2f4075` | Multi-stage, node:20-slim, UID 1001 non-root, HEALTHCHECK, OCI labels |
| `docker-compose.yml` | ✅ Done | `a2f4075` | hub + Redis, healthchecks, volumes, hub-net bridge |
| `AGENTS.md` | ✅ Done | `56140b8` | 11-section AI coding agent instruction manifest |
| `CONTRIBUTING.md` | ✅ Done | `44bf67f` | Full contributor guide |
| `SECURITY.md` | ✅ Done | `44bf67f` | Vulnerability disclosure, trust pipeline overview |
| `CHANGELOG.md` | ✅ Done | `44bf67f`+ | Keep a Changelog format, all sessions documented |
| `CODE_OF_CONDUCT.md` | ✅ Done | `44bf67f` | Contributor Covenant 2.1 |
| `package-lock.json` | ✅ Done | auto | Generated |

---

## 🏗️ Section 2 — GitHub Infrastructure

**100%.**

| File | Status | Notes |
|---|---|---|
| `.github/workflows/ci.yml` | ✅ Done | Live |
| `.github/workflows/codeql.yml` | ✅ Done | Live |
| `.github/workflows/release.yml` | ✅ Done | Live |
| `.github/workflows/dependency-review.yml` | ✅ Done | Live |
| `.github/workflows/deploy-preview.yml` | ✅ Done | Live |
| `.github/workflows/deploy-production.yml` | ✅ Done | Live |
| `.github/workflows/scorecard.yml` | ✅ Done | Live — OpenSSF Scorecard |
| `.github/workflows/stale.yml` | ✅ Done | Live |
| `.github/dependabot.yml` | ✅ Done | `b77990f` |
| `.github/PULL_REQUEST_TEMPLATE.md` | ✅ Done | `b77990f` |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | ✅ Done | `b77990f` |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | ✅ Done | `b77990f` |
| `.github/PROJECT_BOARD_PLATFORM.md` | ✅ Done | `da1ced1` |
| `.github/PROJECT_BOARD_SECURITY.md` | ✅ Done | `da1ced1` |
| `.github/MASTER_TRACKER.md` | ✅ Done | this commit |
| Branch protection on `main` | ❌ Pending | Issue #12 — human action required |

---

## 🧠 Section 3 — Source Modules (`src/`)

### 3.1 Core

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/index.ts` | ✅ Enhanced | `b77990f` | `console.error` → logger; registers `audit-log` and `secret-store` shutdown hooks |
| `src/config.ts` | ✅ Enhanced | `e41a252` | dotenv fixed, 10 new vars, production guards |
| `src/core/server.ts` | ✅ Enhanced | `c85d981` | MCP_TRANSPORT gate, SSE, config-driven rate limits, 404/error middleware |
| `src/core/runtime-manager.ts` | ✅ Enhanced | `b77990f`, `6643e8a` | `eventsAdapter`/`graphqlAdapter`/`cliAdapter`/`credentialBroker` init/shutdown wired; `providerRouter.startHealthChecks()`/`stopHealthChecks()` wired |
| `src/core/lifecycle.ts` | ✅ Wired | `b77990f` | `auditLog.flush()` + `secretStore.clear()` registered as shutdown hooks from `src/index.ts` |

### 3.2 Types

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/types/index.ts` | ✅ Done | `a2f4075` | All shared enums/interfaces |

### 3.3 Normalization

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/normalization/request-normalizer.ts` | ✅ Done | pre-existing | |
| `src/normalization/schema-reconciler.ts` | ✅ Done | pre-existing | |
| `src/normalization/protocol-adapters/{json-rpc,rest,graphql,mcp}.ts` | ✅ Done | `8d52e35` | 4 protocol normalizers |

### 3.4 Discovery

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/discovery/registry-manager.ts` | ✅ Enhanced | `bdb3445` | Now extends `EventEmitter`, emits `discovery:complete`; manager-level cache (`config.CACHE_TTL`-driven, cleared on registry add/remove); enterprise catalog registered via new adapter |
| `src/discovery/enterprise-catalog-adapter.ts` | ✅ Done (new) | `bdb3445` | Bridges `EnterpriseCatalogConnector` (`IRegistryConnector`) to `Registry` — these two registry interfaces were never compatible before this adapter |
| `src/discovery/github-registry.ts` | ✅ Done | pre-existing | |
| `src/discovery/official-registry.ts` | ✅ Done | pre-existing | |
| `src/discovery/local-scanner.ts` | ✅ Done | pre-existing | |
| `src/discovery/enterprise-catalog.ts` | ✅ Done | `8d52e35` | HTTP + file-based, Zod validation, node-cache TTL |

### 3.5 Provisioning

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/provisioning/installer.ts` | ⚠️ Bug fixed, feature work open | `6643e8a` | Fixed nonexistent `auditLogger.log({...})` → real `auditLog.record(...)` (3 sites); `approvalGate.request()` now correct against new facade. **Still open (Issue #7)**: rollback, SHA-256 checksum, install lock, `dryRun`. **Unverified**: `trustEvaluator`, `policyEngine`, `dependencyResolver`, `configGenerator`, `runtimeRegistrar` integration was not independently re-read this session |
| `src/provisioning/dependency-resolver.ts` | ✅ Done | pre-existing | Not independently re-verified this session |
| `src/provisioning/runtime-registrar.ts` | ✅ Done | pre-existing | Not independently re-verified this session |
| `src/provisioning/config-generator.ts` | ✅ Done | pre-existing | Not independently re-verified this session |

### 3.6 Routing

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/routing/provider-router.ts` | ✅ Enhanced | `bdb3445` | Real `CircuitBreakerState` (CLOSED/OPEN/HALF_OPEN) machine, opens after 5 consecutive failures, 30s cooldown to HALF_OPEN trial; `startHealthChecks()`/`stopHealthChecks()` (default 60s, idempotent); `getMetrics(id)` — request/failure counts + p50/p95/p99 from a 200-sample rolling window |
| `src/routing/scheduler.ts` | ✅ Done | pre-existing | |
| `src/routing/capability-selector.ts` | ✅ Done | pre-existing | |

### 3.7 Policy

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/policy/policy-engine.ts` | ⚠️ Needs enhancement | pre-existing | Still needs: JSON pack loading, hot-reload, `explainDecision`, metrics — Issue #8, not touched |
| `src/policy/trust-evaluator.ts` | ⚠️ Needs full implementation | pre-existing | Full 10-stage pipeline — Issue #14, not touched |
| `src/policy/approval-gates.ts` | ✅ Enhanced | `b77990f`, `6643e8a` | Sync/async flows + Admin API sub-router; added `metadata?` param, `requestAndWait()`, and the `approvalGate` singular facade matching installer.ts's blocking contract |

### 3.8 Security

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/security/crypto.ts` | ✅ Done | `e41a252` | AES-256-GCM, scrypt, `generateSecureToken`, `constantTimeEqual`, `hmac`/`verifyHmac` |
| `src/security/audit.ts` | ✅ Enhanced | `b77990f` | HMAC-signed entries, `flush()`, bounded ring buffer + `getRecent()` |
| `src/security/credential-broker.ts` | ✅ Done | `b77990f` | Scope-enforced issue/retrieve/rotate/revoke, wired into `runtime-manager.ts` |
| `src/security/secret-store.ts` | ✅ Done | `b77990f` | In-memory AES-256-GCM, TTL, `rotateEncryption()` |

### 3.9 Orchestration

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/orchestration/task-graph.ts` | ✅ Done | pre-existing | |
| `src/orchestration/agent-router.ts` | ✅ Done | pre-existing | |
| `src/orchestration/execution-planner.ts` | ✅ Done | pre-existing | |
| `src/orchestration/workflow-engine.ts` | ✅ Enhanced | `bdb3445` | DLQ at `runtime/workflow-dlq.jsonl`; per-step `retryPolicy` with exponential backoff; run state persisted to `runtime/workflows/<runId>.json` + `loadPersistedRun()`; `cancelWorkflow(runId)` (stops before next step, in-flight step finishes); full event set: `workflow:started`, `workflow:step:complete`, `workflow:step:failed`, `workflow:complete`, `workflow:cancelled` |

### 3.10 Observability

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/observability/logger.ts` | ✅ Done | `e41a252` | Daily rotation, redaction, requestId/correlationId child loggers |
| `src/observability/metrics.ts` | ✅ Done | pre-existing | |
| `src/observability/tracing.ts` | ✅ Done | pre-existing | |
| `src/observability/cost-monitor.ts` | ✅ Done | `8d52e35` | Live behind `GET /admin/costs` |

### 3.11 Adapters

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/adapters/mcp/index.ts` | ✅ Done | pre-existing | |
| `src/adapters/rest/index.ts` | ✅ Done | pre-existing | |
| `src/adapters/graphql/index.ts` | ✅ Done | `ec4a88` | init/shutdown wired from `runtime-manager.ts` |
| `src/adapters/cli/index.ts` | ✅ Done | `ec4a88` | init/shutdown wired from `runtime-manager.ts` |
| `src/adapters/events/index.ts` | ✅ Done | `ec4a88` | Router mounted at `/adapters/events`; init/shutdown wired |

### 3.12 API

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/api/health.ts` | ✅ Done | `e41a252` | `/health`, `/health/live`, `/health/ready` |
| `src/api/admin-api.ts` | ✅ Enhanced | `b77990f` | `/policies`, `/costs`, `/audit` wired to real data; `/approvals/*` mounted |
| `src/api/status.ts` | ✅ Done | pre-existing | |

---

## 🧪 Section 4 — Test Files (`tests/`)

| File | Status | Commit | Coverage Focus |
|---|---|---|---|
| `tests/crypto.test.ts` | ✅ Done | pre-existing | |
| `tests/metrics.test.ts` | ✅ Done | pre-existing | |
| `tests/policy-engine.test.ts` | ✅ Done | pre-existing | |
| `tests/request-normalizer.test.ts` | ✅ Done | pre-existing | |
| `tests/scheduler.test.ts` | ✅ Done | pre-existing | |
| `tests/schema-reconciler.test.ts` | ✅ Done | pre-existing | |
| `tests/task-graph.test.ts` | ✅ Done | pre-existing | |
| `tests/trust-evaluator.test.ts` | ✅ Done | pre-existing | |
| `tests/config.test.ts` | ✅ Done | `fca8e4b` | 14 cases |
| `tests/cost-monitor.test.ts` | ✅ Done | `fca8e4b` | 8 cases |
| `tests/cli-adapter.test.ts` | ✅ Done | `fca8e4b` | 10 cases |
| `tests/admin-api.test.ts` | ✅ Done | `fca8e4b` | JWT validation |
| `tests/protocol-adapters.test.ts` | ✅ Done | `fca8e4b` | 20 cases |
| `tests/secret-store.test.ts` | ✅ Done | `b77990f` | 7 cases |
| `tests/credential-broker.test.ts` | ✅ Done | `b77990f` | 7 cases |
| `tests/approval-gates.test.ts` | ✅ Done | `b77990f` | 8 cases |
| `tests/registry-manager.test.ts` | ✅ Done | `6643e8a` | 8 cases: merge, single-failure isolation, dedup, unavailable skip, cache TTL, `discovery:complete`, `listAll` dedup, cache-clear on `removeRegistry` |
| `tests/workflow-engine.test.ts` | ✅ Done | `6643e8a` | 11 cases: sequential exec, unknown/disabled throws, retry-then-fail with attempt count, `onFailure` routing, throw-no-handler, `cancelWorkflow`, cancel-unknown throws, getWorkflow/listWorkflows, started/complete events, run history |
| `tests/provider-router.test.ts` | ✅ Done | `6643e8a` | 10 cases: routing, fallback, no-provider, breaker opens, open-breaker skipped, success resets counter, `getMetrics`, `registerProvider`, health-check idempotency, `listProviders` |
| `tests/installer.test.ts` | ❌ Not created | — | Deferred — installer.ts's deeper dependencies need verification first; writing tests against unverified integration points would give false confidence |
| `tests/events-adapter.test.ts` | ❌ Not created | — | Issue #19 |

---

## 📚 Section 5 — Documentation (`docs/`)

| File | Status | Commit |
|---|---|---|
| `docs/architecture.md` | ✅ Done | `a71f208` |
| `docs/security.md` | ✅ Done | `a71f208` |
| `docs/api.md` | ✅ Done | `a71f208` |
| `docs/deployment.md` | ✅ Done | `a71f208` |

> ⚠️ Not re-verified this session against the workflow-engine/provider-router/registry-manager enhancements above — `docs/architecture.md`'s "Request Lifecycle" and `docs/api.md` may not yet describe the new events, circuit-breaker states, or `discovery:complete` event.

---

## 📋 Section 6 — Open Issues

| # | Title | Board | Priority | Status |
|---|---|---|---|---|
| [#2](../../issues/2) | Create GitHub Actions workflow files | Platform | 🔴 Critical | ✅ Resolved — recommend closing |
| [#4](../../issues/4) | registry-manager: parallel discovery + dedup | Platform | 🔴 High | ✅ Resolved in `bdb3445` — recommend closing |
| [#5](../../issues/5) | workflow-engine: DLQ, retry, state, cancel | Platform | 🔴 High | ✅ Resolved in `bdb3445` — recommend closing |
| [#6](../../issues/6) | provider-router: circuit breaker + health checks | Platform | 🔴 High | ✅ Resolved in `bdb3445` — recommend closing |
| [#7](../../issues/7) | installer: rollback, checksum, lock, dry-run | Platform | 🔴 High | ⚠️ Compile-blocking bug fixed in `6643e8a`; feature work still open — do NOT close |
| [#8](../../issues/8) | policy-engine: JSON packs, hot-reload, explainDecision | Platform | 🟡 Medium | Still open |
| [#9](../../issues/9) | wire adapters + monitors into runtime lifecycle | Platform | 🔴 High | ✅ Resolved in `b77990f` — recommend closing |
| [#10](../../issues/10) | complete remaining test files | Platform | 🟡 Medium | 3 of 4 done this session (registry-manager, workflow-engine, provider-router); `installer.test.ts` still blocked on Issue #7 verification pass |
| [#11](../../issues/11) | create all GitHub Actions workflow files | Platform | 🔴 Critical | ✅ Resolved — duplicate of #2; recommend closing |
| [#12](../../issues/12) | configure branch protection on main | Platform | 🔴 High | Still open — human action, unblocked now that CI is live |
| [#13](../../issues/13) | credential-broker: scoped access + rotation | Security | 🔴 Critical | ✅ Resolved in `b77990f` — recommend closing |
| [#14](../../issues/14) | trust-evaluator: full 10-stage pipeline | Security | 🔴 Critical | Still open |
| [#15](../../issues/15) | approval-gates: sync/async + Admin API | Security | 🔴 High | ✅ Resolved in `b77990f` — recommend closing |
| [#16](../../issues/16) | audit log retention + HMAC verify script | Security | 🟡 Medium | Still open — `getRecent()` exists; standalone verify script not written |
| [#17](../../issues/17) | production hardening: helmet, CORS, headers | Security | 🔴 High | Still open |
| [#18](../../issues/18) | zero-downtime key rotation procedure | Security | 🔴 High | Still open — `secretStore.rotateEncryption()` exists; runbook script not written |
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

| SHA | Message | Key Changes |
|---|---|---|
| `499128c` | fix: ts-jest aligned, license Apache-2.0, deps | First batch of bug fixes |
| `2778f70` | chore: tsconfig hardened | Strict flags, path aliases |
| `56140b8` | docs: AGENTS.md | 11-section AI agent instruction manifest |
| `fa095e4` | fix(p1): TS `^5.7.3`, harden configs, fix README | Version fixes, gitignore, eslint, env.example |
| `44bf67f` | docs: CONTRIBUTING, SECURITY, CHANGELOG, CoC | Community docs |
| `a2f4075` | feat: Dockerfile, docker-compose, types | Multi-stage Docker, shared types |
| `e41a252` | fix+feat: config, logger, crypto, audit, health | dotenv fix, log rotation, AES-256-GCM, HMAC audit |
| `c85d981` | feat: server.ts + admin-api.ts | MCP_TRANSPORT gate, SSE, JWT auth |
| `8d52e35` | feat: enterprise-catalog, cost-monitor, protocol adapters | 4 new modules + 4 normalizers |
| `ec4a88` | feat: CLI, Events, GraphQL adapters | Spawn CLI, HMAC webhook, GraphQL introspect |
| `fca8e4b` | test: 5 new test files | config, cost-monitor, cli-adapter, admin-api, protocol-adapters |
| `a71f208` | docs: architecture, security, api, deployment | Full docs suite |
| `da1ced1` | docs: project boards | Platform Build, Security boards |
| `586ebd9` | feat: consolidate Universal MCP Hub work | GitHub OpenAPI adapters migrated from `mcp` repo |
| `b77990f` | feat(security,policy): credential-broker, secret-store, approval-gates | Issues #9 #13 #15; admin-api wired to live data |
| `8cfd69a` | docs: MASTER_TRACKER.md refresh | Corrected stale GitHub-infra status |
| `4c5d014` | docs(changelog): document 2026-09-10 session | |
| `bdb3445` | feat(discovery,orchestration,routing): enterprise-catalog, workflow-engine DLQ/retry, provider-router circuit breaker | Issues #4 #5 #6 |
| `6643e8a` | fix(installer): auditLog API mismatch; feat(policy): approval-gates facade; wire provider-router health checks | Issue #7 partial, runtime-manager wiring, 3 new test files |

---

## 🚦 Section 9 — What Needs To Happen Next

### Immediate
- [ ] **Issue #12** — branch protection on `main` (CI confirmed live)
- [ ] Close #2, #4, #5, #6, #9, #11, #13, #15 (resolved across the last two sessions — needs a maintainer with issue-write access)

### High Priority
- [ ] **Issue #7 (remaining)** — installer.ts rollback + checksum + lock + dry-run. Before starting: read `trust-evaluator.ts`, `policy-engine.ts`, `dependency-resolver.ts`, `config-generator.ts`, `runtime-registrar.ts` in full — installer.ts's calls into all five were taken on faith this session and not independently verified beyond the audit/approval fixes
- [ ] **Issue #14** — full 10-stage trust pipeline
- [ ] **Issue #17** — production hardening pass

### Medium Priority
- [ ] **Issue #8** — policy-engine JSON pack loading + hot-reload
- [ ] **Issue #10** — `tests/installer.test.ts` (blocked on Issue #7 verification), `tests/events-adapter.test.ts` (Issue #19)
- [ ] **Issue #16 / #18** — `scripts/verify-audit-log.ts`, `scripts/rotate-encryption-key.ts` (underlying primitives already exist)
- [ ] Confirm `docs/architecture.md` / `docs/api.md` still match the new workflow-engine events, circuit-breaker states, and `discovery:complete` event

### Deferred
- [ ] Quality & Technical Debt / Docs & DX / Release & Ecosystem Roadmap boards
- [ ] Coverage threshold raise: 60% → 80%
- [ ] `policies/default.json` example policy pack
- [ ] npm publish checklist

---

## 🏁 Section 10 — Release Gates

### `v0.1.0` Gate — Platform Stable

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run test:ci` exits 0, all present test files passing
- [ ] `npm run build` exits 0, `dist/index.js` present
- [ ] Docker image builds and container starts without error
- [ ] `GET /health/live` returns 200
- [ ] `GET /health/ready` returns 200 after runtime init
- [ ] `GET /admin/capabilities` returns 401 without token, 200 with valid token
- [x] All GitHub Actions workflows live on `main`
- [ ] Branch protection rules active on `main`
- [ ] No open issues labelled `priority-critical`
- [x] Issues #4 #5 #6 #9 addressed (pending manual close)
- [ ] Issue #7 fully closed (feature work remaining)

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
