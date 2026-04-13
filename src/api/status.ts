import { Router, type Request, type Response } from 'express';
import { metrics } from '../observability/metrics';
import { runtimeRegistrar } from '../provisioning/runtime-registrar';
import { workflowEngine } from '../orchestration/workflow-engine';
import { policyEngine } from '../policy/policy-engine';
import { providerRouter } from '../routing/provider-router';

export const statusRouter = Router();

statusRouter.get('/', (_req: Request, res: Response) => {
  try {
    const snapshot = metrics.getSnapshot();
    const installedTools = runtimeRegistrar.list();
    const workflows = workflowEngine.listWorkflows();
    const policies = policyEngine.listPolicies();
    const providers = providerRouter.listProviders();

    res.json({
      timestamp: new Date().toISOString(),
      hub: {
        installedTools: installedTools.length,
        runningTools: installedTools.filter((t) => t.status === 'running').length,
        registeredWorkflows: workflows.length,
        enabledWorkflows: workflows.filter((w) => w.enabled).length,
        policies: policies.length,
        providers: providers.length,
      },
      metrics: snapshot,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

statusRouter.get('/metrics', (_req: Request, res: Response) => {
  try {
    const snapshot = metrics.getSnapshot();
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

statusRouter.get('/providers', async (_req: Request, res: Response) => {
  try {
    const providers = providerRouter.listProviders();
    const healthChecks = await Promise.allSettled(
      providers.map(async (p) => {
        const healthy = await providerRouter.checkHealth(p.id);
        return { id: p.id, name: p.name, healthy, baseUrl: p.baseUrl };
      }),
    );

    const results = healthChecks.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        id: providers[i]?.id ?? 'unknown',
        name: providers[i]?.name ?? 'unknown',
        healthy: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    res.json({ providers: results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
