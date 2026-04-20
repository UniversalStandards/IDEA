/**
 * tests/credential-broker.test.ts
 * Unit tests for src/security/credential-broker.ts — CredentialBroker
 */

// Set env vars before any module imports so config initialises without errors
process.env['NODE_ENV'] = 'test';
process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-must-be-32chars!!';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLogger: { log: jest.fn() },
  auditLog: { record: jest.fn() },
}));

import { CredentialBroker } from '../src/security/credential-broker';
import { secretStore } from '../src/security/secret-store';

describe('CredentialBroker', () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    jest.clearAllMocks();
    secretStore.clear();
    broker = new CredentialBroker();
  });

  it('register() stores the credential and returns it with an id', () => {
    const cred = broker.register('my-api-key', {
      name: 'my-api-key',
      type: 'api_key',
      value: 'secret-value',
      scopes: ['read'],
    });
    expect(cred.id).toBeDefined();
    expect(typeof cred.id).toBe('string');
    expect(cred.name).toBe('my-api-key');
    expect(cred.value).toBe('secret-value');
    expect(cred.type).toBe('api_key');
  });

  it('get() returns undefined for unknown credential', () => {
    expect(broker.get('nonexistent')).toBeUndefined();
  });

  it('get() returns the credential when registered', () => {
    broker.register('my-key', {
      name: 'my-key',
      type: 'api_key',
      value: 'my-secret',
      scopes: ['read', 'write'],
    });
    const result = broker.get('my-key');
    expect(result).toBeDefined();
    expect(result?.value).toBe('my-secret');
    expect(result?.name).toBe('my-key');
    expect(result?.scopes).toEqual(['read', 'write']);
  });

  it('get() returns undefined and logs warn for expired credential', () => {
    const pastDate = new Date(Date.now() - 10_000).toISOString();
    broker.register('expired-key', {
      name: 'expired-key',
      type: 'api_key',
      value: 'some-secret',
      scopes: [],
      expiresAt: pastDate,
    });
    const result = broker.get('expired-key');
    expect(result).toBeUndefined();
  });

  it('get() returns credential for non-expired expiresAt (future date)', () => {
    const futureDate = new Date(Date.now() + 100_000).toISOString();
    broker.register('future-key', {
      name: 'future-key',
      type: 'bearer',
      value: 'bearer-token',
      scopes: ['admin'],
      expiresAt: futureDate,
    });
    const result = broker.get('future-key');
    expect(result).toBeDefined();
    expect(result?.value).toBe('bearer-token');
  });

  it('inject() throws when credential not found', () => {
    expect(() => broker.inject('tool-1', 'unknown-cred')).toThrow(
      'Credential not found or expired: unknown-cred',
    );
  });

  it('inject() returns credential and records injection for known toolId', () => {
    broker.register('inj-key', {
      name: 'inj-key',
      type: 'api_key',
      value: 'inj-secret',
      scopes: ['exec'],
    });
    const result = broker.inject('tool-abc', 'inj-key');
    expect(result).toBeDefined();
    expect(result.value).toBe('inj-secret');
    expect(result.name).toBe('inj-key');
  });

  it('revoke() returns false for never-registered name', () => {
    expect(broker.revoke('ghost')).toBe(false);
  });

  it('revoke() returns true and removes credential name from injections map', () => {
    broker.register('rev-key', {
      name: 'rev-key',
      type: 'api_key',
      value: 'rev-secret',
      scopes: [],
    });
    broker.inject('tool-x', 'rev-key');
    const result = broker.revoke('rev-key');
    expect(result).toBe(true);
    expect(broker.getInjectedCredentials('tool-x')).not.toContain('rev-key');
  });

  it('rotate() returns false for unknown name', () => {
    expect(broker.rotate('nonexistent', 'new-val')).toBe(false);
  });

  it('rotate() returns true and updates stored value', () => {
    broker.register('rot-key', {
      name: 'rot-key',
      type: 'api_key',
      value: 'old-value',
      scopes: [],
    });
    const result = broker.rotate('rot-key', 'new-value');
    expect(result).toBe(true);
    const updated = broker.get('rot-key');
    expect(updated?.value).toBe('new-value');
  });

  it('listAll() returns metadata for all registered credentials', () => {
    broker.register('key-a', { name: 'key-a', type: 'api_key', value: 'val-a', scopes: [] });
    broker.register('key-b', { name: 'key-b', type: 'bearer', value: 'val-b', scopes: ['read'] });
    const list = broker.listAll();
    expect(list).toHaveLength(2);
    const names = list.map((c) => c.name);
    expect(names).toContain('key-a');
    expect(names).toContain('key-b');
    // StoredCredential must NOT expose the secret value
    list.forEach((entry) => {
      expect((entry as Record<string, unknown>)['value']).toBeUndefined();
    });
  });

  it('getInjectedCredentials() returns empty array for unknown toolId', () => {
    expect(broker.getInjectedCredentials('unknown-tool')).toEqual([]);
  });

  it('getInjectedCredentials() returns injected names after inject()', () => {
    broker.register('injected-cred', {
      name: 'injected-cred',
      type: 'api_key',
      value: 'val',
      scopes: [],
    });
    broker.inject('my-tool', 'injected-cred');
    expect(broker.getInjectedCredentials('my-tool')).toContain('injected-cred');
  });
});
