/**
 * tests/upcloud-worker-factory.test.ts
 * Unit tests for src/adapters/upcloud-worker-factory/index.ts.
 *
 * axios is mocked at the module level (both the default-export HTTP methods
 * used for Vault calls, and the instance returned by axios.create() used for
 * broker calls) so these tests never make a real network call. The
 * credential broker and audit log are used for real (in-memory, no I/O) so
 * behavior is verified end-to-end rather than through a mock of our own code.
 */

import jwt from 'jsonwebtoken';
import axios from 'axios';
import { _resetConfig } from '../src/config';
import {
  UpcloudWorkerFactoryAdapter,
  UpcloudWorkerFactoryError,
  deriveWorkerSessionKey,
} from '../src/adapters/upcloud-worker-factory/index';
import { credentialBroker } from '../src/security/credential-broker';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const JWT_SECRET = 'test-secret-that-is-32-characters-long!!';
const ENCRYPTION_KEY = 'test-encryption-key-32-characters!!';

// AGENTS.md §8 (Testing): "no Date.now() ... without mocking." Several
// fixtures below build an `expiresAt` relative to "now" (and the adapter
// itself reads Date.now() internally for duration metrics and Vault-token
// caching) — pin the clock so every one of those reads is deterministic
// rather than depending on wall-clock time at test-run time.
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z').getTime();

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    JWT_SECRET,
    ENCRYPTION_KEY,
    ...overrides,
  };
}

describe('UpcloudWorkerFactoryAdapter', () => {
  const originalEnv = process.env;
  let mockBrokerClient: { post: jest.Mock; get: jest.Mock; delete: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
    mockBrokerClient = { post: jest.fn(), get: jest.fn(), delete: jest.fn() };
    mockedAxios.create.mockReturnValue(mockBrokerClient as unknown as ReturnType<typeof axios.create>);
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    mockedAxios.put.mockReset();
    mockedAxios.put.mockResolvedValue({ data: {} });
    // credentialBroker is a module-level singleton (shared across tests), but
    // every test below uses a unique sessionId/scope, so no cross-test reset
    // is needed — scope keys never collide.
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetConfig();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('initialize() / shutdown()', () => {
    it('is a no-op when ENABLE_UPCLOUD_WORKER_FACTORY is false (the default)', async () => {
      process.env = baseEnv();
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();

      await adapter.initialize();

      expect(mockedAxios.create).not.toHaveBeenCalled();
      await expect(
        adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' }),
      ).rejects.toThrow(UpcloudWorkerFactoryError);
    });

    it('throws if enabled without UPCLOUD_BROKER_URL', async () => {
      process.env = baseEnv({ ENABLE_UPCLOUD_WORKER_FACTORY: 'true' });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();

      await expect(adapter.initialize()).rejects.toThrow('UPCLOUD_BROKER_URL');
    });

    it('creates a broker HTTP client when properly configured', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();

      await adapter.initialize();

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://broker.example.internal' }),
      );
    });

    it('shutdown() ends every active session', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-1',
          workerId: 'worker-1',
          endpoint: 'wss://worker-1.example.internal/cdp',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      mockBrokerClient.delete.mockResolvedValue({ data: {} });

      await adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' });
      expect(adapter.listSessions()).toHaveLength(1);

      await adapter.shutdown();

      expect(adapter.listSessions()).toHaveLength(0);
      expect(mockBrokerClient.delete).toHaveBeenCalledWith('/sessions/sess-1');
    });

    it('shutdown() does not lose a session whose broker-side DELETE failed, instead of falsely declaring full success', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post
        .mockResolvedValueOnce({
          data: {
            sessionId: 'sess-shutdown-ok',
            workerId: 'worker-shutdown-ok',
            endpoint: 'wss://worker-shutdown-ok.example.internal/cdp',
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        })
        .mockResolvedValueOnce({
          data: {
            sessionId: 'sess-shutdown-fails',
            workerId: 'worker-shutdown-fails',
            endpoint: 'wss://worker-shutdown-fails.example.internal/cdp',
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        });

      const okHandle = await adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' });
      const failHandle = await adapter.createSession({ capability: 'desktop', requestedBy: 'agent-1' });

      mockBrokerClient.delete.mockImplementation((path: string) =>
        path.includes(failHandle.sessionId)
          ? Promise.reject(new Error('broker unreachable'))
          : Promise.resolve({ data: {} }),
      );

      // endSession() resolves normally even for the session whose broker
      // DELETE fails (it marks teardownPending rather than rejecting), so
      // Promise.allSettled() alone can't tell shutdown() anything went
      // wrong — this is exactly the gap being tested: shutdown() must check
      // real post-settle state, not just which promises rejected.
      await expect(adapter.shutdown()).resolves.toBeUndefined();

      expect(adapter.getSession(okHandle.sessionId)).toBeUndefined();
      const pending = adapter.listPendingTeardownSessions();
      expect(pending.map((s) => s.sessionId)).toEqual([failHandle.sessionId]);
    });
  });

  describe('createSession()', () => {
    let adapter: UpcloudWorkerFactoryAdapter;

    beforeEach(async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();
    });

    it('returns a session handle with a verifiable worker-session token', async () => {
      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-abc',
          workerId: 'worker-abc',
          endpoint: 'wss://worker-abc.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });

      const handle = await adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' });

      expect(handle.sessionId).toBe('sess-abc');
      expect(handle.endpoint).toBe('wss://worker-abc.example.internal/cdp');
      expect(handle.capability).toBe('browser');

      const claims = adapter.verifySessionToken(handle.token);
      expect(claims.subject).toBe('agent-1');
      expect(claims.sessionId).toBe('sess-abc');
      expect(claims.capabilities).toEqual(['browser']);
    });

    it('caps the requested TTL at WORKER_SESSION_MAX_TTL_MS', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        WORKER_SESSION_MAX_TTL_MS: '120000',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-cap',
          workerId: 'worker-cap',
          endpoint: 'wss://worker-cap.example.internal/cdp',
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      });

      await adapter.createSession({ capability: 'browser', requestedBy: 'agent-1', ttlMs: 999_999_999 });

      expect(mockBrokerClient.post).toHaveBeenCalledWith(
        '/sessions',
        expect.objectContaining({ ttlMs: 120_000 }),
      );
    });

    it('throws BROKER_ERROR when the broker response fails schema validation', async () => {
      mockBrokerClient.post.mockResolvedValue({ data: { sessionId: 'only-a-session-id' } });

      await expect(
        adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' }),
      ).rejects.toMatchObject({ code: 'BROKER_ERROR' });
    });

    it('rejects a broker endpoint that is not a secure WebSocket URL', async () => {
      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-insecure',
          workerId: 'worker-insecure',
          // A compromised or misbehaving broker could return any scheme —
          // https:// (or file://, etc.) must be rejected, not just blindly
          // trusted and handed back as something to connect to.
          endpoint: 'https://worker-insecure.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });

      await expect(
        adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' }),
      ).rejects.toMatchObject({ code: 'BROKER_ERROR' });
    });

    it('rolls back the broker session when Vault leasing fails after allocation', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-rollback',
          workerId: 'worker-rollback',
          endpoint: 'wss://worker-rollback.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockBrokerClient.delete.mockResolvedValue({ data: {} });
      // Vault AppRole login succeeds, but the lease response itself fails
      // schema validation — leasing fails *after* the broker already
      // allocated a worker for this session.
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      mockedAxios.get.mockResolvedValue({ data: { not: 'a valid lease shape' } });

      await expect(
        adapter.createSession({
          capability: 'browser',
          requestedBy: 'agent-1',
          vaultSecretPaths: ['upcloud-worker-factory/session-creds'],
        }),
      ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

      // The allocated worker must not be leaked: its broker session is torn
      // down, and the session never shows up as something endSession() or
      // shutdown() could find later.
      expect(mockBrokerClient.delete).toHaveBeenCalledWith('/sessions/sess-rollback');
      expect(adapter.listSessions()).toHaveLength(0);
    });

    it('rolls back earlier-leased scopes when a later path in a multi-secret request fails', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-partial',
          workerId: 'worker-partial',
          endpoint: 'wss://worker-partial.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockBrokerClient.delete.mockResolvedValue({ data: {} });
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      // First path leases successfully; second path's response fails schema
      // validation — the first path's credential must not be left live.
      mockedAxios.get
        .mockResolvedValueOnce({
          data: { lease_id: 'lease-1', lease_duration: 3600, data: { apiKey: 'first-secret-value' } },
        })
        .mockResolvedValueOnce({ data: { not: 'a valid lease shape' } });

      await expect(
        adapter.createSession({
          capability: 'browser',
          requestedBy: 'agent-1',
          vaultSecretPaths: ['upcloud-worker-factory/first-path', 'upcloud-worker-factory/second-path'],
        }),
      ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

      const firstScope = {
        toolId: 'upcloud-worker-factory',
        action: `${encodeURIComponent('sess-partial')}:${encodeURIComponent('upcloud-worker-factory/first-path')}`,
      };
      expect(() => credentialBroker.retrieve(firstScope, 'test')).toThrow();

      // The first path's underlying Vault lease must be revoked too, not
      // just the hub's own encrypted copy — otherwise it stays valid
      // against whatever backend issued it until its TTL runs out on its
      // own, even though the session that leased it never came into being.
      expect(mockedAxios.put).toHaveBeenCalledWith(
        'https://vault.example.internal/v1/sys/leases/revoke',
        { lease_id: 'lease-1' },
        expect.objectContaining({ headers: { 'X-Vault-Token': 'vault-token-xyz' } }),
      );
    });

    it('retains a teardown-pending record when the compensating broker DELETE also fails after Vault leasing fails, instead of leaking it silently', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-double-fail',
          workerId: 'worker-double-fail',
          endpoint: 'wss://worker-double-fail.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      // The compensating rollback DELETE fails too, not just the Vault
      // lease — before this fix, that left the allocated worker completely
      // invisible to every reconciliation path (listPendingTeardownSessions,
      // getStatus, shutdown), because createSession() had never added it to
      // `this.sessions` in the first place.
      mockBrokerClient.delete.mockRejectedValue(new Error('broker unreachable'));
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      mockedAxios.get.mockResolvedValue({ data: { not: 'a valid lease shape' } });

      await expect(
        adapter.createSession({
          capability: 'desktop',
          requestedBy: 'agent-1',
          vaultSecretPaths: ['upcloud-worker-factory/session-creds'],
        }),
      ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

      expect(mockBrokerClient.delete).toHaveBeenCalledWith('/sessions/sess-double-fail');

      // The session must now be findable and retryable, not silently gone.
      const pending = adapter.listPendingTeardownSessions();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        sessionId: 'sess-double-fail',
        workerId: 'worker-double-fail',
        capability: 'desktop',
        requestedBy: 'agent-1',
        leasedCredentialScopes: [],
        teardownPending: true,
      });
      expect(adapter.getSession('sess-double-fail')).toBeDefined();

      // Calling endSession() later must retry only the broker-side DELETE —
      // there is nothing left to revoke, since leaseVaultSecrets() already
      // rolled back anything it had issued before this outer catch ran.
      mockBrokerClient.delete.mockResolvedValueOnce({ data: {} });
      await adapter.endSession('sess-double-fail', 'agent-1');
      expect(adapter.listPendingTeardownSessions()).toHaveLength(0);
      expect(adapter.getSession('sess-double-fail')).toBeUndefined();
    });

    it('rejects a Vault secret path containing a traversal segment, before any Vault call is made', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-traversal',
          workerId: 'worker-traversal',
          endpoint: 'wss://worker-traversal.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockBrokerClient.delete.mockResolvedValue({ data: {} });

      // Without validation, this would normalize to a Vault API path
      // *outside* VAULT_SECRET_MOUNT, reachable by whatever the AppRole's
      // policy allows — not just secrets under the configured mount.
      await expect(
        adapter.createSession({
          capability: 'browser',
          requestedBy: 'agent-1',
          vaultSecretPaths: ['../../sys/leases/lookup'],
        }),
      ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

      // Rejected before ever touching Vault — not even the AppRole login.
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('percent-encodes each Vault secret path segment before including it in the request URL', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-encode',
          workerId: 'worker-encode',
          endpoint: 'wss://worker-encode.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      mockedAxios.get.mockResolvedValue({
        data: { lease_id: 'lease-1', lease_duration: 3600, data: { apiKey: 'leased-secret-value' } },
      });

      await adapter.createSession({
        capability: 'browser',
        requestedBy: 'agent-1',
        vaultSecretPaths: ['team a/secret#1'],
      });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://vault.example.internal/v1/secret/team%20a/secret%231',
        expect.anything(),
      );
    });

    it('leases Vault secrets into credentialBroker and revokes them on endSession()', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-vault',
          workerId: 'worker-vault',
          endpoint: 'wss://worker-vault.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      mockedAxios.get.mockResolvedValue({
        data: { lease_id: 'lease-1', lease_duration: 3600, data: { apiKey: 'leased-secret-value' } },
      });

      const handle = await adapter.createSession({
        capability: 'browser',
        requestedBy: 'agent-1',
        vaultSecretPaths: ['upcloud-worker-factory/session-creds'],
      });

      const scope = {
        toolId: 'upcloud-worker-factory',
        action: `${encodeURIComponent('sess-vault')}:${encodeURIComponent('upcloud-worker-factory/session-creds')}`,
      };
      expect(credentialBroker.retrieve(scope, 'test')).toContain('leased-secret-value');

      await adapter.endSession(handle.sessionId, 'agent-1');

      expect(() => credentialBroker.retrieve(scope, 'test')).toThrow();

      // The underlying Vault lease itself must be revoked, not just the
      // hub's own encrypted copy of it — otherwise the real credential
      // stays valid until its lease TTL expires on its own.
      expect(mockedAxios.put).toHaveBeenCalledWith(
        'https://vault.example.internal/v1/sys/leases/revoke',
        { lease_id: 'lease-1' },
        expect.objectContaining({ headers: { 'X-Vault-Token': 'vault-token-xyz' } }),
      );
    });

    it('does not let two sessions with colliding unencoded sessionId:path pairs clobber each other\'s credential scope', async () => {
      // Without per-component encoding, (sessionId='sess-a:extra',
      // path='creds') and (sessionId='sess-a', path='extra:creds') both
      // join to the literal string 'sess-a:extra:creds' — the exact
      // collision Copilot's High-severity finding described. sessionId
      // comes straight from the broker's own session-create response
      // (BrokerSessionResponseSchema only requires z.string().min(1)), so a
      // misbehaving or compromised broker could trigger this without the
      // caller-supplied vault path needing to contain a colon at all.
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });

      // Session A: sessionId contains a colon; path does not.
      mockBrokerClient.post.mockResolvedValueOnce({
        data: {
          sessionId: 'sess-a:extra',
          workerId: 'worker-a',
          endpoint: 'wss://worker-a.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: { lease_id: 'lease-a', lease_duration: 3600, data: { apiKey: 'secret-for-session-a' } },
      });
      const handleA = await adapter.createSession({
        capability: 'browser',
        requestedBy: 'agent-1',
        vaultSecretPaths: ['creds'],
      });

      // Session B: sessionId does not contain a colon; path does — chosen
      // so the unencoded join ('sess-a' + ':' + 'extra:creds') would equal
      // session A's unencoded join ('sess-a:extra' + ':' + 'creds').
      mockBrokerClient.post.mockResolvedValueOnce({
        data: {
          sessionId: 'sess-a',
          workerId: 'worker-b',
          endpoint: 'wss://worker-b.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: { lease_id: 'lease-b', lease_duration: 3600, data: { apiKey: 'secret-for-session-b' } },
      });
      const handleB = await adapter.createSession({
        capability: 'browser',
        requestedBy: 'agent-2',
        vaultSecretPaths: ['extra:creds'],
      });

      expect(handleA.sessionId).not.toBe(handleB.sessionId);

      const scopeA = {
        toolId: 'upcloud-worker-factory',
        action: `${encodeURIComponent('sess-a:extra')}:${encodeURIComponent('creds')}`,
      };
      const scopeB = {
        toolId: 'upcloud-worker-factory',
        action: `${encodeURIComponent('sess-a')}:${encodeURIComponent('extra:creds')}`,
      };

      // Each session's credential is independently retrievable under its
      // own distinct, percent-encoded scope key — issuing session B's
      // secret must not have overwritten session A's.
      expect(scopeA.action).not.toBe(scopeB.action);
      expect(credentialBroker.retrieve(scopeA, 'test')).toContain('secret-for-session-a');
      expect(credentialBroker.retrieve(scopeB, 'test')).toContain('secret-for-session-b');

      // Ending session A must revoke only session A's credential, not
      // session B's — the exact blast-radius failure a collision causes.
      mockBrokerClient.delete.mockResolvedValue({ data: {} });
      await adapter.endSession(handleA.sessionId, 'agent-1');
      expect(() => credentialBroker.retrieve(scopeA, 'test')).toThrow();
      expect(credentialBroker.retrieve(scopeB, 'test')).toContain('secret-for-session-b');
    });

    it('revokeVaultLease() failure during endSession() is logged but does not stop teardown', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-vault-revoke-fails',
          workerId: 'worker-vault-revoke-fails',
          endpoint: 'wss://worker-vault-revoke-fails.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockBrokerClient.delete.mockResolvedValue({ data: {} });
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      mockedAxios.get.mockResolvedValue({
        data: { lease_id: 'lease-1', lease_duration: 3600, data: { apiKey: 'leased-secret-value' } },
      });
      mockedAxios.put.mockRejectedValue(new Error('Vault unreachable'));

      const handle = await adapter.createSession({
        capability: 'browser',
        requestedBy: 'agent-1',
        vaultSecretPaths: ['upcloud-worker-factory/session-creds'],
      });

      // Vault being unreachable for the revoke call must not prevent the
      // rest of teardown (broker session delete, credentialBroker revoke,
      // local session-map cleanup) from completing.
      await expect(adapter.endSession(handle.sessionId, 'agent-1')).resolves.toBeUndefined();
      expect(adapter.listSessions()).toHaveLength(0);
    });

    it('retains the session as teardown-pending when the broker teardown call fails, instead of discarding it', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
        VAULT_ADDR: 'https://vault.example.internal',
        VAULT_ROLE_ID: 'role-123',
        VAULT_SECRET_ID: 'secret-123',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-broker-delete-fails',
          workerId: 'worker-broker-delete-fails',
          endpoint: 'wss://worker-broker-delete-fails.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
      mockBrokerClient.delete.mockRejectedValue(new Error('broker unreachable'));
      mockedAxios.post.mockResolvedValue({
        data: { auth: { client_token: 'vault-token-xyz', lease_duration: 3600 } },
      });
      mockedAxios.get.mockResolvedValue({
        data: { lease_id: 'lease-1', lease_duration: 3600, data: { apiKey: 'leased-secret-value' } },
      });

      const handle = await adapter.createSession({
        capability: 'browser',
        requestedBy: 'agent-1',
        vaultSecretPaths: ['upcloud-worker-factory/session-creds'],
      });
      const scope = {
        toolId: 'upcloud-worker-factory',
        action: `${encodeURIComponent(handle.sessionId)}:${encodeURIComponent('upcloud-worker-factory/session-creds')}`,
      };

      await expect(adapter.endSession(handle.sessionId, 'agent-1')).resolves.toBeUndefined();

      // Credentials are revoked unconditionally, regardless of the broker
      // call's outcome — a leased secret must not outlive its session just
      // because the remote worker couldn't be reached.
      expect(() => credentialBroker.retrieve(scope, 'test')).toThrow();
      expect(mockedAxios.put).toHaveBeenCalledWith(
        'https://vault.example.internal/v1/sys/leases/revoke',
        { lease_id: 'lease-1' },
        expect.objectContaining({ headers: { 'X-Vault-Token': 'vault-token-xyz' } }),
      );

      // But the session itself is retained, not silently dropped, so the
      // still-possibly-live remote worker isn't forgotten about.
      expect(adapter.listSessions()).toHaveLength(1);
      const pending = adapter.getSession(handle.sessionId);
      expect(pending?.teardownPending).toBe(true);
      expect(pending?.leasedCredentialScopes).toHaveLength(0);
      expect(adapter.listPendingTeardownSessions().map((s) => s.sessionId)).toEqual([handle.sessionId]);
    });

    it('retrying endSession() after a teardown-pending failure completes teardown once the broker call succeeds', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-broker-delete-retry',
          workerId: 'worker-broker-delete-retry',
          endpoint: 'wss://worker-broker-delete-retry.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });

      const handle = await adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' });

      mockBrokerClient.delete.mockRejectedValueOnce(new Error('broker unreachable'));
      await adapter.endSession(handle.sessionId, 'agent-1');
      expect(adapter.listPendingTeardownSessions()).toHaveLength(1);

      mockBrokerClient.delete.mockResolvedValueOnce({ data: {} });
      await adapter.endSession(handle.sessionId, 'agent-1');

      expect(adapter.listSessions()).toHaveLength(0);
      expect(adapter.listPendingTeardownSessions()).toHaveLength(0);
    });
  });

  describe('verifySessionToken()', () => {
    it('rejects a token not scoped for worker-session access', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      // Signed with the correct (derived) worker-session key so it passes
      // signature verification — this test is specifically about the
      // `scope` check, not about key separation (see the test below for
      // that).
      const foreignToken = jwt.sign(
        { sub: 'someone', scope: 'admin-api' },
        deriveWorkerSessionKey(JWT_SECRET),
        { expiresIn: '5m' },
      );

      expect(() => adapter.verifySessionToken(foreignToken)).toThrow('not scoped for worker-session');
    });

    it('rejects a token signed with JWT_SECRET directly, even with a worker-session scope claim', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      // If something ever signed a worker-session-shaped token with the
      // hub's general JWT_SECRET instead of the derived key, it must still
      // not verify here — the whole point of key separation.
      const wrongKeyToken = jwt.sign(
        { sub: 'someone', scope: 'worker-session', sessionId: 'sess-x', capabilities: ['browser'] },
        JWT_SECRET,
        { expiresIn: '5m' },
      );

      expect(() => adapter.verifySessionToken(wrongKeyToken)).toThrow();
    });

    it('rejects an otherwise-validly-signed token whose capabilities claim contains a value outside browser/desktop', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      // Correctly signed with the derived key — this is specifically about
      // not trusting the *claims* inside an otherwise-genuine token.
      const forgedCapabilityToken = jwt.sign(
        { sub: 'someone', scope: 'worker-session', sessionId: 'sess-x', capabilities: ['admin'] },
        deriveWorkerSessionKey(JWT_SECRET),
        { expiresIn: '5m' },
      );

      expect(() => adapter.verifySessionToken(forgedCapabilityToken)).toThrow(
        'missing or invalid capabilities claim',
      );
    });

    it('rejects a validly-signed token whose capabilities claim is missing or not an array', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      const missingCapabilitiesToken = jwt.sign(
        { sub: 'someone', scope: 'worker-session', sessionId: 'sess-x' },
        deriveWorkerSessionKey(JWT_SECRET),
        { expiresIn: '5m' },
      );
      const nonArrayCapabilitiesToken = jwt.sign(
        { sub: 'someone', scope: 'worker-session', sessionId: 'sess-x', capabilities: 'browser' },
        deriveWorkerSessionKey(JWT_SECRET),
        { expiresIn: '5m' },
      );

      expect(() => adapter.verifySessionToken(missingCapabilitiesToken)).toThrow(
        'missing or invalid capabilities claim',
      );
      expect(() => adapter.verifySessionToken(nonArrayCapabilitiesToken)).toThrow(
        'missing or invalid capabilities claim',
      );
    });

    it('accepts a validly-signed token with a genuine capabilities claim', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      const genuineToken = jwt.sign(
        { sub: 'agent-1', scope: 'worker-session', sessionId: 'sess-good', capabilities: ['desktop'] },
        deriveWorkerSessionKey(JWT_SECRET),
        { expiresIn: '5m' },
      );

      expect(adapter.verifySessionToken(genuineToken)).toEqual({
        subject: 'agent-1',
        sessionId: 'sess-good',
        capabilities: ['desktop'],
      });
    });
  });

  describe('deriveWorkerSessionKey() — key separation', () => {
    it('produces a key that never equals JWT_SECRET', () => {
      expect(deriveWorkerSessionKey(JWT_SECRET)).not.toBe(JWT_SECRET);
    });

    it('is deterministic for the same JWT_SECRET', () => {
      expect(deriveWorkerSessionKey(JWT_SECRET)).toBe(deriveWorkerSessionKey(JWT_SECRET));
    });

    it('mints tokens that do NOT verify against the hub-wide JWT_SECRET', async () => {
      // This is the actual regression this change prevents: every other
      // verifier in the hub (admin-api.ts, transport/middleware/auth.ts,
      // multitenancy/TenantMiddleware.ts) calls
      // jwt.verify(token, cfg.JWT_SECRET). A genuine worker-session token
      // minted by this adapter must fail that call outright, rather than
      // succeeding and depending on each verifier to check `scope` by hand.
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      mockBrokerClient.post.mockResolvedValue({
        data: {
          sessionId: 'sess-keysep',
          workerId: 'worker-keysep',
          endpoint: 'wss://worker-keysep.example.internal/cdp',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });

      const handle = await adapter.createSession({ capability: 'browser', requestedBy: 'agent-1' });

      expect(() => jwt.verify(handle.token, JWT_SECRET)).toThrow();
      // But it does verify against the derived key, confirming the token
      // itself is well-formed and this isn't a false pass.
      expect(() => jwt.verify(handle.token, deriveWorkerSessionKey(JWT_SECRET))).not.toThrow();
    });
  });

  describe('endSession()', () => {
    it('is a safe no-op for an unknown sessionId', async () => {
      process.env = baseEnv({
        ENABLE_UPCLOUD_WORKER_FACTORY: 'true',
        UPCLOUD_BROKER_URL: 'https://broker.example.internal',
      });
      _resetConfig();
      const adapter = new UpcloudWorkerFactoryAdapter();
      await adapter.initialize();

      await expect(adapter.endSession('does-not-exist', 'agent-1')).resolves.toBeUndefined();
    });
  });
});
