/**
 * tests/provider-router.test.ts
 * Unit tests for src/routing/provider-router.ts
 */

jest.mock('../src/config', () => ({
  config: {
    DEFAULT_AI_PROVIDER: 'primary',
    FALLBACK_AI_PROVIDER: 'fallback',
    LOCAL_MODEL_PROVIDER: 'local-model',
  },
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: {
    increment: jest.fn(),
    histogram: jest.fn(),
    gauge: jest.fn(),
  },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue({ status: 200 }),
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
  },
}));

import { ProviderRouter } from '../src/routing/provider-router';
import type { AIProvider } from '../src/routing/provider-router';

function makeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    id: 'primary',
    name: 'Primary Provider',
    baseUrl: 'http://primary.example.com',
    models: ['model-1'],
    maxTokens: 4096,
    capabilities: ['chat', 'completion'],
    ...overrides,
  };
}

describe('ProviderRouter', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = new ProviderRouter();
    router.stopHealthChecks();
    // Clear builtin providers so only our test providers are present
    (router as unknown as { providers: Map<string, AIProvider> }).providers.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('routes to primary provider by default when it supports the requested capability', () => {
    const primary = makeProvider({ id: 'primary', capabilities: ['chat'] });
    router.registerProvider(primary);

    const result = router.route({ capability: 'chat' });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('primary');
  });

  it('falls back to fallback provider when primary does not support the capability', () => {
    const primary = makeProvider({
      id: 'primary',
      capabilities: ['completion'],
    });
    const fallback = makeProvider({
      id: 'fallback',
      name: 'Fallback Provider',
      baseUrl: 'http://fallback.example.com',
      capabilities: ['rare-feature'],
    });
    router.registerProvider(primary);
    router.registerProvider(fallback);

    const result = router.route({ capability: 'rare-feature' });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('fallback');
  });

  it('circuit breaker opens after N consecutive failures and skips the provider', () => {
    const primary = makeProvider({ id: 'primary', capabilities: ['chat'] });
    router.registerProvider(primary);

    // CIRCUIT_OPEN_THRESHOLD is 5; record that many failures
    for (let i = 0; i < 5; i++) {
      router.recordFailure('primary');
    }

    const result = router.route({ capability: 'chat' });

    // Circuit is open — primary should be skipped; no other provider has 'chat'
    expect(result).toBeNull();
  });

  it('circuit breaker allows a request again after the cooldown period elapses', () => {
    const primary = makeProvider({ id: 'primary', capabilities: ['chat'] });
    router.registerProvider(primary);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      router.recordFailure('primary');
    }

    // Advance clock past the 60 s cooldown
    nowSpy.mockReturnValue(1_000 + 60_001);

    const result = router.route({ capability: 'chat' });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('primary');

    nowSpy.mockRestore();
  });

  it('getLatencyStats returns correct percentiles after recording samples', () => {
    // No samples yet
    const empty = router.getLatencyStats('primary');
    expect(empty.count).toBe(0);
    expect(empty.p50).toBe(0);

    // Record 4 samples: 10, 20, 30, 100
    [10, 20, 30, 100].forEach((ms) => router.recordLatency('primary', ms));

    const stats = router.getLatencyStats('primary');
    expect(stats.count).toBe(4);
    // Sorted: [10, 20, 30, 100]
    // p50 = index floor(0.5 * 3) = 1 → 20
    expect(stats.p50).toBe(20);
    // p95 = index floor(0.95 * 3) = 2 → 30
    expect(stats.p95).toBe(30);
    // p99 = index floor(0.99 * 3) = 2 → 30
    expect(stats.p99).toBe(30);
  });

  it('returns null when no provider supports the requested capability', () => {
    router.registerProvider(makeProvider({ id: 'primary', capabilities: ['completion'] }));
    const result = router.route({ capability: 'vision' });
    expect(result).toBeNull();
  });

  it('uses preferred provider when it supports the capability', () => {
    const primary = makeProvider({ id: 'primary', capabilities: ['chat'] });
    const preferred = makeProvider({
      id: 'preferred',
      name: 'Preferred',
      baseUrl: 'http://preferred.example.com',
      capabilities: ['chat'],
    });
    router.registerProvider(primary);
    router.registerProvider(preferred);

    const result = router.route({ capability: 'chat', preferredProvider: 'preferred' });
    expect(result?.id).toBe('preferred');
  });

  it('fallback=false excludes fallback chain providers from the priority chain', () => {
    // With fallback=false, the explicit chain only has [primary].
    // 'primary' supports 'completion' but not 'vision', so the chain loop finds nothing.
    // However, the last-resort scan over ALL providers still runs and can find 'fallback'.
    const primary = makeProvider({ id: 'primary', capabilities: ['completion'] });
    const fallback = makeProvider({
      id: 'fallback',
      name: 'Fallback',
      baseUrl: 'http://fallback.example.com',
      capabilities: ['vision'],
    });
    router.registerProvider(primary);
    router.registerProvider(fallback);

    // Last-resort scan finds 'fallback' since its circuit is closed
    const result = router.route({ capability: 'vision', fallback: false });
    expect(result?.id).toBe('fallback');
  });

  it('falls back to any matching provider when all chain providers have open circuits', () => {
    const main = makeProvider({ id: 'primary', capabilities: ['chat'] });
    const spare = makeProvider({
      id: 'spare',
      name: 'Spare',
      baseUrl: 'http://spare.example.com',
      capabilities: ['chat'],
    });
    router.registerProvider(main);
    router.registerProvider(spare);

    // Open circuit for primary
    for (let i = 0; i < 5; i++) router.recordFailure('primary');

    // 'primary' is circuit-open; route should fall back to 'spare'
    const result = router.route({ capability: 'chat' });
    expect(result?.id).toBe('spare');
  });

  it('unhealthy health cache entry in chain causes last-resort lookup', () => {
    // The chain-based lookup checks health cache; the last-resort scan does NOT.
    // So a provider with unhealthy health cache IS still reachable via last-resort.
    const primary = makeProvider({ id: 'primary', capabilities: ['chat'] });
    router.registerProvider(primary);

    // Manually inject an unhealthy cache entry that is still within TTL
    const healthCache = (router as unknown as { healthCache: Map<string, { healthy: boolean; checkedAt: number }> }).healthCache;
    healthCache.set('primary', { healthy: false, checkedAt: Date.now() });

    // The chain skips primary (unhealthy), but last-resort still finds it
    const result = router.route({ capability: 'chat' });
    // primary is found via last-resort (which doesn't check health cache)
    expect(result?.id).toBe('primary');
  });

  it('ignores stale health cache entry (beyond TTL)', () => {
    const primary = makeProvider({ id: 'primary', capabilities: ['chat'] });
    router.registerProvider(primary);

    const healthCache = (router as unknown as { healthCache: Map<string, { healthy: boolean; checkedAt: number }> }).healthCache;
    // Set unhealthy but with old timestamp (> 30s TTL)
    healthCache.set('primary', { healthy: false, checkedAt: Date.now() - 31_000 });

    const result = router.route({ capability: 'chat' });
    expect(result?.id).toBe('primary');
  });

  it('getProviderMetrics returns zero counts for new provider', () => {
    router.registerProvider(makeProvider({ id: 'primary' }));
    const m = router.getProviderMetrics('primary');
    expect(m.requestCount).toBe(0);
    expect(m.failureCount).toBe(0);
  });

  it('getProviderMetrics reflects recorded successes and failures', () => {
    router.registerProvider(makeProvider({ id: 'primary' }));
    router.recordSuccess('primary');
    router.recordSuccess('primary');
    router.recordFailure('primary');
    const m = router.getProviderMetrics('primary');
    expect(m.requestCount).toBe(2);
    expect(m.failureCount).toBe(1);
  });

  it('recordSuccess on a half-open circuit closes it', () => {
    router.registerProvider(makeProvider({ id: 'primary' }));

    const cb = (router as unknown as { getCircuitBreaker: (id: string) => { status: string; failureCount: number } }).getCircuitBreaker('primary');
    cb.status = 'half-open';
    cb.failureCount = 3;

    router.recordSuccess('primary');
    expect(cb.status).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });

  it('recordFailure on a half-open circuit immediately re-opens it', () => {
    router.registerProvider(makeProvider({ id: 'primary' }));
    const cb = (router as unknown as { getCircuitBreaker: (id: string) => { status: string; failureCount: number } }).getCircuitBreaker('primary');
    cb.status = 'half-open';
    cb.failureCount = 1;

    router.recordFailure('primary');
    expect(cb.status).toBe('open');
  });

  it('latency samples are capped at LATENCY_MAX_SAMPLES (100)', () => {
    // Insert 110 samples
    for (let i = 0; i < 110; i++) router.recordLatency('primary', i);
    const stats = router.getLatencyStats('primary');
    expect(stats.count).toBe(100);
  });

  it('listProviders returns all registered providers', () => {
    router.registerProvider(makeProvider({ id: 'primary' }));
    router.registerProvider(makeProvider({ id: 'secondary', name: 'Secondary', baseUrl: 'http://sec.example.com' }));
    const list = router.listProviders();
    const ids = list.map((p) => p.id);
    expect(ids).toContain('primary');
    expect(ids).toContain('secondary');
  });

  it('getProvider returns the provider by ID', () => {
    const p = makeProvider({ id: 'primary' });
    router.registerProvider(p);
    expect(router.getProvider('primary')?.name).toBe('Primary Provider');
    expect(router.getProvider('nonexistent')).toBeUndefined();
  });

  it('checkHealth returns true when axios resolves', async () => {
    const axios = require('axios') as { default: { get: jest.Mock } };
    axios.default.get.mockResolvedValueOnce({ status: 200 });
    router.registerProvider(makeProvider({ id: 'primary', baseUrl: 'http://primary.example.com' }));
    const healthy = await router.checkHealth('primary');
    expect(healthy).toBe(true);
  });

  it('checkHealth returns false when axios rejects', async () => {
    const axios = require('axios') as { default: { get: jest.Mock } };
    axios.default.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    router.registerProvider(makeProvider({ id: 'primary', baseUrl: 'http://primary.example.com' }));
    const healthy = await router.checkHealth('primary');
    expect(healthy).toBe(false);
  });

  it('checkHealth returns false for unknown provider', async () => {
    const healthy = await router.checkHealth('nonexistent-provider');
    expect(healthy).toBe(false);
  });

  it('stopHealthChecks is a no-op when not started', () => {
    expect(() => router.stopHealthChecks()).not.toThrow();
  });
});
