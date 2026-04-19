import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { registryManager } from '../discovery/registry-manager';
import { policyEngine } from '../policy/policy-engine';
import { providerRouter } from '../routing/provider-router';
import { workflowEngine } from '../orchestration/workflow-engine';
import { capabilitySelector } from '../routing/capability-selector';
import { scheduler } from '../routing/scheduler';
import { runtimeRegistrar } from '../provisioning/runtime-registrar';
import { type NormalizedRequest } from '../normalization/request-normalizer';
import { requestNormalizer } from '../normalization/request-normalizer';
import { executionPlanner } from '../orchestration/execution-planner';
import { agentRouter } from '../orchestration/agent-router';
import { toolClientPool } from './mcp-client';

const logger = createLogger('runtime-manager');

export interface SubsystemHealth {
  name: string;
  healthy: boolean;
  detail?: string;
}

export interface RuntimeStatus {
  healthy: boolean;
  subsystems: SubsystemHealth[];
  installedTools: number;
  runningTools: number;
  schedulerStats: ReturnType<typeof scheduler.getStats>;
  timestamp: string;
}

export class RuntimeManager {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing runtime manager...');

    try {
      // Initialize registries
      const registries = registryManager.listRegistries();
      logger.info('Registries configured', { registries });

      // Policy engine is already initialized via its module
      logger.info('Policy engine ready', { policies: policyEngine.listPolicies().length });

      // Provider router is pre-configured
      logger.info('Provider router ready', { providers: providerRouter.listProviders().length });

      // Workflow engine is event-driven, no startup needed
      logger.info('Workflow engine ready');

      // Capability selector is stateless, ready
      logger.info('Capability selector ready');

      // Register a default hub agent in the agent router
      agentRouter.registerAgent({
        agentId: 'hub:default',
        capabilities: ['discover', 'install', 'execute', 'validate', 'approve', 'notify'],
        priority: 10,
        maxLoad: 50,
        currentLoad: 0,
      });
      logger.info('Agent router ready', { agents: agentRouter.listAgents().length });

      metrics.increment('runtime_initializations_total');
      this.initialized = true;
      logger.info('Runtime manager initialized successfully');
    } catch (err) {
      logger.error('Runtime manager initialization failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Runtime manager shutting down...');

    // Close all MCP client connections before stopping processes
    await toolClientPool.closeAll();

    // Stop all running tools
    const tools = runtimeRegistrar.list();
    for (const tool of tools) {
      if (tool.status === 'running') {
        try {
          runtimeRegistrar.stop(tool.tool.id);
          logger.info('Tool stopped during shutdown', { toolId: tool.tool.id });
        } catch (err) {
          logger.warn('Error stopping tool during shutdown', {
            toolId: tool.tool.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    metrics.increment('runtime_shutdowns_total');
    this.initialized = false;
    logger.info('Runtime manager shutdown complete');
  }

  getStatus(): RuntimeStatus {
    const tools = runtimeRegistrar.list();
    const subsystems: SubsystemHealth[] = [
      {
        name: 'installer',
        healthy: true,
        detail: `${tools.length} tools registered`,
      },
      {
        name: 'registry',
        healthy: registryManager.listRegistries().length > 0,
        detail: `${registryManager.listRegistries().length} registries`,
      },
      {
        name: 'policy-engine',
        healthy: true,
        detail: `${policyEngine.listPolicies().length} policies`,
      },
      {
        name: 'provider-router',
        healthy: providerRouter.listProviders().length > 0,
        detail: `${providerRouter.listProviders().length} providers`,
      },
      {
        name: 'workflow-engine',
        healthy: true,
        detail: `${workflowEngine.listWorkflows().length} workflows`,
      },
      {
        name: 'scheduler',
        healthy: true,
        detail: JSON.stringify(scheduler.getStats()),
      },
    ];

    const healthy = subsystems.every((s) => s.healthy);

    return {
      healthy,
      subsystems,
      installedTools: tools.length,
      runningTools: tools.filter((t) => t.status === 'running').length,
      schedulerStats: scheduler.getStats(),
      timestamp: new Date().toISOString(),
    };
  }

  async handleRequest(request: NormalizedRequest): Promise<unknown> {
    const start = Date.now();
    logger.debug('Handling request', { requestId: request.id, method: request.method });

    try {
      // Capability selection to find the best tool for this request
      const availableTools = runtimeRegistrar.list();
      const selected = capabilitySelector.select(request, availableTools);

      // Build execution context from the normalized request
      const toolId = (request.params['toolId'] as string | undefined)
        ?? selected?.tool.tool.id;
      const action = (request.params['action'] as string | undefined) ?? request.method;
      const params = request.params;
      const requiresApproval = (request.params['requiresApproval'] as boolean | undefined) ?? false;

      // Build and execute a full plan through the execution planner
      const result = await scheduler.schedule(async () => {
        const plan = await executionPlanner.plan(request.method, {
          toolId,
          action,
          params,
          actor: request.clientType,
          requiresApproval,
          query: request.params['query'],
        });

        const execResult = await executionPlanner.execute(plan);

        const latency = Date.now() - start;
        if (selected) {
          capabilitySelector.recordOutcome(selected.tool.tool.id, execResult.success, latency);
        }

        return requestNormalizer.denormalize(execResult, request.clientType);
      }, 5);

      metrics.histogram('request_handling_duration_ms', Date.now() - start);
      metrics.increment('requests_handled_total', { method: request.method, success: 'true' });

      return result;
    } catch (err) {
      const latency = Date.now() - start;
      metrics.histogram('request_handling_duration_ms', latency);
      metrics.increment('requests_handled_total', { method: request.method, success: 'false' });

      logger.warn('Request handling failed', {
        requestId: request.id,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export const runtimeManager = new RuntimeManager();
