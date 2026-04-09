import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const logger = createLogger('agent-router');

export interface AgentCapability {
  agentId: string;
  capabilities: string[];
  priority: number;
  maxLoad: number;
  currentLoad: number;
}

export class AgentRouter {
  private readonly agents = new Map<string, AgentCapability>();
  private readonly taskHandlers = new Map<
    string,
    (task: Record<string, unknown>) => Promise<unknown>
  >();

  registerAgent(agent: AgentCapability): void {
    this.agents.set(agent.agentId, { ...agent });
    logger.info('Agent registered', {
      agentId: agent.agentId,
      capabilities: agent.capabilities,
      maxLoad: agent.maxLoad,
    });
    metrics.increment('agents_registered_total');
  }

  registerHandler(
    agentId: string,
    handler: (task: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.taskHandlers.set(agentId, handler);
  }

  route(capability: string): AgentCapability | null {
    const candidates = Array.from(this.agents.values()).filter(
      (a) =>
        a.capabilities.includes(capability) &&
        a.currentLoad < a.maxLoad,
    );

    if (candidates.length === 0) {
      logger.warn('No available agent for capability', { capability });
      return null;
    }

    // Sort by: highest priority first, then lowest load ratio
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const aRatio = a.currentLoad / Math.max(a.maxLoad, 1);
      const bRatio = b.currentLoad / Math.max(b.maxLoad, 1);
      return aRatio - bRatio;
    });

    const selected = candidates[0]!;
    logger.debug('Agent routed', {
      capability,
      agentId: selected.agentId,
      load: `${selected.currentLoad}/${selected.maxLoad}`,
    });
    metrics.increment('agent_routes_total', { capability, agentId: selected.agentId });
    return selected;
  }

  async delegate(
    agentId: string,
    task: Record<string, unknown>,
  ): Promise<unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const handler = this.taskHandlers.get(agentId);
    this.updateLoad(agentId, 1);

    const taskId = randomUUID();
    logger.debug('Delegating task to agent', { agentId, taskId });
    metrics.increment('agent_delegations_total', { agentId });

    try {
      let result: unknown;
      if (handler) {
        result = await handler(task);
      } else {
        // No handler registered — simulate execution
        result = {
          taskId,
          agentId,
          status: 'completed',
          output: { handled: false, task },
        };
      }
      metrics.increment('agent_delegations_completed_total', { agentId, success: 'true' });
      return result;
    } catch (err) {
      metrics.increment('agent_delegations_completed_total', { agentId, success: 'false' });
      throw err;
    } finally {
      this.updateLoad(agentId, -1);
    }
  }

  async fanOut(
    tasks: Array<{ capability: string; task: Record<string, unknown> }>,
  ): Promise<unknown[]> {
    logger.debug('Fan-out delegation', { taskCount: tasks.length });

    const delegations = tasks.map(({ capability, task }) => {
      const agent = this.route(capability);
      if (!agent) {
        return Promise.reject(new Error(`No agent available for capability: ${capability}`));
      }
      return this.delegate(agent.agentId, task);
    });

    const results = await Promise.allSettled(delegations);
    return results.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      return { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    });
  }

  updateLoad(agentId: string, delta: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.currentLoad = Math.max(0, agent.currentLoad + delta);
    metrics.gauge('agent_current_load', agent.currentLoad, { agentId });
    logger.debug('Agent load updated', { agentId, currentLoad: agent.currentLoad });
  }

  listAgents(): AgentCapability[] {
    return Array.from(this.agents.values());
  }
}

export const agentRouter = new AgentRouter();
