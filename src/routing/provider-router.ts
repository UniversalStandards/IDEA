import axios from 'axios';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { config } from '../config';

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

export class ProviderRouter {
  private readonly providers = new Map<string, AIProvider>();
  private readonly healthCache = new Map<string, { healthy: boolean; checkedAt: number }>();
  private readonly HEALTH_CACHE_TTL_MS = 30_000;

  constructor() {
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, { ...p });
    }
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
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

      // Check cached health
      const cached = this.healthCache.get(id);
      if (cached && Date.now() - cached.checkedAt < this.HEALTH_CACHE_TTL_MS) {
        if (!cached.healthy) continue;
      }

      metrics.increment('provider_route_total', { providerId: id, capability: request.capability });
      logger.debug('Provider routed', { providerId: id, capability: request.capability });
      return provider;
    }

    // Last resort: any provider supporting the capability
    for (const provider of this.providers.values()) {
      if (provider.capabilities.includes(request.capability)) {
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
