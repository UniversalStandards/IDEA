/**
 * tests/provider-router.test.ts
 * Unit tests for src/routing/provider-router.ts
 *
 * Covers:
 *  - routes to primary provider by default
 *  - falls back to fallback provider on primary failure (circuit OPEN)
 *  - circuit breaker opens after N consecutive failures
 *  - circuit breaker transitions to HALF_OPEN after cooldown
 *  - circuit breaker closes after a successful probe in HALF_OPEN state
 *  - circuit breaker re-opens when probe fails in HALF_OPEN state
 *  - recordSuccess resets failure count in CLOSED state
 *  - last-resort fallback when priority chain is exhausted
 *  - getCircuitBreakerStates() reflects current state of all providers
 *  - checkHealth() records success and failure into the circuit breaker
 */

process.env['NODE_ENV'] = 'test';
process.env['DEFAULT_AI_PROVIDER'] = 'openai';
process.env['FALLBACK_AI_PROVIDER'] = 'anthropic';
process.env['LOCAL_MODEL_PROVIDER'] = 'ollama';

// ─── Mocks must be declared before any imports ───────────────────────────────

jest.mock('axios');
jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Allow metrics to run in-memory; no need to mock.

// ─── Imports ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import { ProviderRouter } from '../src/routing/provider-router';
import { CircuitBreakerState } from '../src/types/index';

const mockedAxios = axios as jest.Mocked<typeof axios>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a router with health checks disabled and a configurable failure threshold. */
function makeRouter(opts: {
  failureThreshold?: number;
  cooldownMs?: number;
} = {}): ProviderRouter {
  return new ProviderRouter({
    autoStartHealthChecks: false,
    failureThreshold: opts.failureThreshold ?? 5,
    cooldownMs: opts.cooldownMs ?? 60_000,
    healthCheckIntervalMs: 60_000,
  });
}

/** Open the circuit for a provider by recording N consecutive failures. */
function openCircuit(router: ProviderRouter, providerId: string, threshold = 5): void {
  for (let i = 0; i < threshold; i++) {
    router.recordFailure(providerId);
  }
}

/** Advance cb.openedAt so the cooldown appears elapsed. */
function advancePastCooldown(router: ProviderRouter, providerId: string): void {
  const cb = router['_getCircuitBreaker'](providerId);
  if (cb) {
    // Backdate openedAt so that (Date.now() - openedAt) >= cooldownMs
    cb.openedAt = Date.now() - 61_000;
  }
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('ProviderRouter — routing', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = makeRouter();
  });

  afterEach(() => {
    router.stop();
  });

  it('routes to the primary provider (openai) by default', () => {
    const provider = router.route({ capability: 'chat' });
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('openai');
  });

  it('falls back to the fallback provider (anthropic) when primary circuit is OPEN', () => {
    openCircuit(router, 'openai');
    const provider = router.route({ capability: 'chat' });
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('anthropic');
  });

  it('uses the preferred provider when specified and its circuit is CLOSED', () => {
    const provider = router.route({ capability: 'chat', preferredProvider: 'anthropic' });
    expect(provider?.id).toBe('anthropic');
  });

  it('skips the preferred provider when its circuit is OPEN and falls back to default', () => {
    openCircuit(router, 'anthropic');
    const provider = router.route({ capability: 'chat', preferredProvider: 'anthropic' });
    expect(provider).not.toBeNull();
    // openai (default) should be selected instead
    expect(provider?.id).toBe('openai');
  });

  it('falls back to any available provider when the full priority chain is open', () => {
    openCircuit(router, 'openai');
    openCircuit(router, 'anthropic');
    // ollama (LOCAL) supports 'local' capability
    const provider = router.route({ capability: 'local' });
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('ollama');
  });

  it('returns null when no provider supports the requested capability', () => {
    const provider = router.route({ capability: 'nonexistent-capability' });
    expect(provider).toBeNull();
  });

  it('returns null when all supporting providers have OPEN circuits', () => {
    // 'embedding' is only supported by openai and google
    openCircuit(router, 'openai');
    openCircuit(router, 'google');
    const provider = router.route({ capability: 'embedding' });
    expect(provider).toBeNull();
  });

  it('does not include fallback providers when fallback is false', () => {
    openCircuit(router, 'openai');
    // With fallback:false, only openai (OPEN) and no fallback chain
    const provider = router.route({ capability: 'chat', fallback: false });
    expect(provider).toBeNull();
  });
});

describe('ProviderRouter — circuit breaker state machine', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = makeRouter({ failureThreshold: 3 });
  });

  afterEach(() => {
    router.stop();
  });

  it('starts in CLOSED state for all built-in providers', () => {
    const states = router.getCircuitBreakerStates();
    for (const state of Object.values(states)) {
      expect(state).toBe(CircuitBreakerState.CLOSED);
    }
  });

  it('opens the circuit after N consecutive failures (threshold = 3)', () => {
    openCircuit(router, 'openai', 3);
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.OPEN);
  });

  it('does not open the circuit before the threshold is reached', () => {
    router.recordFailure('openai');
    router.recordFailure('openai');
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions from OPEN to HALF_OPEN after the cooldown elapses', () => {
    openCircuit(router, 'openai', 3);
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.OPEN);

    advancePastCooldown(router, 'openai');

    // isAvailable is called internally by route()
    router.route({ capability: 'chat', preferredProvider: 'openai' });
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.HALF_OPEN);
  });

  it('closes the circuit (HALF_OPEN → CLOSED) after a successful probe', () => {
    openCircuit(router, 'openai', 3);
    advancePastCooldown(router, 'openai');

    // Trigger HALF_OPEN transition
    router.route({ capability: 'chat', preferredProvider: 'openai' });
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.HALF_OPEN);

    // Record a successful outcome
    router.recordSuccess('openai', 120);
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.CLOSED);
  });

  it('re-opens the circuit (HALF_OPEN → OPEN) when the probe fails', () => {
    openCircuit(router, 'openai', 3);
    advancePastCooldown(router, 'openai');

    router.route({ capability: 'chat', preferredProvider: 'openai' });
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.HALF_OPEN);

    router.recordFailure('openai');
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.OPEN);
  });

  it('resets the consecutive failure count after a success in CLOSED state', () => {
    router.recordFailure('openai');
    router.recordFailure('openai');
    router.recordSuccess('openai', 50);
    // Should be back to CLOSED with 0 failures
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.CLOSED);
    // A single additional failure should NOT open the circuit (threshold = 3)
    router.recordFailure('openai');
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.CLOSED);
  });

  it('does not change state when recordSuccess is called on an OPEN circuit', () => {
    openCircuit(router, 'openai', 3);
    // Health check succeeds but cooldown has NOT elapsed → stay OPEN
    router.recordSuccess('openai', 100);
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.OPEN);
  });
});

describe('ProviderRouter — checkHealth()', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = makeRouter({ failureThreshold: 3 });
    mockedAxios.get = jest.fn();
  });

  afterEach(() => {
    router.stop();
    jest.clearAllMocks();
  });

  it('returns true and records success when the endpoint responds', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200 });
    const healthy = await router.checkHealth('openai');
    expect(healthy).toBe(true);
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.CLOSED);
  });

  it('returns false and records failure when the endpoint is unreachable', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const healthy = await router.checkHealth('openai');
    expect(healthy).toBe(false);
  });

  it('opens the circuit after N consecutive health-check failures', async () => {
    mockedAxios.get.mockRejectedValue(new Error('timeout'));
    for (let i = 0; i < 3; i++) {
      await router.checkHealth('openai');
    }
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.OPEN);
  });

  it('closes the circuit when a health check succeeds while HALF_OPEN', async () => {
    // Open the circuit
    mockedAxios.get.mockRejectedValue(new Error('timeout'));
    for (let i = 0; i < 3; i++) {
      await router.checkHealth('openai');
    }
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.OPEN);

    // Advance past cooldown so checkHealth triggers OPEN → HALF_OPEN
    advancePastCooldown(router, 'openai');

    mockedAxios.get.mockResolvedValueOnce({ status: 200 });
    await router.checkHealth('openai');
    expect(router.getCircuitBreakerStates()['openai']).toBe(CircuitBreakerState.CLOSED);
  });

  it('returns false for an unregistered provider', async () => {
    const healthy = await router.checkHealth('unknown-provider');
    expect(healthy).toBe(false);
  });
});

describe('ProviderRouter — getCircuitBreakerStates()', () => {
  it('returns an entry for every built-in provider', () => {
    const router = makeRouter();
    const states = router.getCircuitBreakerStates();
    expect(Object.keys(states)).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'google', 'ollama']),
    );
    router.stop();
  });

  it('includes newly registered providers', () => {
    const router = makeRouter();
    router.registerProvider({
      id: 'custom-llm',
      name: 'Custom LLM',
      baseUrl: 'http://localhost:9999',
      models: ['custom-model'],
      maxTokens: 4096,
      capabilities: ['chat'],
    });
    const states = router.getCircuitBreakerStates();
    expect(states['custom-llm']).toBe(CircuitBreakerState.CLOSED);
    router.stop();
  });
});

describe('ProviderRouter — lifecycle', () => {
  it('stop() clears the health-check timer', () => {
    const router = new ProviderRouter({
      autoStartHealthChecks: true,
      healthCheckIntervalMs: 60_000,
      failureThreshold: 5,
      cooldownMs: 60_000,
    });
    // Should not throw
    router.stop();
    // Calling stop() again is a no-op
    expect(() => router.stop()).not.toThrow();
  });

  it('startHealthChecks() is idempotent', () => {
    const router = makeRouter();
    router.startHealthChecks();
    router.startHealthChecks(); // second call is a no-op
    router.stop();
  });
});
