import axios from 'axios';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { config } from '../config';

const logger = createLogger('provider-router');

const CIRCUIT_OPEN_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const LATENCY_MAX_SAMPLES = 100;

export interface AIProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  maxTokens: number;
  capabilities: string[];
}

interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureAt: number;
  cooldownMs: number;
}

interface ProviderLatencyStats {
  samples: number[];
  maxSamples: number;
}

interface ProviderMetrics {
  requestCount: number;
  failureCount: number;
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.max(0, idx)] ?? 0;
}

export class ProviderRouter {
  private readonly providers = new Map<string, AIProvider>();
  private readonly healthCache = new Map<string, { healthy: boolean; checkedAt: number }>();
  private readonly HEALTH_CACHE_TTL_MS = 30_000;
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private readonly latencyStats = new Map<string, ProviderLatencyStats>();
  private readonly providerMetrics = new Map<string, ProviderMetrics>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, { ...p });
    }
    if (process.env['NODE_ENV'] !== 'test') {
      this.startHealthChecks();
    }
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    logger.info('AI provider registered', { id: provider.id, name: provider.name });
  }

  private getCircuitBreaker(providerId: string): CircuitBreakerState {
    let state = this.circuitBreakers.get(providerId);
    if (!state) {
      state = {
        status: 'closed',
        failureCount: 0,
        lastFailureAt: 0,
        cooldownMs: CIRCUIT_COOLDOWN_MS,
      };
      this.circuitBreakers.set(providerId, state);
    }
    return state;
  }

  /** Returns true if the provider is allowed to receive a request, promoting to half-open as needed. */
  private isCircuitAllowed(providerId: string): boolean {
    const cb = this.getCircuitBreaker(providerId);
    if (cb.status === 'closed' || cb.status === 'half-open') return true;
    // OPEN — check if cooldown has elapsed
    if (Date.now() - cb.lastFailureAt >= cb.cooldownMs) {
      cb.status = 'half-open';
      logger.info('Circuit breaker half-open, allowing probe request', { providerId });
      return true;
    }
    return false;
  }

  recordSuccess(providerId: string): void {
    const cb = this.getCircuitBreaker(providerId);
    if (cb.status === 'half-open') {
      logger.info('Circuit breaker closed after successful probe', { providerId });
    }
    cb.status = 'closed';
    cb.failureCount = 0;

    const m = this.ensureProviderMetrics(providerId);
    m.requestCount += 1;
    metrics.increment('provider_request_total', { providerId, result: 'success' });
  }

  recordFailure(providerId: string): void {
    const cb = this.getCircuitBreaker(providerId);
    cb.failureCount += 1;
    cb.lastFailureAt = Date.now();

    const m = this.ensureProviderMetrics(providerId);
    m.failureCount += 1;
    metrics.increment('provider_request_total', { providerId, result: 'failure' });

    if (cb.status === 'half-open' || cb.failureCount >= CIRCUIT_OPEN_THRESHOLD) {
      if (cb.status !== 'open') {
        logger.warn('Circuit breaker opened', { providerId, failureCount: cb.failureCount });
      }
      cb.status = 'open';
    }
  }

  recordLatency(providerId: string, latencyMs: number): void {
    let stats = this.latencyStats.get(providerId);
    if (!stats) {
      stats = { samples: [], maxSamples: LATENCY_MAX_SAMPLES };
      this.latencyStats.set(providerId, stats);
    }
    stats.samples.push(latencyMs);
    if (stats.samples.length > stats.maxSamples) {
      stats.samples.shift();
    }
    metrics.gauge('provider_latency_ms', latencyMs, { providerId });
  }

  getLatencyStats(providerId: string): { p50: number; p95: number; p99: number; count: number } {
    const stats = this.latencyStats.get(providerId);
    if (!stats || stats.samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, count: 0 };
    }
    const sorted = [...stats.samples].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      count: sorted.length,
    };
  }

  private ensureProviderMetrics(providerId: string): ProviderMetrics {
    let m = this.providerMetrics.get(providerId);
    if (!m) {
      m = { requestCount: 0, failureCount: 0 };
      this.providerMetrics.set(providerId, m);
    }
    return m;
  }

  getProviderMetrics(providerId: string): Readonly<ProviderMetrics> {
    return this.ensureProviderMetrics(providerId);
  }

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

      // Check cached health
      const cached = this.healthCache.get(id);
      if (cached && Date.now() - cached.checkedAt < this.HEALTH_CACHE_TTL_MS) {
        if (!cached.healthy) continue;
      }

      // Check circuit breaker
      if (!this.isCircuitAllowed(id)) {
        logger.debug('Skipping provider — circuit open', { providerId: id });
        continue;
      }

      metrics.increment('provider_route_total', { providerId: id, capability: request.capability });
      logger.debug('Provider routed', { providerId: id, capability: request.capability });
      return provider;
    }

    // Last resort: any provider supporting the capability with a closed/half-open circuit
    for (const provider of this.providers.values()) {
      if (!provider.capabilities.includes(request.capability)) continue;
      if (!this.isCircuitAllowed(provider.id)) continue;
      metrics.increment('provider_route_total', {
        providerId: provider.id,
        capability: request.capability,
        fallback: 'true',
      });
      return provider;
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

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      for (const id of this.providers.keys()) {
        this.checkHealth(id).catch((err: unknown) => {
          logger.error('Background health check error', { providerId: id, err });
        });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthChecks(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
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
