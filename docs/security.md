# Security Implementation Guide

## 1. Trust Pipeline

Every tool or adapter passes through 10 evaluation stages before it can execute:

| Stage | Module | Description |
|---|---|---|
| 1. Discovery | `registry-manager.ts` | Collect tool metadata from all enabled registries |
| 2. Metadata Inspection | `trust-evaluator.ts` | Inspect name, version, author, description, publish date |
| 3. Source Validation | `trust-evaluator.ts` | Verify repository origin, download counts, publish history |
| 4. Signature / Provenance | `trust-evaluator.ts` | npm package signatures, SLSA provenance where available |
| 5. Policy Evaluation | `policy-engine.ts` | Allowlist/denylist, tenant policy, environment policy |
| 6. Risk Scoring | `trust-evaluator.ts` | Composite 0–1 trust score; `RiskLevel` enum assignment |
| 7. Approval Gate | `approval-gates.ts` | Human confirmation required for HIGH/CRITICAL risk tools |
| 8. Provisioning | `installer.ts` | Install under least-privilege; lock file prevents race conditions |
| 9. Runtime Monitoring | `runtime-manager.ts` | Health checks; anomaly detection during execution |
| 10. Revocation | `registry-manager.ts` | Immediate deregistration on trust degradation or policy violation |

---

## 2. Credential Broker

All secrets are managed by `src/security/credential-broker.ts`:

- **Storage**: In-memory, encrypted with AES-256-GCM. Never written to disk in plaintext.
- **Scoping**: Each secret is bound to a specific tool or provider ID. Cross-tool access is not permitted.
- **Injection**: Credentials are injected at execution time, not at configuration time. They are never passed in log entries.
- **Rotation**: Time-limited credentials can be refreshed via the rotation API without restarting the hub.
- **Audit**: Every credential access event is written to the audit log.

---

## 3. Secret Store

`src/security/secret-store.ts` manages the in-memory secret map:

- Secrets stored as `encrypt(value, ENCRYPTION_KEY)` using AES-256-GCM with a random IV per operation.
- The `ENCRYPTION_KEY` environment variable must be at least 32 characters. In production, a 256-bit random key is required.
- Future: integration with HashiCorp Vault or AWS Secrets Manager via an `ISecretBackend` interface.

---

## 4. Audit Logging

`src/security/audit.ts` produces a tamper-evident audit trail:

### Entry Schema
```json
{
  "id": "uuid",
  "timestamp": "ISO 8601",
  "action": "tool.provision.success",
  "actor": "system | <user-id> | <agent-id>",
  "resource": "<tool-id>",
  "outcome": "success | failure | pending",
  "correlationId": "uuid",
  "requestId": "uuid (optional)",
  "metadata": { },
  "hmac": "sha256-hex"
}
```

### HMAC Signature
Each entry is HMAC-SHA256 signed over `{ id, action, actor, resource, outcome, correlationId }` using the `ENCRYPTION_KEY`. This allows detection of log tampering.

### Storage
Entries are appended as JSONL to `runtime/audit.jsonl`. Rotation and archival are managed by the operator (e.g., logrotate or a sidecar).

### Flush on Shutdown
`auditLog.flush()` is registered in the lifecycle shutdown sequence to drain any buffered entries before process exit.

---

## 5. Network Boundaries

- **Rate limiting**: Configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX_REQUESTS` (default: 300 req/60s).
- **CORS**: Strict allowlist via `CORS_ORIGIN`. Wildcard `*` is only appropriate for development.
- **Egress control**: All outbound requests from the hub (registry fetches, provider calls) should be proxied through an egress gateway in production to enforce network policies.
- **No inbound secrets**: The Admin API rejects all requests without a valid JWT Bearer token.

---

## 6. Approval Gates

`src/policy/approval-gates.ts` implements synchronous and asynchronous approval:

- **Synchronous**: Block execution until an operator confirms or denies via the Admin API.
- **Asynchronous**: Queue the action and notify an external system (webhook, Slack, email) to request approval.
- **Timeout**: If no decision is received within the configured window, the action is automatically denied.
- **Audit**: Every approval request and decision is written to the audit log.

---

## 7. Key Rotation Procedure

### Rotating `JWT_SECRET` (zero-downtime)
1. Generate a new secret: `openssl rand -hex 32`
2. Add the new secret as `JWT_SECRET_NEW` to the environment
3. Update the JWT verification middleware to accept tokens signed with either `JWT_SECRET` or `JWT_SECRET_NEW`
4. Issue new tokens signed with `JWT_SECRET_NEW`
5. Wait until all existing tokens expire (or force-revoke them)
6. Replace `JWT_SECRET` with `JWT_SECRET_NEW` and remove the dual-verification logic

### Rotating `ENCRYPTION_KEY`
1. Generate a new key: `openssl rand -hex 32`
2. Decrypt all secrets in the SecretStore with the old key
3. Re-encrypt them with the new key
4. Swap the `ENCRYPTION_KEY` environment variable
5. Update the `HMAC` signatures in the audit log if required by your compliance policy
