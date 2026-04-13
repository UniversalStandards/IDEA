import { Router, type Request, type Response, type NextFunction, type Application } from 'express';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { registryManager } from '../../discovery/registry-manager';
import { installer } from '../../provisioning/installer';
import { runtimeRegistrar } from '../../provisioning/runtime-registrar';
import { policyEngine } from '../../policy/policy-engine';
import { providerRouter } from '../../routing/provider-router';
import { workflowEngine } from '../../orchestration/workflow-engine';
import { config } from '../../config';
import { timingSafeEqual } from '../../security/crypto';

const logger = createLogger('rest-adapter');

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: missing Bearer token' });
    return;
  }
  const token = authHeader.slice(7);
  if (!timingSafeEqual(token, config.JWT_SECRET)) {
    res.status(401).json({ error: 'Unauthorized: invalid token' });
    return;
  }
  next();
}

export function createRestAdapter(app: Application): void {
  const router = Router();

  // Apply auth middleware to all routes
  router.use(authMiddleware);

  // GET /api/v1/tools — list all available tools from registries
  router.get('/tools', async (_req: Request, res: Response) => {
    try {
      const tools = await registryManager.listAll();
      metrics.increment('rest_requests_total', { endpoint: 'GET /tools' });
      res.json({ tools, count: tools.length });
    } catch (err) {
      logger.error('GET /tools failed', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/v1/tools/installed — list installed tools
  router.get('/tools/installed', (_req: Request, res: Response) => {
    try {
      const tools = runtimeRegistrar.list();
      metrics.increment('rest_requests_total', { endpoint: 'GET /tools/installed' });
      res.json({ tools, count: tools.length });
    } catch (err) {
      logger.error('GET /tools/installed failed', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/v1/tools/search — search registries
  router.post('/tools/search', async (req: Request, res: Response) => {
    try {
      const { query, tags, limit } = req.body as {
        query?: string;
        tags?: string[];
        limit?: number;
      };
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const results = await registryManager.search({ query, ...(tags !== undefined ? { tags } : {}), ...(limit !== undefined ? { limit } : {}) });
      metrics.increment('rest_requests_total', { endpoint: 'POST /tools/search' });
      res.json({ tools: results, count: results.length });
    } catch (err) {
      logger.error('POST /tools/search failed', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/v1/tools/:id/install — install a tool
  router.post('/tools/:id/install', async (req: Request, res: Response) => {
    try {
      const toolId = req.params['id'] as string;
      if (!toolId) {
        res.status(400).json({ error: 'Tool ID is required' });
        return;
      }
      const tool = await registryManager.getById(toolId);
      if (!tool) {
        res.status(404).json({ error: `Tool not found: ${toolId}` });
        return;
      }
      const result = await installer.install(tool);
      metrics.increment('rest_requests_total', { endpoint: 'POST /tools/:id/install' });
      res.json(result);
    } catch (err) {
      logger.error('POST /tools/:id/install failed', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/v1/tools/:id — uninstall a tool
  router.delete('/tools/:id', async (req: Request, res: Response) => {
    try {
      const toolId = req.params['id'] as string;
      if (!toolId) {
        res.status(400).json({ error: 'Tool ID is required' });
        return;
      }
      const registered = runtimeRegistrar.get(toolId);
      if (!registered) {
        res.status(404).json({ error: `Tool not installed: ${toolId}` });
        return;
      }
      await installer.uninstall(toolId);
      metrics.increment('rest_requests_total', { endpoint: 'DELETE /tools/:id' });
      res.json({ success: true, toolId });
    } catch (err) {
      logger.error('DELETE /tools/:id failed', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/v1/execute — execute a tool action
  router.post('/execute', async (req: Request, res: Response) => {
    try {
      const { toolId, action, params } = req.body as {
        toolId?: string;
        action?: string;
        params?: Record<string, unknown>;
      };

      if (!toolId || !action) {
        res.status(400).json({ error: 'toolId and action are required' });
        return;
      }

      const registered = runtimeRegistrar.get(toolId);
      if (!registered) {
        res.status(404).json({ error: `Tool not registered: ${toolId}` });
        return;
      }

      const decision = policyEngine.evaluate({
        toolId,
        actor: 'rest-client',
        action,
        environment: process.env['NODE_ENV'] ?? 'development',
      });

      if (!decision.allowed) {
        res.status(403).json({ error: `Policy denied: ${decision.reasons.join(', ')}` });
        return;
      }

      metrics.increment('rest_requests_total', { endpoint: 'POST /execute' });
      res.json({
        success: true,
        toolId,
        action,
        params: params ?? {},
        status: registered.status,
      });
    } catch (err) {
      logger.error('POST /execute failed', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/v1/providers — list AI providers
  router.get('/providers', (_req: Request, res: Response) => {
    try {
      const providers = providerRouter.listProviders().map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models,
        maxTokens: p.maxTokens,
        capabilities: p.capabilities,
      }));
      metrics.increment('rest_requests_total', { endpoint: 'GET /providers' });
      res.json({ providers, count: providers.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/v1/providers/route — route to an AI provider
  router.post('/providers/route', (req: Request, res: Response) => {
    try {
      const { capability, preferredProvider, fallback } = req.body as {
        capability?: string;
        preferredProvider?: string;
        fallback?: boolean;
      };

      if (!capability) {
        res.status(400).json({ error: 'capability is required' });
        return;
      }

      const provider = providerRouter.route({ capability, ...(preferredProvider !== undefined ? { preferredProvider } : {}), ...(fallback !== undefined ? { fallback } : {}) });
      if (!provider) {
        res.status(404).json({ error: `No provider available for capability: ${capability}` });
        return;
      }

      metrics.increment('rest_requests_total', { endpoint: 'POST /providers/route' });
      res.json({ provider });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/v1/policies — list policies
  router.get('/policies', (_req: Request, res: Response) => {
    try {
      const policies = policyEngine.listPolicies();
      metrics.increment('rest_requests_total', { endpoint: 'GET /policies' });
      res.json({ policies, count: policies.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/v1/workflows/:id/trigger — trigger a workflow
  router.post('/workflows/:id/trigger', async (req: Request, res: Response) => {
    try {
      const workflowId = req.params['id'] as string;
      if (!workflowId) {
        res.status(400).json({ error: 'Workflow ID is required' });
        return;
      }
      const input = req.body as Record<string, unknown> | undefined;
      const result = await workflowEngine.trigger(workflowId, input);
      metrics.increment('rest_requests_total', { endpoint: 'POST /workflows/:id/trigger' });
      res.json(result);
    } catch (err) {
      logger.error('POST /workflows/:id/trigger failed', { err });
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  app.use('/api/v1', router);
  logger.info('REST adapter mounted at /api/v1');
}
