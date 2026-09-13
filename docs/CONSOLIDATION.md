# Consolidation: Universal MCP Hub Work → IDEA

Director-authorized consolidation of three independently-built "Universal MCP
Hub" systems into this repo as the single active target.

## Source inventory

| Repo | Org | Real/Live? | Contribution |
|---|---|---|---|
| `IDEA` | UniversalStandards | Yes — target | Base architecture: policy, multitenancy, security, observability, orchestration scaffolding |
| `mcp` | UniversalStandards | Yes | discovery/, installer/, normalizer/, auth/ logic; already-built GitHub OpenAPI adapter modules |
| `Universal-Standard-MCP-Server` | Universal-Standard (different org) | Yes | src/evolution/ (self-evolution agents), src/websocket/, src/providers/ (multi-provider routing) |
| "MCP Hive Nexus" | — | No — chat design only, never pushed | 9-stage agent pipeline (Intake→Deploy), documented as a pattern rather than rebuilt separately |

## What moved where

- `adapters/github/*.yaml` — the modular OpenAPI GitHub adapter, migrated from `mcp/github/`. Internal `$ref`s repointed to this repo. Added `templates.yaml` (repo copy/fork/generate-from-template — previously a known gap).
- `src/evolution/types.ts` — merges Universal-Standard-MCP-Server's evolution engine with the Hive Nexus 9-stage pipeline (intake → internal_search → respond/notify → external_search → design → build → test → deploy).
- `src/routing/`, `src/transport/` — target locations for Universal-Standard-MCP-Server's provider routing and WebSocket transport (interfaces scaffolded here; full port of the Express/Drizzle implementation is a follow-up pass, not a 1:1 copy — IDEA's own `core/` server lifecycle is authoritative, we are not running two server bootstraps).
- `src/discovery/`, `src/provisioning/`, `src/normalization/`, `src/security/` — target locations for `mcp`'s discovery/installer/normalizer/auth logic (same note: ported to IDEA's existing layering, not copied verbatim).

## New capabilities added (not present in any source system)

- **`src/federation/`** — cross-hub capability sharing between separate IDEA/MCP instances, with signed manifests and trust-level policy. Lets multiple orgs/clouds/air-gapped environments share capabilities without a central registry or shared credentials.
- **`src/marketplace/`** — tiered/metered access to any capability (free/per-call/subscription), usage records, entitlement checks.
- **`src/telemetry/`** — usage-driven optimization signals (pre-warm, cache-aggressively, rate-limit-tighten, deprecate-candidate) feeding back into routing/ and provisioning/.

## Repos retired

- `UniversalStandards/mcp` — `DEPRECATED.md` added, pointing here.
- `Universal-Standard/Universal-Standard-MCP-Server` — `DEPRECATED.md` added, pointing here.

Both repos are left live (not archived/deleted) for history.

## Explicitly deferred (not done in this pass)

- Full line-for-line port of Universal-Standard-MCP-Server's Express routes/middleware/websocket implementation — only interfaces were scaffolded. Actual runtime code needs to be adapted to IDEA's `core/` server lifecycle rather than pasted in as a second server.
- Drizzle/Postgres schema from Universal-Standard-MCP-Server was intentionally NOT ported — redundant with IDEA's own persistence approach; revisit only if IDEA has no persistence layer of its own.
