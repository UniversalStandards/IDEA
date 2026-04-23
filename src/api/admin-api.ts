/**
 * src/api/admin-api.ts
 * Protected admin API endpoints.
 * All routes require a valid JWT Bearer token signed with JWT_SECRET.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createLogger } from '../observability/logger';
import { getConfig } from '../config';
import { runtimeManager } from '../core/runtime-manager';
import { auditLog } from '../security/audit';
import { approvalGate } from '../policy/approval-gates';
import type { ApprovalDecision } from '../policy/approval-gates';

const logger = createLogger('admin-api');

export const adminRouter = Router();

// ─────────────────────────────────────────────────────────────────
// JWT Authentication Middleware
// ─────────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header. Expected: Bearer <token>' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const cfg = getConfig();
    const decoded = jwt.verify(token, cfg.JWT_SECRET);
    // Attach decoded payload to request for downstream use
    (req as Request & { jwtPayload: unknown }).jwtPayload = decoded;
    next();
  } catch (err) {
    logger.warn('Admin API: JWT verification failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Apply auth middleware to all admin routes
adminRouter.use(requireAuth);

// ─────────────────────────────────────────────────────────────────
// GET /admin/capabilities
// Returns all capabilities currently registered in the runtime.
// ─────────────────────────────────────────────────────────────────

adminRouter.get('/capabilities', (req: Request, res: Response) => {
  try {
    // runtimeManager.getCapabilities() may not exist in all versions
    const rm = runtimeManager as unknown as Record<string, unknown>;
    const capabilities =
      typeof rm['getCapabilities'] === 'function'
        ? (rm['getCapabilities'] as () => unknown[])()
        : [];

    auditLog.record('admin.capabilities.list', 'admin', 'runtime', 'success', undefined, {
      count: capabilities.length,
    });

    res.json({ capabilities, count: capabilities.length });
  } catch (err) {
    logger.error('Failed to retrieve capabilities', { err });
    res.status(500).json({ error: 'Failed to retrieve capabilities' });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /admin/capabilities/:id
// Deregisters a specific capability from the runtime by ID.
// ─────────────────────────────────────────────────────────────────

const capabilityIdSchema = z.string().min(1).max(255);

adminRouter.delete('/capabilities/:id', (req: Request, res: Response) => {
  const parsed = capabilityIdSchema.safeParse(req.params['id']);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid capability ID' });
    return;
  }

  const id = parsed.data;
  try {
    const rm = runtimeManager as unknown as Record<string, unknown>;
    const removed =
      typeof rm['deregisterCapability'] === 'function'
        ? (rm['deregisterCapability'] as (id: string) => boolean)(id)
        : false;

    if (!removed) {
      res.status(404).json({ error: `Capability '${id}' not found or already removed` });
      return;
    }

    auditLog.record('admin.capability.deregister', 'admin', id, 'success');
    logger.info('Admin: capability deregistered', { id });
    res.json({ message: `Capability '${id}' deregistered successfully` });
  } catch (err) {
    logger.error('Failed to deregister capability', { err, id });
    res.status(500).json({ error: 'Failed to deregister capability' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/policies
// Lists active policy rules from the policy engine.
// ─────────────────────────────────────────────────────────────────

adminRouter.get('/policies', (_req: Request, res: Response) => {
  try {
    // Policy engine integration will be wired here once policy-engine exposes getPolicies()
    res.json({
      policies: [],
      count: 0,
      message: 'Policy listing available after policy-engine is fully initialized',
    });
  } catch (err) {
    logger.error('Failed to retrieve policies', { err });
    res.status(500).json({ error: 'Failed to retrieve policies' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/costs
// Returns cost summary from the cost monitor for the last 24h.
// ─────────────────────────────────────────────────────────────────

const costsQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(168).default(24),
});

adminRouter.get('/costs', (req: Request, res: Response) => {
  const parsed = costsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
    return;
  }

  const { windowHours } = parsed.data;
  const windowMs = windowHours * 60 * 60 * 1000;

  try {
    // costMonitor will be wired once src/observability/cost-monitor.ts is imported
    res.json({
      window: `${String(windowHours)}h`,
      windowMs,
      totalCostUsd: 0,
      requestCount: 0,
      byProvider: {},
      byModel: {},
      from: new Date(Date.now() - windowMs).toISOString(),
      to: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Failed to retrieve cost data', { err });
    res.status(500).json({ error: 'Failed to retrieve cost data' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/audit
// Returns recent audit log entries (paginated).
// ─────────────────────────────────────────────────────────────────

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().optional(),
});

adminRouter.get('/audit', (req: Request, res: Response) => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
    return;
  }

  const { limit, offset, action } = parsed.data;

  try {
    res.json({
      entries: [],
      limit,
      offset,
      action: action ?? null,
      total: 0,
      message: 'Audit entries available when ENABLE_AUDIT_LOGGING=true and after runtime initialization',
    });
  } catch (err) {
    logger.error('Failed to retrieve audit entries', { err });
    res.status(500).json({ error: 'Failed to retrieve audit entries' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/approvals
// Lists all pending approval requests.
// ─────────────────────────────────────────────────────────────────

adminRouter.get('/approvals', (_req: Request, res: Response) => {
  try {
    const pending = approvalGate.pending();
    res.json({ approvals: pending, count: pending.length });
  } catch (err) {
    logger.error('Failed to retrieve pending approvals', { err });
    res.status(500).json({ error: 'Failed to retrieve pending approvals' });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /admin/approvals/:requestId/decision
// Submit an approval or rejection decision for a pending request.
// ─────────────────────────────────────────────────────────────────

const decisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1).max(255),
  reason: z.string().max(1000).optional(),
});

const requestIdParamSchema = z.string().uuid();

adminRouter.post('/approvals/:requestId/decision', (req: Request, res: Response) => {
  const paramParsed = requestIdParamSchema.safeParse(req.params['requestId']);
  if (!paramParsed.success) {
    res.status(400).json({ error: 'Invalid requestId — must be a UUID' });
    return;
  }

  const bodyParsed = decisionBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: bodyParsed.error.issues });
    return;
  }

  const requestId = paramParsed.data;
  const { decision, decidedBy, reason } = bodyParsed.data;

  const approvalDecision: ApprovalDecision = {
    requestId,
    decision,
    decidedBy,
    decidedAt: new Date().toISOString(),
    ...(reason !== undefined && { reason }),
  };

  try {
    const updated = approvalGate.submitDecision(approvalDecision);
    auditLog.record(
      `admin.approval.${decision}`,
      decidedBy,
      requestId,
      decision === 'approved' ? 'success' : 'failure',
      undefined,
      { reason },
    );
    res.json({ message: `Approval request ${decision}`, approval: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes('already resolved')) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error('Failed to submit approval decision', { err, requestId });
    res.status(500).json({ error: 'Failed to submit approval decision' });
  }
});
