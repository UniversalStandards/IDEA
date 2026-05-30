import { auditLog } from '../audit';
import { sha256Hex } from './x509-utils';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'PX', durationMs?: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

interface RevocationRecord {
  revokedAt: number;
  expiresAt: number;
  reason?: string;
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

export class TokenRevocation {
  private readonly memoryBlocklist = new Map<string, RevocationRecord>();

  constructor(
    private readonly redisClient?: RedisLike,
    private readonly logger: AuditRecorder = auditLog
  ) {}

  async revokeToken(token: string, expiresAt: Date, reason?: string): Promise<void> {
    const key = this.tokenKey(token);
    const record: RevocationRecord = {
      revokedAt: Date.now(),
      expiresAt: expiresAt.getTime(),
    };
    if (reason) record.reason = reason;

    this.memoryBlocklist.set(key, record);

    const ttlMs = Math.max(1, record.expiresAt - Date.now());
    if (this.redisClient) {
      await this.redisClient.set(key, JSON.stringify(record), 'PX', ttlMs);
    }

    this.logger.record('token.revoke', 'system', key, 'success', undefined, {
      expiresAt: expiresAt.toISOString(),
      reason: reason ?? null,
    });
  }

  async isRevoked(token: string): Promise<boolean> {
    const started = process.hrtime.bigint();
    const key = this.tokenKey(token);
    const now = Date.now();

    const memory = this.memoryBlocklist.get(key);
    if (memory && now <= memory.expiresAt) {
      return this.finalizeLookup(key, true, started);
    }

    if (memory && now > memory.expiresAt) {
      this.memoryBlocklist.delete(key);
    }

    if (!this.redisClient) {
      return this.finalizeLookup(key, false, started);
    }

    const raw = await this.redisClient.get(key);
    if (!raw) {
      return this.finalizeLookup(key, false, started);
    }

    const record = JSON.parse(raw) as RevocationRecord;
    if (now > record.expiresAt) {
      await this.redisClient.del(key);
      return this.finalizeLookup(key, false, started);
    }

    this.memoryBlocklist.set(key, record);
    return this.finalizeLookup(key, true, started);
  }

  private finalizeLookup(key: string, revoked: boolean, started: bigint): boolean {
    const elapsedNs = Number(process.hrtime.bigint() - started);
    this.logger.record('token.revocation.lookup', 'system', key, 'success', undefined, {
      revoked,
      durationNs: elapsedNs,
    });
    return revoked;
  }

  private tokenKey(token: string): string {
    return `token-revoked:${sha256Hex(token)}`;
  }
}
