/**
 * src/security/credential-broker.ts
 * Scoped credential issuance and lifecycle management.
 *
 * Wraps secret-store.ts with:
 *  - Scope enforcement: a credential is issued for a specific (toolId, action)
 *    pair and cannot be retrieved outside that scope.
 *  - Audit logging on every store/retrieve/revoke/rotate operation.
 *  - Rotation without downtime: rotate() issues a new value while in-flight
 *    callers holding the same scope keep working transparently.
 */

import { randomUUID } from 'crypto';
import { secretStore } from './secret-store';
import { auditLog } from './audit';
import { createLogger } from '../observability/logger';
import type { IAdapter } from '../types/index';

const logger = createLogger('credential-broker');

export interface CredentialScope {
  readonly toolId: string;
  readonly action?: string; // omit to scope the whole tool
}

export interface CredentialHandle {
  readonly id: string;
  readonly scope: CredentialScope;
  readonly createdAt: Date;
  readonly rotatedAt?: Date;
  readonly revoked: boolean;
}

function scopeKey(scope: CredentialScope): string {
  return `cred:${scope.toolId}:${scope.action ?? '*'}`;
}

export class CredentialBrokerError extends Error {
  public readonly code: 'NOT_FOUND' | 'SCOPE_VIOLATION' | 'REVOKED';

  constructor(message: string, code: 'NOT_FOUND' | 'SCOPE_VIOLATION' | 'REVOKED') {
    super(message);
    this.name = 'CredentialBrokerError';
    this.code = code;
  }
}

export class CredentialBroker implements IAdapter {
  readonly name = 'credential-broker';
  readonly protocol = 'internal';

  private readonly handles = new Map<string, CredentialHandle>();

  async initialize(): Promise<void> {
    logger.info('Credential broker initialized', { handles: this.handles.size });
  }

  async shutdown(): Promise<void> {
    // secretStore itself is cleared separately during shutdown, after every
    // adapter has reported shutdown complete, so in-flight requests that
    // still need a credential during their own drain do not fail early.
    logger.info('Credential broker shut down');
  }

  /**
   * Issue and store a new scoped credential.
   * @returns a handle identifying the credential — the plaintext value is
   *          never returned from issue(); retrieve it with `retrieve()`
   *          using the same scope.
   */
  issue(scope: CredentialScope, value: string, ttlMs?: number): CredentialHandle {
    const id = randomUUID();
    const key = scopeKey(scope);
    secretStore.set(key, value, ttlMs);

    const handle: CredentialHandle = {
      id,
      scope,
      createdAt: new Date(),
      revoked: false,
    };
    this.handles.set(id, handle);

    auditLog.record('credential.issued', 'system', key, 'success', id, {
      toolId: scope.toolId,
      action: scope.action ?? '*',
    });

    return handle;
  }

  /**
   * Retrieve a credential's plaintext value. The caller must present the
   * same scope the credential was issued under — a request for
   * { toolId: 'x', action: 'read' } will NOT retrieve a credential issued
   * for { toolId: 'x', action: 'write' }.
   */
  retrieve(scope: CredentialScope, requestedBy: string): string {
    const key = scopeKey(scope);
    const value = secretStore.get(key);

    if (value === undefined) {
      auditLog.record('credential.retrieve', requestedBy, key, 'failure', undefined, {
        reason: 'not_found_or_expired',
      });
      throw new CredentialBrokerError(`No credential found for scope '${key}'`, 'NOT_FOUND');
    }

    auditLog.record('credential.retrieve', requestedBy, key, 'success');
    return value;
  }

  /**
   * Rotate a credential in place: the new value replaces the old one under
   * the same scope key.
   */
  rotate(scope: CredentialScope, newValue: string, rotatedBy: string, ttlMs?: number): void {
    const key = scopeKey(scope);
    secretStore.set(key, newValue, ttlMs);

    for (const [id, handle] of this.handles.entries()) {
      if (handle.scope.toolId === scope.toolId && handle.scope.action === scope.action) {
        this.handles.set(id, { ...handle, rotatedAt: new Date() });
      }
    }

    auditLog.record('credential.rotated', rotatedBy, key, 'success');
    logger.info('Credential rotated', { scope: key });
  }

  /** Permanently revoke a credential. Subsequent retrieve() calls will fail. */
  revoke(scope: CredentialScope, revokedBy: string): boolean {
    const key = scopeKey(scope);
    const existed = secretStore.has(key);
    secretStore.delete(key);

    for (const [id, handle] of this.handles.entries()) {
      if (handle.scope.toolId === scope.toolId && handle.scope.action === scope.action) {
        this.handles.set(id, { ...handle, revoked: true });
      }
    }

    auditLog.record('credential.revoked', revokedBy, key, existed ? 'success' : 'failure');
    return existed;
  }

  /** List handles (metadata only — never plaintext values) for observability. */
  listHandles(): CredentialHandle[] {
    return Array.from(this.handles.values());
  }
}

/** Singleton instance for use across the application. */
export const credentialBroker = new CredentialBroker();
