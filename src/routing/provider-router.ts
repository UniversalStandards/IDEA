import axios from 'axios';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { config } from '../config';
import { CircuitBreakerState } from '../types/index';

const logger = createLogger('provider-router');

export interface AIProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  maxTokens: number;
  capabilities: string[];
}

export interface CircuitBreakerEntry {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  /** Unix timestamp (ms) when the circuit transitioned to OPEN. */
  openedAt: number;
}

export interface ProviderRouterOptions {
  /** Number of consecutive failures before opening the circuit. Default: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD (5). */
  failureThreshold?: number;
  /** Milliseconds to wait in OPEN state before transitioning to HALF_OPEN. Default: config.CIRCUIT_BREAKER_COOLDOWN_MS (60 000). */
  cooldownMs?: number;
  /** Background health-check interval in milliseconds. Default: config.PROVIDER_HEALTH_CHECK_INTERVAL_MS (60 000). */
  healthCheckIntervalMs?: number;
  /** Set to false to skip starting the background health-check timer (useful in tests). Default: true. */
  autoStartHealthChecks?: boolean;
}

/** Attach an API key to a provider only when the env var is defined (required by exactOptionalPropertyTypes). */
function withApiKey(provider: AIProvider, key: string | undefined): AIProvider {
  return key !== undefined ? { ...provider, apiKey: key } : provider;
}const BUILTIN_PROVIDERS: AIProvider[] = [
  withApiKey(
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      maxTokens: 128000,
      capabilities: ['chat', 'completion', 'embedding', 'vision', 'code', 'function_calling'],
    },
    process.env['OPENAI_API_KEY'],
  ),
  withApiKey(
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com',
      models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
      maxTokens: 200000,
      capabilities: ['chat', 'completion', 'vision', 'code', 'function_calling'],
    },
    process.env['ANTHROPIC_API_KEY'],
  ),
  withApiKey(
    {
      id: 'google',
      name: 'Google Gemini',
      baseUrl: process.env['GOOGLE_BASE_URL'] ?? 'https://generativelanguage.googleapis.com',
      models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'],
      maxTokens: 1000000,
      capabilities: ['chat', 'completion', 'vision', 'code', 'embedding'],
    },
    process.env['GOOGLE_API_KEY'],
  ),
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    models: ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'phi3'],
    maxTokens: 32768,
    capabilities: ['chat', 'completion', 'code', 'local'],
  },
];

/** Maximum number of latency samples retained per provider for percentile calculation. */
const LATENCY_WINDOW_SIZE = 100;

/**
 * Calculate the p-th percentile from a pre-sorted array.
 * Returns 0 for an empty array.
 */
function calcPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export class ProviderRouter {
  private readonly providers = new Map<string, AIProvider>();
  private readonly circuitBreakers = new Map<string, CircuitBreakerEntry>();
  private readonly latencyWindows = new Map<string, number[]>();

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly healthCheckIntervalMs: number;

  private healthCheckTimer: NodeJS.Timeout | null = null;

  /** Kept for backward-compatible checkHealth() return value. */
  private readonly healthCache = new Map<string, { healthy: boolean; checkedAt: number }>();

  constructor(options?: ProviderRouterOptions) {
    this.failureThreshold = options?.failureThreshold ?? config.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    this.cooldownMs = options?.cooldownMs ?? config.CIRCUIT_BREAKER_COOLDOWN_MS;
    this.healthCheckIntervalMs =
      options?.healthCheckIntervalMs ?? config.PROVIDER_HEALTH_CHECK_INTERVAL_MS;

    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, { ...p });
      this.circuitBreakers.set(p.id, {
        state: CircuitBreakerState.CLOSED,
        consecutiveFailures: 0,
        openedAt: 0,
      });
    }

    if (options?.autoStartHealthChecks !== false) {
      this.startHealthChecks();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Start the background health-check task.
   * Safe to call multiple times — subsequent calls are no-ops if already running.
   *
   * The underlying `setInterval` timer is `unref()`-ed so that it does not
   * prevent the Node.js process from exiting when no other async work remains.
   * Call `stop()` during graceful shutdown to release the timer explicitly.
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      for (const id of this.providers.keys()) {
        this.checkHealth(id).catch((err: unknown) => {
          logger.error('Background health check error', {
            providerId: id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }, this.healthCheckIntervalMs);

    // Do not hold the Node.js event loop open just for health checks.
    this.healthCheckTimer.unref();

    logger.debug('Provider health check background task started', {
      intervalMs: this.healthCheckIntervalMs,
    });
  }

  /** Stop the background health-check task and release the timer. */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      logger.debug('Provider health check background task stopped');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Provider Registration
  // ─────────────────────────────────────────────────────────────────

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    if (!this.circuitBreakers.has(provider.id)) {
      this.circuitBreakers.set(provider.id, {
        state: CircuitBreakerState.CLOSED,
        consecutiveFailures: 0,
        openedAt: 0,
      });
    }
    logger.info('AI provider registered', { id: provider.id, name: provider.name });
  }

  // ─────────────────────────────────────────────────────────────────
  // Circuit Breaker — internal helpers
  // ─────────────────────────────────────────────────────────────────

  private ensureCircuitBreaker(providerId: string): CircuitBreakerEntry {
    let cb = this.circuitBreakers.get(providerId);
    if (!cb) {
      cb = { state: CircuitBreakerState.CLOSED, consecutiveFailures: 0, openedAt: 0 };
      this.circuitBreakers.set(providerId, cb);
    }
    return cb;
  }

  /**
   * Returns true if the provider is eligible to receive a request.
   * Also performs the OPEN → HALF_OPEN transition once the cooldown has elapsed.
   */
  private isAvailable(providerId: string): boolean {
    const cb = this.ensureCircuitBreaker(providerId);

    if (cb.state === CircuitBreakerState.CLOSED) return true;
    if (cb.state === CircuitBreakerState.HALF_OPEN) return true;

    // OPEN: transition to HALF_OPEN once cooldown has elapsed.
    if (Date.now() - cb.openedAt >= this.cooldownMs) {
      cb.state = CircuitBreakerState.HALF_OPEN;
      logger.info('Circuit breaker transitioned to HALF_OPEN', { providerId });
      metrics.gauge('provider_circuit_breaker_state', 1, {
        providerId,
        state: CircuitBreakerState.HALF_OPEN,
      });
      return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────
  // Circuit Breaker — public outcome reporting
  // ─────────────────────────────────────────────────────────────────

  /**
   * Report a successful request outcome for a provider.
   *
   * - CLOSED:    resets the consecutive failure count.
   * - HALF_OPEN: closes the circuit (recovery confirmed).
   * - OPEN:      no state change (wait for cooldown → HALF_OPEN).
   *
   * Also records latency and emits p50/p95/p99 gauge metrics.
   */
  recordSuccess(providerId: string, latencyMs: number): void {
    const cb = this.ensureCircuitBreaker(providerId);

    if (cb.state === CircuitBreakerState.HALF_OPEN) {
      cb.state = CircuitBreakerState.CLOSED;
      cb.consecutiveFailures = 0;
      logger.info('Circuit breaker closed after successful probe', { providerId });
      metrics.gauge('provider_circuit_breaker_state', 0, {
        providerId,
        state: CircuitBreakerState.CLOSED,
      });
    } else if (cb.state === CircuitBreakerState.CLOSED) {
      cb.consecutiveFailures = 0;
    }
    // If OPEN: health check succeeded but cooldown has not elapsed via isAvailable yet;
    // do not change state — the cooldown guard enforces the HALF_OPEN gate.

    this.healthCache.set(providerId, { healthy: true, checkedAt: Date.now() });

    // Record latency and emit percentile gauges.
    metrics.histogram('provider_request_latency_ms', latencyMs, { providerId });
    this.updateLatencyPercentiles(providerId, latencyMs);
  }

  /**
   * Report a failed request outcome for a provider.
   *
   * - CLOSED:    increments consecutive failures; opens the circuit when threshold is reached.
   * - HALF_OPEN: re-opens the circuit immediately (probe failed).
   * - OPEN:      no additional state change.
   */
  recordFailure(providerId: string): void {
    const cb = this.ensureCircuitBreaker(providerId);

    metrics.increment('provider_failure_count', { providerId });

    if (cb.state === CircuitBreakerState.HALF_OPEN) {
      // Probe failed — re-open the circuit and reset the cooldown timer.
      cb.state = CircuitBreakerState.OPEN;
      cb.openedAt = Date.now();
      logger.warn('Circuit breaker re-opened after probe failure', { providerId });
      metrics.gauge('provider_circuit_breaker_state', 2, {
        providerId,
        state: CircuitBreakerState.OPEN,
      });
    } else if (cb.state === CircuitBreakerState.CLOSED) {
      cb.consecutiveFailures += 1;
      if (cb.consecutiveFailures >= this.failureThreshold) {
        cb.state = CircuitBreakerState.OPEN;
        cb.openedAt = Date.now();
        logger.warn('Circuit breaker opened', {
          providerId,
          consecutiveFailures: cb.consecutiveFailures,
          threshold: this.failureThreshold,
        });
        metrics.gauge('provider_circuit_breaker_state', 2, {
          providerId,
          state: CircuitBreakerState.OPEN,
        });
      }
    }

    this.healthCache.set(providerId, { healthy: false, checkedAt: Date.now() });
  }

  // ─────────────────────────────────────────────────────────────────
  // Latency percentile tracking
  // ─────────────────────────────────────────────────────────────────

  private updateLatencyPercentiles(providerId: string, latencyMs: number): void {
    let window = this.latencyWindows.get(providerId);
    if (!window) {
      window = [];
      this.latencyWindows.set(providerId, window);
    }
    window.push(latencyMs);
    if (window.length > LATENCY_WINDOW_SIZE) {
      window.shift();
    }
    const sorted = [...window].sort((a, b) => a - b);
    metrics.gauge('provider_latency_p50_ms', calcPercentile(sorted, 50), { providerId });
    metrics.gauge('provider_latency_p95_ms', calcPercentile(sorted, 95), { providerId });
    metrics.gauge('provider_latency_p99_ms', calcPercentile(sorted, 99), { providerId });
  }

  // ─────────────────────────────────────────────────────────────────
  // Routing
  // ─────────────────────────────────────────────────────────────────

  /**
   * Route a request to the most appropriate provider.
   *
   * Priority order (PRIMARY → FALLBACK → LOCAL):
   *   1. `request.preferredProvider` (if supplied)
   *   2. `config.DEFAULT_AI_PROVIDER`
   *   3. `config.FALLBACK_AI_PROVIDER`  (only when fallback !== false)
   *   4. `config.LOCAL_MODEL_PROVIDER`  (only when fallback !== false)
   *   5. Any remaining provider that supports the capability and has an open circuit.
   *
   * Providers whose circuit breaker is OPEN are skipped.
   */
  route(request: {
    capability: string;
    preferredProvider?: string;
    fallback?: boolean;
  }): AIProvider | null {
    const defaultId = config.DEFAULT_AI_PROVIDER;
    const fallbackId = config.FALLBACK_AI_PROVIDER;
    const localId = config.LOCAL_MODEL_PROVIDER;

    // Build the PRIMARY → FALLBACK → LOCAL priority chain.
    const chain: string[] = [];
    if (request.preferredProvider) chain.push(request.preferredProvider);
    chain.push(defaultId);
    if (request.fallback !== false) {
      chain.push(fallbackId);
      chain.push(localId);
    }

    // Deduplicate while preserving order.
    const seen = new Set<string>();
    const ordered = chain.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    for (const id of ordered) {
      const provider = this.providers.get(id);
      if (!provider) continue;
      if (!provider.capabilities.includes(request.capability)) continue;

      // Skip providers whose circuit breaker is OPEN (and cooldown has not elapsed).
      if (!this.isAvailable(id)) {
        logger.debug('Provider skipped — circuit breaker OPEN', { providerId: id });
        continue;
      }

      metrics.increment('provider_request_count', { providerId: id, capability: request.capability });
      logger.debug('Provider routed', { providerId: id, capability: request.capability });
      return provider;
    }

    // Last resort: any available provider that supports the capability.
    // Only applied when fallback has not been explicitly disabled.
    if (request.fallback !== false) {
      for (const provider of this.providers.values()) {
        if (!provider.capabilities.includes(request.capability)) continue;
        if (!this.isAvailable(provider.id)) continue;

        metrics.increment('provider_request_count', {
          providerId: provider.id,
          capability: request.capability,
          fallback: 'true',
        });
        logger.debug('Provider routed (last-resort fallback)', { providerId: provider.id });
        return provider;
      }
    }

    logger.warn('No provider found for capability', { capability: request.capability });
    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Health checks
  // ─────────────────────────────────────────────────────────────────

  /**
   * Ping a provider's base URL to verify connectivity.
   * Any HTTP response (even 4xx/5xx) is treated as reachable.
   * Network errors or timeouts count as unhealthy.
   *
   * The result feeds into the circuit breaker via recordSuccess / recordFailure.
   */
  async checkHealth(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) return false;

    // Trigger OPEN → HALF_OPEN transition if the cooldown has elapsed, so that
    // a successful health check can close the circuit even when no routing
    // requests are being made.
    this.isAvailable(providerId);

    const start = Date.now();
    try {
      await axios.get(provider.baseUrl, { timeout: 5000, validateStatus: () => true });
      const latencyMs = Date.now() - start;
      this.healthCache.set(providerId, { healthy: true, checkedAt: Date.now() });
      this.recordSuccess(providerId, latencyMs);
      logger.debug('Provider health OK', { providerId, latencyMs });
      return true;
    } catch {
      this.healthCache.set(providerId, { healthy: false, checkedAt: Date.now() });
      this.recordFailure(providerId);
      logger.warn('Provider health check failed', { providerId });
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Introspection
  // ─────────────────────────────────────────────────────────────────

  listProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Returns the current circuit breaker state for every registered provider.
   * Useful for exposing health-check data and observability dashboards.
   */
  getCircuitBreakerStates(): Record<string, CircuitBreakerState> {
    const result: Record<string, CircuitBreakerState> = {};
    for (const [id, cb] of this.circuitBreakers.entries()) {
      result[id] = cb.state;
    }
    return result;
  }

  /** @internal Used by tests to inspect the raw circuit-breaker entry. */
  _getCircuitBreaker(providerId: string): CircuitBreakerEntry | undefined {
    return this.circuitBreakers.get(providerId);
  }
}

export const providerRouter = new ProviderRouter();
