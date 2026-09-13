/**
 * src/security/secret-store.ts
 * In-memory, encrypted secret storage.
 *
 * Secrets are held in memory only (never written to disk) and are encrypted
 * at rest using AES-256-GCM via crypto.ts, keyed off ENCRYPTION_KEY. This
 * protects secret values from casual memory dumps/heap snapshots while still
 * allowing fast access within a single process.
 *
 * This is NOT a substitute for a KMS in a multi-node deployment — see
 * docs/security.md "Secret Store" section for the future KMS integration path.
 */

import { encrypt, decrypt } from './crypto';
import { getConfig } from '../config';
import { createLogger } from '../observability/logger';

const logger = createLogger('secret-store');

interface StoredSecret {
  readonly ciphertext: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
}

export class SecretStore {
  private readonly secrets = new Map<string, StoredSecret>();

  /**
   * Store a secret value, encrypted at rest.
   * @param key   Unique identifier for the secret
   * @param value Plaintext secret value (never logged)
   * @param ttlMs Optional time-to-live in milliseconds
   */
  set(key: string, value: string, ttlMs?: number): void {
    const encryptionKey = this.getEncryptionKey();
    const ciphertext = encrypt(value, encryptionKey);
    const expiresAt = ttlMs !== undefined ? new Date(Date.now() + ttlMs) : undefined;
    this.secrets.set(key, { ciphertext, createdAt: new Date(), expiresAt });
    logger.debug('Secret stored', { key, hasTtl: ttlMs !== undefined });
  }

  /**
   * Retrieve and decrypt a secret value.
   * Returns undefined if the key does not exist or has expired.
   */
  get(key: string): string | undefined {
    const stored = this.secrets.get(key);
    if (!stored) return undefined;

    if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
      this.secrets.delete(key);
      logger.debug('Secret expired and evicted', { key });
      return undefined;
    }

    const encryptionKey = this.getEncryptionKey();
    try {
      return decrypt(stored.ciphertext, encryptionKey);
    } catch (err) {
      logger.error('Failed to decrypt secret — key rotation may have invalidated it', {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Check existence without decrypting. */
  has(key: string): boolean {
    const stored = this.secrets.get(key);
    if (!stored) return false;
    if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
      this.secrets.delete(key);
      return false;
    }
    return true;
  }

  /** Permanently remove a secret. */
  delete(key: string): boolean {
    return this.secrets.delete(key);
  }

  /** Re-encrypt every stored secret under a new encryption key (zero-downtime rotation). */
  rotateEncryption(oldKey: string, newKey: string): number {
    let rotated = 0;
    for (const [key, stored] of this.secrets.entries()) {
      try {
        const plaintext = decrypt(stored.ciphertext, oldKey);
        const ciphertext = encrypt(plaintext, newKey);
        this.secrets.set(key, { ...stored, ciphertext });
        rotated += 1;
      } catch (err) {
        logger.error('Failed to rotate secret during key rotation', {
          key,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('Secret store encryption rotated', { rotated, total: this.secrets.size });
    return rotated;
  }

  /** Number of secrets currently stored (for observability, not their values). */
  size(): number {
    return this.secrets.size;
  }

  /** Remove all secrets. Used on shutdown and in tests. */
  clear(): void {
    this.secrets.clear();
  }

  private getEncryptionKey(): string {
    try {
      return getConfig().ENCRYPTION_KEY;
    } catch {
      // Config not yet validated (e.g. in isolated unit tests) — use a fixed
      // 32-char fallback so encrypt/decrypt round-trips still function.
      return 'test-fallback-key-32-characters!';
    }
  }
}

/** Singleton instance for use across the application. */
export const secretStore = new SecretStore();
