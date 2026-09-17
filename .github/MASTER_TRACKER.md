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

> **Session note (2026-09-16)**: Closed Issues #4, #5, #6 in full. `registry-manager.ts` already had `Promise.allSettled` + dedup from a prior session (Issue #4 was stale on that point) — what was genuinely missing was enterprise-catalog registration (blocked by a real interface mismatch: `EnterpriseCatalogConnector` implements `IRegistryConnector` from `types/index.ts`, but `registry-manager.ts` consumes the unrelated `Registry` interface from `discovery/types.ts` — fixed via a new `enterprise-catalog-adapter.ts` bridge), manager-level caching, and `discovery:complete` event emission. `workflow-engine.ts` got the full Issue #5 treatment: DLQ (`runtime/workflow-dlq.jsonl`), exponential backoff retry per step, JSON state persistence per run, `cancelWorkflow(runId)`, and the full event set. `provider-router.ts` got the full Issue #6 treatment: a real CLOSED/OPEN/HALF_OPEN circuit breaker, a start/stop-able background health-check loop, and p50/p95/p99 latency + request/failure counters per provider; wired into `runtime-manager.ts` start/stop. **Also found and fixed a real, pre-existing compile-blocking bug**: `src/provisioning/installer.ts` imported a nonexistent `auditLogger` export and called a nonexistent `.log({...})` method — the actual module exports `auditLog` with `.record(action, actor, resource, outcome, correlationId?, meta?)`. Fixed the three call sites. Installer.ts also called `approvalGate.request(...)` (singular, 5-arg, blocking) against what was a non-blocking `approvalGates` (plural) API — added a `requestAndWait()` method and an `approvalGate` facade object that preserves the blocking blocking-until-decided-or-throw contract installer.ts depends on for its safety-critical approval gate. **Issue #7 (installer rollback/checksum/lock/dry-run) is still open** — only the compile-blocking audit/approval bugs were fixed, not the feature work, and `trustEvaluator.evaluate()/getMinimumRequired()`, `policyEngine.evaluate()`, `dependencyResolver.resolve()`, `configGenerator.generate()`, and `runtimeRegistrar.register()/unregister()/list()` were NOT independently verified this session — installer.ts may still have other integration issues against those five modules that weren't checked.

---

## 🏗️ Section 2 — GitHub Infrastructure

**100%** — unchanged this session. See prior entry for full file list.

| Item | Status |
|---|---|
| All 8 workflow files (`ci`, `codeql`, `dependency-review`, `release`, `deploy-preview`, `deploy-production`, `scorecard`, `stale`) | ✅ Done |
| `dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`, 2× `ISSUE_TEMPLATE/*.yml` | ✅ Done |
| Project boards, `MASTER_TRACKER.md` | ✅ Done |
| Branch protection on `main` | ❌ Pending — human action required |

---

## 🧠 Section 3 — Source Modules (`src/`) — changes this session only

> Unlisted files are unchanged from the previous session's tracker entry.

| File | Status | Commit | Notes |
|---|---|---|---|
| `src/discovery/registry-manager.ts` | ✅ Enhanced | `bdb3445` | Now extends `EventEmitter`, emits `discovery:complete` after `search()`/`listAll()`; added manager-level result cache (`config.CACHE_TTL`-driven, cleared on registry add/remove); enterprise catalog now actually registered via the new adapter below |
| `src/discovery/enterprise-catalog-adapter.ts` | ✅ Done (new) | `bdb3445` | Bridges `EnterpriseCatalogConnector` (`IRegistryConnector`, `discover()`) to `Registry` (`search/getById/list/isAvailable`) — the two interfaces this codebase uses for registries were never compatible before this adapter existed |
| `src/orchestration/workflow-engine.ts` | ✅ Enhanced | `bdb3445` | DLQ at `runtime/workflow-dlq.jsonl` for steps that exhaust retries; per-step `retryPolicy` (maxRetries/initialDelayMs/backoffMultiplier) with exponential backoff; run state persisted to `runtime/workflows/<runId>.json` + `loadPersistedRun()`; `cancelWorkflow(runId)` (stops before the *next* step — an in-flight step is allowed to finish); full event set: `workflow:started`, `workflow:step:complete`, `workflow:step:failed`, `workflow:complete`, `workflow:cancelled` |
| `src/routing/provider-router.ts` | ✅ Enhanced | `bdb3445` | Real `CircuitBreakerState` (CLOSED/OPEN/HALF_OPEN) state machine per provider, opens after 5 consecutive failures, 30s cooldown before a HALF_OPEN trial; `startHealthChecks()`/`stopHealthChecks()` background loop (default 60s, idempotent); `getMetrics(id)` returns request/failure counts and p50/p95/p99 latency from a 200-sample rolling window |
| `src/policy/approval-gates.ts` | ✅ Enhanced | `6643e8a` | Added `metadata?` param to `request()`, a `requestAndWait()` combined create-and-block method, and an `approvalGate` (singular) facade matching the blocking contract `installer.ts` was already written against |
| `src/provisioning/installer.ts` | ⚠️ Bug fixed, feature work still open | `6643e8a` | Fixed: nonexistent `auditLogger.log({...})` → real `auditLog.record(...)` (3 call sites); `approvalGate.request()` call site now correct against the new facade. **Still open (Issue #7)**: rollback on partial install failure, SHA-256 checksum verification, install lock file, `dryRun` option. **Unverified this session**: integration with `trustEvaluator`, `policyEngine`, `dependencyResolver`, `configGenerator`, `runtimeRegistrar` — not independently read/confirmed |
| `src/core/runtime-manager.ts` | ✅ Enhanced | `6643e8a` | `providerRouter.startHealthChecks()` called in `initialize()`, `providerRouter.stopHealthChecks()` called in `shutdown()` |

---

## 🧪 Section 4 — Test Files — changes this session only

| File | Status | Commit | Coverage Focus |
|---|---|---|---|
| `tests/registry-manager.test.ts` | ✅ Done | `6643e8a` | 8 cases: merge across registries, single-failure isolation, dedup keeps higher-trust source, unavailable registry skipped, cache prevents re-invocation within TTL, `discovery:complete` emitted, `listAll` dedup, cache cleared on `removeRegistry` |
| `tests/workflow-engine.test.ts` | ✅ Done | `6643e8a` | 11 cases: sequential execution, unknown/disabled workflow throws, retry-then-fail with attempt count, `onFailure` routing, throw-with-no-handler, `cancelWorkflow` mid-run, cancel-unknown-run throws, `getWorkflow`/`listWorkflows`, `workflow:started`/`workflow:complete` events, run history accumulation |
| `tests/provider-router.test.ts` | ✅ Done | `6643e8a` | 10 cases: capability routing, fallback chain, no-provider-found, circuit opens after threshold, open breaker skipped in routing, successful call resets failure count, `getMetrics` counts + percentiles, `registerProvider`, health-check start/stop idempotency, `listProviders` |
| `tests/installer.test.ts` | ❌ Not created | — | Deferred — installer.ts's deeper dependencies (trustEvaluator, policyEngine, dependencyResolver, configGenerator, runtimeRegistrar) need to be verified/mocked correctly first; writing tests against unverified integration points would give false confidence |

---

## 📋 Section 6 — Open Issues — changes this session only

| # | Title | Status |
|---|---|---|
| [#4](../../issues/4) | registry-manager: parallel discovery + dedup | ✅ Resolved in `bdb3445` — recommend closing (parallel/dedup existed already; enterprise-catalog registration + caching + event were the real gaps, now closed) |
| [#5](../../issues/5) | workflow-engine: DLQ, retry, state, cancel | ✅ Resolved in `bdb3445` — recommend closing |
| [#6](../../issues/6) | provider-router: circuit breaker + health checks | ✅ Resolved in `bdb3445` — recommend closing |
| [#7](../../issues/7) | installer: rollback, checksum, lock, dry-run | ⚠️ Partially addressed in `6643e8a` — a compile-blocking bug (wrong audit API) was fixed, but the rollback/checksum/lock/dry-run feature work itself is untouched. **Do not close.** |

All other rows unchanged from the previous session — see that entry for #2, #8–#19.

---

## 🔢 Section 8 — Commit History — additions this session

| SHA | Message | Key Changes |
|---|---|---|
| `bdb3445` | feat(discovery,orchestration,routing): enterprise-catalog registration, workflow-engine DLQ/retry/persistence/cancel, provider-router circuit breaker | Issues #4, #5, #6 |
| `6643e8a` | fix(installer): correct auditLog API mismatch; feat(policy): approval-gates blocking facade; wire provider-router health checks | Issue #7 (partial — bug fix only), runtime-manager wiring, 3 new test files |

---

## 🚦 Section 9 — What Needs To Happen Next (updated)

### Immediate
- [ ] **Issue #12** — branch protection on `main` (CI confirmed live)
- [ ] Close #2, #4, #5, #6, #9, #11, #13, #15 (all resolved across the last two sessions — needs a maintainer with issue-write access)

### High Priority
- [ ] **Issue #7 (remaining)** — installer.ts rollback + checksum + lock + dry-run. Before starting: read `trust-evaluator.ts`, `policy-engine.ts`, `dependency-resolver.ts`, `config-generator.ts`, `runtime-registrar.ts` in full — installer.ts's calls into all five were taken on faith this session and were not independently verified beyond the audit/approval fixes
- [ ] **Issue #14** — full 10-stage trust pipeline in `trust-evaluator.ts`
- [ ] **Issue #17** — production hardening pass

### Medium Priority
- [ ] **Issue #8** — policy-engine JSON pack loading + hot-reload
- [ ] **Issue #10** — remaining test file: `tests/installer.test.ts` (blocked on the Issue #7 verification pass above), plus `tests/events-adapter.test.ts` (Issue #19)
- [ ] **Issue #16 / #18** — `scripts/verify-audit-log.ts` and `scripts/rotate-encryption-key.ts` runbook scripts (underlying primitives — `auditLog.getRecent()`, `secretStore.rotateEncryption()` — already exist)

### Deferred
- [ ] Quality & Technical Debt / Docs & DX / Release & Ecosystem Roadmap boards (create)
- [ ] Coverage threshold raise: 60% → 80%
- [ ] `policies/default.json` example policy pack (needed once #8 lands)

---

*Everything above Section 2 that isn't listed as changed this session is carried forward unmodified from the 2026-09-10 entry — see repository history for that full text.*

*This tracker is maintained by the US-SPURS / UniversalStandards engineering team.*  
*Update this file at the end of every work session before closing context.*
