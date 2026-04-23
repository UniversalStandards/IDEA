import axios from 'axios';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { config } from '../config';

const logger = createLogger('provider-router');

export interface AIProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string | undefined;
  models: string[];
  maxTokens: number;
  capabilities: string[];
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  lastAttemptAt: number | null;
}

export interface ProviderRoutingMetrics {
  requestCount: number;
  failureCount: number;
  latencies: number[];
}

const BUILTIN_PROVIDERS: AIProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com',
    apiKey: process.env['OPENAI_API_KEY'],
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    maxTokens: 128000,
    capabilities: ['chat', 'completion', 'embedding', 'vision', 'code', 'function_calling'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com',
    apiKey: process.env['ANTHROPIC_API_KEY'],
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
    maxTokens: 200000,
    capabilities: ['chat', 'completion', 'vision', 'code', 'function_calling'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: process.env['GOOGLE_BASE_URL'] ?? 'https://generativelanguage.googleapis.com',
    apiKey: process.env['GOOGLE_API_KEY'],
    models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'],
    maxTokens: 1000000,
    capabilities: ['chat', 'completion', 'vision', 'code', 'embedding'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    models: ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'phi3'],
    maxTokens: 32768,
    capabilities: ['chat', 'completion', 'code', 'local'],
  },
];

/** Number of consecutive failures before a circuit opens. */
const CIRCUIT_FAILURE_THRESHOLD = 5;
/** How long (ms) the circuit stays OPEN before transitioning to HALF_OPEN. */
const CIRCUIT_COOLDOWN_MS = 60_000;
/** Background health-poll interval (ms). */
const HEALTH_POLL_INTERVAL_MS = 60_000;
/** On-demand health-check result cache TTL (ms). */
const HEALTH_CACHE_TTL_MS = 30_000;
/** Maximum stored latency samples per provider (memory guard). */
const MAX_LATENCY_SAMPLES = 1000;

export class ProviderRouter {
  private readonly providers = new Map<string, AIProvider>();
  private readonly healthCache = new Map<string, { healthy: boolean; checkedAt: number }>();
  private readonly circuitBreakers = new Map<string, CircuitBreakerStatus>();
  private readonly routingMetrics = new Map<string, ProviderRoutingMetrics>();
  private healthPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, { ...p });
      this._initProviderState(p.id);
    }
  }

  private _initProviderState(providerId: string): void {
    if (!this.circuitBreakers.has(providerId)) {
      this.circuitBreakers.set(providerId, {
        state: CircuitState.CLOSED,
        consecutiveFailures: 0,
        openedAt: null,
        lastAttemptAt: null,
      });
    }
    if (!this.routingMetrics.has(providerId)) {
      this.routingMetrics.set(providerId, {
        requestCount: 0,
        failureCount: 0,
        latencies: [],
      });
    }
  }

  /** Start background health polling. Idempotent. */
  initialize(): void {
    if (this.healthPollInterval !== null) return;
    logger.info('Starting provider health polling', { intervalMs: HEALTH_POLL_INTERVAL_MS });
    this.healthPollInterval = setInterval(() => {
      void this._pollAllProviders();
    }, HEALTH_POLL_INTERVAL_MS);
    // Allow the Node.js event loop to exit without waiting for this timer.
    if (typeof this.healthPollInterval.unref === 'function') {
      this.healthPollInterval.unref();
    }
  }

  /** Stop background health polling. Idempotent. */
  shutdown(): void {
    if (this.healthPollInterval !== null) {
      clearInterval(this.healthPollInterval);
      this.healthPollInterval = null;
      logger.info('Provider health polling stopped');
    }
  }

  private async _pollAllProviders(): Promise<void> {
    const ids = Array.from(this.providers.keys());
    await Promise.allSettled(ids.map((id) => this.checkHealth(id)));
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    this._initProviderState(provider.id);
    logger.info('AI provider registered', { id: provider.id, name: provider.name });
  }

  // ── Circuit-breaker helpers ──────────────────────────────────────────────

  /**
   * Returns true when the circuit allows a request through (CLOSED or HALF_OPEN).
   * Automatically transitions OPEN → HALF_OPEN once the cooldown has elapsed.
   */
  private _isCircuitAllowing(providerId: string): boolean {
    const cb = this.circuitBreakers.get(providerId);
    if (!cb) return true;

    if (cb.state === CircuitState.CLOSED) return true;

    if (cb.state === CircuitState.OPEN) {
      const now = Date.now();
      if (cb.openedAt !== null && now - cb.openedAt >= CIRCUIT_COOLDOWN_MS) {
        cb.state = CircuitState.HALF_OPEN;
        cb.lastAttemptAt = now;
        logger.info('Circuit breaker transitioned to HALF_OPEN', { providerId });
        metrics.increment('circuit_breaker_state_change', {
          providerId,
          state: CircuitState.HALF_OPEN,
        });
        return true;
      }
      return false;
    }

    // HALF_OPEN — allow the probe request through
    return true;
  }

  /**
   * Record a successful request outcome. Closes the circuit if it was HALF_OPEN,
   * and tracks latency.
   */
  recordSuccess(providerId: string, latencyMs: number): void {
    const cb = this.circuitBreakers.get(providerId);
    const pm = this.routingMetrics.get(providerId);

    if (pm) {
      pm.requestCount++;
      pm.latencies.push(latencyMs);
      if (pm.latencies.length > MAX_LATENCY_SAMPLES) {
        pm.latencies.shift();
      }
    }

    if (cb) {
      cb.consecutiveFailures = 0;
      if (cb.state === CircuitState.HALF_OPEN) {
        cb.state = CircuitState.CLOSED;
        cb.openedAt = null;
        logger.info('Circuit breaker CLOSED after successful probe', { providerId });
        metrics.increment('circuit_breaker_state_change', {
          providerId,
          state: CircuitState.CLOSED,
        });
      }
    }

    metrics.histogram('provider_request_latency_ms', latencyMs, { providerId });
  }

  /**
   * Record a failed request outcome. Opens the circuit after reaching the
   * failure threshold, or immediately when already HALF_OPEN.
   */
  recordFailure(providerId: string): void {
    const cb = this.circuitBreakers.get(providerId);
    const pm = this.routingMetrics.get(providerId);

    if (pm) {
      pm.requestCount++;
      pm.failureCount++;
    }

    metrics.increment('provider_failures_total', { providerId });

    if (!cb) return;

    cb.consecutiveFailures++;

    if (cb.state === CircuitState.HALF_OPEN || cb.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      cb.state = CircuitState.OPEN;
      cb.openedAt = Date.now();
      logger.warn('Circuit breaker OPENED', {
        providerId,
        consecutiveFailures: cb.consecutiveFailures,
      });
      metrics.increment('circuit_breaker_state_change', {
        providerId,
        state: CircuitState.OPEN,
      });
    }
  }

  getCircuitState(providerId: string): CircuitBreakerStatus | undefined {
    return this.circuitBreakers.get(providerId);
  }

  getProviderRoutingMetrics(providerId: string): ProviderRoutingMetrics | undefined {
    return this.routingMetrics.get(providerId);
  }

  /**
   * Returns latency percentiles (p50 / p95 / p99) for a provider,
   * or null when no latency data has been recorded yet.
   */
  getLatencyPercentiles(providerId: string): { p50: number; p95: number; p99: number } | null {
    const pm = this.routingMetrics.get(providerId);
    if (!pm || pm.latencies.length === 0) return null;

    const sorted = [...pm.latencies].sort((a, b) => a - b);
    const percentile = (pct: number): number => {
      const idx = Math.ceil(sorted.length * pct) - 1;
      return sorted[Math.max(0, idx)] ?? 0;
    };

    return {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /**
   * Route a request to the best available provider using the
   * PRIMARY → FALLBACK → LOCAL fallback chain.
   * Providers with an OPEN circuit breaker are skipped automatically.
   */
  route(request: {
    capability: string;
    preferredProvider?: string;
    fallback?: boolean;
  }): AIProvider | null {
    const defaultId = config.DEFAULT_AI_PROVIDER;
    const fallbackId = config.FALLBACK_AI_PROVIDER;
    const localId = config.LOCAL_MODEL_PROVIDER;

    // Build priority chain: preferred → primary → fallback → local
    const chain: string[] = [];
    if (request.preferredProvider) chain.push(request.preferredProvider);
    chain.push(defaultId);
    if (request.fallback !== false) {
      chain.push(fallbackId);
      chain.push(localId);
    }

    // Deduplicate while preserving order
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

      // Skip providers whose circuit is OPEN
      if (!this._isCircuitAllowing(id)) {
        logger.debug('Circuit breaker OPEN, skipping provider', { providerId: id });
        metrics.increment('provider_circuit_skip_total', { providerId: id });
        continue;
      }

      // Respect on-demand health cache
      const cached = this.healthCache.get(id);
      if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL_MS) {
        if (!cached.healthy) continue;
      }

      metrics.increment('provider_route_total', { providerId: id, capability: request.capability });
      logger.debug('Provider routed', { providerId: id, capability: request.capability });
      return provider;
    }

    // Last resort: any registered provider that supports the capability
    // and whose circuit is not fully OPEN — only when fallback is allowed
    if (request.fallback !== false) {
      for (const provider of this.providers.values()) {
        if (!provider.capabilities.includes(request.capability)) continue;
        if (!this._isCircuitAllowing(provider.id)) continue;

        metrics.increment('provider_route_total', {
          providerId: provider.id,
          capability: request.capability,
          fallback: 'true',
        });
        return provider;
      }
    }

    logger.warn('No provider found for capability', { capability: request.capability });
    return null;
  }

  async checkHealth(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) return false;

    try {
      await axios.get(provider.baseUrl, { timeout: 5000, validateStatus: () => true });
      this.healthCache.set(providerId, { healthy: true, checkedAt: Date.now() });
      logger.debug('Provider health OK', { providerId });
      return true;
    } catch {
      this.healthCache.set(providerId, { healthy: false, checkedAt: Date.now() });
      logger.warn('Provider health check failed', { providerId });
      return false;
    }
  }

  listProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }
}

export const providerRouter = new ProviderRouter();
