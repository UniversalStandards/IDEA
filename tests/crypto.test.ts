/**
 * Tests for the crypto utilities.
 */
import { encrypt, decrypt, hash, hmac, generateSecret, timingSafeEqual } from '../src/security/crypto';

const TEST_KEY = 'test-key-for-unit-testing-purposes';

describe('crypto', () => {
  describe('encrypt / decrypt', () => {
    it('round-trips a simple string', () => {
      const plaintext = 'hello, world';
      const ciphertext = encrypt(plaintext, TEST_KEY);
      expect(ciphertext).not.toEqual(plaintext);
      expect(decrypt(ciphertext, TEST_KEY)).toEqual(plaintext);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
      const plaintext = 'same plaintext';
      const c1 = encrypt(plaintext, TEST_KEY);
      const c2 = encrypt(plaintext, TEST_KEY);
      expect(c1).not.toEqual(c2);
      expect(decrypt(c1, TEST_KEY)).toEqual(plaintext);
      expect(decrypt(c2, TEST_KEY)).toEqual(plaintext);
    });

    it('round-trips an empty string', () => {
      expect(decrypt(encrypt('', TEST_KEY), TEST_KEY)).toEqual('');
    });

    it('round-trips a long string', () => {
      const long = 'a'.repeat(10_000);
      expect(decrypt(encrypt(long, TEST_KEY), TEST_KEY)).toEqual(long);
    });

    it('throws on wrong key', () => {
      const ciphertext = encrypt('secret', TEST_KEY);
      expect(() => decrypt(ciphertext, 'wrong-key')).toThrow();
    });
  });

  describe('hash', () => {
    it('returns a 64-char hex string for any input', () => {
      expect(hash('data')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      expect(hash('hello')).toEqual(hash('hello'));
    });

    it('produces different hashes for different inputs', () => {
      expect(hash('a')).not.toEqual(hash('b'));
    });
  });

  describe('hmac', () => {
    it('returns a hex string', () => {
      expect(hmac('message', 'secret')).toMatch(/^[0-9a-f]+$/);
    });

    it('is deterministic', () => {
      expect(hmac('msg', 'key')).toEqual(hmac('msg', 'key'));
    });

    it('changes with different key', () => {
      expect(hmac('msg', 'key1')).not.toEqual(hmac('msg', 'key2'));
    });
  });

  describe('generateSecret', () => {
    it('generates a hex string of the correct length', () => {
      const s = generateSecret(16);
      expect(s).toMatch(/^[0-9a-f]+$/);
      expect(s.length).toEqual(32); // 16 bytes → 32 hex chars
    });

    it('defaults to 32 bytes (64 hex chars)', () => {
      expect(generateSecret().length).toEqual(64);
    });

    it('is random', () => {
      expect(generateSecret()).not.toEqual(generateSecret());
    });
  });

  describe('timingSafeEqual', () => {
    it('returns true for equal strings', () => {
      expect(timingSafeEqual('abc', 'abc')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(timingSafeEqual('abc', 'xyz')).toBe(false);
    });

    it('returns false when lengths differ', () => {
      expect(timingSafeEqual('short', 'a-much-longer-string')).toBe(false);
    });
  });
});
