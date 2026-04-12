/**
 * src/security/crypto.ts
 * Cryptographic utilities using Node.js built-in `crypto` module.
 * All operations use modern, secure algorithms:
 * - AES-256-GCM for symmetric encryption (authenticated)
 * - scrypt for key derivation
 * - crypto.randomBytes for secure token generation
 * - crypto.timingSafeEqual for constant-time comparison
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, scrypt as scryptCb } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scryptCb);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;   // 128-bit IV
const TAG_LENGTH = 16;  // 128-bit auth tag
const KEY_LENGTH = 32;  // 256-bit key

// ─────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure random token.
 * @param bytes Number of random bytes (output hex length = bytes * 2)
 */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Both strings are compared after UTF-8 encoding.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison to avoid length-based timing leak
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Derive a 256-bit key from a secret using scrypt.
 * @param secret The source secret string
 * @param salt   A random salt Buffer (generate with randomBytes(32))
 */
export async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  const key = await scryptAsync(secret, salt, KEY_LENGTH);
  return key as Buffer;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * A unique random IV is generated for each invocation.
 * Output format: <iv_hex>:<ciphertext_hex>:<tag_hex>
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex.length === 64 ? keyHex : padKey(keyHex), 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypt a string encrypted by `encrypt()`.
 * Throws if the authentication tag is invalid (tampered ciphertext).
 */
export function decrypt(ciphertext: string, keyHex: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format — expected iv:ciphertext:tag');
  }
  const [ivHex, encHex, tagHex] = parts as [string, string, string];
  const key = Buffer.from(keyHex.length === 64 ? keyHex : padKey(keyHex), 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedData = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Compute HMAC-SHA256 of a payload.
 * Returns the hex-encoded digest.
 */
export function hmac(payload: string, secret: string): string {
  const { createHmac } = require('crypto') as typeof import('crypto');
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an HMAC-SHA256 signature in constant time.
 */
export function verifyHmac(payload: string, secret: string, expectedHmac: string): boolean {
  const actual = hmac(payload, secret);
  return constantTimeEqual(actual, expectedHmac);
}

/**
 * Compute a SHA-256 hash of a string.
 * Returns the hex-encoded digest.
 */
export function hash(input: string): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Alias for generateSecureToken — generates a hex-encoded secure random token.
 * @param bytes Number of random bytes (output hex length = bytes * 2). Default: 32.
 */
export function generateSecret(bytes = 32): string {
  return generateSecureToken(bytes);
}

/**
 * Alias for constantTimeEqual — timing-safe string comparison.
 * Exported under this name for backward compatibility with callers that expect timingSafeEqual.
 */
export { constantTimeEqual as timingSafeEqual };

// ─────────────────────────────────────────────────────────────────
function padKey(key: string): string {
  // Convert a non-hex key string to a 32-byte hex key by hashing
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(key).digest('hex');
}
