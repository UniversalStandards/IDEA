import { ProviderRouter } from '../src/routing/provider-router';
import { CircuitBreakerState } from '../src/types/index';

describe('ProviderRouter', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = new ProviderRouter();
  });

  afterEach(() => {
    router.stopHealthChecks();
  });

  it('routes to a provider that supports the requested capability', () => {
    const provider = router.route({ capability: 'chat' });
    expect(provider).not.toBeNull();
    expect(provider?.capabilities).toContain('chat');
  });

  it('falls back through the chain when the preferred provider does not exist', () => {
    const provider = router.route({ capability: 'chat', preferredProvider: 'nonexistent-provider' });
    expect(provider).not.toBeNull();
  });

  it('returns null when no provider supports the requested capability', () => {
    const provider = router.route({ capability: 'this-capability-does-not-exist' });
    expect(provider).toBeNull();
  });

  it('circuit breaker opens after enough consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      router.reportOutcome('openai', false, 100);
    }
    expect(router.getCircuitState('openai')).toBe(CircuitBreakerState.OPEN);
  });

  it('an open circuit breaker makes the provider unroutable as preferred/default/fallback', () => {
    for (let i = 0; i < 5; i++) {
      router.reportOutcome('openai', false, 100);
    }
    const provider = router.route({ capability: 'chat', preferredProvider: 'openai' });
    // openai is open; router should have skipped it in favor of another chat-capable provider
    expect(provider?.id).not.toBe('openai');
  });

  it('a successful outcome resets the consecutive failure counter', () => {
    router.reportOutcome('openai', false, 100);
    router.reportOutcome('openai', false, 100);
    router.reportOutcome('openai', true, 100);
    router.reportOutcome('openai', false, 100);
    router.reportOutcome('openai', false, 100);
    expect(router.getCircuitState('openai')).toBe(CircuitBreakerState.CLOSED);
  });

  it('getMetrics reports request/failure counts and latency percentiles', () => {
    router.reportOutcome('openai', true, 100);
    router.reportOutcome('openai', true, 200);
    router.reportOutcome('openai', false, 300);

    const m = router.getMetrics('openai');
    expect(m.requestCount).toBe(3);
    expect(m.failureCount).toBe(1);
    expect(m.p50).toBeGreaterThan(0);
  });

  it('registerProvider adds a new provider with a closed circuit breaker', () => {
    router.registerProvider({
      id: 'custom',
      name: 'Custom Provider',
      baseUrl: 'https://example.test',
      models: ['custom-model'],
      maxTokens: 4096,
      capabilities: ['chat'],
    });
    expect(router.getProvider('custom')).toBeDefined();
    expect(router.getCircuitState('custom')).toBe(CircuitBreakerState.CLOSED);
  });

  it('startHealthChecks / stopHealthChecks are idempotent and do not throw', () => {
    router.startHealthChecks(10_000);
    router.startHealthChecks(10_000);
    router.stopHealthChecks();
    router.stopHealthChecks();
  });

  it('listProviders returns all built-in providers', () => {
    expect(router.listProviders().length).toBeGreaterThanOrEqual(4);
  });
});
