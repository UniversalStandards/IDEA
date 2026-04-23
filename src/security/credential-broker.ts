/**
 * src/security/credential-broker.ts
 *
 * Scoped credential broker — stores, retrieves, revokes, and rotates secrets
 * on a per-tool basis.  Each credential is:
 *   - Encrypted in memory with AES-256-GCM (via crypto.encrypt)
 *   - Bound to a specific toolId — cross-tool access is rejected
 *   - Audited: every operation is recorded via auditLog.record()
 *   - Never logged in plaintext (logger fields never contain the raw value)
 */

import { encrypt, decrypt } from './crypto';
import { auditLog } from './audit';
import { createLogger } from '../observability/logger';
import { getConfig } from '../config';

const logger = createLogger('credential-broker');

// Internal storage key: cred:{toolId}:{key}
const STORE_PREFIX = 'cred:';

function storeKey(toolId: string, key: string): string {
  return `${STORE_PREFIX}${toolId}:${key}`;
}

function getEncryptionKey(): string {
  try {
    return getConfig().ENCRYPTION_KEY;
  } catch {
    return process.env['ENCRYPTION_KEY'] ?? 'fallback-dev-key-change-me-in-prod!!';
  }
}

export class CredentialBroker {
  // In-memory map: storageKey → encrypted ciphertext
  private readonly vault = new Map<string, string>();

  /**
   * Encrypt and store a credential scoped to `toolId`.
   * Overwrites any previously stored value for the same toolId/key pair.
   */
  store(toolId: string, key: string, value: string): void {
    if (!toolId || !key) throw new Error('toolId and key must not be empty');

    const encKey = getEncryptionKey();
    const ciphertext = encrypt(value, encKey);
    this.vault.set(storeKey(toolId, key), ciphertext);

    logger.debug('Credential stored', { toolId, key });
    auditLog.record('credential.store', toolId, key, 'success');
  }

  /**
   * Decrypt and return a credential.
   * Throws if the credential does not exist or belongs to a different toolId.
   */
  retrieve(toolId: string, key: string): string {
    if (!toolId || !key) throw new Error('toolId and key must not be empty');

    const sk = storeKey(toolId, key);
    const ciphertext = this.vault.get(sk);

    if (ciphertext === undefined) {
      auditLog.record('credential.retrieve', toolId, key, 'failure');
      throw new Error(`Credential not found for toolId="${toolId}" key="${key}"`);
    }

    const encKey = getEncryptionKey();
    const plaintext = decrypt(ciphertext, encKey);

    auditLog.record('credential.retrieve', toolId, key, 'success');
    logger.debug('Credential retrieved', { toolId, key });
    return plaintext;
  }

  /**
   * Remove one credential (when `key` is provided) or all credentials for a
   * tool (when `key` is omitted).
   * Throws if the targeted credential(s) do not exist.
   */
  revoke(toolId: string, key?: string): void {
    if (!toolId) throw new Error('toolId must not be empty');

    if (key !== undefined) {
      const sk = storeKey(toolId, key);
      if (!this.vault.has(sk)) {
        auditLog.record('credential.revoke', toolId, key, 'failure');
        throw new Error(`Credential not found for toolId="${toolId}" key="${key}"`);
      }
      this.vault.delete(sk);
      logger.info('Credential revoked', { toolId, key });
      auditLog.record('credential.revoke', toolId, key, 'success');
    } else {
      // Revoke all credentials for this toolId
      const prefix = storeKey(toolId, '');
      const keysToDelete: string[] = [];
      for (const sk of this.vault.keys()) {
        if (sk.startsWith(prefix)) keysToDelete.push(sk);
      }
      if (keysToDelete.length === 0) {
        auditLog.record('credential.revoke-all', toolId, toolId, 'failure');
        throw new Error(`No credentials found for toolId="${toolId}"`);
      }
      for (const sk of keysToDelete) {
        this.vault.delete(sk);
      }
      logger.info('All credentials revoked for tool', { toolId, count: keysToDelete.length });
      auditLog.record('credential.revoke-all', toolId, toolId, 'success');
    }
  }

  /**
   * Atomically replace a credential value.
   * The old value is wiped before the new value is written.
   * Throws if the credential does not exist.
   */
  rotate(toolId: string, key: string, newValue: string): void {
    if (!toolId || !key) throw new Error('toolId and key must not be empty');

    const sk = storeKey(toolId, key);
    if (!this.vault.has(sk)) {
      auditLog.record('credential.rotate', toolId, key, 'failure');
      throw new Error(`Credential not found for toolId="${toolId}" key="${key}"`);
    }

    // Wipe old value first, then write new encrypted value
    this.vault.delete(sk);
    const encKey = getEncryptionKey();
    const ciphertext = encrypt(newValue, encKey);
    this.vault.set(sk, ciphertext);

    logger.info('Credential rotated', { toolId, key });
    auditLog.record('credential.rotate', toolId, key, 'success');
  }

  /**
   * List credential keys (not values) for a given toolId.
   * Useful for introspection and administrative tools.
   */
  listKeys(toolId: string): string[] {
    const prefix = storeKey(toolId, '');
    const results: string[] = [];
    for (const sk of this.vault.keys()) {
      if (sk.startsWith(prefix)) {
        results.push(sk.slice(prefix.length));
      }
    }
    return results;
  }

  /** Remove all credentials from memory (primarily for tests / shutdown). */
  clear(): void {
    this.vault.clear();
  }
}

export const credentialBroker = new CredentialBroker();
