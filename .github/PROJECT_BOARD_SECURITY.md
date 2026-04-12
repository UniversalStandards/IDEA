# 🔒 Project Board 2 — Security & Compliance
## Universal MCP Orchestration Hub — Trust, Hardening & Audit

> **Purpose**: Tracks every security implementation, hardening task, compliance requirement, and vulnerability management item for the platform. Separate from the feature build board by design — security work has its own cadence, ownership, and release criteria.

---

## 🚨 Critical — Must Complete Before Any Production Traffic

> These are non-negotiable gates. The platform must not receive real tool execution traffic until these are closed.

| Issue | Title | Risk if Skipped |
|---|---|---|
| [#13](../../issues/13) | Implement credential-broker with scoped access, rotation, audit | Credentials exposed cross-tool |
| [#14](../../issues/14) | Implement full 10-stage trust pipeline in trust-evaluator | Untrusted tools auto-approved |
| [#15](../../issues/15) | Implement approval-gates with sync/async flows + Admin API | High-risk tools execute without human gate |

---

## 🔥 In Progress

> Currently being actively worked on.

| Issue | Title | Branch | Notes |
|---|---|---|---|
| [#17](../../issues/17) | Production hardening: helmet, CORS, rate limiting, security headers | `security/hardening` | Includes `npm audit` CI step |

---

## 💻 Active — Priority High

> Ready to start. No external blockers.

| Issue | Title | Depends On | Effort |
|---|---|---|---|
| [#18](../../issues/18) | Zero-downtime key rotation for JWT_SECRET and ENCRYPTION_KEY | #13 | M |
| [#19](../../issues/19) | E2E webhook signature verification + SSE event delivery tests | — | M |

---

## 📌 Backlog — Priority Medium

> Important but not blocking the critical path.

| Issue | Title | Depends On | Effort |
|---|---|---|---|
| [#16](../../issues/16) | Audit log retention policy + HMAC verification script | — | S |

---

## 📋 Recurring — Ongoing Security Cadence

> These are not one-time tasks. They repeat on a schedule.

| Cadence | Task | Owner | Tooling |
|---|---|---|---|
| Weekly | CodeQL scheduled scan review | — | `.github/workflows/codeql.yml` |
| Weekly | Dependabot PR review and merge | — | `.github/dependabot.yml` |
| Weekly | OpenSSF Scorecard score review | — | `.github/workflows/scorecard.yml` |
| Monthly | `npm audit --audit-level=moderate` full pass | — | Manual + CI |
| Monthly | Review `runtime/audit.jsonl` integrity via `scripts/verify-audit-log.ts` | — | Manual |
| Quarterly | JWT_SECRET rotation (see Issue #18 runbook) | — | `POST /admin/security/rotate-key` |
| Quarterly | ENCRYPTION_KEY rotation (see Issue #18 runbook) | — | `scripts/rotate-encryption-key.ts` |
| On CVE alert | Triage and patch affected dependency | — | Dependabot + `npm audit` |

---

## ✅ Done

> Security work already implemented and merged.

| Commit | Description |
|---|---|
| `e41a252` | `src/security/crypto.ts` — AES-256-GCM, scrypt key derivation, `constantTimeEqual`, `generateSecureToken` |
| `e41a252` | `src/security/audit.ts` — HMAC-signed audit entries, `correlationId`, async `flush()` |
| `e41a252` | `src/config.ts` — insecure default checks in production, `LOG_LEVEL=silly` blocked in prod |
| `e41a252` | `src/observability/logger.ts` — sensitive field redaction (`token`, `secret`, `key`, etc.) |
| `c85d981` | `src/api/admin-api.ts` — JWT Bearer authentication on all admin routes |
| `c85d981` | `src/core/server.ts` — MCP_TRANSPORT gate (stdio no longer auto-attaches), helmet, CORS |
| `ec4a88` | `src/adapters/events/index.ts` — HMAC-SHA256 webhook signature verification, event deduplication |
| `ec4a88` | `src/adapters/cli/index.ts` — shell metacharacter guard, spawn (not exec), restricted env |
| `fca8e4b` | `tests/admin-api.test.ts` — JWT validation: missing header, wrong secret, expired token |
| `a71f208` | `docs/security.md` — trust pipeline, credential broker, audit schema, key rotation procedure |

---

## Threat Model Summary

| Threat | Control | Status |
|---|---|---|
| Malicious tool installation | 10-stage trust pipeline (Issue #14) | 🟡 In Progress |
| Cross-tool credential access | Scoped credential broker (Issue #13) | 🔴 Not Started |
| Unsigned tool admission | Signature check in trust pipeline (Issue #14) | 🟡 In Progress |
| Shell injection via CLI adapter | `spawn` + metacharacter guard | ✅ Done |
| Webhook spoofing | HMAC-SHA256 signature verification | ✅ Done |
| Replay attack via duplicate events | Dedup cache with configurable window | ✅ Done |
| Unauthenticated admin access | JWT Bearer middleware on all admin routes | ✅ Done |
| Log tampering | HMAC-signed audit entries | ✅ Done |
| Sensitive data in logs | Redaction list in logger | ✅ Done |
| High-risk tool auto-execution | Approval gates (Issue #15) | 🔴 Not Started |
| Stale/rotated credentials in memory | Key rotation procedure (Issue #18) | 🟡 In Progress |
| Supply chain CVEs | Dependabot + Dependency Review + CodeQL | 🟡 Needs CI setup |
| Overly permissive CORS | Config-driven `CORS_ORIGIN` + hardening (Issue #17) | 🟡 In Progress |
| Rate limit bypass | Config-driven rate limiter, server-side | ✅ Done |
| Insecure defaults in production | Config validation throws on insecure defaults | ✅ Done |

---

## Security Release Gate Criteria

Before the platform accepts production tool execution traffic, all of the following must be closed:

- [ ] Issue #13 — Credential broker implemented and tested
- [ ] Issue #14 — Full 10-stage trust pipeline implemented and tested
- [ ] Issue #15 — Approval gates implemented and tested
- [ ] Issue #17 — Production hardening pass complete; `npm audit` clean
- [ ] Issue #18 — Key rotation procedure validated
- [ ] CodeQL scan green on `main` (no high/critical findings)
- [ ] OpenSSF Scorecard score ≥ 7.0
- [ ] `docs/security.md` reflects current implementation (no stale sections)
- [ ] All audit log entries HMAC-verified by `scripts/verify-audit-log.ts`
- [ ] No open issues labelled `security` + `priority-critical`

---

## Effort Key

| Symbol | Meaning |
|---|---|
| S | Small — < 2 hours |
| M | Medium — 2–8 hours |
| L | Large — 1–2 days |
| XL | Extra Large — 2+ days |
