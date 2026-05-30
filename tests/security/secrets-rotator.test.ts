process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-jwt-secret-min-32-characters!!!';
process.env['ENCRYPTION_KEY'] = process.env['ENCRYPTION_KEY'] ?? 'test-encryption-key-min-32-characters';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../../src/observability/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('SecretsRotator', () => {
  it('rotates JWT, DB, and API keys with overlap windows and due intervals', async () => {
    const { SecretStore } = await import('../../src/security/secret-store');
    const { ApiKeyLifecycle } = await import('../../src/security/auth/ApiKeyLifecycle');
    const { SecretsRotator } = await import('../../src/security/rotation/SecretsRotator');

    const store = new SecretStore();
    const audit = { record: jest.fn() };
    const lifecycle = new ApiKeyLifecycle(store, audit);
    lifecycle.createKey('svc-a', ['read'], new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString());

    const rotator = new SecretsRotator({
      store,
      logger: audit,
      apiKeyLifecycle: lifecycle,
      jwtOverlapMs: 10_000,
      dbOverlapMs: 20_000,
      apiKeyOverlapSec: 120,
    });

    const t0 = Date.now();
    const first = rotator.rotateDueSecrets(t0);
    expect(first.jwtRotated).toBe(true);
    expect(first.dbRotated).toBe(true);
    expect(first.apiKeysRotated).toBe(1);
    expect(store.get('rotation:jwt:current')).toBeTruthy();
    expect(store.get('rotation:db-password:current')).toBeTruthy();

    const notDue = rotator.rotateDueSecrets(t0 + 60_000);
    expect(notDue.jwtRotated).toBe(false);
    expect(notDue.dbRotated).toBe(false);
    expect(notDue.apiKeysRotated).toBe(0);

    const dueJwt = rotator.rotateJwtSigningKeyIfDue(t0 + 24 * 60 * 60 * 1000 + 1);
    expect(dueJwt).toBe(true);
    expect(store.get('rotation:jwt:previous')).toContain('validUntil');
  });
});
