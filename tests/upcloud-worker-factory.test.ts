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
import { UpcloudWorkerFactoryAdapter, UpcloudWorkerFactoryError } from '../src/adapters/upcloud-worker-factory/index';
import { credentialBroker } from '../src/security/credential-broker';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const JWT_SECRET = 'test-secret-that-is-32-characters-long!!';
const ENCRYPTION_KEY = 'test-encryption-key-32-characters!!';

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
    mockBrokerClient = { post: jest.fn(), get: jest.fn(), delete: jest.fn() };
    mockedAxios.create.mockReturnValue(mockBrokerClient as unknown as ReturnType<typeof axios.create>);
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    // credentialBroker is a module-level singleton (shared across tests), but
    // every test below uses a unique sessionId/scope, so no cross-test reset
    // is needed — scope keys never collide.
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetConfig();
    jest.clearAllMocks();
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

      const scope = { toolId: 'upcloud-worker-factory', action: 'sess-vault:upcloud-worker-factory/session-creds' };
      expect(credentialBroker.retrieve(scope, 'test')).toContain('leased-secret-value');

      await adapter.endSession(handle.sessionId, 'agent-1');

      expect(() => credentialBroker.retrieve(scope, 'test')).toThrow();
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

      const foreignToken = jwt.sign({ sub: 'someone', scope: 'admin-api' }, JWT_SECRET, { expiresIn: '5m' });

      expect(() => adapter.verifySessionToken(foreignToken)).toThrow('not scoped for worker-session');
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
