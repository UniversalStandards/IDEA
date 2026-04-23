/**
 * src/api/admin-api.ts
 * Protected admin API endpoints.
 * All routes require a valid JWT Bearer token signed with JWT_SECRET.
 *
 * SSE streaming endpoints accept the token via query param (?token=…)
 * because the browser EventSource API cannot send custom headers.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createLogger } from '../observability/logger';
import { getConfig } from '../config';
import { runtimeManager } from '../core/runtime-manager';
import { auditLog } from '../security/audit';
import { metrics } from '../observability/metrics';
import { logStreamer } from '../observability/log-streamer';
import { workflowEngine } from '../orchestration/workflow-engine';
import { providerRouter } from '../routing/provider-router';
import { buildDashboardHtml } from './dashboard';

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

// ─────────────────────────────────────────────────────────────────
// GET /admin/dashboard
// Serves the self-contained monitoring UI.  No auth required for the
// page itself — the page prompts for and stores the JWT in localStorage.
// ─────────────────────────────────────────────────────────────────

adminRouter.get('/dashboard', (_req: Request, res: Response) => {
  const proto = _req.headers['x-forwarded-proto'] ?? _req.protocol ?? 'http';
  const host  = _req.headers['x-forwarded-host'] ?? _req.headers['host'] ?? 'localhost';
  const baseUrl = `${String(proto)}://${String(host)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildDashboardHtml(baseUrl));
});

// ─────────────────────────────────────────────────────────────────
// SSE helpers — registered BEFORE requireAuth because browser
// EventSource cannot set custom Authorization headers.
// Each SSE route performs its own token check via verifySseToken().
// ─────────────────────────────────────────────────────────────────

function verifySseToken(req: Request): boolean {
  const cfg = getConfig();

  // Try Authorization header first
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    try {
      jwt.verify(authHeader.slice(7), cfg.JWT_SECRET);
      return true;
    } catch {
      return false;
    }
  }

  // Fall back to query param (browser EventSource cannot set headers)
  const queryToken = req.query['token'];
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    try {
      jwt.verify(queryToken, cfg.JWT_SECRET);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function sendSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// ─────────────────────────────────────────────────────────────────
// GET /admin/metrics/stream
// SSE stream: sends a MetricsSnapshot + process memory every 5 s.
// ─────────────────────────────────────────────────────────────────

adminRouter.get('/metrics/stream', (req: Request, res: Response) => {
  if (!verifySseToken(req)) {
    res.status(401).json({ error: 'Unauthorized — provide a valid JWT via Authorization header or ?token= param' });
    return;
  }

  sendSseHeaders(res);
  res.write(': connected\n\n');

  const sendSnapshot = (): void => {
    try {
      const snapshot = metrics.getSnapshot();
      const mem = process.memoryUsage();
      const providers = providerRouter.listProviders().map((p) => {
        const cached = (providerRouter as unknown as { healthCache?: Map<string, { healthy: boolean; checkedAt: number }> }).healthCache;
        const health = cached?.get(p.id);
        return {
          id: p.id,
          name: p.name,
          healthy: health ? health.healthy : null,
          checkedAt: health ? new Date(health.checkedAt).toISOString() : null,
        };
      });

      const payload = { ...snapshot, memory: mem, providers };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      logger.warn('metrics/stream send error', { err: err instanceof Error ? err.message : String(err) });
    }
  };

  // Send an initial snapshot immediately so the client doesn't wait 5 s
  sendSnapshot();
  const interval = setInterval(sendSnapshot, 5_000);

  // Heartbeat to keep proxies/firewalls alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30_000);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    logger.debug('metrics/stream client disconnected');
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/logs/stream
// SSE stream: forwards every Winston log entry in real time.
// Supports optional ?level= and ?module= query filters.
// ─────────────────────────────────────────────────────────────────

const logsStreamSchema = z.object({
  level:  z.string().optional(),
  module: z.string().optional(),
});

adminRouter.get('/logs/stream', (req: Request, res: Response) => {
  if (!verifySseToken(req)) {
    res.status(401).json({ error: 'Unauthorized — provide a valid JWT via Authorization header or ?token= param' });
    return;
  }

  const parsed = logsStreamSchema.safeParse(req.query);
  const levelFilter  = parsed.success ? (parsed.data.level  ?? '') : '';
  const moduleFilter = parsed.success ? (parsed.data.module ?? '') : '';

  sendSseHeaders(res);
  res.write(': connected\n\n');

  const onLog = (entry: Record<string, unknown>): void => {
    try {
      if (levelFilter && entry['level'] !== levelFilter) return;
      if (moduleFilter && !String(entry['module'] ?? '').toLowerCase().includes(moduleFilter.toLowerCase())) return;
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      logStreamer.off('log', onLog);
    }
  };

  logStreamer.on('log', onLog);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30_000);

  req.on('close', () => {
    logStreamer.off('log', onLog);
    clearInterval(heartbeat);
    logger.debug('logs/stream client disconnected');
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /admin/events/stream
// SSE stream: forwards workflow lifecycle events in real time.
// ─────────────────────────────────────────────────────────────────

const WORKFLOW_EVENTS = [
  'workflow:completed',
  'workflow:started',
  'workflow:step:complete',
  'workflow:step:failed',
  'workflow:cancelled',
] as const;

adminRouter.get('/events/stream', (req: Request, res: Response) => {
  if (!verifySseToken(req)) {
    res.status(401).json({ error: 'Unauthorized — provide a valid JWT via Authorization header or ?token= param' });
    return;
  }

  sendSseHeaders(res);
  res.write(': connected\n\n');

  const forwardEvent = (eventType: string) => (data: unknown): void => {
    try {
      const payload = { event: eventType, timestamp: new Date().toISOString(), data };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      WORKFLOW_EVENTS.forEach((ev) => {
        const fn = listeners[ev];
        if (fn) workflowEngine.off(ev, fn);
      });
    }
  };

  // Build a listener map so we can remove them on disconnect
  const listeners: Record<string, (data: unknown) => void> = {};
  for (const ev of WORKFLOW_EVENTS) {
    listeners[ev] = forwardEvent(ev);
    workflowEngine.on(ev, listeners[ev]);
  }

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30_000);

  req.on('close', () => {
    WORKFLOW_EVENTS.forEach((ev) => {
      const fn = listeners[ev];
      if (fn) workflowEngine.off(ev, fn);
    });
    clearInterval(heartbeat);
    logger.debug('events/stream client disconnected');
  });
});

// Apply auth middleware to all admin routes AFTER the public SSE + dashboard routes
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
