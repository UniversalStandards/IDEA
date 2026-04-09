import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../observability/logger';
import { auditLogger } from '../security/audit';
import { credentialBroker } from '../security/credential-broker';
import { approvalGate } from '../policy/approval-gates';
import { runtimeRegistrar } from '../provisioning/runtime-registrar';
import { CredentialType } from '../security/credential-broker';
import { config } from '../config';

const logger = createLogger('admin-api');

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: missing Bearer token' });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== config.JWT_SECRET) {
    res.status(401).json({ error: 'Unauthorized: invalid token' });
    return;
  }
  next();
}

export const adminRouter = Router();
adminRouter.use(adminAuth);

// GET /admin/audit — query audit log
adminRouter.get('/audit', (req: Request, res: Response) => {
  try {
    const { actor, action, from, to } = req.query as Record<string, string | undefined>;
    const entries = auditLogger.query({ actor, action, from, to });
    res.json({ entries, count: entries.length });
  } catch (err) {
    logger.error('GET /admin/audit failed', { err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /admin/credentials — list credential names (not values)
adminRouter.get('/credentials', (_req: Request, res: Response) => {
  try {
    const creds = credentialBroker.listAll().map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      scopes: c.scopes,
      expiresAt: c.expiresAt,
    }));
    res.json({ credentials: creds, count: creds.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /admin/credentials — register a new credential
adminRouter.post('/credentials', (req: Request, res: Response) => {
  try {
    const { name, type, value, scopes } = req.body as {
      name?: string;
      type?: string;
      value?: string;
      scopes?: string[];
    };

    if (!name || !type || !value) {
      res.status(400).json({ error: 'name, type, and value are required' });
      return;
    }

    const validTypes: CredentialType[] = ['api_key', 'oauth_token', 'basic', 'bearer'];
    if (!validTypes.includes(type as CredentialType)) {
      res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      return;
    }

    const cred = credentialBroker.register(name, {
      name,
      type: type as CredentialType,
      value,
      scopes: scopes ?? [],
    });

    res.status(201).json({
      id: cred.id,
      name: cred.name,
      type: cred.type,
      scopes: cred.scopes,
    });
  } catch (err) {
    logger.error('POST /admin/credentials failed', { err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /admin/credentials/:name — revoke credential
adminRouter.delete('/credentials/:name', (req: Request, res: Response) => {
  try {
    const name = req.params['name'] as string;
    if (!name) {
      res.status(400).json({ error: 'Credential name is required' });
      return;
    }
    const revoked = credentialBroker.revoke(name);
    if (!revoked) {
      res.status(404).json({ error: `Credential not found: ${name}` });
      return;
    }
    res.json({ success: true, name });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /admin/approvals — list pending approvals
adminRouter.get('/approvals', (_req: Request, res: Response) => {
  try {
    const pending = approvalGate.pending();
    res.json({ approvals: pending, count: pending.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /admin/approvals/:id/approve — approve a pending action
adminRouter.post('/approvals/:id/approve', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    if (!id) {
      res.status(400).json({ error: 'Approval ID is required' });
      return;
    }
    const approval = approvalGate.approve(id, 'admin');
    res.json(approval);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// POST /admin/approvals/:id/deny — deny with reason
adminRouter.post('/approvals/:id/deny', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    if (!id) {
      res.status(400).json({ error: 'Approval ID is required' });
      return;
    }
    const { reason } = req.body as { reason?: string };
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    const approval = approvalGate.deny(id, 'admin', reason);
    res.json(approval);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// GET /admin/tools/installed — list with full metadata
adminRouter.get('/tools/installed', (_req: Request, res: Response) => {
  try {
    const tools = runtimeRegistrar.list();
    res.json({ tools, count: tools.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /admin/tools/:id/restart — restart a tool process
adminRouter.post('/tools/:id/restart', (req: Request, res: Response) => {
  try {
    const toolId = req.params['id'] as string;
    if (!toolId) {
      res.status(400).json({ error: 'Tool ID is required' });
      return;
    }
    const registered = runtimeRegistrar.get(toolId);
    if (!registered) {
      res.status(404).json({ error: `Tool not found: ${toolId}` });
      return;
    }

    runtimeRegistrar.stop(toolId);
    runtimeRegistrar.start(toolId);

    logger.info('Tool restarted via admin', { toolId });
    res.json({ success: true, toolId, status: 'running' });
  } catch (err) {
    logger.error('POST /admin/tools/:id/restart failed', { err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
