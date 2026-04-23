import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { auditLog } from '../security/audit';
import { config } from '../config';

const logger = createLogger('approval-gate');

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ApprovalRequest {
  id: string;
  toolId: string;
  action: string;
  requestedBy: string;
  reason: string;
  metadata?: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  denyReason?: string;
}

interface AutoApproveRule {
  toolId: string;
  action: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalGate {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly autoApproveRules: AutoApproveRule[] = [];
  private readonly timeoutMs: number;
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  async request(
    toolId: string,
    action: string,
    requestedBy: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<ApprovalRequest> {
    if (this.isAutoApproved(toolId, action)) {
      const req = this.createRequest(toolId, action, requestedBy, reason, metadata);
      return this.approveInternal(req, 'system:auto-approve');
    }

    let enabled = true;
    try {
      enabled = config.REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS;
    } catch {
      enabled = process.env['REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS'] !== 'false';
    }

    if (!enabled) {
      const req = this.createRequest(toolId, action, requestedBy, reason, metadata);
      return this.approveInternal(req, 'system:policy-disabled');
    }

    const req = this.createRequest(toolId, action, requestedBy, reason, metadata);

    return new Promise<ApprovalRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.requests.get(req.id);
        if (current && current.status === 'pending') {
          current.status = 'denied';
          current.resolvedAt = new Date().toISOString();
          current.resolvedBy = 'system:timeout';
          current.denyReason = `Approval timed out after ${this.timeoutMs}ms`;
          this.pendingTimers.delete(req.id);

          auditLog.record(
            `approval.timeout:${action}`,
            requestedBy,
            toolId,
            'failure',
            undefined,
            { requestId: req.id },
          );

          reject(new Error(`Approval request timed out: ${req.id}`));
        }
      }, this.timeoutMs);

      this.pendingTimers.set(req.id, timer);

      const poll = (): void => {
        const current = this.requests.get(req.id);
        if (!current || current.status === 'pending') {
          setTimeout(poll, 500);
          return;
        }
        clearTimeout(timer);
        this.pendingTimers.delete(req.id);
        if (current.status === 'approved') {
          resolve(current);
        } else {
          reject(new Error(`Approval denied: ${current.denyReason ?? 'No reason given'}`));
        }
      };

      setTimeout(poll, 500);
    });
  }

  private createRequest(
    toolId: string,
    action: string,
    requestedBy: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): ApprovalRequest {
    const req: ApprovalRequest = {
      id: randomUUID(),
      toolId,
      action,
      requestedBy,
      reason,
      metadata: metadata ?? {},
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.requests.set(req.id, req);

    auditLog.record(
      `approval.request:${action}`,
      requestedBy,
      toolId,
      'success',
      undefined,
      { requestId: req.id, reason },
    );

    logger.info('Approval request created', { id: req.id, toolId, action, requestedBy });
    return req;
  }

  private approveInternal(req: ApprovalRequest, approvedBy: string): ApprovalRequest {
    req.status = 'approved';
    req.resolvedAt = new Date().toISOString();
    req.resolvedBy = approvedBy;
    return req;
  }

  approve(id: string, approvedBy: string): ApprovalRequest {
    const req = this.requests.get(id);
    if (!req) throw new Error(`Approval request not found: ${id}`);
    if (req.status !== 'pending') {
      throw new Error(`Approval request already resolved: ${req.status}`);
    }

    req.status = 'approved';
    req.resolvedAt = new Date().toISOString();
    req.resolvedBy = approvedBy;

    const timer = this.pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(id);
    }

    auditLog.record(
      `approval.approve:${req.action}`,
      approvedBy,
      req.toolId,
      'success',
      undefined,
      { requestId: id },
    );

    logger.info('Approval request approved', { id, approvedBy });
    return req;
  }

  deny(id: string, deniedBy: string, denyReason: string): ApprovalRequest {
    const req = this.requests.get(id);
    if (!req) throw new Error(`Approval request not found: ${id}`);
    if (req.status !== 'pending') {
      throw new Error(`Approval request already resolved: ${req.status}`);
    }

    req.status = 'denied';
    req.resolvedAt = new Date().toISOString();
    req.resolvedBy = deniedBy;
    req.denyReason = denyReason;

    const timer = this.pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(id);
    }

    auditLog.record(
      `approval.deny:${req.action}`,
      deniedBy,
      req.toolId,
      'failure',
      undefined,
      { requestId: id, denyReason },
    );

    logger.info('Approval request denied', { id, deniedBy, denyReason });
    return req;
  }

  pending(): ApprovalRequest[] {
    return Array.from(this.requests.values()).filter((r) => r.status === 'pending');
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  listAll(): ApprovalRequest[] {
    return Array.from(this.requests.values());
  }

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

  private isAutoApproved(toolId: string, action: string): boolean {
    return this.autoApproveRules.some(
      (r) =>
        (r.toolId === toolId || r.toolId === '*') &&
        (r.action === action || r.action === '*'),
    );
  }
}

export const approvalGate = new ApprovalGate();
