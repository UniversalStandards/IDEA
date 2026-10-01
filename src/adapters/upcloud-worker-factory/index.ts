/**
 * src/adapters/upcloud-worker-factory/index.ts
 *
 * Adapter for the UpCloud-hosted ephemeral browser/desktop worker fleet.
 * Lets an agent get a short-lived, session-scoped remote browser/desktop
 * surface when the caller has no local device or browser linked —
 * provisioned on-demand from a pool of UpCloud workers, torn down on
 * session end.
 *
 * This file is the implementation side of the frozen interface contract in
 * docs/gates/upcloud-worker-factory.md ("Gate 1" auth handshake, "Gate 2"
 * provider registration, "Gate 3" credential lease protocol). Read that
 * document first if you are changing any of the three call shapes below —
 * they are a contract other in-flight work is building against.
 *
 * Deliberately NOT reinvented from scratch:
 *  - Auth (Gate 1) reuses this hub's existing JWT_SECRET and Bearer-token
 *    convention (see transport/middleware/auth.ts, api/admin-api.ts), but
 *    worker-session tokens are signed with a key *derived* from JWT_SECRET
 *    (see deriveWorkerSessionKey() below) rather than JWT_SECRET itself —
 *    see the security note on mintSessionToken() for why.
 *  - Credential leasing (Gate 3) issues every Vault-leased secret through
 *    this hub's own credential-broker — never a parallel secret store.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { auditLog } from '../../security/audit';
import { credentialBroker } from '../../security/credential-broker';
import { getConfig } from '../../config';
import type {
  IAdapter,
  WorkerSessionCapability,
  WorkerSessionHandle,
  WorkerSessionState,
  CredentialScopeRef,
} from '../../types/index';

const logger = createLogger('upcloud-worker-factory');

// ─────────────────────────────────────────────────────────────────
// Wire-protocol types (broker-facing only — not shared outside this module;
// see docs/gates/upcloud-worker-factory.md "Gate 2" for the registration
// schema these back).
// ─────────────────────────────────────────────────────────────────

/**
 * The broker's own `endpoint` is a CDP debug URL for the allocated worker —
 * `z.string().url()` alone would also accept `http(s)://`, `file://`, or any
 * other scheme a misbehaving or compromised broker response could return,
 * and that string is handed straight back to the caller as something to
 * connect to. Require the one scheme this is ever meant to be: `wss://`.
 */
const SecureWorkerEndpointSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('wss://'), {
    message: 'Worker endpoint must be a secure WebSocket URL (wss://)',
  });

const BrokerSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  workerId: z.string().min(1),
  endpoint: SecureWorkerEndpointSchema,
  expiresAt: z.string().datetime(),
});

const VaultLeaseResponseSchema = z.object({
  lease_id: z.string().min(1),
  lease_duration: z.number().int().positive(),
  data: z.record(z.unknown()),
});

/**
 * The `capabilities` claim inside a worker-session JWT. A valid signature
 * only proves the token was minted by this hub's own mintSessionToken() (or
 * by anyone else who holds deriveWorkerSessionKey(JWT_SECRET)) — it says
 * nothing about whether the *claims inside* still match this type's
 * contract. Used by verifySessionToken() to reject a claim that is missing,
 * not an array, or contains anything other than 'browser'/'desktop', rather
 * than casting it through unchecked (see the note there for why that
 * matters even for an otherwise-validly-signed token).
 */
const WorkerSessionCapabilitySchema = z.enum(['browser', 'desktop']);

const VaultAppRoleLoginResponseSchema = z.object({
  auth: z.object({
    client_token: z.string().min(1),
    lease_duration: z.number().int().positive(),
  }),
});

/**
 * Derives the signing key for worker-session bearer tokens from this hub's
 * JWT_SECRET (HMAC-SHA256 over a fixed, versioned context string).
 *
 * This is key *separation*, not secrecy from JWT_SECRET — anyone who holds
 * JWT_SECRET can compute this too. The point is that the result is never
 * equal to JWT_SECRET itself, so the ordinary `jwt.verify(token,
 * cfg.JWT_SECRET)` call made by every other verifier in this hub —
 * api/admin-api.ts, transport/middleware/auth.ts,
 * multitenancy/TenantMiddleware.ts, and any future one — rejects a
 * worker-session token on signature mismatch alone, with no per-verifier
 * opt-in required. Before this, isolation depended entirely on each
 * verifier remembering to check `scope !== 'worker-session'` by hand;
 * TenantMiddleware.ts had no such check (worker tokens just happen to
 * carry no `orgId` claim today, which is not a security boundary). A
 * worker session is handed to an ephemeral, comparatively less-trusted
 * remote browser/desktop surface, so its token should not carry the same
 * blast radius as an admin or runtime token if exfiltrated or replayed.
 *
 * Exported so tests can mint/verify worker-session-shaped tokens without
 * reaching into the adapter's private methods.
 */
export function deriveWorkerSessionKey(jwtSecret: string): string {
  return crypto
    .createHmac('sha256', jwtSecret)
    .update('upcloud-worker-factory:worker-session:v1')
    .digest('hex');
}

/**
 * Validates and percent-encodes a caller-supplied Vault secret path
 * (`WorkerSessionRequest.vaultSecretPaths`) before it is concatenated into
 * a request URL under `VAULT_SECRET_MOUNT`.
 *
 * Rejects empty, `.`, and `..` segments: without this, a path like
 * `../../sys/leases/lookup` would normalize to a URL *outside* the
 * configured mount, letting whoever can request a worker session make the
 * adapter's Vault AppRole token hit any Vault API path that token's policy
 * allows — not just secrets under the mount it was meant to be confined to.
 * Every remaining segment is then percent-encoded individually (not the
 * path as a whole, which would also encode the `/` separators meant to
 * stay as hierarchy) so a segment can't smuggle a pre-encoded traversal
 * sequence (e.g. a literal `%2e%2e`) past this check and have some
 * downstream layer decode it later — `encodeURIComponent` turns a literal
 * `%` into `%25`, so a value can never *become* a dot-segment after this.
 */
function encodeVaultSecretPath(path: string): string {
  const segments = path.split('/');
  return segments
    .map((segment) => {
      if (segment.length === 0 || segment === '.' || segment === '..') {
        throw new UpcloudWorkerFactoryError(
          `Invalid Vault secret path '${path}': empty, '.', and '..' segments are not allowed`,
          'VAULT_ERROR',
        );
      }
      return encodeURIComponent(segment);
    })
    .join('/');
}

/**
 * Builds the credentialBroker scope `action` string for a leased Vault
 * secret as `<sessionId>:<path>`, where both components are joined with a
 * literal `:`. Neither component is restricted in shape: `sessionId` comes
 * from the broker's session-create response (BrokerSessionResponseSchema
 * only requires `z.string().min(1)`), and `path` is caller-supplied (one of
 * WorkerSessionRequest.vaultSecretPaths). Without encoding, a `:` inside
 * either value lets two distinct (sessionId, path) pairs collide on the
 * same joined string — e.g. (sessionId='a:b', path='c') and
 * (sessionId='a', path='b:c') both produce 'a:b:c' — which
 * CredentialBroker.scopeKey() then maps to the identical storage key
 * (`cred:upcloud-worker-factory:a:b:c`), so credentialBroker.issue()
 * silently overwrites one session's secret with the other's, and ending
 * either session revokes the other's still-in-use credential.
 * `encodeURIComponent` escapes every literal `:` (and `%`, so a value
 * can never *become* one after encoding) in each component before they are
 * joined, making the joined string unambiguous — the same technique
 * encodeVaultSecretPath() uses above for the same reason. The encoded
 * action string is never parsed back into its parts (confirmed: every
 * caller in this file and in credential-broker.ts compares or stores the
 * whole CredentialScopeRef object rather than splitting `action`), so
 * encoding each component independently is safe.
 */
function buildVaultLeaseScopeAction(sessionId: string, path: string): string {
  return `${encodeURIComponent(sessionId)}:${encodeURIComponent(path)}`;
}

export interface WorkerSessionRequest {
  /** 'browser' for a CDP-driven Chromium session, 'desktop' for a full
   *  pixel-streamed desktop (see docs/gates — desktop is CDP's debug/view
   *  layer on top, not the primary agent-control path). */
  readonly capability: WorkerSessionCapability;
  /** Identity of the agent (or subagent) this session is issued to — becomes
   *  the JWT `sub` claim and the credentialBroker audit actor. */
  readonly requestedBy: string;
  /** Overrides WORKER_SESSION_DEFAULT_TTL_MS, capped at WORKER_SESSION_MAX_TTL_MS. */
  readonly ttlMs?: number;
  /** Vault secret paths (relative to VAULT_SECRET_MOUNT) this session needs
   *  leased on creation, e.g. ['upcloud-worker-factory/session-creds']. */
  readonly vaultSecretPaths?: string[];
}

export class UpcloudWorkerFactoryError extends Error {
  public readonly code: 'DISABLED' | 'NOT_FOUND' | 'BROKER_ERROR' | 'VAULT_ERROR';

  constructor(message: string, code: UpcloudWorkerFactoryError['code']) {
    super(message);
    this.name = 'UpcloudWorkerFactoryError';
    this.code = code;
  }
}

export class UpcloudWorkerFactoryAdapter implements IAdapter {
  readonly name = 'upcloud-worker-factory';
  readonly protocol = 'worker-session';

  private readonly sessions = new Map<string, WorkerSessionState>();
  private client: AxiosInstance | undefined;
  private vaultToken: string | undefined;
  private vaultTokenExpiresAtMs = 0;

  async initialize(): Promise<void> {
    const cfg = getConfig();
    if (!cfg.ENABLE_UPCLOUD_WORKER_FACTORY) {
      logger.info('UpCloud worker factory disabled (ENABLE_UPCLOUD_WORKER_FACTORY=false)');
      return;
    }
    if (!cfg.UPCLOUD_BROKER_URL) {
      throw new Error('ENABLE_UPCLOUD_WORKER_FACTORY=true requires UPCLOUD_BROKER_URL');
    }

    this.client = axios.create({
      baseURL: cfg.UPCLOUD_BROKER_URL,
      timeout: 15_000,
      headers: cfg.UPCLOUD_BROKER_API_KEY ? { 'X-API-Key': cfg.UPCLOUD_BROKER_API_KEY } : {},
    });

    logger.info('UpCloud worker factory adapter initialized', {
      brokerUrl: cfg.UPCLOUD_BROKER_URL,
      warmPoolSize: cfg.WORKER_POOL_WARM_SIZE,
    });
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    const results = await Promise.allSettled(ids.map((id) => this.endSession(id, 'system')));

    // endSession() resolves normally even when the broker-side teardown call
    // failed — it marks the session teardownPending rather than rejecting
    // (see endSession() above) — so `rejected` here only catches a genuinely
    // unexpected throw, never an ordinary broker-unreachable case. Checking
    // it alone would make shutdown declare every session "ended" even when
    // some are only teardown-pending; check the real post-settle state too.
    const threw = results.filter((r) => r.status === 'rejected').length;
    if (threw > 0) {
      logger.warn('Some worker sessions threw unexpectedly while ending during shutdown', {
        threw,
        total: ids.length,
      });
    }

    const stillPending = this.listPendingTeardownSessions();
    if (stillPending.length > 0) {
      logger.error(
        'Shutdown is leaving worker sessions behind with failed broker-side teardown — their ' +
          'remote workers and session tokens may still be live. Leased credentials for these ' +
          'sessions have already been revoked, but this in-memory teardownPending record does not ' +
          'survive process exit, so nothing will automatically retry the broker-side DELETE after ' +
          'this process ends.',
        { pendingSessionIds: stillPending.map((s) => s.sessionId) },
      );
    }

    this.client = undefined;
    this.vaultToken = undefined;
    logger.info('UpCloud worker factory adapter shut down', {
      sessionsFullyEnded: ids.length - stillPending.length - threw,
      sessionsPendingTeardown: stillPending.length,
      sessionsThrew: threw,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Gate 1 — auth handshake
  // ─────────────────────────────────────────────────────────────

  /**
   * Mint a worker-session-scoped bearer token. Signed with
   * deriveWorkerSessionKey(JWT_SECRET) — a key derived from, but never
   * equal to, this hub's JWT_SECRET — so a worker-session token fails
   * signature verification outright against every other verifier in this
   * hub that checks straight against JWT_SECRET. See the note on
   * deriveWorkerSessionKey() above for why that matters.
   */
  mintSessionToken(
    sessionId: string,
    subject: string,
    capabilities: WorkerSessionCapability[],
    ttlMs: number,
  ): string {
    const cfg = getConfig();
    return jwt.sign(
      { sub: subject, scope: 'worker-session', sessionId, capabilities },
      deriveWorkerSessionKey(cfg.JWT_SECRET),
      { expiresIn: Math.max(1, Math.floor(ttlMs / 1000)) },
    );
  }

  /**
   * Verify a worker-session bearer token and return its claims. Throws if
   * the signature is invalid, the token is expired, it was not issued for
   * worker-session scope (e.g. a token signed with JWT_SECRET directly
   * presented here), or its `capabilities` claim does not hold at least one
   * valid `'browser'` | `'desktop'` value.
   *
   * That last check matters even though the signature has already been
   * verified: a valid signature only proves the token was minted by
   * something holding deriveWorkerSessionKey(JWT_SECRET) — it says nothing
   * about whether the claims *inside* a given token still conform to this
   * function's declared return type. Previously a non-array capabilities
   * claim was silently replaced with `[]`, and an array containing anything
   * other than 'browser'/'desktop' (e.g. `['admin']`) was cast straight
   * through unchecked, letting a malformed-but-validly-signed token violate
   * the type downstream callers rely on and potentially slip past a
   * capability check that isn't doing an exact-match comparison itself.
   */
  verifySessionToken(token: string): {
    subject: string;
    sessionId: string;
    capabilities: WorkerSessionCapability[];
  } {
    const cfg = getConfig();
    const decoded = jwt.verify(token, deriveWorkerSessionKey(cfg.JWT_SECRET)) as Record<string, unknown>;
    if (decoded['scope'] !== 'worker-session') {
      throw new Error('Token is not scoped for worker-session access');
    }
    const sessionId = decoded['sessionId'];
    const subject = decoded['sub'];
    if (typeof sessionId !== 'string' || typeof subject !== 'string') {
      throw new Error('Worker-session token is missing required claims');
    }
    const capabilitiesResult = z.array(WorkerSessionCapabilitySchema).min(1).safeParse(decoded['capabilities']);
    if (!capabilitiesResult.success) {
      throw new Error('Worker-session token has a missing or invalid capabilities claim');
    }
    return {
      subject,
      sessionId,
      capabilities: capabilitiesResult.data,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Session lifecycle
  // ─────────────────────────────────────────────────────────────

  async createSession(request: WorkerSessionRequest): Promise<WorkerSessionHandle> {
    if (!this.client) {
      throw new UpcloudWorkerFactoryError(
        'UpCloud worker factory is not initialized (ENABLE_UPCLOUD_WORKER_FACTORY=false, or initialize() has not run)',
        'DISABLED',
      );
    }

    const cfg = getConfig();
    const ttlMs = Math.min(request.ttlMs ?? cfg.WORKER_SESSION_DEFAULT_TTL_MS, cfg.WORKER_SESSION_MAX_TTL_MS);
    const startedAt = Date.now();

    let broker: z.infer<typeof BrokerSessionResponseSchema>;
    try {
      const response = await this.client.post<unknown>('/sessions', {
        capability: request.capability,
        ttlMs,
        requestedBy: request.requestedBy,
      });
      const parsed = BrokerSessionResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(`Broker returned an invalid session response: ${parsed.error.message}`);
      }
      broker = parsed.data;
    } catch (err) {
      metrics.increment('worker_sessions_create_failures_total', { capability: request.capability });
      auditLog.record('worker_session.create', request.requestedBy, 'unknown', 'failure', undefined, {
        capability: request.capability,
        err: err instanceof Error ? err.message : String(err),
      });
      throw new UpcloudWorkerFactoryError(
        `Failed to allocate a worker session: ${err instanceof Error ? err.message : String(err)}`,
        'BROKER_ERROR',
      );
    }

    let leasedCredentialScopes: CredentialScopeRef[];
    try {
      leasedCredentialScopes = await this.leaseVaultSecrets(
        broker.sessionId,
        request.vaultSecretPaths ?? [],
        ttlMs,
      );
    } catch (err) {
      // The broker already allocated a worker for this session before Vault
      // leasing ran — if leasing fails now (bad Vault credentials, a schema
      // mismatch, a later path in a multi-secret request failing after
      // earlier ones succeeded), nothing has added this session to
      // `this.sessions` yet, so neither endSession() nor shutdown() could
      // ever find it. Roll the allocation back explicitly rather than
      // leaking a worker that nothing can now reach. (Any credential scopes
      // already issued for earlier paths in this same request are rolled
      // back inside leaseVaultSecrets() itself before it rethrows.)
      let brokerRollbackFailed = false;
      await this.client.delete(`/sessions/${encodeURIComponent(broker.sessionId)}`).catch((teardownErr: unknown) => {
        brokerRollbackFailed = true;
        logger.error('Failed to roll back broker session after Vault leasing failure', {
          sessionId: broker.sessionId,
          err: teardownErr instanceof Error ? teardownErr.message : String(teardownErr),
        });
      });

      if (brokerRollbackFailed) {
        // The compensating DELETE above also failed, so the broker-allocated
        // worker may still be live — but this session was never added to
        // `this.sessions` (createSession() hadn't reached that point yet),
        // so without inserting a record here, listPendingTeardownSessions(),
        // getStatus(), and shutdown() would have no way to ever find or
        // retry it: the leaked worker would be permanently invisible to
        // every reconciliation path this adapter has. Insert a
        // teardown-pending record now, mirroring endSession()'s own
        // broker-failure handling, even though this session was never
        // handed back to a caller as a WorkerSessionHandle. Credential
        // scopes are already empty here — leaseVaultSecrets() rolls back
        // everything it issued itself before rethrowing the error this
        // catch block is responding to.
        this.sessions.set(broker.sessionId, {
          sessionId: broker.sessionId,
          workerId: broker.workerId,
          capability: request.capability,
          endpoint: broker.endpoint,
          requestedBy: request.requestedBy,
          createdAt: new Date(),
          expiresAt: new Date(broker.expiresAt),
          leasedCredentialScopes: [],
          teardownPending: true,
        });
        metrics.increment('worker_sessions_teardown_pending_total', { capability: request.capability });
        auditLog.record('worker_session.teardown_pending', request.requestedBy, broker.sessionId, 'pending', undefined, {
          capability: request.capability,
          stage: 'create_rollback',
        });
      }

      metrics.increment('worker_sessions_create_failures_total', { capability: request.capability });
      auditLog.record('worker_session.create', request.requestedBy, broker.sessionId, 'failure', undefined, {
        capability: request.capability,
        stage: 'vault_lease',
        err: err instanceof Error ? err.message : String(err),
      });

      throw err instanceof UpcloudWorkerFactoryError
        ? err
        : new UpcloudWorkerFactoryError(
            `Failed to lease credentials for worker session: ${err instanceof Error ? err.message : String(err)}`,
            'VAULT_ERROR',
          );
    }

    const token = this.mintSessionToken(broker.sessionId, request.requestedBy, [request.capability], ttlMs);

    const state: WorkerSessionState = {
      sessionId: broker.sessionId,
      workerId: broker.workerId,
      capability: request.capability,
      endpoint: broker.endpoint,
      requestedBy: request.requestedBy,
      createdAt: new Date(),
      expiresAt: new Date(broker.expiresAt),
      leasedCredentialScopes,
    };
    this.sessions.set(broker.sessionId, state);

    metrics.increment('worker_sessions_created_total', { capability: request.capability });
    metrics.histogram('worker_session_create_duration_ms', Date.now() - startedAt);
    auditLog.record('worker_session.created', request.requestedBy, broker.sessionId, 'success', undefined, {
      capability: request.capability,
      workerId: broker.workerId,
      ttlMs,
      leasedSecretCount: leasedCredentialScopes.length,
    });

    logger.info('Worker session created', {
      sessionId: broker.sessionId,
      capability: request.capability,
      workerId: broker.workerId,
      ttlMs,
    });

    return {
      sessionId: broker.sessionId,
      endpoint: broker.endpoint,
      token,
      expiresAt: state.expiresAt,
      capability: request.capability,
    };
  }

  /**
   * End a session: tear down the broker-side worker, revoke every credential
   * scope leased for it, and drop local state.
   *
   * Credential revocation is unconditional — it runs even if the broker's
   * own session-teardown HTTP call fails, so a leased secret never outlives
   * its session purely because the remote worker was already gone (see Gate
   * 3 in docs/gates/upcloud-worker-factory.md).
   *
   * A failed broker-side teardown is a *different* kind of failure from a
   * failed credential revocation, though: the remote worker and its
   * still-valid session token may remain live and reachable. Previously
   * this was logged and the session was dropped from local state anyway —
   * which silently discarded the only record that the worker still needed
   * tearing down, with no way to retry. Now, on a broker-teardown failure,
   * the session is retained (marked `teardownPending`, with its credential
   * scopes cleared since those are already revoked) instead of deleted —
   * calling endSession() again for the same sessionId retries only the
   * broker-side DELETE, since there is nothing left to revoke.
   */
  async endSession(sessionId: string, endedBy: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      logger.warn('Attempted to end unknown worker session', { sessionId });
      return;
    }

    let brokerTeardownFailed = false;
    if (this.client) {
      try {
        await this.client.delete(`/sessions/${encodeURIComponent(sessionId)}`);
      } catch (err) {
        brokerTeardownFailed = true;
        logger.warn(
          'Broker session teardown request failed — the remote worker and its session token ' +
            'may remain live; retaining session as teardown-pending for a retry (credentials are ' +
            'still revoked now, unconditionally)',
          {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    for (const scope of state.leasedCredentialScopes) {
      credentialBroker.revoke(scope, endedBy);
      if (scope.vaultLeaseId) {
        await this.revokeVaultLease(scope.vaultLeaseId, sessionId);
      }
    }

    if (brokerTeardownFailed) {
      this.sessions.set(sessionId, { ...state, leasedCredentialScopes: [], teardownPending: true });
      metrics.increment('worker_sessions_teardown_pending_total', { capability: state.capability });
      auditLog.record('worker_session.teardown_pending', endedBy, sessionId, 'pending', undefined, {
        capability: state.capability,
        revokedCredentialScopes: state.leasedCredentialScopes.length,
      });
      return;
    }

    this.sessions.delete(sessionId);
    metrics.increment('worker_sessions_ended_total', { capability: state.capability });
    auditLog.record('worker_session.ended', endedBy, sessionId, 'success', undefined, {
      capability: state.capability,
      durationMs: Date.now() - state.createdAt.getTime(),
      revokedCredentialScopes: state.leasedCredentialScopes.length,
    });

    logger.info('Worker session ended', { sessionId, endedBy });
  }

  getSession(sessionId: string): WorkerSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): WorkerSessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Sessions whose broker-side teardown failed and are awaiting a retry.
   * Their leased credentials have already been revoked — only the remote
   * broker DELETE itself still needs to succeed. Call endSession() again
   * with the same sessionId to retry; a future reconciliation job can use
   * this to find work without needing its own separate tracking.
   */
  listPendingTeardownSessions(): WorkerSessionState[] {
    return Array.from(this.sessions.values()).filter((s) => s.teardownPending === true);
  }

  // ─────────────────────────────────────────────────────────────
  // Gate 3 — Vault dynamic-secret leasing, brokered through credentialBroker
  // ─────────────────────────────────────────────────────────────

  private async ensureVaultToken(): Promise<string> {
    const cfg = getConfig();
    if (!cfg.VAULT_ADDR || !cfg.VAULT_ROLE_ID || !cfg.VAULT_SECRET_ID) {
      throw new UpcloudWorkerFactoryError(
        'Vault secret leasing requires VAULT_ADDR, VAULT_ROLE_ID, and VAULT_SECRET_ID',
        'VAULT_ERROR',
      );
    }
    if (this.vaultToken && Date.now() < this.vaultTokenExpiresAtMs) {
      return this.vaultToken;
    }

    const resp = await axios.post<unknown>(
      `${cfg.VAULT_ADDR}/v1/auth/approle/login`,
      { role_id: cfg.VAULT_ROLE_ID, secret_id: cfg.VAULT_SECRET_ID },
      { timeout: 10_000 },
    );
    const parsed = VaultAppRoleLoginResponseSchema.safeParse(resp.data);
    if (!parsed.success) {
      throw new UpcloudWorkerFactoryError(
        `Vault AppRole login returned an unexpected response: ${parsed.error.message}`,
        'VAULT_ERROR',
      );
    }

    this.vaultToken = parsed.data.auth.client_token;
    // Refresh 5s before actual expiry to avoid a race against an in-flight lease.
    this.vaultTokenExpiresAtMs = Date.now() + parsed.data.auth.lease_duration * 1000 - 5_000;
    return this.vaultToken;
  }

  /**
   * Revoke a Vault dynamic-secret lease immediately through Vault's own
   * `sys/leases/revoke` API, rather than relying solely on the lease's own
   * TTL to expire it. Without this, ending a worker session only erased
   * the hub's own encrypted copy of the credential via credentialBroker —
   * the actual Vault-issued credential stayed valid against whatever
   * backend issued it (a database, a cloud provider, …) until its lease
   * TTL ran out on its own, which could be well after the session ended.
   * Best-effort: a failure here is logged loudly but does not abort the
   * caller's own teardown — the lease's TTL remains a backstop even if
   * this call itself fails (Vault unreachable, token expired, etc.).
   */
  private async revokeVaultLease(leaseId: string, sessionId: string): Promise<void> {
    const cfg = getConfig();
    try {
      const token = await this.ensureVaultToken();
      await axios.put(
        `${cfg.VAULT_ADDR}/v1/sys/leases/revoke`,
        { lease_id: leaseId },
        { headers: { 'X-Vault-Token': token }, timeout: 10_000 },
      );
    } catch (err) {
      logger.error('Failed to revoke Vault lease — it will still expire on its own TTL as a backstop', {
        sessionId,
        leaseId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Lease one dynamic secret per requested Vault path and issue each into
   * credentialBroker, scoped to (`upcloud-worker-factory`, `<sessionId>:<path>`).
   * Returns the scopes (each carrying the Vault lease_id alongside the
   * credentialBroker scope) so endSession() can revoke both the hub's own
   * copy and the underlying Vault lease itself — see revokeVaultLease()
   * above for why both matter.
   */
  private async leaseVaultSecrets(
    sessionId: string,
    vaultPaths: string[],
    ttlMs: number,
  ): Promise<CredentialScopeRef[]> {
    if (vaultPaths.length === 0) return [];

    // Validate and encode every path *before* any Vault call is made, so a
    // malformed path in a multi-secret request is rejected up front rather
    // than partway through — see encodeVaultSecretPath() for why this
    // matters (path-traversal outside VAULT_SECRET_MOUNT).
    const requestedPaths = vaultPaths.map((path) => ({ path, encodedPath: encodeVaultSecretPath(path) }));

    const cfg = getConfig();
    const token = await this.ensureVaultToken();
    const scopes: CredentialScopeRef[] = [];

    try {
      for (const { path, encodedPath } of requestedPaths) {
        const resp = await axios.get<unknown>(`${cfg.VAULT_ADDR}/v1/${cfg.VAULT_SECRET_MOUNT}/${encodedPath}`, {
          headers: { 'X-Vault-Token': token },
          timeout: 10_000,
        });
        const parsed = VaultLeaseResponseSchema.safeParse(resp.data);
        if (!parsed.success) {
          throw new UpcloudWorkerFactoryError(
            `Vault returned an unexpected lease shape for '${path}': ${parsed.error.message}`,
            'VAULT_ERROR',
          );
        }

        const scope: CredentialScopeRef = {
          toolId: 'upcloud-worker-factory',
          action: buildVaultLeaseScopeAction(sessionId, path),
          vaultLeaseId: parsed.data.lease_id,
        };
        credentialBroker.issue(scope, JSON.stringify(parsed.data.data), ttlMs);
        scopes.push(scope);

        logger.debug('Vault secret leased into credential broker', {
          sessionId,
          path,
          leaseId: parsed.data.lease_id,
        });
      }
    } catch (err) {
      // A multi-secret request that fails partway through must not leave
      // the secrets already issued for earlier paths live with nothing able
      // to reach — or later revoke — them: this request is about to fail
      // end-to-end, so roll back everything it issued (both the
      // credentialBroker copy and the underlying Vault lease) before
      // propagating.
      for (const scope of scopes) {
        credentialBroker.revoke(scope, 'system:rollback');
        if (scope.vaultLeaseId) {
          await this.revokeVaultLease(scope.vaultLeaseId, sessionId);
        }
      }
      throw err;
    }

    return scopes;
  }
}

/** Singleton instance for use across the application. */
export const upcloudWorkerFactoryAdapter = new UpcloudWorkerFactoryAdapter();
