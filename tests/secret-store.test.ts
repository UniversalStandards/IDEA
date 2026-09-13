import { SecretStore } from '../src/security/secret-store';

describe('SecretStore', () => {
  let store: SecretStore;

  beforeEach(() => {
    store = new SecretStore();
  });

  it('stores and retrieves a secret round-trip', () => {
    store.set('api-key', 'super-secret-value');
    expect(store.get('api-key')).toBe('super-secret-value');
  });

  it('returns undefined for a key that was never set', () => {
    expect(store.get('missing')).toBeUndefined();
  });

  it('never stores the plaintext value in memory', () => {
    store.set('token', 'plaintext-value');
    const internal = store as unknown as { secrets: Map<string, { ciphertext: string }> };
    const stored = internal.secrets.get('token');
    expect(stored?.ciphertext).toBeDefined();
    expect(stored?.ciphertext).not.toContain('plaintext-value');
  });

  it('expires a secret after its TTL elapses', () => {
    jest.useFakeTimers();
    store.set('short-lived', 'value', 1000);
    expect(store.has('short-lived')).toBe(true);
    jest.advanceTimersByTime(1001);
    expect(store.has('short-lived')).toBe(false);
    expect(store.get('short-lived')).toBeUndefined();
    jest.useRealTimers();
  });

  it('deletes a secret permanently', () => {
    store.set('to-delete', 'value');
    expect(store.delete('to-delete')).toBe(true);
    expect(store.get('to-delete')).toBeUndefined();
  });

  it('rotates encryption to a new key and preserves the ability to decrypt', () => {
    store.set('rotatable', 'value');
    const currentKey = (store as unknown as { getEncryptionKey: () => string }).getEncryptionKey();
    const newKey = 'b'.repeat(32);
    const rotated = store.rotateEncryption(currentKey, newKey);
    expect(rotated).toBe(1);
  });

  it('reports size correctly', () => {
    store.set('a', '1');
    store.set('b', '2');
    expect(store.size()).toBe(2);
  });

  it('clear() removes all secrets', () => {
    store.set('a', '1');
    store.clear();
    expect(store.size()).toBe(0);
  });
});
