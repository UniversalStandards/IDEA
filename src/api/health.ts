/**
 * src/api/health.ts
 * Health check endpoints:
 *   GET /health       — combined liveness + readiness (backward compat)
 *   GET /health/live  — liveness probe (always 200 if process is up)
 *   GET /health/ready — readiness probe (200 only when runtime is initialized)
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { runtimeManager } from '../core/runtime-manager';
import type { HealthStatus } from '../types/index';

const logger = createLogger('health');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../../package.json') as { version: string };

export const healthRouter = Router();

const startedAt = Date.now();

function buildHealthResponse(ready: boolean): HealthStatus {
  return {
    status: ready ? 'ok' : 'degraded',
    version,
    nodeVersion: process.version,
    environment: process.env['NODE_ENV'] ?? 'unknown',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date(),
    checks: {
      runtime: {
        status: ready ? 'ok' : 'unavailable',
        message: ready ? 'Runtime manager initialized' : 'Runtime manager not yet ready',
      },
      memory: {
        status: 'ok',
        message: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap used`,
      },
    },
  };
}

/** GET /health — combined probe (backward compatible) */
healthRouter.get('/', (req: Request, res: Response) => {
  const requestId = (res.getHeader('X-Request-ID') as string | undefined) ?? randomUUID();
  res.setHeader('X-Request-ID', requestId);
  const ready = runtimeManager.isInitialized();
  const body = buildHealthResponse(ready);
  logger.debug('Health check', { ready, requestId });
  res.status(ready ? 200 : 503).json(body);
});

/** GET /health/live — liveness probe. Always 200 if the process is running. */
healthRouter.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** GET /health/ready — readiness probe. 503 until runtime is initialized. */
healthRouter.get('/ready', (_req: Request, res: Response) => {
  const ready = runtimeManager.isInitialized();
  if (!ready) {
    res.status(503).json({
      status: 'unavailable',
      message: 'Runtime not yet initialized',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});
