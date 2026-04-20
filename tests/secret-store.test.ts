/**
 * tests/secret-store.test.ts
 * Unit tests for src/security/secret-store.ts — SecretStore
 */

process.env['NODE_ENV'] = 'test';
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

jest.mock('../src/config', () => ({
  config: { ENCRYPTION_KEY: 'test-encryption-key-must-be-32chars!!' },
  getConfig: () => ({ ENCRYPTION_KEY: 'test-encryption-key-must-be-32chars!!' }),
}));

import * as fs from 'fs';
import * as path from 'path';
import { SecretStore } from '../src/security/secret-store';

// Write temp files inside the tests/ directory (never /tmp)
const TEST_FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures');
let fileCounter = 0;

describe('SecretStore', () => {
  let store: SecretStore;
  let testFilePath: string;

  beforeEach(() => {
    store = new SecretStore();
    testFilePath = path.join(
      TEST_FIXTURES_DIR,
      `secret-store-test-${process.pid}-${++fileCounter}.json`,
    );
  });

  afterEach(async () => {
    if (fs.existsSync(testFilePath)) {
      await fs.promises.unlink(testFilePath);
    }
    // Remove fixtures dir only when empty
    try {
      await fs.promises.rmdir(TEST_FIXTURES_DIR);
    } catch {
      // directory is not empty or doesn't exist — that's fine
    }
  });

  // ── In-memory operations ──────────────────────────────────────────────────

  it('set() throws for empty key', () => {
    expect(() => store.set('', 'value')).toThrow('Secret key must not be empty');
    expect(() => store.set('   ', 'value')).toThrow('Secret key must not be empty');
  });

  it('set() + get() round-trip returns correct value', () => {
    store.set('my-key', 'my-value');
    expect(store.get('my-key')).toBe('my-value');
  });

  it('get() returns undefined for unknown key', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('has() returns false before set, true after set', () => {
    expect(store.has('k')).toBe(false);
    store.set('k', 'v');
    expect(store.has('k')).toBe(true);
  });

  it('delete() returns false for unknown key', () => {
    expect(store.delete('missing')).toBe(false);
  });

  it('delete() returns true for known key and removes it', () => {
    store.set('del-key', 'val');
    expect(store.delete('del-key')).toBe(true);
    expect(store.has('del-key')).toBe(false);
    expect(store.get('del-key')).toBeUndefined();
  });

  it('list() returns all stored keys', () => {
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    const keys = store.list();
    expect(keys).toHaveLength(3);
    expect(keys).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('clear() removes all entries', () => {
    store.set('x', 'val-x');
    store.set('y', 'val-y');
    store.clear();
    expect(store.list()).toHaveLength(0);
    expect(store.get('x')).toBeUndefined();
    expect(store.get('y')).toBeUndefined();
  });

  // ── Persistence operations ────────────────────────────────────────────────

  it('save() + load() round-trip preserves all values', async () => {
    store.set('key1', 'value1');
    store.set('key2', 'value2');
    await store.save(testFilePath);

    const loaded = new SecretStore();
    await loaded.load(testFilePath);

    expect(loaded.get('key1')).toBe('value1');
    expect(loaded.get('key2')).toBe('value2');
    expect(loaded.list()).toHaveLength(2);
  });

  it('load() with non-existent file succeeds without error', async () => {
    const nonExistentPath = path.join(TEST_FIXTURES_DIR, 'does-not-exist.json');
    await expect(store.load(nonExistentPath)).resolves.toBeUndefined();
  });

  it('load() throws for unsupported store version', async () => {
    // First save a valid store
    store.set('k', 'v');
    await store.save(testFilePath);

    // Overwrite the version field with an unsupported value
    const raw = await fs.promises.readFile(testFilePath, 'utf8');
    const payload = JSON.parse(raw) as Record<string, unknown>;
    payload['version'] = 99;
    await fs.promises.writeFile(testFilePath, JSON.stringify(payload), 'utf8');

    const fresh = new SecretStore();
    await expect(fresh.load(testFilePath)).rejects.toThrow(
      'Unsupported secret store version: 99',
    );
  });
});
