import { randomBytes, randomUUID, scryptSync } from 'crypto';
import { secretStore, type SecretStore } from '../secret-store';
import { auditLog } from '../audit';

const PREFIX = 'api-key:';

export interface ApiKeyRecord {
  id: string;
  owner: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  activeSecretHashes: Array<{ hash: string; salt: string; validUntil?: string }>;
}

export interface CreatedApiKey {
  id: string;
  apiKey: string;
  expiresAt: string;
  scopes: string[];
}

interface AuditRecorder {
  record: (
    action: string,
    actor: string,
    resource: string,
    outcome: 'success' | 'failure' | 'pending',
    correlationId?: string,
    meta?: Record<string, unknown>
  ) => void;
}

export class ApiKeyLifecycle {
  constructor(
    private readonly store: SecretStore = secretStore,
    private readonly logger: AuditRecorder = auditLog
  ) {}

  createKey(owner: string, scopes: string[], expiresAt: string): CreatedApiKey {
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const apiKey = `${id}.${secret}`;

    const record: ApiKeyRecord = {
      id,
      owner,
      scopes,
      createdAt: new Date().toISOString(),
      expiresAt,
      activeSecretHashes: [this.hashSecret(secret)],
    };

    this.store.set(this.recordKey(id), JSON.stringify(record));
    this.logger.record('api_key.create', owner, id, 'success', undefined, { scopes, expiresAt });

    return { id, apiKey, expiresAt, scopes };
  }

  rotateKey(id: string, overlapSeconds = 3600): CreatedApiKey {
    const record = this.getRecord(id);
    this.ensureActive(record);

    const now = Date.now();
    const newSecret = randomBytes(32).toString('base64url');

    for (const hash of record.activeSecretHashes) {
      if (!hash.validUntil) {
        hash.validUntil = new Date(now + overlapSeconds * 1_000).toISOString();
      }
    }

    record.activeSecretHashes.push(this.hashSecret(newSecret));
    this.store.set(this.recordKey(id), JSON.stringify(record));

    this.logger.record('api_key.rotate', record.owner, id, 'success', undefined, { overlapSeconds });

    return {
      id,
      apiKey: `${id}.${newSecret}`,
      expiresAt: record.expiresAt,
      scopes: record.scopes,
    };
  }

  revokeKey(id: string): void {
    const record = this.getRecord(id);
    record.revokedAt = new Date().toISOString();
    this.store.set(this.recordKey(id), JSON.stringify(record));

    this.logger.record('api_key.revoke', record.owner, id, 'success');
  }

  validateKey(apiKey: string): ApiKeyRecord | undefined {
    const [id, secret] = apiKey.split('.', 2);
    if (!id || !secret) return undefined;

    const record = this.getRecord(id);
    if (record.revokedAt) return undefined;
    if (Date.now() > new Date(record.expiresAt).getTime()) return undefined;

    const secretHashCandidates = record.activeSecretHashes.map((entry) => ({
      hash: this.hashSecret(secret, entry.salt).hash,
      salt: entry.salt,
    }));
    const now = Date.now();
    const hasActiveHash = record.activeSecretHashes.some((entry) => {
      const candidate = secretHashCandidates.find((value) => value.salt === entry.salt);
      if (!candidate || entry.hash !== candidate.hash) return false;
      if (!entry.validUntil) return true;
      return now <= new Date(entry.validUntil).getTime();
    });

    if (!hasActiveHash) {
      return undefined;
    }

    this.logger.record('api_key.validate', record.owner, id, 'success');

    return record;
  }

  rotateAllActiveKeys(overlapSeconds = 3600): number {
    let rotated = 0;
    for (const key of this.store.list()) {
      if (!key.startsWith(PREFIX)) continue;
      const id = key.replace(PREFIX, '');
      try {
        const record = this.getRecord(id);
        if (!record.revokedAt && Date.now() <= new Date(record.expiresAt).getTime()) {
          this.rotateKey(id, overlapSeconds);
          rotated += 1;
        }
      } catch {
        // ignore malformed keys
      }
    }
    return rotated;
  }

  private getRecord(id: string): ApiKeyRecord {
    const raw = this.store.get(this.recordKey(id));
    if (!raw) throw new Error('API key not found');
    return JSON.parse(raw) as ApiKeyRecord;
  }

  private recordKey(id: string): string {
    return `${PREFIX}${id}`;
  }

  private ensureActive(record: ApiKeyRecord): void {
    if (record.revokedAt) throw new Error('API key has been revoked');
    if (Date.now() > new Date(record.expiresAt).getTime()) throw new Error('API key has expired');
  }

  private hashSecret(secret: string, existingSalt?: string): { hash: string; salt: string } {
    const salt = existingSalt ?? randomBytes(16).toString('hex');
    const hash = scryptSync(secret, salt, 32).toString('hex');
    return { hash, salt };
  }
}
