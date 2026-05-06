import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { createLogger } from '../observability/logger';
import { getConfig } from '../config';
import { type TenantStore } from './TenantStore';

const logger = createLogger('tenant-middleware');

declare module 'express-serve-static-core' {
  interface Request {
    orgId?: string;
    tenantContext?: {
      orgId: string;
    };
  }
}

export function createTenantMiddleware(store: TenantStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const orgIdFromToken = resolveOrgIdFromBearer(req);
    const orgIdFromApiKey = resolveOrgIdFromApiKey(req, store);
    const orgId = orgIdFromToken ?? orgIdFromApiKey;

    if (!orgId) {
      res.status(401).json({ error: 'Missing or invalid tenant context' });
      return;
    }

    const tenant = store.get(orgId);
    if (tenant?.status !== 'active') {
      res.status(401).json({ error: 'Missing or invalid tenant context' });
      return;
    }

    req.orgId = orgId;
    req.tenantContext = { orgId };
    next();
  };
}

function resolveOrgIdFromBearer(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string') {
    return undefined;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const token = match[1];
  if (!token) return undefined;

  try {
    const decoded = jwt.verify(token, getConfig().JWT_SECRET) as JwtPayload | string;
    if (typeof decoded === 'string') return undefined;

    const orgClaim = decoded['orgId'] ?? decoded['org_id'];
    return typeof orgClaim === 'string' && orgClaim.trim() ? orgClaim : undefined;
  } catch (err) {
    logger.warn('Failed to verify tenant JWT', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function resolveOrgIdFromApiKey(req: Request, store: TenantStore): string | undefined {
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader !== 'string') return undefined;
  return store.resolveOrgIdByApiKey(apiKeyHeader);
}
