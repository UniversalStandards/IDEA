import { WorkflowEngine } from '../src/orchestration/workflow-engine';
import { SpeculativeExecutor } from '../src/routing/SpeculativeExecutor';
import { ToolCache } from '../src/cache/ToolCache';

describe('WorkflowEngine speculation integration', () => {
  it('uses prefetched next-step result on speculation hit', async () => {
    const calls: string[] = [];
    const cache = new ToolCache(60_000);

    const actionExecutor = async (action: string, _params: Record<string, unknown>): Promise<unknown> => {
      calls.push(action);
      if (action === 'step-1') {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { done: 'step-1' };
      }
      if (action === 'step-2') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { done: 'step-2' };
      }
      return { done: action };
    };

    const speculation = new SpeculativeExecutor({
      enabled: true,
      cache,
      predictor: async (context) => context.nextActions,
      executor: async (action, params) => actionExecutor(action, params),
      isPrefetchable: () => true,
    });

    const engine = new WorkflowEngine({
      speculativeExecutor: speculation,
      actionExecutor,
    });

    engine.registerWorkflow({
      id: 'wf-spec',
      name: 'Speculation workflow',
      enabled: true,
      trigger: { type: 'manual', config: {} },
      steps: [
        { id: 's1', name: 'step 1', action: 'step-1' },
        { id: 's2', name: 'step 2', action: 'step-2' },
      ],
    });

    const startedAt = Date.now();
    const run = await engine.trigger('wf-spec', {});
    const durationMs = Date.now() - startedAt;

    expect(run.success).toBe(true);
    expect(run.stepResults['s2']?.output).toEqual({ done: 'step-2' });
    expect(calls.filter((entry) => entry === 'step-2')).toHaveLength(1);
    expect(durationMs).toBeLessThan(100);
  });
});
