# 🚀 Project Board 1 — Platform Build
## Universal MCP Orchestration Hub — Core Infrastructure

> **Purpose**: Tracks all technical implementation work to bring the platform from pre-alpha to a stable `0.1.0` release. Every card maps to a GitHub Issue. Priority order follows AGENTS.md Section 9.

---

## 🚨 Critical — Must Ship First

> Blocking everything downstream. Nothing merges until these are done.

| Issue | Title | Owner | Blocked By |
|---|---|---|---|
| [#11](../../issues/11) | Create all GitHub Actions workflow files | — | Needs workflow-scope PAT |
| [#12](../../issues/12) | Configure branch protection rules on `main` | — | #11 |
| [#9](../../issues/9) | Wire cost-monitor, events-adapter, graphql-adapter, cli-adapter into runtime lifecycle | — | — |

---

## 🔥 In Progress

> Currently being worked on.

| Issue | Title | Branch | Notes |
|---|---|---|---|
| [#4](../../issues/4) | Enhance registry-manager: parallel discovery + deduplication | `feat/registry-parallel` | `Promise.allSettled`, enterprise-catalog wiring |
| [#5](../../issues/5) | Workflow-engine: DLQ, retry/backoff, state persistence, cancellation | `feat/workflow-dlq` | `WorkflowStatus` enum already in types |

---

## 📋 Backlog — Priority High

> Ready to start. Ordered by execution dependency.

| Issue | Title | Depends On | Effort |
|---|---|---|---|
| [#6](../../issues/6) | Provider-router: circuit breaker + health checks + metrics | — | M |
| [#7](../../issues/7) | Installer: rollback, SHA-256 checksum, install lock, dry-run | — | M |
| [#8](../../issues/8) | Policy-engine: JSON pack loading, hot-reload, explainDecision | — | M |

---

## 📌 Backlog — Priority Medium

> Important but not blocking release.

| Issue | Title | Depends On | Effort |
|---|---|---|---|
| [#10](../../issues/10) | Complete 4 remaining test files (registry-manager, installer, workflow-engine, provider-router) | #4, #5, #6, #7 | L |

---

## ✅ Done

> Completed and merged to `main`.

| Commit | Description |
|---|---|
| `fa095e4` | fix(p1): TS `^5.7.3`, harden `.gitignore`/`.eslintrc`/`.env.example`, fix README badges |
| `44bf67f` | docs: CONTRIBUTING, SECURITY, CHANGELOG, CODE_OF_CONDUCT |
| `a2f4075` | feat: Dockerfile, docker-compose.yml, `src/types/index.ts` (all shared types) |
| `e41a252` | fix+feat: config.ts, logger (rotation+redact), crypto, audit (HMAC+flush), health (/live /ready) |
| `c85d981` | feat: server.ts (MCP_TRANSPORT gate, SSE, config rate limits, 404 middleware), admin-api (JWT auth) |
| `8d52e35` | feat: enterprise-catalog, cost-monitor, all 4 protocol adapters |
| `ec4a88` | feat: CLI, Events (webhook+SSE+HMAC), GraphQL adapters |
| `fca8e4b` | test: config, cost-monitor, cli-adapter, admin-api, protocol-adapter test files |
| `a71f208` | docs: architecture, security, api, deployment guides |
| `56140b8` | docs: AGENTS.md — AI coding agent instruction manifest |

---

## 🚧 Blocked

> Cannot proceed without external action.

| Issue | Blocked By | Required Action |
|---|---|---|
| [#11](../../issues/11) | GitHub token scope | Generate a PAT with `workflow` scope and create files via web UI or local git push |
| [#12](../../issues/12) | #11 | Status check names must match workflow job names |

---

## Effort Key

| Symbol | Meaning |
|---|---|
| S | Small — < 2 hours |
| M | Medium — 2–8 hours |
| L | Large — 1–2 days |
| XL | Extra Large — 2+ days |

---

## Release Gate Criteria for `v0.1.0`

Before tagging `v0.1.0` the following must all be true:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run test:ci` exits 0, all coverage thresholds pass
- [ ] `npm run build` exits 0, `dist/index.js` present
- [ ] Docker image builds and starts without error
- [ ] `GET /health/ready` returns 200 after startup
- [ ] `GET /admin/capabilities` returns 401 without token
- [ ] `GET /admin/capabilities` returns 200 with valid token
- [ ] All GitHub Actions workflows present and green on `main`
- [ ] Branch protection rules active on `main`
- [ ] No open `priority-critical` issues
