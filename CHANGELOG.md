# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added — 2026-10-01 session
- `src/adapters/upcloud-worker-factory/index.ts` — ephemeral browser/desktop worker session adapter (UpCloud worker fleet), implemented against the frozen interface contract in `docs/gates/upcloud-worker-factory.md`: session create/end (`createSession`/`endSession`/`getSession`/`listSessions`), worker-session-scoped JWT issuance/verification reusing the existing `JWT_SECRET` convention, and Vault AppRole dynamic-secret leasing brokered entirely through the existing `credentialBroker` (no parallel secret path). Default-off (`ENABLE_UPCLOUD_WORKER_FACTORY=false`).
- `docs/gates/upcloud-worker-factory.md` — the frozen v1 interface contract (auth handshake / provider registration / credential lease protocol) this hub's own open work and the UpCloud-side broker/pool build can both proceed against in parallel without blocking each other
- `src/config.ts` — `ENABLE_UPCLOUD_WORKER_FACTORY`, `UPCLOUD_BROKER_URL`, `UPCLOUD_BROKER_API_KEY`, `WORKER_SESSION_DEFAULT_TTL_MS`, `WORKER_SESSION_MAX_TTL_MS`, `WORKER_POOL_WARM_SIZE`, `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `VAULT_SECRET_MOUNT`, plus a production guard requiring the broker/Vault vars when the feature is enabled
- `src/types/index.ts` — `WorkerSessionCapability`, `WorkerSessionState`, `WorkerSessionHandle`, `CredentialScopeRef`
- `tests/upcloud-worker-factory.test.ts` — 10 cases against a mocked broker/Vault HTTP surface (no live UpCloud/Vault account exists yet to integration-test against)
- `src/core/runtime-manager.ts` — `upcloudWorkerFactoryAdapter` wired into `initialize()`/`shutdown()`/`getStatus()` following the existing adapter pattern; shuts down before `credentialBroker` so its own leased scopes can be revoked

### Fixed — 2026-10-01 session
- `src/provisioning/runtime-registrar.ts` — imported a nonexistent `auditLogger` export and called a nonexistent `.log({...})` method (4 call sites); the real module exports `auditLog` with `.record(action, actor, resource, outcome, correlationId?, meta?)`. This is the same bug class `6643e8a` fixed in `installer.ts`, but this file was marked "✅ Done | pre-existing | not independently re-verified" in `MASTER_TRACKER.md` and was never actually caught — it does not compile as of the last session's commit.
- `src/provisioning/runtime-registrar.ts` — `RegisteredTool.process`/`.pid`/`.errorMessage` were declared with `?` (optional-may-be-omitted) but the class clears them to an explicit `undefined` in place as the process lifecycle transitions; under `exactOptionalPropertyTypes` that is a type error. Declared as `T | undefined` instead, matching the actual mutable-field usage.
- `src/security/secret-store.ts` — `set()` assigned an explicit `undefined` to the optional `expiresAt` field; now omits the key entirely when there is no TTL.
- `src/discovery/enterprise-catalog.ts` — `parseCatalog()` had the same explicit-`undefined`-into-optional-field issue for `packageName`/`repositoryUrl`/`trustScore`.

### ⚠️ Known issue discovered — 2026-10-01 session (not fixed this session, out of scope for the worker-factory task)
`npm run typecheck` / `npm run build` do not currently pass for the whole project, and were not introduced by anything above — every file touched or added this session typechecks and tests cleanly in isolation (`tests/upcloud-worker-factory.test.ts`, `tests/secret-store.test.ts`, `tests/credential-broker.test.ts` all pass). The pre-existing cause: at least **`src/adapters/cli/index.ts`, `src/discovery/enterprise-catalog-adapter.ts`, `src/discovery/github-registry.ts`, `src/discovery/local-scanner.ts`, `src/discovery/official-registry.ts`, `src/normalization/request-normalizer.ts`, `src/orchestration/workflow-engine.ts`, `src/routing/capability-selector.ts`, `src/routing/provider-router.ts`** have the same `exactOptionalPropertyTypes` violation class just fixed above (an explicit `undefined` assigned into a `?`-declared field) or other strict-mode errors (`workflow-engine.ts` also needs an `override` modifier on an `EventEmitter` member; `capability-selector.ts` has unguarded possibly-`undefined` access). `tests/registry-manager.test.ts` — marked "✅ Done, 8 cases" in `MASTER_TRACKER.md` — does not actually run; its suite fails at the `github-registry.ts` compile error before any test executes. Attempting `tsc --noEmit` across the whole ~70-file `src/` tree reliably OOMs (confirmed up to 8GB heap in this environment) rather than reporting all of the above at once — almost certainly the cumulative cost of TypeScript's structural-diff error message formatting across this many simultaneous `exactOptionalPropertyTypes`/`exactOptionalPropertyTypes`-adjacent failures, not an infinite loop. Recommend a dedicated session to sweep all of `src/` for this one error class on a machine with more headroom (or bisect-and-fix file-by-file as done here), since `MASTER_TRACKER.md`'s "94%, all green" status is not currently accurate — the project has likely never had a fully green `npm run typecheck` since `exactOptionalPropertyTypes` was turned on in `fa095e4`.

### Changed — 2026-10-01 session
- Renamed product branding from "Universal MCP Orchestration Hub" / repo nickname "IDEA" to **Universal Standard MCP Server** (Director-authorized, absorbing `Universal-Standard/Universal-Standard-MCP-Server` per `docs/CONSOLIDATION.md`) — `package.json` (`name`, `description`), `README.md` (title, intro, comparison table, architecture diagram, new §4.9), `AGENTS.md` header. The GitHub repo slug (`UniversalStandards/IDEA`) is **unchanged** in this pass — all clone URLs, CI badge links, and issue/discussion links in `README.md` still correctly point at it; renaming the slug itself is a separate, human-initiated action (GitHub Settings → repository name) left for the Director to do directly since it affects external links beyond this repo's own docs.
- `package-lock.json` — `name` fields updated to `universal-standard-mcp-server` to match the `package.json` rename above (flagged by Copilot's PR review; missed in the first pass).

### Fixed — 2026-10-01 session (PR #173 review response)
- `src/adapters/upcloud-worker-factory/index.ts` — `BrokerSessionResponseSchema.endpoint` validated only `z.string().url()`, which accepts any scheme (`https://`, `file://`, …) for what is always meant to be a `wss://` CDP endpoint; a compromised or misbehaving broker response would have passed validation and been handed back as something to connect to. Added a refinement requiring the `wss://` scheme. (Codex/Copilot finding.)
- `src/adapters/upcloud-worker-factory/index.ts` — `createSession()` had no rollback path: if Vault leasing failed *after* the broker already allocated a worker for the session, that worker was never torn down (nothing had added the session to `this.sessions` yet, so neither `endSession()` nor `shutdown()` could ever find it), and any credential scopes already issued for earlier paths in a multi-secret request were left live with nothing able to reach or revoke them. `leaseVaultSecrets()` now rolls back its own partially-issued scopes on a mid-loop failure, and `createSession()` now tears down the broker session on any post-allocation failure before rethrowing. (Codex P1 finding.)
- `src/api/admin-api.ts` — `requireAuth` verified only the JWT signature, not its `scope` — since every bearer token this hub issues is signed with the same `JWT_SECRET`, a worker-session token (minted by the adapter above) could be replayed against the Admin API and would pass as authenticated, reaching capability deletion, approvals, and audit data. `requireAuth` now explicitly rejects any token carrying `scope: 'worker-session'` with 403. (Codex P1 finding — security.)
- `src/api/admin-api.ts` — `GET /admin/capabilities`'s existence check accessed a `Record<string, unknown>` index-signature property with dot notation (`...).getCapabilities`), which is a compile error on this project's strict config; switched to bracket notation. Trivial, but it was blocking `tests/admin-api.test.ts` from running at all (ts-jest fails the whole suite on any compile error in the file under test), which in turn was blocking verification of the fix directly above — fixed in the same file this PR already touches, not a scope expansion.
- `tests/upcloud-worker-factory.test.ts` — fixtures built `expiresAt` from live `Date.now()` calls with no fixed clock, and the adapter's own internal `Date.now()` reads (duration metrics, Vault-token cache expiry) were equally non-deterministic; `AGENTS.md` §8 requires tests to be deterministic ("no `Date.now()` ... without mocking"). Pinned the clock with `jest.useFakeTimers({ now: FIXED_NOW })` in `beforeEach`/`jest.useRealTimers()` in `afterEach`. (Codex P1 finding.)
- Added test coverage for all of the above: a rejected-insecure-endpoint case, a Vault-failure-after-allocation rollback case, a partial-multi-secret-rollback case, and two new `admin-api.test.ts` cases driving the real `requireAuth` middleware directly off `adminRouter`'s own stack (worker-session token → 403; ordinary admin token → still passes).

### ⚠️ Known issue, updated — 2026-10-01 session (PR #173 review response)
Fixing the `admin-api.ts` index-signature issue above (needed to unblock `tests/admin-api.test.ts`) exposed a **10th** file in the same pre-existing bug family: `src/policy/approval-gates.ts` (two more `exactOptionalPropertyTypes` violations — `metadata` and `decisionNote`), imported transitively via `adminRouter.use('/approvals', approvalGates.buildRouter())`. `tests/admin-api.test.ts` therefore still cannot run through the project's normal `npm run test` (ts-jest fails the whole suite on any compile error anywhere in the file's import graph) — confirmed via an isolated diagnostic run with `isolatedModules` that all 10 tests in that file, including the 2 new ones, pass once the unrelated compile error is bypassed. This does not change anything already recommended above: a dedicated session should sweep all ~10 now-identified files for this one error class.

### Added — 2026-09-10 session (`b77990f`, `8cfd69a`)
- `src/security/secret-store.ts` — in-memory AES-256-GCM secret store with TTL expiry and `rotateEncryption()` for zero-downtime key rotation
- `src/security/credential-broker.ts` — scope-enforced credential issue/retrieve/rotate/revoke with audit logging on every operation
- `src/policy/approval-gates.ts` — sync (`waitForDecision`, timeout → `TIMED_OUT`) and async (`decide()`) human/agent approval flows, mounted as an Admin API sub-router at `/admin/approvals`
- `src/security/audit.ts`: `getRecent(limit, offset, action?)` — bounded in-memory ring buffer read path
- `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`
- `tests/secret-store.test.ts`, `tests/credential-broker.test.ts`, `tests/approval-gates.test.ts`
- `adapters/github/*.yaml` — modular OpenAPI GitHub adapter (migrated from `UniversalStandards/mcp`), including a new `templates.yaml` for repo generate-from-template and fork operations
- `src/evolution/types.ts`, `docs/CONSOLIDATION.md` — Universal MCP Hub consolidation record

### Fixed — 2026-09-10 session
- Last remaining `console.error` in `src/index.ts` replaced with the structured logger
- `/admin/policies`, `/admin/costs`, `/admin/audit` were returning hardcoded stub data (`[]`, `0`, `"message": "available once wired"`) — now return real data from `policyEngine`, `costMonitor`, and `auditLog`
- Corrected `MASTER_TRACKER.md` Section 2, which had claimed all GitHub Actions workflows were blocked on a missing `workflow`-scope PAT — verified 8 of them were already live in `.github/workflows/`

### Changed — 2026-09-10 session
- `src/core/runtime-manager.ts` — `eventsAdapter`, `graphqlAdapter`, `cliAdapter`, `credentialBroker` are now initialized on startup and shut down on graceful shutdown; added as subsystems in `getStatus()`
- `src/index.ts` — registers `audit-log` (flush) and `secret-store` (clear) as lifecycle shutdown hooks
- `src/transport/http.ts` — mounts the events-adapter router at `/adapters/events`

### Added (prior sessions)
- `AGENTS.md` — AI coding agent instruction manifest
- GitHub Actions CI, CodeQL, Release, Dependency Review, Deploy Preview, Deploy Production, Scorecard, Stale workflows
- `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`
- `.nvmrc` — Node 20 LTS pin
- `Dockerfile` — multi-stage production container
- `docker-compose.yml` — local dev environment with Redis
- `src/types/index.ts` — shared TypeScript type definitions
- `src/discovery/enterprise-catalog.ts` — enterprise catalog connector
- `src/observability/cost-monitor.ts` — cost tracking and budget monitoring
- `src/adapters/cli/index.ts` — CLI tool adapter (spawn-based, injection-safe)
- `src/adapters/events/index.ts` — webhook and SSE event adapter
- `src/adapters/graphql/index.ts` — GraphQL endpoint adapter
- `src/normalization/protocol-adapters/` — JSON-RPC, REST, GraphQL, MCP normalizers
- `docs/architecture.md`, `docs/security.md`, `docs/api.md`, `docs/deployment.md`
- Test suite: config, cost-monitor, admin-api, cli-adapter, protocol-adapters, crypto, metrics, policy-engine, request-normalizer, scheduler, schema-reconciler, task-graph, trust-evaluator

### Fixed (prior sessions)
- License mismatch: README badge and package.json corrected to Apache-2.0
- TypeScript version: corrected from non-existent `^6.0.2` to `^5.7.3`
- Jest/ts-jest pinned to `^29.x` for stability
- `dotenv` double-initialization removed from `src/config.ts`
- MCP stdio transport gated on `MCP_TRANSPORT=stdio` env var
- Hardcoded rate limits moved to configurable env vars

### Changed (prior sessions)
- `tsconfig.json` hardened with strict flags and path aliases
- `eslint.config.js` updated to ESLint 9 flat config with stricter rules
- `.gitignore` fully hardened
- `.env.example` expanded with all new environment variables
- `README.md` restructured with Quick Start and updated project structure
- `src/api/health.ts` expanded with `/health/live` and `/health/ready`
- `src/api/admin-api.ts` protected with JWT Bearer authentication
- `src/observability/logger.ts` enhanced with daily rotation and redaction
- `src/security/crypto.ts` enhanced with `generateSecureToken`, `constantTimeEqual`, `deriveKey`
- `src/security/audit.ts` enhanced with HMAC signatures and `flush()` method

### Known open gaps (see `.github/MASTER_TRACKER.md` for full detail)
- `src/discovery/registry-manager.ts` — parallel discovery + dedup not yet implemented
- `src/orchestration/workflow-engine.ts` — DLQ, retry/backoff, state persistence, cancellation not yet implemented
- `src/routing/provider-router.ts` — circuit breaker + background health checks not yet implemented
- `src/provisioning/installer.ts` — rollback, checksum, lock, dry-run not yet implemented
- `src/policy/policy-engine.ts` — JSON policy-pack hot-reload not yet implemented
- `src/policy/trust-evaluator.ts` — full 10-stage trust pipeline not yet implemented
- Branch protection on `main` not yet configured (requires repo admin action)

---

## [0.1.0] — 2026-01-01

### Added
- Initial scaffold: all source modules
- MCP adapter, REST adapter, Zod config, Winston logging
- Policy engine, discovery, provisioning, execution planner, workflow engine
- Initial test suite
