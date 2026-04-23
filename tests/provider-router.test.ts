/**
 * tests/provider-router.test.ts
 * Unit tests for src/routing/provider-router.ts
 * Covers: circuit breaker state machine, background health polling,
 *         fallback chain, and routing metrics.
 */

// ── Environment & mocks (must come before any imports) ───────────────────────

process.env['NODE_ENV'] = 'test';
process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';

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

// Config mock: set up routing chain  openai → anthropic → ollama
jest.mock('../src/config', () => ({
  config: {
    DEFAULT_AI_PROVIDER: 'openai',
    FALLBACK_AI_PROVIDER: 'anthropic',
    LOCAL_MODEL_PROVIDER: 'ollama',
  },
}));

// Prevent real HTTP calls
jest.mock('axios');

import axios from 'axios';
import { ProviderRouter, CircuitState, type AIProvider } from '../src/routing/provider-router';

const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider(id: string, capabilities: string[] = ['chat']): AIProvider {
  return {
    id,
    name: id,
    baseUrl: `http://${id}.example.com`,
    models: ['test-model'],
    maxTokens: 4096,
    capabilities,
  };
}

function openCircuit(router: ProviderRouter, providerId: string, failures = 5): void {
  for (let i = 0; i < failures; i++) {
    router.recordFailure(providerId);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProviderRouter — routing', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = new ProviderRouter();
    // Replace built-in providers with test doubles
    const openai = makeProvider('openai', ['chat', 'code']);
    const anthropic = makeProvider('anthropic', ['chat', 'code']);
    const ollama = makeProvider('ollama', ['chat', 'code', 'local']);
    router.registerProvider(openai);
    router.registerProvider(anthropic);
    router.registerProvider(ollama);
  });

  it('routes to the primary provider by default', () => {
    const result = router.route({ capability: 'chat' });
    expect(result?.id).toBe('openai');
  });

  it('routes to a preferred provider when specified', () => {
    const result = router.route({ capability: 'chat', preferredProvider: 'anthropic' });
    expect(result?.id).toBe('anthropic');
  });

  it('falls back to fallback provider when primary circuit is OPEN', () => {
    openCircuit(router, 'openai');
    expect(router.getCircuitState('openai')?.state).toBe(CircuitState.OPEN);

    const result = router.route({ capability: 'chat' });
    expect(result?.id).toBe('anthropic');
  });

  it('falls back to local provider when primary and fallback circuits are OPEN', () => {
    openCircuit(router, 'openai');
    openCircuit(router, 'anthropic');

    const result = router.route({ capability: 'chat' });
    expect(result?.id).toBe('ollama');
  });

  it('returns null when all providers in the chain have their circuits OPEN', () => {
    openCircuit(router, 'openai');
    openCircuit(router, 'anthropic');
    openCircuit(router, 'ollama');
    openCircuit(router, 'google'); // built-in provider still present; open its circuit too

    const result = router.route({ capability: 'chat' });
    expect(result).toBeNull();
  });

  it('returns null when no provider supports the requested capability', () => {
    const result = router.route({ capability: 'nonexistent-capability' });
    expect(result).toBeNull();
  });

  it('does not use fallback providers when fallback is explicitly false', () => {
    openCircuit(router, 'openai');
    const result = router.route({ capability: 'chat', fallback: false });
    expect(result).toBeNull();
  });
});

describe('ProviderRouter — circuit breaker', () => {
  let router: ProviderRouter;
  const providerId = 'openai';

  beforeEach(() => {
    router = new ProviderRouter();
    router.registerProvider(makeProvider(providerId, ['chat']));
  });

  it('starts in CLOSED state', () => {
    const cb = router.getCircuitState(providerId);
    expect(cb?.state).toBe(CircuitState.CLOSED);
    expect(cb?.consecutiveFailures).toBe(0);
  });

  it('stays CLOSED while failures are below threshold', () => {
    for (let i = 0; i < 4; i++) {
      router.recordFailure(providerId);
    }
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.CLOSED);
  });

  it('opens after reaching the failure threshold (5)', () => {
    openCircuit(router, providerId);
    const cb = router.getCircuitState(providerId);
    expect(cb?.state).toBe(CircuitState.OPEN);
    expect(cb?.openedAt).not.toBeNull();
  });

  it('resets consecutive failure count on success', () => {
    for (let i = 0; i < 3; i++) {
      router.recordFailure(providerId);
    }
    router.recordSuccess(providerId, 100);
    expect(router.getCircuitState(providerId)?.consecutiveFailures).toBe(0);
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.CLOSED);
  });

  it('transitions OPEN → HALF_OPEN after cooldown, then CLOSED on success', () => {
    jest.useFakeTimers();

    openCircuit(router, providerId);
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.OPEN);

    // Advance past the 60 s cooldown
    jest.advanceTimersByTime(61_000);

    // Next routing call should trigger the OPEN → HALF_OPEN transition
    router.registerProvider(makeProvider(providerId, ['chat']));
    const result = router.route({ capability: 'chat', preferredProvider: providerId, fallback: false });
    expect(result?.id).toBe(providerId);
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.HALF_OPEN);

    // Record success to close it
    router.recordSuccess(providerId, 50);
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.CLOSED);

    jest.useRealTimers();
  });

  it('reopens immediately from HALF_OPEN on failure', () => {
    jest.useFakeTimers();

    openCircuit(router, providerId);
    jest.advanceTimersByTime(61_000);

    // Trigger HALF_OPEN transition
    router.route({ capability: 'chat', preferredProvider: providerId, fallback: false });
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.HALF_OPEN);

    // Failure in HALF_OPEN → back to OPEN
    router.recordFailure(providerId);
    expect(router.getCircuitState(providerId)?.state).toBe(CircuitState.OPEN);

    jest.useRealTimers();
  });

  it('blocks requests while circuit is OPEN and cooldown has not elapsed', () => {
    jest.useFakeTimers();

    openCircuit(router, providerId);
    // No other providers available → should return null
    const result = router.route({ capability: 'chat', preferredProvider: providerId, fallback: false });
    expect(result).toBeNull();

    jest.useRealTimers();
  });
});

describe('ProviderRouter — routing metrics', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = new ProviderRouter();
    router.registerProvider(makeProvider('openai', ['chat']));
  });

  it('records request count and latency on success', () => {
    router.recordSuccess('openai', 150);
    router.recordSuccess('openai', 250);

    const pm = router.getProviderRoutingMetrics('openai');
    expect(pm?.requestCount).toBe(2);
    expect(pm?.failureCount).toBe(0);
    expect(pm?.latencies).toEqual([150, 250]);
  });

  it('records request count and failure count on failure', () => {
    router.recordFailure('openai');
    router.recordFailure('openai');

    const pm = router.getProviderRoutingMetrics('openai');
    expect(pm?.requestCount).toBe(2);
    expect(pm?.failureCount).toBe(2);
  });

  it('returns null percentiles when no latency data exists', () => {
    expect(router.getLatencyPercentiles('openai')).toBeNull();
  });

  it('computes correct p50/p95/p99 percentiles', () => {
    // Record 100 ordered latency samples: 1 ms … 100 ms
    for (let i = 1; i <= 100; i++) {
      router.recordSuccess('openai', i);
    }

    const p = router.getLatencyPercentiles('openai');
    expect(p).not.toBeNull();
    expect(p!.p50).toBe(50);
    expect(p!.p95).toBe(95);
    expect(p!.p99).toBe(99);
  });

  it('returns null percentiles for unknown provider', () => {
    expect(router.getLatencyPercentiles('unknown-provider')).toBeNull();
  });
});

describe('ProviderRouter — background health polling', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    jest.useFakeTimers();
    mockedAxios.get.mockResolvedValue({ status: 200 });
    router = new ProviderRouter();
  });

  afterEach(() => {
    router.shutdown();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('starts the polling interval on initialize()', () => {
    router.initialize();
    // Trigger one poll cycle
    jest.advanceTimersByTime(60_000);
    // Should have attempted health checks for all built-in providers
    expect(mockedAxios.get).toHaveBeenCalled();
  });

  it('does not start a second interval when initialize() is called twice', () => {
    router.initialize();
    router.initialize();
    jest.advanceTimersByTime(60_000);
    // Number of calls should equal the number of built-in providers (4), not 8
    const callCount = mockedAxios.get.mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it('stops polling after shutdown()', () => {
    router.initialize();
    router.shutdown();
    jest.advanceTimersByTime(120_000);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('shutdown() is idempotent', () => {
    router.initialize();
    router.shutdown();
    expect(() => router.shutdown()).not.toThrow();
  });
});

describe('ProviderRouter — checkHealth', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    jest.clearAllMocks();
    router = new ProviderRouter();
    router.registerProvider(makeProvider('openai', ['chat']));
  });

  it('returns true and caches healthy state on successful HTTP call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200 });
    const result = await router.checkHealth('openai');
    expect(result).toBe(true);
  });

  it('returns false and caches unhealthy state on HTTP error', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));
    const result = await router.checkHealth('openai');
    expect(result).toBe(false);
  });

  it('returns false for an unknown provider id', async () => {
    const result = await router.checkHealth('nonexistent');
    expect(result).toBe(false);
  });
});
