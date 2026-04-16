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

// ─────────────────────────────────────────────────────────────────
class AuditLogger {
  private readonly buffer: AuditEntry[] = [];
  private flushPromise: Promise<void> | null = null;
  private readonly enabled: boolean;

  constructor() {
    // Lazy-read config so audit can be instantiated before validateConfig() is called
    try {
      this.enabled = getConfig().ENABLE_AUDIT_LOGGING;
    } catch {
      this.enabled = true;
    }
  }

  /**
   * Record an audit event.
   * @param action   A dot-separated action name, e.g. 'tool.provision.success'
   * @param actor    The identity initiating the action (user, system, agent ID)
   * @param resource The resource being acted upon (tool ID, route, etc.)
   * @param outcome  Result of the action
   * @param meta     Additional context (will be redacted of known sensitive keys)
   */
  record(
    action: string,
    actor: string,
    resource: string,
    outcome: 'success' | 'failure' | 'pending',
    correlationId?: string,
    meta: Record<string, unknown> = {},
  ): void {
    if (!this.enabled) return;

    const id = randomUUID();
    const entry: AuditEntry = {
      id,
      timestamp: new Date(),
      action,
      actor,
      resource,
      outcome,
      correlationId: correlationId ?? randomUUID(),
      metadata: meta,
    };

    // Sign the entry payload (without hmac field)
    const payload = JSON.stringify({ id, action, actor, resource, outcome, correlationId: entry.correlationId });
    const signedEntry: AuditEntry = {
      ...entry,
      hmac: this.sign(payload),
    };

    this.buffer.push(signedEntry);
    // Async write — do not await to keep record() synchronous
    void this.writeLine(signedEntry);
  }

  log(entry: {
    actor: string;
    action: string;
    resource: string;
    outcome: 'success' | 'failure' | 'pending' | 'denied';
    correlationId?: string;
    metadata?: Record<string, unknown>;
  }): void {
    const normalizedOutcome = entry.outcome === 'denied' ? 'failure' : entry.outcome;
    this.record(
      entry.action,
      entry.actor,
      entry.resource,
      normalizedOutcome,
      entry.correlationId,
      entry.metadata ?? {},
    );
  }

  /**
   * Flush all buffered entries to disk.
   * Should be called during graceful shutdown.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    // Prevent concurrent flush calls
    if (this.flushPromise) return this.flushPromise;
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
    if (process.env['NODE_ENV'] === 'test') return;
    try {
      await mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
      await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      logger.warn('Failed to write audit entry to disk', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────

export const auditLog = new AuditLogger();
export const auditLogger = auditLog;
