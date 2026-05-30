import { SpeculativeExecutor } from '../src/routing/SpeculativeExecutor';
import { ToolCache } from '../src/cache/ToolCache';
import { metrics } from '../src/observability/metrics';

describe('SpeculativeExecutor', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('returns prefetched result on hit and updates metrics', async () => {
    const cache = new ToolCache(60_000);
    const executor = new SpeculativeExecutor({
      enabled: true,
      cache,
      predictor: async (context) => context.nextActions,
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true };
      },
      isPrefetchable: () => true,
      latencyValuePerMsUsd: 0.0001,
      prefetchCallCostUsd: 0.00001,
      tier1PredictionCostUsd: 0.00001,
    });

    const session = await executor.start({
      workflowId: 'wf-1',
      stepId: 's1',
      action: 'initial',
      params: {},
      nextActions: [
        { stepId: 's2', action: 'next', params: {}, confidence: 0.8 },
        { stepId: 's3', action: 'fallback', params: {}, confidence: 0.2 },
      ],
    });

    expect(session).not.toBeNull();
    const consumed = await executor.consume(
      { action: 'next', params: {} },
      session?.predicted ?? [],
    );

    expect(consumed.outcome).toBe('hit');
    expect(consumed.cached?.result).toEqual({ ok: true });

    const snapshot = metrics.getSnapshot();
    const hitRate = snapshot.gauges.find((entry) => entry.name === 'speculation.hit_rate');
    expect(hitRate?.value).toBe(100);
    const latencySaved = snapshot.histograms.find((entry) => entry.name === 'speculation.latency_saved_ms');
    expect(latencySaved?.count).toBe(1);
  });

  it('records miss and discards incorrect speculative results', async () => {
    const cache = new ToolCache(60_000);
    const executor = new SpeculativeExecutor({
      enabled: true,
      cache,
      predictor: async () => [{ action: 'wrong', params: {}, confidence: 1 }],
      executor: async () => ({ prefetched: true }),
      isPrefetchable: () => true,
    });

    const session = await executor.start({
      workflowId: 'wf-1',
      stepId: 's1',
      action: 'initial',
      params: {},
      nextActions: [{ action: 'wrong', params: {}, confidence: 1 }],
    });

    expect(session).not.toBeNull();
    const consumed = await executor.consume(
      { action: 'actual', params: {} },
      session?.predicted ?? [],
    );

    expect(consumed.outcome).toBe('miss');
    expect(cache.get('wrong', {})).toBeUndefined();

    const snapshot = metrics.getSnapshot();
    const wasted = snapshot.counters.find((entry) => entry.name === 'speculation.wasted_calls');
    expect(wasted?.value).toBe(1);
  });

  it('is a no-op when disabled', async () => {
    const predictor = jest.fn(async () => [{ action: 'next', params: {}, confidence: 1 }]);
    const executor = new SpeculativeExecutor({
      enabled: false,
      predictor,
      executor: async () => ({ ok: true }),
    });

    const session = await executor.start({
      workflowId: 'wf-1',
      stepId: 's1',
      action: 'initial',
      params: {},
      nextActions: [{ action: 'next', params: {}, confidence: 1 }],
    });

    expect(session).toBeNull();
    expect(predictor).not.toHaveBeenCalled();
  });
});
