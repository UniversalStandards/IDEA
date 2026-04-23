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

### Overview

Zero-downtime rotation is achieved through a **dual-secret window**: both the outgoing key and the
incoming key are accepted simultaneously during the transition period. Once all clients have
migrated to tokens or secrets encrypted with the new key, the old key is removed.

---

### 7.1 Rotating `JWT_SECRET` (zero-downtime)

**Step 1 — Generate a new secret**

```bash
openssl rand -hex 32
# Example output: a3f8c2...  (64 hex chars = 256 bits)
```

**Step 2 — Add `JWT_SECRET_NEW` to the environment (without removing `JWT_SECRET`)**

```bash
# .env / deployment config
JWT_SECRET=<current-secret>
JWT_SECRET_NEW=<new-secret>
```

Restart or send `SIGHUP` to the hub. The `requireAuth` middleware in `src/api/admin-api.ts` now
accepts tokens signed with **either** `JWT_SECRET_NEW` or `JWT_SECRET`.

**Step 3 — Issue new tokens signed with `JWT_SECRET_NEW`**

```bash
# Ensure JWT_SECRET_NEW is exported in the current shell, then run:
JWT_SECRET_NEW=<new-secret> node -e "
  const jwt = require('jsonwebtoken');
  console.log(jwt.sign({ sub: 'admin', role: 'admin' }, process.env.JWT_SECRET_NEW, { expiresIn: '1h' }));
"
```

Replace all service accounts, scripts, and CI/CD pipelines with tokens generated from `JWT_SECRET_NEW`.

**Step 4 — Wait for old tokens to expire**

JWT tokens contain an `exp` claim. Wait until the maximum TTL of any token issued with the old
`JWT_SECRET` has elapsed (e.g., 1 hour for `expiresIn: '1h'`). Alternatively, force-revoke by
updating `JWT_SECRET` now if revocation is acceptable.

**Step 5 — Promote `JWT_SECRET_NEW` to `JWT_SECRET`**

```bash
# .env / deployment config — remove the old secret entirely
JWT_SECRET=<new-secret>
# JWT_SECRET_NEW is no longer set
```

Restart or send `SIGHUP`. The middleware reverts to single-secret verification.

**Implementation note**: The `requireAuth` middleware in `src/api/admin-api.ts` implements this
logic by iterating over `[JWT_SECRET_NEW, JWT_SECRET]` (when both are present) and accepting the
first successful verification.

---

### 7.2 Rotating `ENCRYPTION_KEY` (zero-downtime, in-process)

The preferred method for live systems is the Admin API endpoint, which performs the rotation
in-process with no downtime.

**Step 1 — Generate a new key**

```bash
openssl rand -hex 32
```

**Step 2 — Set `ENCRYPTION_KEY_NEW` in the environment**

```bash
ENCRYPTION_KEY=<current-key>
ENCRYPTION_KEY_NEW=<new-key>
```

**Step 3 — Trigger in-process rotation via the Admin API**

```bash
curl -X POST http://localhost:3000/admin/security/rotate-key \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "confirm": true, "newKey": "<new-key>" }'
```

Expected response:

```json
{
  "message": "Encryption key rotation complete",
  "rotatedCount": 42,
  "hint": "Update ENCRYPTION_KEY to the new value and remove ENCRYPTION_KEY_NEW from your environment."
}
```

The endpoint (`POST /admin/security/rotate-key`) requires:
- A valid JWT Bearer token (enforced by `requireAuth`).
- `{ "confirm": true }` in the request body to prevent accidental invocation.
- `{ "newKey": "<min-32-char-key>" }` — the new encryption key.

**Step 4 — Promote `ENCRYPTION_KEY_NEW` to `ENCRYPTION_KEY`**

```bash
ENCRYPTION_KEY=<new-key>
# ENCRYPTION_KEY_NEW is no longer set
```

Restart or send `SIGHUP`.

---

### 7.3 Rotating `ENCRYPTION_KEY` (offline, via script)

Use this approach when the hub is stopped (e.g., during a maintenance window) or when rotating
secrets stored in the persisted `runtime/secrets.json` file.

```bash
OLD_KEY=<current-key> NEW_KEY=<new-key> \
  tsx scripts/rotate-encryption-key.ts [--store-path <path>]
```

Default store path: `runtime/secrets.json`

The script:
1. Reads the encrypted store from disk.
2. Decrypts each secret with `OLD_KEY`.
3. Re-encrypts with `NEW_KEY` using a fresh AES-256-GCM IV per secret.
4. Writes the updated store atomically (temp file + rename) with `chmod 600`.
5. Prints a summary: rotated count, skipped count.

After the script succeeds, update `ENCRYPTION_KEY` and restart the hub.

---

### 7.4 Updating HMAC Signatures in the Audit Log

Audit entries in `runtime/audit.jsonl` are HMAC-SHA256 signed with `ENCRYPTION_KEY`. After key
rotation, historical entries remain valid under the old key signature. If your compliance policy
requires re-signing:

1. Process `runtime/audit.jsonl` line-by-line.
2. Parse each JSON entry.
3. Verify the old HMAC (using `oldKey`).
4. Recompute HMAC with `newKey` over the same fields: `{ id, action, actor, resource, outcome, correlationId }`.
5. Replace the `hmac` field and write to a new file.
6. Replace the original file atomically.

> **Note**: Re-signing audit logs changes the tamper-evidence guarantee for historical entries.
> Consult your compliance team before doing this.

