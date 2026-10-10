/**
 * Tests for the crypto utilities.
 */
import { randomBytes } from 'crypto';
import {
  encrypt,
  decrypt,
  hmac,
  verifyHmac,
  generateSecureToken,
  constantTimeEqual,
  deriveKey,
} from '../src/security/crypto';

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

  describe('encrypt / decrypt key handling', () => {
    it('accepts a 64-char hex key as a raw 256-bit key', () => {
      const hexKey = randomBytes(32).toString('hex');
      expect(decrypt(encrypt('payload', hexKey), hexKey)).toEqual('payload');
    });

    it('emits iv:ciphertext:tag with a 16-byte IV and 16-byte auth tag', () => {
      const [iv, , tag] = encrypt('payload', TEST_KEY).split(':');
      expect(iv).toMatch(/^[0-9a-f]{32}$/);
      expect(tag).toMatch(/^[0-9a-f]{32}$/);
    });

    it('rejects ciphertext that is not in iv:ciphertext:tag format', () => {
      expect(() => decrypt('not-valid', TEST_KEY)).toThrow('Invalid ciphertext format');
    });

    it('detects tampering with the ciphertext via the GCM auth tag', () => {
      const [iv, data, tag] = encrypt('sensitive', TEST_KEY).split(':') as [string, string, string];
      const flipped = (data.startsWith('0') ? '1' : '0') + data.slice(1);
      expect(() => decrypt(`${iv}:${flipped}:${tag}`, TEST_KEY)).toThrow();
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

  describe('verifyHmac', () => {
    it('accepts the correct signature', () => {
      const sig = hmac('payload', 'secret');
      expect(verifyHmac('payload', 'secret', sig)).toBe(true);
    });

    it('rejects a signature for a different payload', () => {
      const sig = hmac('payload', 'secret');
      expect(verifyHmac('tampered', 'secret', sig)).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      const sig = hmac('payload', 'other-secret');
      expect(verifyHmac('payload', 'secret', sig)).toBe(false);
    });
  });

  describe('generateSecureToken', () => {
    it('generates a hex string of the correct length', () => {
      const t = generateSecureToken(16);
      expect(t).toMatch(/^[0-9a-f]+$/);
      expect(t.length).toEqual(32); // 16 bytes → 32 hex chars
    });

    it('defaults to 32 bytes (64 hex chars)', () => {
      expect(generateSecureToken().length).toEqual(64);
    });

    it('is random', () => {
      expect(generateSecureToken()).not.toEqual(generateSecureToken());
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal strings', () => {
      expect(constantTimeEqual('abc', 'abc')).toBe(true);
    });

    it('returns false for different strings of the same length', () => {
      expect(constantTimeEqual('abc', 'xyz')).toBe(false);
    });

    it('returns false (without throwing) when lengths differ', () => {
      expect(constantTimeEqual('short', 'a-much-longer-string')).toBe(false);
    });

    it('compares multi-byte UTF-8 strings correctly', () => {
      expect(constantTimeEqual('héllo', 'héllo')).toBe(true);
      expect(constantTimeEqual('héllo', 'hello')).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it('derives a 32-byte (256-bit) key', async () => {
      const key = await deriveKey('passphrase', randomBytes(32));
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('is deterministic for the same secret and salt', async () => {
      const salt = randomBytes(32);
      const a = await deriveKey('passphrase', salt);
      const b = await deriveKey('passphrase', salt);
      expect(a.equals(b)).toBe(true);
    });

    it('produces a different key for a different salt', async () => {
      const a = await deriveKey('passphrase', randomBytes(32));
      const b = await deriveKey('passphrase', randomBytes(32));
      expect(a.equals(b)).toBe(false);
    });

    it('produces a different key for a different secret', async () => {
      const salt = randomBytes(32);
      const a = await deriveKey('passphrase-1', salt);
      const b = await deriveKey('passphrase-2', salt);
      expect(a.equals(b)).toBe(false);
    });
  });
});
