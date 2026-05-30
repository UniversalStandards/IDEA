import { CircuitBreaker } from '../src/routing/CircuitBreaker';
import { CostRouter } from '../src/routing/CostRouter';
import { HealthRouter } from '../src/routing/HealthRouter';
import { LatencyScorer } from '../src/routing/LatencyScorer';
import { LoadBalancer } from '../src/routing/LoadBalancer';
import { AIProvider, ProviderRouter } from '../src/routing/provider-router';

const provider = (id: string, models: string[]): AIProvider => ({
  id,
  name: id,
  baseUrl: 'http://localhost',
  models,
  maxTokens: 4096,
  capabilities: ['chat', 'completion', 'code'],
});

describe('fault-tolerant routing components', () => {
  it('CircuitBreaker opens after 5 failures and recovers via half-open probe', () => {
    let now = 0;
    const breaker = new CircuitBreaker(5, 30_000, () => now);

    for (let i = 0; i < 5; i++) {
      breaker.recordFailure('openai');
    }

    expect(breaker.getState('openai')).toBe('OPEN');
    expect(breaker.canRequest('openai')).toBe(false);

    now = 30_001;
    expect(breaker.canRequest('openai')).toBe(true);
    expect(breaker.canRequest('openai')).toBe(false);
    expect(breaker.getState('openai')).toBe('HALF_OPEN');

    breaker.recordSuccess('openai');
    expect(breaker.getState('openai')).toBe('CLOSED');
  });

  it('HealthRouter excludes providers above 10% error rate in 60s window', () => {
    let now = 0;
    const health = new HealthRouter(0.1, 60_000, () => now);

    for (let i = 0; i < 8; i++) health.recordOutcome('openai', true);
    for (let i = 0; i < 2; i++) health.recordOutcome('openai', false);

    expect(health.isHealthy('openai')).toBe(false);

    now = 61_000;
    expect(health.isHealthy('openai')).toBe(true);
  });

  it('CostRouter chooses cheapest tier that matches complexity', () => {
    const costRouter = new CostRouter();
    const providers = [
      provider('tier1', ['gpt-5-nano']),
      provider('tier2', ['claude-sonnet-4.6']),
      provider('tier3', ['gpt-4o']),
    ];

    expect(costRouter.rankProvidersByCost(providers, 'routine')[0]?.tier).toBe(1);
    expect(costRouter.rankProvidersByCost(providers, 'medium')[0]?.tier).toBe(2);
    expect(costRouter.rankProvidersByCost(providers, 'critical')[0]?.tier).toBe(3);
  });

  it('LatencyScorer updates EMA on each response and penalizes slower providers', () => {
    const scorer = new LatencyScorer(0.5);
    scorer.recordLatency('openai', 50);
    const first = scorer.getScore('openai');
    scorer.recordLatency('openai', 1000);
    scorer.recordLatency('openai', 1200);
    scorer.recordLatency('openai', 1500);
    const second = scorer.getScore('openai');

    expect(second.p95).toBeGreaterThanOrEqual(first.p95);
    expect(second.weightMultiplier).toBeLessThan(first.weightMultiplier);
  });

  it('LoadBalancer WRR distributes near target weights under sustained load', () => {
    const balancer = new LoadBalancer();
    const providers = [provider('a', ['gpt-5-nano']), provider('b', ['gpt-5-nano'])];
    balancer.setWeight('a', 1);
    balancer.setWeight('b', 3);

    const picks: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i++) {
      const selected = balancer.selectProvider(providers, { strategy: 'wrr' });
      if (selected) {
        const current = picks[selected.id] ?? 0;
        picks[selected.id] = current + 1;
      }
    }

    const aRatio = (picks['a'] ?? 0) / 4000;
    const bRatio = (picks['b'] ?? 0) / 4000;

    expect(Math.abs(aRatio - 0.25)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(bRatio - 0.75)).toBeLessThanOrEqual(0.05);
  });

  it('ProviderRouter composes all components and keeps routine tasks in tier 1 majority', () => {
    const router = new ProviderRouter();
    router.registerProvider(provider('openai', ['gpt-5-nano', 'gpt-4o']));
    router.registerProvider(provider('anthropic', ['claude-sonnet-4.6', 'claude-opus-4.6']));
    router.registerProvider(provider('ollama', ['deepseek-v3']));

    let tier1Count = 0;
    let totalOverheadMs = 0;

    for (let i = 0; i < 200; i++) {
      const decision = router.routeDecision({ capability: 'chat', complexity: 'routine' });
      expect(decision).not.toBeNull();
      if (!decision) continue;
      if (decision.tier === 1) tier1Count += 1;
      totalOverheadMs += decision.overheadMs;
      router.completeRoute(decision.provider.id, true, 50);
    }

    expect(tier1Count / 200).toBeGreaterThan(0.7);
    expect(totalOverheadMs / 200).toBeLessThan(2);
  });
});
