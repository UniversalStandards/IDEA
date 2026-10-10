import { Router, type Request, type Response } from 'express';
import { metrics } from '../observability/metrics';
import { runtimeRegistrar } from '../provisioning/runtime-registrar';
import { workflowEngine } from '../orchestration/workflow-engine';
import { policyEngine } from '../policy/policy-engine';
import { providerRouter } from '../routing/provider-router';
import { runtimeManager } from '../core/runtime-manager';

export const statusRouter = Router();

statusRouter.get('/', (_req: Request, res: Response) => {
  try {
    const snapshot = metrics.getSnapshot();
    const installedTools = runtimeRegistrar.list();
    const workflows = workflowEngine.listWorkflows();
    const policies = policyEngine.listPolicies();
    const providers = providerRouter.listProviders();
    // Built from runtimeManager.getStatus()'s own subsystems array rather
    // than querying upcloudWorkerFactoryAdapter directly, so this stays in
    // sync with the one place that already computes it (see
    // src/core/runtime-manager.ts) instead of duplicating the logic.
    const runtimeStatus = runtimeManager.getStatus();
    const workerFactory = runtimeStatus.subsystems.find((s) => s.name === 'upcloud-worker-factory');

    res.json({
      timestamp: new Date().toISOString(),
      hub: {
        installedTools: installedTools.length,
        runningTools: installedTools.filter((t) => t.status === 'running').length,
        registeredWorkflows: workflows.length,
        enabledWorkflows: workflows.filter((w) => w.enabled).length,
        policies: policies.length,
        providers: providers.length,
        // A session whose broker-side teardown failed (see endSession() in
        // src/adapters/upcloud-worker-factory/index.ts) is a leaked remote
        // worker, not something this endpoint should silently omit —
        // surfaced here rather than relegated to a log line nothing is
        // scraping.
        workerFactoryHealthy: workerFactory?.healthy ?? true,
        workerFactoryDetail: workerFactory?.detail ?? 'upcloud-worker-factory adapter disabled or not yet initialized',
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
