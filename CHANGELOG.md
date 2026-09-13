# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
