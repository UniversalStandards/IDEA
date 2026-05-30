import { randomBytes } from 'crypto';
import { secretStore, type SecretStore } from '../secret-store';
import { auditLog } from '../audit';
import { ApiKeyLifecycle } from '../auth/ApiKeyLifecycle';

export interface SecretsRotatorOptions {
  store?: SecretStore;
  logger?: AuditRecorder;
  apiKeyLifecycle?: ApiKeyLifecycle;
  jwtOverlapMs?: number;
  dbOverlapMs?: number;
  apiKeyOverlapSec?: number;
}

interface RotationState {
  lastRotatedAtMs: number;
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

const JWT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DB_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const API_KEY_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

export class SecretsRotator {
  private readonly store: SecretStore;
  private readonly logger: AuditRecorder;
  private readonly apiKeyLifecycle: ApiKeyLifecycle;

  private readonly jwtOverlapMs: number;
  private readonly dbOverlapMs: number;
  private readonly apiKeyOverlapSec: number;

  private readonly state: Record<'jwt' | 'db' | 'apiKey', RotationState> = {
    jwt: { lastRotatedAtMs: 0 },
    db: { lastRotatedAtMs: 0 },
    apiKey: { lastRotatedAtMs: 0 },
  };

  constructor(options: SecretsRotatorOptions = {}) {
    this.store = options.store ?? secretStore;
    this.logger = options.logger ?? auditLog;
    this.apiKeyLifecycle = options.apiKeyLifecycle ?? new ApiKeyLifecycle(this.store, this.logger);
    this.jwtOverlapMs = options.jwtOverlapMs ?? 15 * 60 * 1000;
    this.dbOverlapMs = options.dbOverlapMs ?? 60 * 60 * 1000;
    this.apiKeyOverlapSec = options.apiKeyOverlapSec ?? 24 * 60 * 60;
  }

  rotateDueSecrets(now: number = Date.now()): { jwtRotated: boolean; dbRotated: boolean; apiKeysRotated: number } {
    const jwtRotated = this.rotateJwtSigningKeyIfDue(now);
    const dbRotated = this.rotateDbPasswordIfDue(now);
    const apiKeysRotated = this.rotateApiKeysIfDue(now);
    return { jwtRotated, dbRotated, apiKeysRotated };
  }

  rotateJwtSigningKeyIfDue(now: number = Date.now()): boolean {
    if (!this.isDue(this.state.jwt.lastRotatedAtMs, now, JWT_INTERVAL_MS)) return false;

    this.rotateOverlappingSecret('jwt', now, this.jwtOverlapMs, () => randomBytes(48).toString('base64url'));
    this.state.jwt.lastRotatedAtMs = now;
    return true;
  }

  rotateDbPasswordIfDue(now: number = Date.now()): boolean {
    if (!this.isDue(this.state.db.lastRotatedAtMs, now, DB_INTERVAL_MS)) return false;

    this.rotateOverlappingSecret('db-password', now, this.dbOverlapMs, () => randomBytes(32).toString('base64url'));
    this.state.db.lastRotatedAtMs = now;
    return true;
  }

  rotateApiKeysIfDue(now: number = Date.now()): number {
    if (!this.isDue(this.state.apiKey.lastRotatedAtMs, now, API_KEY_INTERVAL_MS)) return 0;

    const count = this.apiKeyLifecycle.rotateAllActiveKeys(this.apiKeyOverlapSec);
    this.state.apiKey.lastRotatedAtMs = now;

    this.logger.record('secrets.rotate.api_keys', 'system', 'api-keys', 'success', undefined, {
      rotated: count,
      overlapSec: this.apiKeyOverlapSec,
    });

    return count;
  }

  private rotateOverlappingSecret(
    name: string,
    now: number,
    overlapMs: number,
    generator: () => string
  ): void {
    const currentKey = `rotation:${name}:current`;
    const previousKey = `rotation:${name}:previous`;
    const oldValue = this.store.get(currentKey);

    if (oldValue) {
      this.store.set(
        previousKey,
        JSON.stringify({ value: oldValue, validUntil: new Date(now + overlapMs).toISOString() })
      );
    }

    this.store.set(currentKey, generator());

    this.logger.record(`secrets.rotate.${name}`, 'system', name, 'success', undefined, {
      overlapMs,
      previousRetained: Boolean(oldValue),
    });
  }

  private isDue(lastRotatedAtMs: number, now: number, intervalMs: number): boolean {
    return lastRotatedAtMs === 0 || now - lastRotatedAtMs >= intervalMs;
  }
}
