# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- `AGENTS.md` — AI coding agent instruction manifest
- GitHub Actions CI, CodeQL, Release, Dependency Review workflows (see Issue #2 for content)
- `.github/dependabot.yml` — weekly automated dependency updates
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
- Expanded test suite: config, registry-manager, installer, workflow-engine, provider-router, cost-monitor, admin-api, cli-adapter

### Fixed
- License mismatch: README badge and package.json corrected to Apache-2.0
- TypeScript version: corrected from non-existent `^6.0.2` to `^5.7.3`
- Jest/ts-jest pinned to `^29.x` for stability
- `dotenv` double-initialization removed from `src/config.ts`
- MCP stdio transport gated on `MCP_TRANSPORT=stdio` env var
- Hardcoded rate limits moved to configurable env vars

### Changed
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
- `src/discovery/registry-manager.ts` parallel discovery with `Promise.allSettled`
- `src/orchestration/workflow-engine.ts` DLQ, retry/backoff, state persistence, cancellation
- `src/routing/provider-router.ts` circuit breaker and background health checks
- `src/policy/policy-engine.ts` policy pack hot-reload
- `src/provisioning/installer.ts` rollback, checksum verification, install lock

---

## [0.1.0] — 2026-01-01

### Added
- Initial scaffold: all source modules
- MCP adapter, REST adapter, Zod config, Winston logging
- Policy engine, discovery, provisioning, execution planner, workflow engine
- Initial test suite
