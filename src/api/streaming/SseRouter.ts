import { Router, type Request, type Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { getConfig } from '../../config';
import { type SseHandler, sseHandler } from '../../streaming/SseHandler';

export interface SseRouterOptions {
  readonly handler?: SseHandler;
  readonly jwtSecret?: string;
}

export function createSseRouter(options: SseRouterOptions = {}): Router {
  const router = Router();
  const handler = options.handler ?? sseHandler;
  const jwtSecret = options.jwtSecret ?? getConfig().JWT_SECRET;

  router.get('/stream', (req: Request, res: Response) => {
    const orgId = resolveOrgId(req, jwtSecret);
    if (!orgId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    handler.connect(orgId, req, res);
  });

  return router;
}

function resolveOrgId(req: Request, jwtSecret: string): string | undefined {
  const authorization = req.headers['authorization'];
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return undefined;
  }

  try {
    const decoded = jwt.verify(authorization.slice(7), jwtSecret) as JwtPayload | string;
    if (typeof decoded === 'string') {
      return undefined;
    }
    const claim = decoded['orgId'] ?? decoded['org_id'];
    return typeof claim === 'string' && claim.trim() ? claim : undefined;
  } catch {
    return undefined;
  }
}
