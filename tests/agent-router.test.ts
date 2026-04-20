/**
 * Tests for AgentRouter.
 */
import { AgentRouter } from '../src/orchestration/agent-router';
import type { AgentCapability } from '../src/orchestration/agent-router';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), gauge: jest.fn(), histogram: jest.fn() },
}));

function makeAgent(overrides: Partial<AgentCapability> = {}): AgentCapability {
  return {
    agentId: 'agent-1',
    capabilities: ['cap-a'],
    priority: 1,
    maxLoad: 5,
    currentLoad: 0,
    ...overrides,
  };
}

describe('AgentRouter', () => {
  let router: AgentRouter;

  beforeEach(() => {
    router = new AgentRouter();
  });

  // ── registerAgent / listAgents ──────────────────────────────────────────────

  describe('registerAgent / listAgents', () => {
    it('stores an agent; listAgents returns it', () => {
      router.registerAgent(makeAgent());
      const agents = router.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]!.agentId).toBe('agent-1');
    });

    it('overwrites an existing agent when registered again', () => {
      router.registerAgent(makeAgent({ priority: 1 }));
      router.registerAgent(makeAgent({ priority: 99 }));
      const agents = router.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]!.priority).toBe(99);
    });
  });

  // ── route ───────────────────────────────────────────────────────────────────

  describe('route', () => {
    it('returns null when no agents are registered', () => {
      expect(router.route('cap-a')).toBeNull();
    });

    it('returns null when all agents are at maxLoad', () => {
      router.registerAgent(makeAgent({ currentLoad: 5, maxLoad: 5 }));
      expect(router.route('cap-a')).toBeNull();
    });

    it('returns null when no agent has the requested capability', () => {
      router.registerAgent(makeAgent({ capabilities: ['cap-b'] }));
      expect(router.route('cap-a')).toBeNull();
    });

    it('selects the highest priority agent', () => {
      router.registerAgent(makeAgent({ agentId: 'low', priority: 1, capabilities: ['cap-a'] }));
      router.registerAgent(makeAgent({ agentId: 'high', priority: 10, capabilities: ['cap-a'] }));
      expect(router.route('cap-a')!.agentId).toBe('high');
    });

    it('among equal priority agents picks the one with the lowest load ratio', () => {
      router.registerAgent(makeAgent({ agentId: 'busy', priority: 5, currentLoad: 4, maxLoad: 5 }));
      router.registerAgent(makeAgent({ agentId: 'idle', priority: 5, currentLoad: 0, maxLoad: 5 }));
      expect(router.route('cap-a')!.agentId).toBe('idle');
    });
  });

  // ── registerHandler / delegate ──────────────────────────────────────────────

  describe('registerHandler / delegate', () => {
    it('invokes the registered handler with the task', async () => {
      router.registerAgent(makeAgent());
      const handler = jest.fn().mockResolvedValue({ done: true });
      router.registerHandler('agent-1', handler);
      const result = await router.delegate('agent-1', { x: 1 });
      expect(handler).toHaveBeenCalledWith({ x: 1 });
      expect(result).toEqual({ done: true });
    });

    it('throws for an unknown agentId', async () => {
      await expect(router.delegate('no-such-agent', {})).rejects.toThrow(
        'Agent not found: no-such-agent',
      );
    });

    it('returns a default result object when no handler is registered', async () => {
      router.registerAgent(makeAgent());
      const result = (await router.delegate('agent-1', { foo: 'bar' })) as Record<string, unknown>;
      expect(result).toMatchObject({ agentId: 'agent-1', status: 'completed' });
      expect((result['output'] as Record<string, unknown>)['handled']).toBe(false);
    });

    it('increments currentLoad during task execution and restores it after', async () => {
      router.registerAgent(makeAgent({ currentLoad: 0 }));
      let loadDuringTask = -1;
      router.registerHandler('agent-1', async () => {
        loadDuringTask = router.listAgents()[0]!.currentLoad;
        return null;
      });
      await router.delegate('agent-1', {});
      expect(loadDuringTask).toBe(1);
      expect(router.listAgents()[0]!.currentLoad).toBe(0);
    });

    it('re-throws errors from the handler and restores load', async () => {
      router.registerAgent(makeAgent({ currentLoad: 0 }));
      router.registerHandler('agent-1', async () => {
        throw new Error('handler error');
      });
      await expect(router.delegate('agent-1', {})).rejects.toThrow('handler error');
      expect(router.listAgents()[0]!.currentLoad).toBe(0);
    });
  });

  // ── fanOut ──────────────────────────────────────────────────────────────────

  describe('fanOut', () => {
    it('dispatches two tasks to routed agents and returns their results', async () => {
      router.registerAgent(makeAgent({ agentId: 'a1', capabilities: ['cap-a'] }));
      router.registerAgent(makeAgent({ agentId: 'a2', capabilities: ['cap-b'] }));
      router.registerHandler('a1', async () => 'result-a');
      router.registerHandler('a2', async () => 'result-b');
      const results = await router.fanOut([
        { capability: 'cap-a', task: {} },
        { capability: 'cap-b', task: {} },
      ]);
      expect(results).toHaveLength(2);
      expect(results).toContain('result-a');
      expect(results).toContain('result-b');
    });

    it('returns error objects for unroutable capabilities', async () => {
      const results = await router.fanOut([{ capability: 'unknown-cap', task: {} }]);
      expect(results).toHaveLength(1);
      expect((results[0] as Record<string, unknown>)['error']).toMatch(
        'No agent available for capability: unknown-cap',
      );
    });

    it('handles an empty task list', async () => {
      const results = await router.fanOut([]);
      expect(results).toEqual([]);
    });
  });

  // ── updateLoad ──────────────────────────────────────────────────────────────

  describe('updateLoad', () => {
    it('clamps currentLoad at 0 for a negative delta', () => {
      router.registerAgent(makeAgent({ currentLoad: 0 }));
      router.updateLoad('agent-1', -5);
      expect(router.listAgents()[0]!.currentLoad).toBe(0);
    });

    it('increments currentLoad by positive delta', () => {
      router.registerAgent(makeAgent({ currentLoad: 2 }));
      router.updateLoad('agent-1', 3);
      expect(router.listAgents()[0]!.currentLoad).toBe(5);
    });

    it('is a no-op for an unknown agentId', () => {
      expect(() => router.updateLoad('no-such-agent', 1)).not.toThrow();
    });
  });
});
