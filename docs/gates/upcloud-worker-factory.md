# Interface Contract: UpCloud Worker Factory

Status: **v1 — frozen for parallel build.** Changing any shape below is a
breaking change to whatever is being built against it; bump to v2 and note
the delta instead of editing v1 in place.

## Why this document exists

The UpCloud worker factory — an ephemeral browser/desktop worker fleet that
gives an agent a remote browser/desktop surface when the caller has no local
device linked — is being built as a provider module inside this hub rather
than as a fourth standalone repo (see `docs/CONSOLIDATION.md` for why this
hub is the single consolidation target, not a new fragment).

Two pieces of work can proceed **in parallel** without blocking each other —
the hub's own open issues (policy-engine hot-reload, trust-evaluator's
10-stage pipeline, production hardening, etc. — see
`.github/MASTER_TRACKER.md`) and the worker-factory provisioning/pool/broker
build on UpCloud — *as long as both sides build against the three frozen
seams below instead of against each other's in-progress internals.* That is
what this document freezes.

## The three gates

### Gate 1 — Auth handshake

**Decision: no parallel auth system, but a dedicated signing key.** A worker
session token is an ordinary JWT using the same `Bearer <token>` convention
already used by `admin-api.ts` and `transport/middleware/auth.ts` — but it is
signed with `deriveWorkerSessionKey(JWT_SECRET)` (HMAC-SHA256 of `JWT_SECRET`
over a fixed, versioned context string; see `src/adapters/upcloud-worker-factory/index.ts`),
**not** `JWT_SECRET` directly.

> **Updated 2026-10-01** — this gate originally read "signed with the hub's
> existing `JWT_SECRET`, distinguished from an admin-api token by claims, not
> by a different signing key." A review of this PR found that relying on
> every verifier remembering to check `scope !== 'worker-session'` by hand
> left exactly one that didn't (`src/multitenancy/TenantMiddleware.ts`).
> Key derivation closes that by construction instead, and is corrected here
> in place rather than versioned to v2 — no UpCloud-side broker/pool build
> exists against the old text yet (no live UpCloud/Vault account to
> integration-test against), so there is nothing external to break.

```ts
// Claims shape (see mintSessionToken() / verifySessionToken() in
// src/adapters/upcloud-worker-factory/index.ts)
{
  sub: string;                        // the requesting agent/subagent's identity
  scope: 'worker-session';            // distinguishes this from an admin-api token
  sessionId: string;
  capabilities: ('browser' | 'desktop')[];
  exp: number;                        // standard JWT expiry — ttlMs the session was issued for
}
```

> **Updated 2026-10-01 (second correction, same day)** — the paragraph below
> originally told a future external verifier to "compute
> `deriveWorkerSessionKey(JWT_SECRET)` itself," which means handing that
> verifier `JWT_SECRET` so it can do the derivation locally. A review of this
> PR correctly flagged that this defeats the entire point of key
> derivation: an external component holding `JWT_SECRET` is one compromise
> away from an attacker minting admin-api and runtime tokens too, not just
> worker-session ones — exactly the blast-radius expansion key separation
> exists to prevent. Corrected in place for the same reason as the first
> correction above: no UpCloud-side build exists against the old text yet.

> **Updated 2026-10-01 (third correction, same day)** — the paragraph below
> previously said that `api/admin-api.ts`, `transport/middleware/auth.ts`,
> and `multitenancy/TenantMiddleware.ts` all "compute
> `deriveWorkerSessionKey(JWT_SECRET)` itself," same as
> `verifySessionToken()`. That is backwards and self-contradicting: if those
> three *did* compute the derived key, they would *accept* a genuine
> worker-session token (a correct signature check), not reject it. They
> reject it for the opposite reason — they were never changed, and still
> verify with `JWT_SECRET` directly. Corrected in place, same rationale as
> the prior two corrections.

Only `verifySessionToken()` (in
`src/adapters/upcloud-worker-factory/index.ts`) computes
`deriveWorkerSessionKey(JWT_SECRET)` — that is the one verifier that needs to
*accept* a worker-session token. Every other hub-internal verifier —
`api/admin-api.ts`, `transport/middleware/auth.ts`, and
`multitenancy/TenantMiddleware.ts` — is unchanged: each still calls
`jwt.verify(token, cfg.JWT_SECRET)` directly, exactly as it did before this
gate existed. That is precisely *why* a worker-session token (signed with
the derived key, not `JWT_SECRET`) fails signature verification at all three
of them for free, with no per-verifier opt-in required — the rejection comes
from the key mismatch between what the token was signed with and what each
of those verifiers checks against, not from any of them recognizing or
deriving the worker key themselves. Anyone implementing a *new* hub-internal
verifier that must also reject worker-session tokens needs no special-case
logic at all: the ordinary `jwt.verify(token, cfg.JWT_SECRET)` every other
admin/runtime verifier already uses does this automatically.

A verifier *outside* this hub (e.g. a future UpCloud-side component) is a
different case: it **must never be given `JWT_SECRET`**, under any
circumstance, to derive the worker key itself. Instead, the hub computes
`deriveWorkerSessionKey(JWT_SECRET)` once, on its own side, and provisions
*only that resulting derived value* to the external verifier as its own
independent secret — out-of-band (e.g. through Vault), the same way any
other cross-system shared secret is distributed, never by handing over
`JWT_SECRET` itself for the far side to derive from. The external verifier
then calls `jwt.verify(token, <provisioned derived key>)` directly; it holds
that one derived value and nothing else, so its compromise exposes only
worker-session validation, not `JWT_SECRET` or anything signed with it.

A stronger option worth adopting before any UpCloud-side build actually
starts relying on this gate: switch worker-session tokens to asymmetric
signing (RS256/EdDSA) so only a *public* key is ever distributed externally.
Compromise of an external verifier then exposes nothing usable to mint a new
token at all, closing even the "stolen derived key" exposure the symmetric
approach above still carries. This is **not required** for the current,
hub-internal-only implementation (nothing external exists yet to provision
either value to), but should be the default design for whoever builds the
real UpCloud-side verifier.

`verifySessionToken()` additionally rejects any token whose `scope` is not
`'worker-session'` as defense-in-depth — an admin-api token cannot be
replayed as a worker-session token and vice versa, even setting the key
difference aside.

A subagent the calling agent dispatches gets **its own** token (its own
`createSession()` call, its own `sub`), never a shared one — ending one
subagent's session revokes only its own credential scopes (see Gate 3),
never another subagent's.

### Gate 2 — Provider registration

**Decision: this is an `IAdapter`, not a new registry axis.** It does not
need a new `RegistrySource` or `ProviderType` enum value — those are for AI
providers and tool-discovery sources, a different axis entirely. The worker
factory is a capability provider shaped exactly like `cliAdapter` /
`graphqlAdapter` / `eventsAdapter`: it implements `IAdapter`
(`src/types/index.ts`), is constructed as a module-level singleton
(`upcloudWorkerFactoryAdapter`), and is wired into
`core/runtime-manager.ts`'s `initialize()` / `shutdown()` / `getStatus()` the
same way the other three are.

Shared types live in `src/types/index.ts` (`WorkerSessionCapability`,
`WorkerSessionState`, `WorkerSessionHandle`, `CredentialScopeRef`) because
they are referenced across module boundaries (the adapter, and eventually an
admin-api route listing active sessions the way `/admin/capabilities` lists
registered tools). Wire-protocol-only types (the broker's HTTP response
shape, Vault's lease response shape) stay local to
`src/adapters/upcloud-worker-factory/index.ts` — nothing outside that file
needs to know the broker speaks JSON-over-HTTPS specifically, only that
`createSession()` returns a `WorkerSessionHandle`.

Two capability values exist today: `'browser'` (a CDP-driven Chromium
session — the primary, agent-control path) and `'desktop'` (a full
pixel-streamed desktop, for a human to watch or intervene, not the primary
way an agent drives the worker — see the "CDP, not VNC, for agent control"
note in Gate 2's design rationale below). Adding a third capability later is
additive, not breaking: extend the `WorkerSessionCapability` union and the
broker's `/sessions` payload, nothing else in the Gate 1/3 contract changes.

**Design rationale carried over from the original architecture proposal:**
agent-driven browser automation should go through CDP (the DOM/accessibility
tree), not screenshot-and-click VNC — it is what the `'browser'` capability
is for. `'desktop'`'s pixel-streamed view is for a human watching or
intervening, or for the rare case an agent genuinely needs a non-browser
native app, not the default control path.

### Gate 3 — Credential lease protocol

**Decision: the provider module owns the Vault client; the hub's
`credentialBroker` owns every leased secret's actual storage, scoping, audit,
and revocation.** This was the one real design choice among the three (the
other two mostly just apply conventions that already existed):

- Vault policies, mount paths, and AppRole credentials are
  worker-factory-specific knowledge — `ensureVaultToken()` and
  `leaseVaultSecrets()` live inside
  `src/adapters/upcloud-worker-factory/index.ts`, not in `security/`.
- But **no caller ever reads a leased secret from Vault directly, and no
  caller revokes one by calling Vault's revocation API.** Every secret this
  module leases is immediately issued into `credentialBroker.issue(scope,
  value, ttlMs)` (`src/security/credential-broker.ts`) — the same credential
  broker every other adapter in this hub uses. That gets the worker factory,
  for free, everything `credentialBroker` already does: scope enforcement
  (`{toolId: 'upcloud-worker-factory', action: '<sessionId>:<vaultPath>'}`),
  HMAC-signed audit entries on issue/retrieve/revoke, and rotation.
- Scope key shape: `{ toolId: 'upcloud-worker-factory', action:
  '<sessionId>:<vaultPath>' }` — one scope per (session, secret) pair, so
  ending one session's lease never touches another session's secret even if
  both leased the same Vault path.
- TTL: the secret's `credentialBroker` TTL is set to the session's `ttlMs` —
  the hub's own secret store, not Vault's lease duration, is what actually
  bounds how long the plaintext value is reachable from this process. The
  underlying Vault lease TTL is a backstop (it expires Vault-side even if
  revocation here were ever skipped), not the primary expiry mechanism.
- Revocation: `endSession()` calls `credentialBroker.revoke(scope,
  endedBy)` for every scope it leased — this is unconditional and runs even
  if the broker's own session-teardown HTTP call fails, so a leased secret
  never outlives its session purely because the remote worker was already
  gone. If the broker call itself fails, local session bookkeeping is kept
  (marked `teardownPending`, credential scopes cleared since they're already
  revoked) rather than discarded, specifically so the still-possibly-live
  remote worker isn't silently forgotten about — calling `endSession()`
  again retries only the broker-side teardown.

This means a future question like "does this session's Vault secret still
work after the session ends" has one, observable answer:
`credentialBroker.retrieve()` on that scope throws `NOT_FOUND` — regardless
of whether Vault's own lease has technically expired yet.

## What's already built against this contract

`src/adapters/upcloud-worker-factory/index.ts` implements all three gates as
specified above: `mintSessionToken()` / `verifySessionToken()` (Gate 1),
`IAdapter` conformance + registration in `runtime-manager.ts` (Gate 2), and
`leaseVaultSecrets()` / `ensureVaultToken()` wrapping every lease through
`credentialBroker` (Gate 3). Session lifecycle (`createSession()` /
`endSession()` / `getSession()` / `listSessions()`) and config
(`ENABLE_UPCLOUD_WORKER_FACTORY` and friends in `src/config.ts`) are real,
not stubbed — the one thing this pass could not do is stand up an actual
UpCloud broker to integration-test against, so `createSession()` /
`endSession()` are unit-tested against a mocked broker/Vault HTTP surface
(`tests/upcloud-worker-factory.test.ts`), not against a live UpCloud
account. Default-off (`ENABLE_UPCLOUD_WORKER_FACTORY=false`) until a real
broker exists.

## What's still open (the UpCloud-side work, not gated by anything here)

None of this needs to agree with the hub's other open issues — only with the
three gates above:

1. **Worker image** — Chromium launched with `--remote-debugging-port`, CDP
   as the primary control surface; XFCE + noVNC layered on top only for
   human viewing, not agent control.
2. **Session broker** — the actual service behind `UPCLOUD_BROKER_URL`:
   `POST /sessions` → `{sessionId, workerId, endpoint, expiresAt}`, `DELETE
   /sessions/:id`. Pool allocation (warm pool sized by
   `WORKER_POOL_WARM_SIZE`), UpCloud VM/container lifecycle, and
   worker-to-broker health reporting are entirely the broker's concern — the
   adapter only ever speaks this one HTTP contract to it.
3. **Vault setup** — the AppRole, the secret engine, and the mount at
   `VAULT_SECRET_MOUNT` are infra to provision; the adapter only needs
   `VAULT_ADDR` / `VAULT_ROLE_ID` / `VAULT_SECRET_ID` to reach them.

A broker response or Vault lease shape that doesn't match the Zod schemas in
`src/adapters/upcloud-worker-factory/index.ts` fails loudly
(`UpcloudWorkerFactoryError` with `code: 'BROKER_ERROR'` or `'VAULT_ERROR'`)
rather than silently — that is the intended integration point to notice a
drift from this contract.
