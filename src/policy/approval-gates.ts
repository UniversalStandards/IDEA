/**
 * src/policy/approval-gates.ts
 * Synchronous and asynchronous human/agent approval workflows.
 *
 * When policy-engine.evaluate() returns `requiresApproval: true`, the caller
 * creates an approval request here and either:
 *  - awaits `waitForDecision()` (sync flow, blocks up to a timeout), or
 *  - polls / receives a callback via the Admin API routes (async flow)
 *    while the caller's original request is held or retried later.
 *
 * `approvalGate` (singular, exported at the bottom) is a legacy-compatible
 * facade for callers (e.g. src/provisioning/installer.ts) written against a
 * combined "create-and-block" contract: a single call that resolves only
 * once approved, or throws on rejection/timeout. New code should prefer the
 * split `approvalGates.request()` / `approvalGates.waitForDecision()` API,
 * which lets a caller expose a "pending" state instead of blocking.
 */

import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { auditLog } from '../security/audit';
import { createLogger } from '../observability/logger';
import { ApprovalStatus } from '../types/index';

const logger = createLogger('approval-gates');

export interface ApprovalRequestRecord {
  readonly id: string;
  readonly toolId: string;
  readonly action: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly metadata?: Record<string, unknown>;
  status: ApprovalStatus;
  readonly createdAt: Date;
  decidedAt?: Date;
  decidedBy?: string;
  decisionNote?: string;
}

interface Waiter {
  resolve: (req: ApprovalRequestRecord) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalGateManager {
  private readonly requests = new Map<string, ApprovalRequestRecord>();
  private readonly waiters = new Map<string, Waiter[]>();

  /** Create a new pending approval request. Does not block. */
  request(
    toolId: string,
    action: string,
    requestedBy: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): ApprovalRequestRecord {
    const id = randomUUID();
    const req: ApprovalRequestRecord = {
      id,
      toolId,
      action,
      requestedBy,
      reason,
      metadata,
      status: ApprovalStatus.PENDING,
      createdAt: new Date(),
    };
    this.requests.set(id, req);

    auditLog.record('approval.requested', requestedBy, `${toolId}:${action}`, 'pending', id, {
      reason,
      ...metadata,
    });
    logger.info('Approval requested', { id, toolId, action, requestedBy });

    return req;
  }

  /**
   * Block until the request is decided or the timeout elapses.
   * On timeout, the request is marked TIMED_OUT and that terminal state is returned.
   */
  async waitForDecision(id: string, timeoutMs = 5 * 60 * 1000): Promise<ApprovalRequestRecord> {
    const existing = this.requests.get(id);
    if (!existing) {
      throw new Error(`Approval request '${id}' not found`);
    }
    if (existing.status !== ApprovalStatus.PENDING) {
      return existing;
    }

    return new Promise<ApprovalRequestRecord>((resolve) => {
      const timer = setTimeout(() => {
        const current = this.requests.get(id);
        if (current && current.status === ApprovalStatus.PENDING) {
          current.status = ApprovalStatus.TIMED_OUT;
          current.decidedAt = new Date();
          auditLog.record('approval.timed_out', 'system', `${current.toolId}:${current.action}`, 'failure', id);
          this.settle(id, current);
        }
      }, timeoutMs);
      timer.unref();

      const list = this.waiters.get(id) ?? [];
      list.push({ resolve, timer });
      this.waiters.set(id, list);
    });
  }

  /**
   * Create a request AND block until it is approved, rejected, or times out
   * — throwing in the latter two cases. This is the contract pre-existing
   * callers (installer.ts) were written against; see the module doc comment.
   */
  async requestAndWait(
    toolId: string,
    action: string,
    requestedBy: string,
    reason: string,
    metadata?: Record<string, unknown>,
    timeoutMs = 5 * 60 * 1000,
  ): Promise<ApprovalRequestRecord> {
    const req = this.request(toolId, action, requestedBy, reason, metadata);
    const decided = await this.waitForDecision(req.id, timeoutMs);

    if (decided.status === ApprovalStatus.REJECTED) {
      throw new Error(`Approval rejected${decided.decisionNote ? `: ${decided.decisionNote}` : ''}`);
    }
    if (decided.status === ApprovalStatus.TIMED_OUT) {
      throw new Error('Approval request timed out');
    }

    return decided;
  }

  /** Approve or reject a pending request. Idempotent: a second decision throws. */
  decide(id: string, approved: boolean, decidedBy: string, note?: string): ApprovalRequestRecord {
    const req = this.requests.get(id);
    if (!req) {
      throw new Error(`Approval request '${id}' not found`);
    }
    if (req.status !== ApprovalStatus.PENDING) {
      throw new Error(`Approval request '${id}' already decided (status: ${req.status})`);
    }

    req.status = approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
    req.decidedAt = new Date();
    req.decidedBy = decidedBy;
    req.decisionNote = note;

    auditLog.record(
      approved ? 'approval.approved' : 'approval.rejected',
      decidedBy,
      `${req.toolId}:${req.action}`,
      'success',
      id,
      { note },
    );

    this.settle(id, req);
    return req;
  }

  get(id: string): ApprovalRequestRecord | undefined {
    return this.requests.get(id);
  }

  listPending(): ApprovalRequestRecord[] {
    return Array.from(this.requests.values()).filter((r) => r.status === ApprovalStatus.PENDING);
  }

  private settle(id: string, req: ApprovalRequestRecord): void {
    const waiters = this.waiters.get(id) ?? [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(req);
    }
    this.waiters.delete(id);
  }

  /** Admin API sub-router: list pending approvals and decide on them. */
  buildRouter(): Router {
    const router = Router();

    router.get('/pending', (_req: Request, res: Response) => {
      res.json({ pending: this.listPending() });
    });

    const decideSchema = z.object({
      approved: z.boolean(),
      note: z.string().max(1000).optional(),
    });

    router.post('/:id/decide', (req: Request, res: Response) => {
      const parsed = decideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid decision payload', details: parsed.error.issues });
        return;
      }
      const idParam = req.params['id'];
      if (typeof idParam !== 'string') {
        res.status(400).json({ error: 'Missing approval id' });
        return;
      }
      try {
        const decidedBy =
          (req as Request & { jwtPayload?: { sub?: string } }).jwtPayload?.sub ?? 'admin';
        const result = this.decide(idParam, parsed.data.approved, decidedBy, parsed.data.note);
        res.json({ approval: result });
      } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : 'Decision failed' });
      }
    });

    return router;
  }
}

/** Singleton instance for use across the application — preferred API for new code. */
export const approvalGates = new ApprovalGateManager();

/**
 * Legacy-compatible facade matching the blocking
 * `(toolId, action, actor, reason, metadata?) => Promise<ApprovalRequestRecord>`
 * contract that src/provisioning/installer.ts was written against. Internally
 * creates a request via `approvalGates` and blocks until decided, throwing on
 * rejection or timeout — do NOT alias this to `approvalGates.request()`
 * directly, since that method is intentionally non-blocking and would let an
 * install silently proceed without ever actually being gated.
 */
export const approvalGate = {
  request: (
    toolId: string,
    action: string,
    requestedBy: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<ApprovalRequestRecord> =>
    approvalGates.requestAndWait(toolId, action, requestedBy, reason, metadata),
};
