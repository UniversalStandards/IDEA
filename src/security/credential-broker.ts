import { randomUUID } from 'crypto';
import { secretStore } from './secret-store';
import { auditLogger } from './audit';
import { createLogger } from '../observability/logger';

const logger = createLogger('credential-broker');

export type CredentialType = 'api_key' | 'oauth_token' | 'basic' | 'bearer';

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  value: string;
  scopes: string[];
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

type StoredCredential = Omit<Credential, 'value'>;

const CRED_PREFIX = 'cred:';
const META_PREFIX = 'cred-meta:';

export class CredentialBroker {
  private readonly injections = new Map<string, Set<string>>();

  register(name: string, cred: Omit<Credential, 'id'>): Credential {
    const id = randomUUID();
    const full: Credential = { ...cred, id, name };
    const meta: StoredCredential = {
      id: full.id,
      name: full.name,
      type: full.type,
      scopes: full.scopes,
      ...(full.expiresAt !== undefined ? { expiresAt: full.expiresAt } : {}),
      ...(full.metadata !== undefined ? { metadata: full.metadata } : {}),
    };

    secretStore.set(`${CRED_PREFIX}${name}`, full.value);
    secretStore.set(`${META_PREFIX}${name}`, JSON.stringify(meta));

    auditLogger.log({
      actor: 'system',
      action: 'credential.register',
      resource: name,
      outcome: 'success',
      metadata: { id, type: cred.type },
    });

    logger.info('Credential registered', { name, type: cred.type, id });
    return full;
  }

  get(name: string): Credential | undefined {
    const raw = secretStore.get(`${CRED_PREFIX}${name}`);
    const metaRaw = secretStore.get(`${META_PREFIX}${name}`);
    if (!raw || !metaRaw) return undefined;

    const meta = JSON.parse(metaRaw) as StoredCredential;

    if (meta.expiresAt && new Date(meta.expiresAt) < new Date()) {
      logger.warn('Credential expired', { name });
      auditLogger.log({
        actor: 'system',
        action: 'credential.access',
        resource: name,
        outcome: 'failure',
        metadata: { reason: 'expired' },
      });
      return undefined;
    }

    auditLogger.log({
      actor: 'system',
      action: 'credential.access',
      resource: name,
      outcome: 'success',
    });

    return { ...meta, value: raw };
  }

  inject(toolId: string, credName: string): Credential {
    const cred = this.get(credName);
    if (!cred) throw new Error(`Credential not found or expired: ${credName}`);

    if (!this.injections.has(toolId)) {
      this.injections.set(toolId, new Set());
    }
    const injSet = this.injections.get(toolId) ?? new Set<string>();
    injSet.add(credName);
    this.injections.set(toolId, injSet);

    auditLogger.log({
      actor: toolId,
      action: 'credential.inject',
      resource: credName,
      outcome: 'success',
    });

    logger.debug('Credential injected', { toolId, credName });
    return cred;
  }

  revoke(name: string): boolean {
    const existed =
      secretStore.delete(`${CRED_PREFIX}${name}`) ||
      secretStore.delete(`${META_PREFIX}${name}`);

    for (const [toolId, creds] of this.injections.entries()) {
      creds.delete(name);
      if (creds.size === 0) this.injections.delete(toolId);
    }

    auditLogger.log({
      actor: 'system',
      action: 'credential.revoke',
      resource: name,
      outcome: existed ? 'success' : 'failure',
    });

    logger.info('Credential revoked', { name });
    return existed;
  }

  rotate(name: string, newValue: string): boolean {
    if (!secretStore.has(`${CRED_PREFIX}${name}`)) return false;
    secretStore.set(`${CRED_PREFIX}${name}`, newValue);

    auditLogger.log({
      actor: 'system',
      action: 'credential.rotate',
      resource: name,
      outcome: 'success',
    });

    logger.info('Credential rotated', { name });
    return true;
  }

  listAll(): StoredCredential[] {
    const results: StoredCredential[] = [];
    for (const key of secretStore.list()) {
      if (key.startsWith(META_PREFIX)) {
        const raw = secretStore.get(key);
        if (raw) {
          try {
            results.push(JSON.parse(raw) as StoredCredential);
          } catch {
            // ignore malformed entries
          }
        }
      }
    }
    return results;
  }

  getInjectedCredentials(toolId: string): string[] {
    return Array.from(this.injections.get(toolId) ?? []);
  }
}

export const credentialBroker = new CredentialBroker();
