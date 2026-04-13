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
});
