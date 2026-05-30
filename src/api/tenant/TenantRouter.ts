import { Router, type Request, type Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { getConfig } from '../../config';

const orgParamsSchema = z.object({
  orgId: z.string().min(1),
});

const workspaceParamsSchema = z.object({
  orgId: z.string().min(1),
  wsId: z.string().min(1),
});

export interface TenantRouterOptions {
  readonly jwtSecret?: string;
  readonly listCapabilities?: () => unknown[];
  readonly listWorkflows?: () => unknown[];
}

export function createTenantRouter(options: TenantRouterOptions = {}): Router {
  const router = Router();
  const jwtSecret = options.jwtSecret ?? getConfig().JWT_SECRET;
  const defaultCapabilities = (): unknown[] => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runtimeRegistrar } = require('../../provisioning/runtime-registrar') as {
      runtimeRegistrar: { list: () => unknown[] };
    };
    return runtimeRegistrar.list();
  };
  const defaultWorkflows = (): unknown[] => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { workflowEngine } = require('../../orchestration/workflow-engine') as {
      workflowEngine: { listWorkflows: () => unknown[] };
    };
    return workflowEngine.listWorkflows();
  };
  const listCapabilities = options.listCapabilities ?? defaultCapabilities;
  const listWorkflows = options.listWorkflows ?? defaultWorkflows;

  router.get('/orgs/:orgId/capabilities', (req: Request, res: Response): void => {
    const parsed = orgParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid route params', details: parsed.error.issues });
      return;
    }

    const orgIdClaim = resolveOrgId(req, jwtSecret);
    if (!orgIdClaim || orgIdClaim !== parsed.data.orgId) {
      res.status(401).json({ error: 'Tenant isolation violation' });
      return;
    }

    const capabilities = listCapabilities();
    res.json({ orgId: parsed.data.orgId, capabilities, count: capabilities.length });
  });

  router.get('/orgs/:orgId/workspaces/:wsId/workflows', (req: Request, res: Response): void => {
    const parsed = workspaceParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid route params', details: parsed.error.issues });
      return;
    }

    const orgIdClaim = resolveOrgId(req, jwtSecret);
    if (!orgIdClaim || orgIdClaim !== parsed.data.orgId) {
      res.status(401).json({ error: 'Tenant isolation violation' });
      return;
    }

    const workflows = listWorkflows();
    res.json({
      orgId: parsed.data.orgId,
      workspaceId: parsed.data.wsId,
      workflows,
      count: workflows.length,
    });
  });

  router.get('/capabilities', (req: Request, res: Response) => {
    const orgIdClaim = resolveOrgId(req, jwtSecret);
    if (!orgIdClaim) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const capabilities = listCapabilities();
    res.json({ orgId: orgIdClaim, capabilities, count: capabilities.length, alias: true });
  });

  router.get('/workspaces/:wsId/workflows', (req: Request, res: Response) => {
    const wsId = req.params['wsId'];
    if (!wsId) {
      res.status(400).json({ error: 'Missing workspace id' });
      return;
    }

    const orgIdClaim = resolveOrgId(req, jwtSecret);
    if (!orgIdClaim) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const workflows = listWorkflows();
    res.json({
      orgId: orgIdClaim,
      workspaceId: wsId,
      workflows,
      count: workflows.length,
      alias: true,
    });
  });

  return router;
}

function resolveOrgId(req: Request, jwtSecret: string): string | undefined {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return undefined;
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), jwtSecret) as JwtPayload | string;
    if (typeof decoded === 'string') {
      return undefined;
    }
    const orgClaim = decoded['orgId'] ?? decoded['org_id'];
    return typeof orgClaim === 'string' && orgClaim.trim() ? orgClaim : undefined;
  } catch {
    return undefined;
  }
}
