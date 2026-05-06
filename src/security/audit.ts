/**
 * src/security/audit.ts
 * Immutable audit logging with HMAC signatures.
 * Every significant action produces a signed audit entry written to audit.jsonl.
 */

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { hmac } from './crypto';
import { getConfig } from '../config';
import type { AuditEntry } from '../types/index';

const logger = createLogger('audit');
const AUDIT_LOG_PATH = path.join(process.cwd(), 'runtime', 'audit.jsonl');

type AuditOutcome = 'success' | 'failure' | 'pending' | 'denied';

interface AuditLogInput {
  actor: string;
  action: string;
  resource: string;
  outcome: AuditOutcome;
  correlationId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

class AuditLogger {
  private readonly buffer: AuditEntry[] = [];
  private flushPromise: Promise<void> | null = null;
  private readonly enabled: boolean;

  constructor() {
    try {
      this.enabled = getConfig().ENABLE_AUDIT_LOGGING;
    } catch {
      this.enabled = true;
    }
  }

  record(
    action: string,
    actor: string,
    resource: string,
    outcome: AuditOutcome,
    correlationId?: string,
    metadata: Record<string, unknown> = {},
    requestId?: string,
  ): void {
    if (!this.enabled) {
      return;
    }

    const id = randomUUID();
    const entry: AuditEntry = {
      id,
      timestamp: new Date(),
      action,
      actor,
      resource,
      outcome,
      correlationId: correlationId ?? randomUUID(),
      metadata,
      ...(requestId ? { requestId } : {}),
    };

    const payload = JSON.stringify({
      id,
      timestamp: entry.timestamp.toISOString(),
      action,
      actor,
      resource,
      outcome,
      correlationId: entry.correlationId,
      requestId,
      metadata,
    });

    const signedEntry: AuditEntry = {
      ...entry,
      hmac: this.sign(payload),
    };

    this.buffer.push(signedEntry);
    void this.writeLine(signedEntry);
  }

  log(input: AuditLogInput): void {
    this.record(
      input.action,
      input.actor,
      input.resource,
      input.outcome,
      input.correlationId,
      input.metadata ?? {},
      input.requestId,
    );
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }

    this.flushPromise = (async (): Promise<void> => {
      const entries = this.buffer.splice(0);
      for (const entry of entries) {
        await this.writeLine(entry);
      }
      logger.info('Audit log flushed', { count: entries.length });
    })();

    await this.flushPromise;
    this.flushPromise = null;
  }

  private sign(payload: string): string {
    try {
      const secret = getConfig().ENCRYPTION_KEY;
      return hmac(payload, secret);
    } catch {
      return 'unsigned';
    }
  }

  private async writeLine(entry: AuditEntry): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      return;
    }

    try {
      await mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
      await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      logger.warn('Failed to write audit entry to disk', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const auditLog = new AuditLogger();
export const auditLogger = auditLog;
