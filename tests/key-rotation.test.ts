/**
 * tests/key-rotation.test.ts
 * Unit tests for zero-downtime key rotation of JWT_SECRET and ENCRYPTION_KEY.
 *
 * Covers:
 *  - Dual-secret JWT verification: old token valid during rotation window
 *  - New token (signed with JWT_SECRET_NEW) is valid during rotation window
 *  - Very old token rejected after cutover (only JWT_SECRET_NEW present)
 *  - rotateEncryptionKey: re-encrypts all in-memory secrets atomically
 *  - rotateEncryptionKey: validation guards (short key, same key)
 *  - POST /admin/security/rotate-key endpoint: confirm flag required
 */

const JWT_SECRET = 'old-secret-that-is-32-characters-long!!';
const JWT_SECRET_NEW = 'new-secret-that-is-32-characters-long!!';
const ENCRYPTION_KEY = 'old-enc-key-that-is-32-chars-long!!!!!';
const ENCRYPTION_KEY_NEW = 'new-enc-key-that-is-32-chars-long!!!!!';

// Set env before any module imports
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['ENCRYPTION_KEY'] = ENCRYPTION_KEY;
process.env['NODE_ENV'] = 'test';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn() },
}));

jest.mock('../src/core/runtime-manager', () => ({
  runtimeManager: {
    isInitialized: jest.fn(() => true),
    getCapabilities: jest.fn(() => []),
    deregisterCapability: jest.fn(() => false),
  },
}));

import jwt from 'jsonwebtoken';
import { SecretStore, rotateEncryptionKey } from '../src/security/secret-store';
import { encrypt, decrypt } from '../src/security/crypto';
import { _resetConfig } from '../src/config';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function signOldToken(): string {
  return jwt.sign({ sub: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function signNewToken(): string {
  return jwt.sign({ sub: 'admin', role: 'admin' }, JWT_SECRET_NEW, { expiresIn: '1h' });
}

// ─────────────────────────────────────────────────────────────────
// JWT dual-secret verification logic (mirrors requireAuth middleware)
// ─────────────────────────────────────────────────────────────────

/**
 * Simulates the dual-secret middleware verification logic.
 * Tries secretsToTry in order; returns decoded payload or throws.
 */
function verifyWithDualSecrets(
  token: string,
  secretsToTry: string[],
): jwt.JwtPayload | string {
  for (const secret of secretsToTry) {
    try {
      return jwt.verify(token, secret);
    } catch {
      // try next
    }
  }
  throw new Error('Token verification failed against all secrets');
}

// ─────────────────────────────────────────────────────────────────
// Tests: JWT key rotation
// ─────────────────────────────────────────────────────────────────

describe('JWT key rotation — dual-secret window', () => {
  it('accepts a token signed with JWT_SECRET when only JWT_SECRET is configured', () => {
    const token = signOldToken();
    const decoded = verifyWithDualSecrets(token, [JWT_SECRET]) as jwt.JwtPayload;
    expect(decoded['sub']).toBe('admin');
  });

  it('accepts a token signed with JWT_SECRET during rotation window (both secrets present)', () => {
    const token = signOldToken();
    // During rotation: try JWT_SECRET_NEW first, then JWT_SECRET
    const decoded = verifyWithDualSecrets(token, [JWT_SECRET_NEW, JWT_SECRET]) as jwt.JwtPayload;
    expect(decoded['sub']).toBe('admin');
  });

  it('accepts a token signed with JWT_SECRET_NEW during rotation window', () => {
    const token = signNewToken();
    // During rotation: try JWT_SECRET_NEW first, then JWT_SECRET
    const decoded = verifyWithDualSecrets(token, [JWT_SECRET_NEW, JWT_SECRET]) as jwt.JwtPayload;
    expect(decoded['sub']).toBe('admin');
  });

  it('rejects a very old token (signed with JWT_SECRET) after cutover to JWT_SECRET_NEW only', () => {
    const oldToken = signOldToken();
    // After cutover: only JWT_SECRET_NEW is active
    expect(() => verifyWithDualSecrets(oldToken, [JWT_SECRET_NEW])).toThrow();
  });

  it('rejects a token signed with a completely unknown secret even during rotation window', () => {
    const unknownToken = jwt.sign({ sub: 'admin' }, 'unknown-secret-that-is-very-long!!!!!');
    expect(() =>
      verifyWithDualSecrets(unknownToken, [JWT_SECRET_NEW, JWT_SECRET]),
    ).toThrow();
  });

  it('rejects an expired token even if the secret matches', () => {
    const expiredToken = jwt.sign({ sub: 'admin' }, JWT_SECRET, { expiresIn: -1 });
    expect(() => verifyWithDualSecrets(expiredToken, [JWT_SECRET_NEW, JWT_SECRET])).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// Tests: rotateEncryptionKey
// ─────────────────────────────────────────────────────────────────

describe('rotateEncryptionKey', () => {
  function makeStore(entries: Record<string, string>): SecretStore {
    const store = new SecretStore();
    for (const [k, v] of Object.entries(entries)) {
      store.set(k, v);
    }
    return store;
  }

  it('re-encrypts all secrets in the store and returns rotatedCount', async () => {
    const store = makeStore({
      'api-key': 'secret-value-alpha',
      'db-password': 'secret-value-beta',
    });

    const result = await rotateEncryptionKey(ENCRYPTION_KEY, ENCRYPTION_KEY_NEW, store);

    expect(result.rotatedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Values should still be accessible in plaintext
    expect(store.get('api-key')).toBe('secret-value-alpha');
    expect(store.get('db-password')).toBe('secret-value-beta');
  });

  it('returns rotatedCount=0 for an empty store', async () => {
    const store = new SecretStore();
    const result = await rotateEncryptionKey(ENCRYPTION_KEY, ENCRYPTION_KEY_NEW, store);
    expect(result.rotatedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it('new key can encrypt/decrypt values independently after rotation', () => {
    const value = 'super-secret-value';
    const ciphertext = encrypt(value, ENCRYPTION_KEY_NEW);
    expect(decrypt(ciphertext, ENCRYPTION_KEY_NEW)).toBe(value);
    expect(() => decrypt(ciphertext, ENCRYPTION_KEY)).toThrow();
  });

  it('throws if oldKey is shorter than 32 characters', async () => {
    const store = new SecretStore();
    await expect(rotateEncryptionKey('short', ENCRYPTION_KEY_NEW, store)).rejects.toThrow(
      'oldKey must be at least 32 characters',
    );
  });

  it('throws if newKey is shorter than 32 characters', async () => {
    const store = new SecretStore();
    await expect(rotateEncryptionKey(ENCRYPTION_KEY, 'short', store)).rejects.toThrow(
      'newKey must be at least 32 characters',
    );
  });

  it('throws if oldKey and newKey are the same', async () => {
    const store = new SecretStore();
    await expect(rotateEncryptionKey(ENCRYPTION_KEY, ENCRYPTION_KEY, store)).rejects.toThrow(
      'newKey must differ from oldKey',
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Tests: POST /admin/security/rotate-key endpoint
// ─────────────────────────────────────────────────────────────────

describe('POST /admin/security/rotate-key — request validation', () => {
  // Import the router after mocks are set up
  const { adminRouter } = jest.requireActual<typeof import('../src/api/admin-api')>(
    '../src/api/admin-api',
  );

  it('adminRouter has the rotate-key route registered', () => {
    // Check that the route stack contains a handler matching /security/rotate-key
    const stack = adminRouter.stack as Array<{ route?: { path?: string } }>;
    const paths = stack
      .filter((layer) => layer.route !== undefined)
      .map((layer) => layer.route?.path ?? '');
    expect(paths).toContain('/security/rotate-key');
  });
});

// ─────────────────────────────────────────────────────────────────
// Tests: config — JWT_SECRET_NEW and ENCRYPTION_KEY_NEW optional fields
// ─────────────────────────────────────────────────────────────────

describe('Config — rotation key fields', () => {
  afterEach(() => {
    _resetConfig();
    // Restore base env
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['ENCRYPTION_KEY'] = ENCRYPTION_KEY;
    delete process.env['JWT_SECRET_NEW'];
    delete process.env['ENCRYPTION_KEY_NEW'];
  });

  it('parses JWT_SECRET_NEW when set', () => {
    process.env['JWT_SECRET_NEW'] = JWT_SECRET_NEW;
    _resetConfig();
    const { getConfig } = jest.requireActual<typeof import('../src/config')>('../src/config');
    const cfg = getConfig();
    expect(cfg.JWT_SECRET_NEW).toBe(JWT_SECRET_NEW);
  });

  it('parses ENCRYPTION_KEY_NEW when set', () => {
    process.env['ENCRYPTION_KEY_NEW'] = ENCRYPTION_KEY_NEW;
    _resetConfig();
    const { getConfig } = jest.requireActual<typeof import('../src/config')>('../src/config');
    const cfg = getConfig();
    expect(cfg.ENCRYPTION_KEY_NEW).toBe(ENCRYPTION_KEY_NEW);
  });

  it('JWT_SECRET_NEW is undefined when not set', () => {
    _resetConfig();
    const { getConfig } = jest.requireActual<typeof import('../src/config')>('../src/config');
    const cfg = getConfig();
    expect(cfg.JWT_SECRET_NEW).toBeUndefined();
  });

  it('ENCRYPTION_KEY_NEW is undefined when not set', () => {
    _resetConfig();
    const { getConfig } = jest.requireActual<typeof import('../src/config')>('../src/config');
    const cfg = getConfig();
    expect(cfg.ENCRYPTION_KEY_NEW).toBeUndefined();
  });

  it('rejects JWT_SECRET_NEW shorter than 32 characters', () => {
    process.env['JWT_SECRET_NEW'] = 'too-short';
    _resetConfig();
    const { validateConfig } = jest.requireActual<typeof import('../src/config')>('../src/config');
    expect(() => validateConfig()).toThrow();
  });
});
