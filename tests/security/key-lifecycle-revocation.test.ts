process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-jwt-secret-min-32-characters!!!';
process.env['ENCRYPTION_KEY'] = process.env['ENCRYPTION_KEY'] ?? 'test-encryption-key-min-32-characters';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../../src/observability/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('ApiKeyLifecycle', () => {
  it('creates, rotates with overlap, validates and revokes API keys', async () => {
    const { SecretStore } = await import('../../src/security/secret-store');
    const { ApiKeyLifecycle } = await import('../../src/security/auth/ApiKeyLifecycle');

    const store = new SecretStore();
    const audit = { record: jest.fn() };
    const lifecycle = new ApiKeyLifecycle(store, audit);

    const created = lifecycle.createKey('service-a', ['read'], new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    expect(lifecycle.validateKey(created.apiKey)?.owner).toBe('service-a');

    const rotated = lifecycle.rotateKey(created.id, 3600);
    expect(lifecycle.validateKey(rotated.apiKey)?.id).toBe(created.id);
    expect(lifecycle.validateKey(created.apiKey)?.id).toBe(created.id);

    lifecycle.revokeKey(created.id);
    expect(lifecycle.validateKey(rotated.apiKey)).toBeUndefined();
  });
});

describe('TokenRevocation', () => {
  it('revokes and checks tokens via memory + redis-backed store', async () => {
    const { TokenRevocation } = await import('../../src/security/auth/TokenRevocation');

    const store = new Map<string, string>();
    const redis = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => Number(store.delete(key))),
    };

    const revocation = new TokenRevocation(redis, { record: jest.fn() });
    await revocation.revokeToken('jwt-token-1', new Date(Date.now() + 10_000), 'manual');

    const first = await revocation.isRevoked('jwt-token-1');
    const second = await revocation.isRevoked('jwt-token-1');

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(redis.set).toHaveBeenCalled();
  });
});
