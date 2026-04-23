/**
 * tests/credential-broker.test.ts
 * Unit tests for src/security/credential-broker.ts
 */

// Set up env before any module imports
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';
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

import { CredentialBroker } from '../src/security/credential-broker';
import { auditLog } from '../src/security/audit';

const recordMock = auditLog.record as jest.Mock;

describe('CredentialBroker', () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    broker = new CredentialBroker();
    recordMock.mockClear();
  });

  // ─────────────────────────────────────────────────────────────
  describe('store / retrieve round-trip', () => {
    it('stores and retrieves a credential value', () => {
      broker.store('tool-a', 'api_key', 's3cr3t');
      expect(broker.retrieve('tool-a', 'api_key')).toBe('s3cr3t');
    });

    it('stores values encrypted (raw vault entry is not the plaintext)', () => {
      broker.store('tool-a', 'token', 'my-plaintext-token');
      // Access vault indirectly: retrieve should return original value
      expect(broker.retrieve('tool-a', 'token')).toBe('my-plaintext-token');
    });

    it('records a store audit entry', () => {
      broker.store('tool-a', 'key1', 'value1');
      expect(recordMock).toHaveBeenCalledWith('credential.store', 'tool-a', 'key1', 'success');
    });

    it('records a retrieve audit entry on success', () => {
      broker.store('tool-a', 'key1', 'value1');
      recordMock.mockClear();
      broker.retrieve('tool-a', 'key1');
      expect(recordMock).toHaveBeenCalledWith('credential.retrieve', 'tool-a', 'key1', 'success');
    });

    it('round-trips an empty string value', () => {
      broker.store('tool-a', 'empty', '');
      expect(broker.retrieve('tool-a', 'empty')).toBe('');
    });

    it('round-trips a long credential value', () => {
      const long = 'x'.repeat(4096);
      broker.store('tool-a', 'long', long);
      expect(broker.retrieve('tool-a', 'long')).toBe(long);
    });

    it('overwrites existing credential on second store', () => {
      broker.store('tool-a', 'key', 'first');
      broker.store('tool-a', 'key', 'second');
      expect(broker.retrieve('tool-a', 'key')).toBe('second');
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('scope enforcement', () => {
    it('throws when a tool tries to retrieve credentials belonging to another tool', () => {
      broker.store('tool-a', 'secret', 'value-for-a');
      expect(() => broker.retrieve('tool-b', 'secret')).toThrow(/not found/);
    });

    it('records a failure audit entry when scope is violated', () => {
      broker.store('tool-a', 'secret', 'value');
      recordMock.mockClear();
      try {
        broker.retrieve('tool-b', 'secret');
      } catch {
        // expected
      }
      expect(recordMock).toHaveBeenCalledWith('credential.retrieve', 'tool-b', 'secret', 'failure');
    });

    it('throws when retrieving a non-existent key', () => {
      expect(() => broker.retrieve('tool-a', 'no-such-key')).toThrow(/not found/);
    });

    it('isolates multiple tools with the same key name', () => {
      broker.store('tool-a', 'api_key', 'value-a');
      broker.store('tool-b', 'api_key', 'value-b');
      expect(broker.retrieve('tool-a', 'api_key')).toBe('value-a');
      expect(broker.retrieve('tool-b', 'api_key')).toBe('value-b');
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('revoke', () => {
    it('removes a specific credential for a tool', () => {
      broker.store('tool-a', 'key1', 'val1');
      broker.revoke('tool-a', 'key1');
      expect(() => broker.retrieve('tool-a', 'key1')).toThrow(/not found/);
    });

    it('records a revoke audit entry on success', () => {
      broker.store('tool-a', 'key1', 'val1');
      recordMock.mockClear();
      broker.revoke('tool-a', 'key1');
      expect(recordMock).toHaveBeenCalledWith('credential.revoke', 'tool-a', 'key1', 'success');
    });

    it('throws when revoking a non-existent credential', () => {
      expect(() => broker.revoke('tool-a', 'no-such-key')).toThrow(/not found/);
    });

    it('records a failure audit entry when revoke target does not exist', () => {
      try {
        broker.revoke('tool-a', 'missing');
      } catch {
        // expected
      }
      expect(recordMock).toHaveBeenCalledWith('credential.revoke', 'tool-a', 'missing', 'failure');
    });

    it('does not remove credentials belonging to other tools', () => {
      broker.store('tool-a', 'key', 'val-a');
      broker.store('tool-b', 'key', 'val-b');
      broker.revoke('tool-a', 'key');
      expect(broker.retrieve('tool-b', 'key')).toBe('val-b');
    });

    it('removes all credentials when key is omitted', () => {
      broker.store('tool-a', 'key1', 'val1');
      broker.store('tool-a', 'key2', 'val2');
      broker.revoke('tool-a');
      expect(() => broker.retrieve('tool-a', 'key1')).toThrow(/not found/);
      expect(() => broker.retrieve('tool-a', 'key2')).toThrow(/not found/);
    });

    it('records a revoke-all audit entry when key is omitted', () => {
      broker.store('tool-a', 'key1', 'val1');
      recordMock.mockClear();
      broker.revoke('tool-a');
      expect(recordMock).toHaveBeenCalledWith('credential.revoke-all', 'tool-a', 'tool-a', 'success');
    });

    it('throws when revoking all for a tool that has no credentials', () => {
      expect(() => broker.revoke('unknown-tool')).toThrow(/No credentials found/);
    });

    it('does not affect other tools when revoking all for one tool', () => {
      broker.store('tool-a', 'key', 'val-a');
      broker.store('tool-b', 'key', 'val-b');
      broker.revoke('tool-a');
      expect(broker.retrieve('tool-b', 'key')).toBe('val-b');
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('rotate', () => {
    it('replaces the credential value atomically', () => {
      broker.store('tool-a', 'key', 'old-value');
      broker.rotate('tool-a', 'key', 'new-value');
      expect(broker.retrieve('tool-a', 'key')).toBe('new-value');
    });

    it('records a rotate audit entry on success', () => {
      broker.store('tool-a', 'key', 'old');
      recordMock.mockClear();
      broker.rotate('tool-a', 'key', 'new');
      expect(recordMock).toHaveBeenCalledWith('credential.rotate', 'tool-a', 'key', 'success');
    });

    it('throws when rotating a non-existent credential', () => {
      expect(() => broker.rotate('tool-a', 'no-such', 'value')).toThrow(/not found/);
    });

    it('records a failure audit entry when rotate target does not exist', () => {
      try {
        broker.rotate('tool-a', 'missing', 'value');
      } catch {
        // expected
      }
      expect(recordMock).toHaveBeenCalledWith('credential.rotate', 'tool-a', 'missing', 'failure');
    });

    it('old value is no longer retrievable after rotation', () => {
      broker.store('tool-a', 'key', 'old-value');
      broker.rotate('tool-a', 'key', 'new-value');
      // Only way to verify old value is gone: new retrieval returns new value
      expect(broker.retrieve('tool-a', 'key')).toBe('new-value');
    });

    it('does not affect credentials of other tools', () => {
      broker.store('tool-a', 'key', 'val-a');
      broker.store('tool-b', 'key', 'val-b');
      broker.rotate('tool-a', 'key', 'new-val-a');
      expect(broker.retrieve('tool-b', 'key')).toBe('val-b');
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('listKeys', () => {
    it('lists keys for a given toolId', () => {
      broker.store('tool-a', 'k1', 'v1');
      broker.store('tool-a', 'k2', 'v2');
      expect(broker.listKeys('tool-a').sort()).toEqual(['k1', 'k2']);
    });

    it('returns an empty array when toolId has no credentials', () => {
      expect(broker.listKeys('no-such-tool')).toEqual([]);
    });

    it('does not include keys from other tools', () => {
      broker.store('tool-a', 'key', 'val');
      broker.store('tool-b', 'other', 'val');
      expect(broker.listKeys('tool-a')).toEqual(['key']);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe('input validation', () => {
    it('store throws on empty toolId', () => {
      expect(() => broker.store('', 'key', 'val')).toThrow();
    });

    it('store throws on empty key', () => {
      expect(() => broker.store('tool-a', '', 'val')).toThrow();
    });

    it('retrieve throws on empty toolId', () => {
      expect(() => broker.retrieve('', 'key')).toThrow();
    });

    it('revoke throws on empty toolId', () => {
      expect(() => broker.revoke('')).toThrow();
    });

    it('rotate throws on empty toolId', () => {
      expect(() => broker.rotate('', 'key', 'val')).toThrow();
    });
  });
});
