# Security Policy

## Supported Versions

| Version | Security Updates |
|---|---|
| `0.1.x` (current) | ✅ Actively supported |
| Earlier | ❌ Not supported |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Use **[GitHub Security Advisories](https://github.com/UniversalStandards/IDEA/security/advisories/new)** to submit a private report.

Include:
- Affected component and file(s)
- Vulnerability type (RCE, SSRF, injection, auth bypass, etc.)
- Clear description and impact assessment
- Steps to reproduce or proof-of-concept
- Affected versions
- Suggested remediation (if known)

### Response SLA

| Event | Target |
|---|---|
| Acknowledgment | Within 48 hours |
| Triage and severity assessment | Within 5 business days |
| Fix or workaround | Within 14 days for critical/high |
| Public disclosure | Coordinated with reporter after fix is released |

## Security Architecture

### Trust Pipeline

Every tool passes through 10 stages before provisioning:
1. Discovery
2. Metadata Inspection
3. Source Validation
4. Signature / Provenance Checks
5. Policy Evaluation
6. Risk Scoring
7. Approval or Automated Admission
8. Provisioning
9. Runtime Monitoring
10. Revocation if needed

### Credential Broker

Managed by `src/security/credential-broker.ts`:
- Secrets encrypted in-memory with AES-256-GCM
- Scoped per tool/provider
- Injected at execution time, never logged
- Token rotation supported

### Audit Logging

Managed by `src/security/audit.ts`:
- Every significant action produces an audit entry
- Each entry contains: `id`, `timestamp`, `action`, `actor`, `resource`, `outcome`, `correlationId`
- Entries are HMAC-signed to detect tampering
- Written to `audit.jsonl` in the runtime directory

### Sensitive Actions

High-risk operations require:
- Explicit human approval via `approval-gates.ts`
- Policy-based authorization
- Dual authorization for the highest-risk tiers
- Immutable audit trail

## Dependency Policy

- Dependabot opens PRs weekly for dependency updates
- CodeQL runs weekly and on every push to `main`
- Dependency Review blocks PRs introducing high-severity vulnerabilities
- `npm audit` runs in CI

## Hall of Fame

*No reports yet. Responsible disclosures will be credited here with permission.*
