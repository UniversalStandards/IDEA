import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { CircuitBreaker } from './CircuitBreaker';
import { CostRouter } from './CostRouter';
import { HealthRouter } from './HealthRouter';
import { LatencyScorer } from './LatencyScorer';
import { LoadBalancer } from './LoadBalancer';
import type { CostTier, TaskComplexity } from './CostRouter';
import type { LoadBalancingStrategy } from './LoadBalancer';

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

export interface RouteRequest {
  capability: string;
  preferredProvider?: string | undefined;
  fallback?: boolean | undefined;
  complexity?: TaskComplexity | undefined;
  strategy?: LoadBalancingStrategy | undefined;
}

export interface ProviderRouteDecision {
  provider: AIProvider;
  model: string;
  tier: CostTier;
  strategy: LoadBalancingStrategy;
  overheadMs: number;
}

const BUILTIN_PROVIDERS: AIProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com',
    apiKey: process.env['OPENAI_API_KEY'],
    models: ['gpt-5-nano', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    maxTokens: 128000,
    capabilities: ['chat', 'completion', 'embedding', 'vision', 'code', 'function_calling'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com',
    apiKey: process.env['ANTHROPIC_API_KEY'],
    models: ['claude-sonnet-4.6', 'claude-opus-4.6', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
    maxTokens: 200000,
    capabilities: ['chat', 'completion', 'vision', 'code', 'function_calling'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: process.env['GOOGLE_BASE_URL'] ?? 'https://generativelanguage.googleapis.com',
    apiKey: process.env['GOOGLE_API_KEY'],
    models: ['gemini-flash', 'gemini-ultra', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'],
    maxTokens: 1000000,
    capabilities: ['chat', 'completion', 'vision', 'code', 'embedding'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    models: ['deepseek-v3', 'llama3.2', 'llama3.1', 'mistral', 'codellama', 'phi3'],
    maxTokens: 32768,
    capabilities: ['chat', 'completion', 'code', 'local'],
  },
];

export class ProviderRouter {
  private readonly providers = new Map<string, AIProvider>();
  private readonly healthCache = new Map<string, { healthy: boolean; checkedAt: number }>();
  private readonly HEALTH_CACHE_TTL_MS = 30_000;

  private readonly circuitBreaker = new CircuitBreaker(5, 30_000);
  private readonly healthRouter = new HealthRouter(0.1, 60_000);
  private readonly costRouter = new CostRouter();
  private readonly latencyScorer = new LatencyScorer();
  private readonly loadBalancer = new LoadBalancer();

  constructor() {
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, { ...p });
      this.loadBalancer.setWeight(p.id, 1);
    }
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    this.loadBalancer.setWeight(provider.id, 1);
    logger.info('AI provider registered', { id: provider.id, name: provider.name });
  }

  route(request: RouteRequest): AIProvider | null {
    return this.routeDecision(request)?.provider ?? null;
  }

  routeDecision(request: RouteRequest): ProviderRouteDecision | null {
    const startedAt = process.hrtime.bigint();
    const complexity = request.complexity ?? 'routine';
    const strategy = request.strategy ?? (complexity === 'critical' ? 'least-connections' : 'wrr');

    const prioritizedProviders = this.getPrioritizedProviders(request);
    const circuitAllowed = prioritizedProviders.filter((provider) =>
      this.circuitBreaker.canRequest(provider.id),
    );
    const healthyProviders = this.healthRouter.filterHealthyProviders(circuitAllowed);

    const candidates = healthyProviders.length > 0 ? healthyProviders : circuitAllowed;
    const costRanked = this.costRouter.rankProvidersByCost(candidates, complexity);
    if (costRanked.length === 0) {
      logger.warn('No provider found for capability', { capability: request.capability });
      return null;
    }

    const bestTier = costRanked[0]?.tier;
    if (!bestTier) return null;
    const tierCandidates = costRanked.filter((candidate) => candidate.tier === bestTier);

    const dynamicWeights = new Map<string, number>();
    for (const candidate of tierCandidates) {
      const tierWeight = candidate.tier === 1 ? 1.2 : candidate.tier === 2 ? 1 : 0.8;
      const latencyWeight = this.latencyScorer.getWeightMultiplier(candidate.provider.id);
      dynamicWeights.set(candidate.provider.id, Math.max(0.05, tierWeight * latencyWeight));
    }

    const selectedProvider = this.loadBalancer.selectProvider(
      tierCandidates.map((candidate) => candidate.provider),
      { strategy, weights: dynamicWeights },
    );

    if (!selectedProvider) return null;

    const selectedCostRoute = tierCandidates.find(
      (candidate) => candidate.provider.id === selectedProvider.id,
    );
    if (!selectedCostRoute) return null;

    const overheadMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    metrics.increment('provider_route_total', {
      providerId: selectedProvider.id,
      capability: request.capability,
      strategy,
      tier: selectedCostRoute.tier,
    });
    metrics.histogram('provider_route_overhead_ms', overheadMs);

    logger.debug('Provider routed', {
      providerId: selectedProvider.id,
      capability: request.capability,
      model: selectedCostRoute.model,
      tier: selectedCostRoute.tier,
      strategy,
      overheadMs,
    });

    return {
      provider: selectedProvider,
      model: selectedCostRoute.model,
      tier: selectedCostRoute.tier,
      strategy,
      overheadMs,
    };
  }

  completeRoute(providerId: string, success: boolean, latencyMs: number): void {
    this.loadBalancer.releaseConnection(providerId);
    this.healthRouter.recordOutcome(providerId, success);
    this.latencyScorer.recordLatency(providerId, latencyMs);

    if (success) this.circuitBreaker.recordSuccess(providerId);
    else this.circuitBreaker.recordFailure(providerId);
  }

  async checkHealth(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) return false;

    try {
      await axios.get(provider.baseUrl, { timeout: 5000, validateStatus: () => true });
      this.healthCache.set(providerId, { healthy: true, checkedAt: Date.now() });
      this.circuitBreaker.recordSuccess(providerId);
      this.healthRouter.recordOutcome(providerId, true);
      logger.debug('Provider health OK', { providerId });
      return true;
    } catch {
      this.healthCache.set(providerId, { healthy: false, checkedAt: Date.now() });
      this.circuitBreaker.recordFailure(providerId);
      this.healthRouter.recordOutcome(providerId, false);
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

  getCircuitState(providerId: string): string {
    return this.circuitBreaker.getState(providerId);
  }

  private getPrioritizedProviders(request: RouteRequest): AIProvider[] {
    const defaultId = config.DEFAULT_AI_PROVIDER;
    const fallbackId = config.FALLBACK_AI_PROVIDER;
    const localId = config.LOCAL_MODEL_PROVIDER;

    const chain: string[] = [];
    if (request.preferredProvider) chain.push(request.preferredProvider);
    chain.push(defaultId);
    if (request.fallback !== false) {
      chain.push(fallbackId);
      chain.push(localId);
    }

    const seen = new Set<string>();
    const prioritized = chain
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => this.providers.get(id))
      .filter((provider): provider is AIProvider => provider?.capabilities.includes(request.capability) === true);

    if (prioritized.length > 0) {
      return prioritized;
    }

    const fallbackProviders: AIProvider[] = [];
    for (const provider of this.providers.values()) {
      if (provider.capabilities.includes(request.capability)) {
        fallbackProviders.push(provider);
      }
    }

    return fallbackProviders;
  }
}

export const providerRouter = new ProviderRouter();
