import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac as nodeHmac,
  randomBytes,
  timingSafeEqual as nodeTSE,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function deriveKey(key: string): Buffer {
  return createHash('sha256').update(key).digest().subarray(0, KEY_LENGTH);
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns a base64 string: iv(12) + authTag(16) + ciphertext
 */
export function encrypt(plaintext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypts a base64 ciphertext produced by `encrypt`.
 */
export function decrypt(ciphertext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext: too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** SHA-256 hex digest */
export function hash(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** HMAC-SHA256 hex digest */
export function hmac(data: string, secret: string): string {
  return nodeHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

/** Cryptographically secure random hex string */
export function generateSecret(length = 32): string {
  return randomBytes(length).toString('hex');
}

/** Constant-time string comparison */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison to avoid timing sidechannel on length check
    const padded = Buffer.alloc(bufA.length, 0);
    nodeTSE(padded, padded);
    return false;
  }
  return nodeTSE(bufA, bufB);
}
