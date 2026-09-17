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

interface CircuitBreakerEntry {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt?: number;
}

interface LatencySample {
  ms: number;
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MAX_LATENCY_SAMPLES = 200;

export interface ProviderMetricsSnapshot {
  requestCount: number;
  failureCount: number;
  p50: number;
  p95: number;
  p99: number;
  circuitState: CircuitBreakerState;
}

export class ProviderRouter {
  private readonly providers = new Map<string, AIProvider>();
  private readonly healthCache = new Map<string, { healthy: boolean; checkedAt: number }>();
  private readonly HEALTH_CACHE_TTL_MS = 30_000;
  private readonly breakers = new Map<string, CircuitBreakerEntry>();
  private readonly latencies = new Map<string, LatencySample[]>();
  private readonly requestCounts = new Map<string, number>();
  private readonly failureCounts = new Map<string, number>();
  private healthCheckTimer?: NodeJS.Timeout;

  constructor() {
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, { ...p });
      this.breakers.set(p.id, { state: CircuitBreakerState.CLOSED, consecutiveFailures: 0 });
    }
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    this.breakers.set(provider.id, { state: CircuitBreakerState.CLOSED, consecutiveFailures: 0 });
    logger.info('AI provider registered', { id: provider.id, name: provider.name });
  }

  route(request: {
    capability: string;
    preferredProvider?: string;
    fallback?: boolean;
  }): AIProvider | null {
    const defaultId = config.DEFAULT_AI_PROVIDER;
    const fallbackId = config.FALLBACK_AI_PROVIDER;
    const localId = config.LOCAL_MODEL_PROVIDER;

    // Build priority chain
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
      if (!this.isRoutable(id)) continue;

      this.recordRouteMetrics(id, request.capability);
      return provider;
    }

    // Last resort: any routable provider supporting the capability
    for (const provider of this.providers.values()) {
      if (provider.capabilities.includes(request.capability) && this.isRoutable(provider.id)) {
        this.recordRouteMetrics(provider.id, request.capability, true);
        return provider;
      }
    }

    logger.warn('No routable provider found for capability', { capability: request.capability });
    return null;
  }

  /**
   * Report the outcome of a call made to a provider chosen via route().
   * Feeds the circuit breaker state machine and latency percentile tracking.
   * Callers should invoke this after every provider call, success or failure.
   */
  reportOutcome(providerId: string, success: boolean, latencyMs: number): void {
    const breaker = this.getBreaker(providerId);

    this.requestCounts.set(providerId, (this.requestCounts.get(providerId) ?? 0) + 1);

    if (success) {
      breaker.consecutiveFailures = 0;
      if (breaker.state === CircuitBreakerState.HALF_OPEN) {
        breaker.state = CircuitBreakerState.CLOSED;
        logger.info('Circuit breaker closed after successful trial request', { providerId });
      }
    } else {
      this.failureCounts.set(providerId, (this.failureCounts.get(providerId) ?? 0) + 1);
      breaker.consecutiveFailures += 1;

      if (breaker.state === CircuitBreakerState.HALF_OPEN) {
        breaker.state = CircuitBreakerState.OPEN;
        breaker.openedAt = Date.now();
        logger.warn('Circuit breaker re-opened after failed trial request', { providerId });
      } else if (
        breaker.consecutiveFailures >= FAILURE_THRESHOLD &&
        breaker.state !== CircuitBreakerState.OPEN
      ) {
        breaker.state = CircuitBreakerState.OPEN;
        breaker.openedAt = Date.now();
        logger.warn('Circuit breaker opened after consecutive failures', {
          providerId,
          consecutiveFailures: breaker.consecutiveFailures,
        });
      }
    }

    const samples = this.latencies.get(providerId) ?? [];
    samples.push({ ms: latencyMs });
    if (samples.length > MAX_LATENCY_SAMPLES) samples.shift();
    this.latencies.set(providerId, samples);

    metrics.histogram('provider_request_duration_ms', latencyMs, {
      providerId,
      success: String(success),
    });
  }

  getCircuitState(providerId: string): CircuitBreakerState {
    return this.getBreaker(providerId).state;
  }

  getMetrics(providerId: string): ProviderMetricsSnapshot {
    const samples = (this.latencies.get(providerId) ?? []).map((s) => s.ms).sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (samples.length === 0) return 0;
      const idx = Math.min(samples.length - 1, Math.floor((p / 100) * samples.length));
      return samples[idx] ?? 0;
    };

    return {
      requestCount: this.requestCounts.get(providerId) ?? 0,
      failureCount: this.failureCounts.get(providerId) ?? 0,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      circuitState: this.getBreaker(providerId).state,
    };
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

  /** Start the periodic background health-check task (default: every 60s). Idempotent — safe to call more than once. */
  startHealthChecks(intervalMs = HEALTH_CHECK_INTERVAL_MS): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      for (const id of this.providers.keys()) {
        void this.checkHealth(id);
      }
    }, intervalMs);
    this.healthCheckTimer.unref();
    logger.info('Provider background health checks started', { intervalMs });
  }

  /** Stop the periodic background health-check task. Idempotent. */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      logger.info('Provider background health checks stopped');
    }
  }

  listProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  private isRoutable(id: string): boolean {
    const breaker = this.getBreaker(id);
    if (breaker.state === CircuitBreakerState.OPEN) {
      if (breaker.openedAt && Date.now() - breaker.openedAt >= COOLDOWN_MS) {
        breaker.state = CircuitBreakerState.HALF_OPEN;
        logger.info('Circuit breaker half-open, allowing a trial request', { providerId: id });
      } else {
        return false;
      }
    }

    const cached = this.healthCache.get(id);
    if (cached && Date.now() - cached.checkedAt < this.HEALTH_CACHE_TTL_MS && !cached.healthy) {
      return false;
    }

    return true;
  }

  private getBreaker(id: string): CircuitBreakerEntry {
    let breaker = this.breakers.get(id);
    if (!breaker) {
      breaker = { state: CircuitBreakerState.CLOSED, consecutiveFailures: 0 };
      this.breakers.set(id, breaker);
    }
    return breaker;
  }

  private recordRouteMetrics(id: string, capability: string, fallback = false): void {
    metrics.increment('provider_route_total', {
      providerId: id,
      capability,
      ...(fallback ? { fallback: 'true' } : {}),
    });
    logger.debug('Provider routed', { providerId: id, capability });
  }
}

export const providerRouter = new ProviderRouter();
