/**
 * src/policy/approval-gates.ts
 * Approval gate supporting both synchronous (polling) and asynchronous (webhook) flows
 * for high-risk tool executions.
 *
 * Synchronous flow: caller blocks until a decision is made via the Admin API or timeout fires.
 * Asynchronous flow: webhook notification is sent; caller awaits a Promise that resolves when
 *   POST /admin/approvals/:requestId/decision is called back.
 */

import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';
import { createLogger } from '../observability/logger';
import { auditLog } from '../security/audit';
import { getConfig } from '../config';
import type { RiskLevel } from '../types/index';

const logger = createLogger('approval-gate');

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  /** Unique identifier for this approval request. */
  requestId: string;
  toolId: string;
  action: string;
  /** Identity of the actor requesting the action. */
  actor: string;
  riskLevel: RiskLevel;
  /** ISO-8601 timestamp after which the request is auto-denied. */
  expiresAt: string;
  metadata?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'timed_out';
  createdAt: string;
  decision?: ApprovalDecision;
}

export interface ApprovalDecision {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

interface PendingCallback {
  resolve: (req: ApprovalRequest) => void;
  reject: (err: Error) => void;
}

interface AutoApproveRule {
  toolId: string;
  action: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────
// ApprovalGate class
// ─────────────────────────────────────────────────────────────────

export class ApprovalGate {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly pendingCallbacks = new Map<string, PendingCallback>();
  private readonly autoApproveRules: AutoApproveRule[] = [];
  private readonly timeoutMs: number;
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  // ─────────────────────────────────────────────────────────────────
  // Synchronous gate: blocks and polls until a decision is submitted
  // via the Admin API or the timeout fires.
  // ─────────────────────────────────────────────────────────────────

  async requestSync(
    toolId: string,
    action: string,
    actor: string,
    riskLevel: RiskLevel,
    metadata?: Record<string, unknown>,
  ): Promise<ApprovalRequest> {
    if (this.isAutoApproved(toolId, action)) {
      const req = this.createRequest(toolId, action, actor, riskLevel, metadata);
      return this.resolveApproved(req, 'system:auto-approve');
    }

    let enabled = true;
    try {
      enabled = getConfig().REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS;
    } catch {
      enabled = process.env['REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS'] !== 'false';
    }

    if (!enabled) {
      const req = this.createRequest(toolId, action, actor, riskLevel, metadata);
      return this.resolveApproved(req, 'system:policy-disabled');
    }

    const req = this.createRequest(toolId, action, actor, riskLevel, metadata);

    return new Promise<ApprovalRequest>((resolve, reject) => {
      this.pendingCallbacks.set(req.requestId, { resolve, reject });

      const timer = setTimeout(() => {
        const current = this.requests.get(req.requestId);
        if (current && current.status === 'pending') {
          current.status = 'timed_out';
          this.pendingTimers.delete(req.requestId);

          auditLog.record(
            `approval.timeout:${action}`,
            actor,
            toolId,
            'failure',
            undefined,
            { requestId: req.requestId },
          );

          logger.warn('Approval request timed out', { requestId: req.requestId });

          const cb = this.pendingCallbacks.get(req.requestId);
          this.pendingCallbacks.delete(req.requestId);
          if (!cb) {
            logger.warn('Timeout fired but no pending callback found', { requestId: req.requestId });
          }
          cb?.reject(new Error(`Approval request timed out: ${req.requestId}`));
        }
      }, this.timeoutMs);

      this.pendingTimers.set(req.requestId, timer);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Asynchronous gate: sends a webhook notification and returns a
  // Promise that resolves when submitDecision() is called (e.g. via
  // POST /admin/approvals/:requestId/decision).
  // ─────────────────────────────────────────────────────────────────

  async requestAsync(
    toolId: string,
    action: string,
    actor: string,
    riskLevel: RiskLevel,
    metadata?: Record<string, unknown>,
  ): Promise<ApprovalRequest> {
    if (this.isAutoApproved(toolId, action)) {
      const req = this.createRequest(toolId, action, actor, riskLevel, metadata);
      return this.resolveApproved(req, 'system:auto-approve');
    }

    const req = this.createRequest(toolId, action, actor, riskLevel, metadata);

    // Fire-and-forget webhook notification — failures are logged but never throw
    this.sendWebhook(req).catch((err: unknown) => {
      logger.warn('Failed to send approval webhook notification', {
        requestId: req.requestId,
        err: err instanceof Error ? err.message : String(err),
      });
    });

    return new Promise<ApprovalRequest>((resolve, reject) => {
      this.pendingCallbacks.set(req.requestId, { resolve, reject });

      const timer = setTimeout(() => {
        const current = this.requests.get(req.requestId);
        if (current && current.status === 'pending') {
          current.status = 'timed_out';
          this.pendingTimers.delete(req.requestId);

          auditLog.record(
            `approval.timeout:${action}`,
            actor,
            toolId,
            'failure',
            undefined,
            { requestId: req.requestId },
          );

          logger.warn('Async approval request timed out', { requestId: req.requestId });

          const cb = this.pendingCallbacks.get(req.requestId);
          this.pendingCallbacks.delete(req.requestId);
          if (!cb) {
            logger.warn('Async timeout fired but no pending callback found', { requestId: req.requestId });
          }
          cb?.reject(new Error(`Approval request timed out: ${req.requestId}`));
        }
      }, this.timeoutMs);

      this.pendingTimers.set(req.requestId, timer);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // submitDecision: called by the Admin API to record a decision and
  // unblock the waiting Promise (sync or async flow).
  // ─────────────────────────────────────────────────────────────────

  submitDecision(decision: ApprovalDecision): ApprovalRequest {
    const req = this.requests.get(decision.requestId);
    if (!req) throw new Error(`Approval request not found: ${decision.requestId}`);
    if (req.status !== 'pending') {
      throw new Error(`Approval request already resolved: ${req.status}`);
    }

    const timer = this.pendingTimers.get(decision.requestId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(decision.requestId);
    }

    req.status = decision.decision === 'approved' ? 'approved' : 'rejected';
    req.decision = decision;

    const outcome = decision.decision === 'approved' ? 'success' : 'failure';
    auditLog.record(
      `approval.${decision.decision}:${req.action}`,
      decision.decidedBy,
      req.toolId,
      outcome,
      undefined,
      { requestId: decision.requestId, reason: decision.reason },
    );

    logger.info('Approval decision submitted', {
      requestId: decision.requestId,
      decision: decision.decision,
      decidedBy: decision.decidedBy,
    });

    const cb = this.pendingCallbacks.get(decision.requestId);
    this.pendingCallbacks.delete(decision.requestId);

    if (cb) {
      if (decision.decision === 'approved') {
        cb.resolve(req);
      } else {
        cb.reject(new Error(`Approval rejected by ${decision.decidedBy}: ${decision.reason ?? 'No reason given'}`));
      }
    }

    return req;
  }

  // ─────────────────────────────────────────────────────────────────
  // Convenience wrappers kept for backward compatibility
  // ─────────────────────────────────────────────────────────────────

  approve(requestId: string, approvedBy: string, reason?: string): ApprovalRequest {
    return this.submitDecision({
      requestId,
      decision: 'approved',
      decidedBy: approvedBy,
      decidedAt: new Date().toISOString(),
      ...(reason !== undefined && { reason }),
    });
  }

  deny(requestId: string, deniedBy: string, reason: string): ApprovalRequest {
    return this.submitDecision({
      requestId,
      decision: 'rejected',
      decidedBy: deniedBy,
      decidedAt: new Date().toISOString(),
      reason,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Query helpers
  // ─────────────────────────────────────────────────────────────────

  pending(): ApprovalRequest[] {
    return Array.from(this.requests.values()).filter((r) => r.status === 'pending');
  }

  get(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  listAll(): ApprovalRequest[] {
    return Array.from(this.requests.values());
  }

  // ─────────────────────────────────────────────────────────────────
  // Auto-approve rules
  // ─────────────────────────────────────────────────────────────────

  autoApprove(toolId: string, action: string): void {
    const existing = this.autoApproveRules.find(
      (r) => r.toolId === toolId && r.action === action,
    );
    if (!existing) {
      this.autoApproveRules.push({ toolId, action });
      logger.info('Auto-approve rule added', { toolId, action });
    }
  }

  removeAutoApprove(toolId: string, action: string): void {
    const idx = this.autoApproveRules.findIndex(
      (r) => r.toolId === toolId && r.action === action,
    );
    if (idx >= 0) {
      this.autoApproveRules.splice(idx, 1);
      logger.info('Auto-approve rule removed', { toolId, action });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  private createRequest(
    toolId: string,
    action: string,
    actor: string,
    riskLevel: RiskLevel,
    metadata?: Record<string, unknown>,
  ): ApprovalRequest {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.timeoutMs).toISOString();

    const req: ApprovalRequest = {
      requestId: randomUUID(),
      toolId,
      action,
      actor,
      riskLevel,
      expiresAt,
      ...(metadata !== undefined && { metadata }),
      status: 'pending',
      createdAt: now.toISOString(),
    };
    this.requests.set(req.requestId, req);

    auditLog.record(
      `approval.request:${action}`,
      actor,
      toolId,
      'pending',
      undefined,
      { requestId: req.requestId, riskLevel },
    );

    logger.info('Approval request created', {
      requestId: req.requestId,
      toolId,
      action,
      actor,
      riskLevel,
    });
    return req;
  }

  private resolveApproved(req: ApprovalRequest, decidedBy: string): ApprovalRequest {
    req.status = 'approved';
    req.decision = {
      requestId: req.requestId,
      decision: 'approved',
      decidedBy,
      decidedAt: new Date().toISOString(),
    };
    return req;
  }

  private isAutoApproved(toolId: string, action: string): boolean {
    return this.autoApproveRules.some(
      (r) =>
        (r.toolId === toolId || r.toolId === '*') &&
        (r.action === action || r.action === '*'),
    );
  }

  private async sendWebhook(req: ApprovalRequest): Promise<void> {
    let webhookUrl: string | undefined;
    try {
      webhookUrl = getConfig().APPROVAL_WEBHOOK_URL;
    } catch {
      webhookUrl = process.env['APPROVAL_WEBHOOK_URL'];
    }

    if (!webhookUrl) return;

    const payload = JSON.stringify({
      event: 'approval.requested',
      requestId: req.requestId,
      toolId: req.toolId,
      action: req.action,
      actor: req.actor,
      riskLevel: req.riskLevel,
      expiresAt: req.expiresAt,
      createdAt: req.createdAt,
      metadata: req.metadata,
    });

    await new Promise<void>((resolve, reject) => {
      const url = new URL(webhookUrl as string);
      const transport = url.protocol === 'https:' ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Approval-Event': 'approval.requested',
        },
      };

      const reqHttp = transport.request(options, (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
          logger.info('Approval webhook sent', { requestId: req.requestId, status: res.statusCode });
          resolve();
        } else {
          reject(new Error(`Webhook returned HTTP ${String(res.statusCode)}`));
        }
        res.resume(); // drain response body
      });

      reqHttp.on('error', reject);
      reqHttp.write(payload);
      reqHttp.end();
    });
  }
}

export const approvalGate = new ApprovalGate();
