import { Router, Request, Response } from 'express';
import { registryManager } from '../discovery/registry-manager';

const START_TIME = Date.now();

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  res.json({
    status: 'ok',
    uptime,
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '1.0.0',
  });
});

healthRouter.get('/ready', async (_req: Request, res: Response) => {
  try {
    // Check if at least one registry is available
    const registries = registryManager.listRegistries();
    const available = registries.length > 0;

    if (available) {
      res.json({
        status: 'ok',
        ready: true,
        registries,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(503).json({
        status: 'degraded',
        ready: false,
        reason: 'No registries available',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      ready: false,
      reason: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

healthRouter.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ alive: true, timestamp: new Date().toISOString() });
});
