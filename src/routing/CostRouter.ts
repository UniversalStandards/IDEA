import type { AIProvider } from './provider-router';

export type TaskComplexity = 'routine' | 'medium' | 'complex' | 'critical';
export type CostTier = 1 | 2 | 3;

export interface CostRoute {
  provider: AIProvider;
  model: string;
  tier: CostTier;
}

const TIER_MODELS: Record<CostTier, readonly string[]> = {
  1: ['gpt-5-nano', 'gemini-flash', 'deepseek-v3', 'gpt-4o-mini', 'gemini-1.5-flash'],
  2: ['claude-sonnet-4.6', 'gpt-4o-mini', 'claude-3-5-sonnet-20241022'],
  3: ['claude-opus-4.6', 'gpt-4o', 'gemini-ultra', 'claude-3-opus-20240229', 'gpt-4-turbo'],
};

export class CostRouter {
  getTargetTier(complexity: TaskComplexity): CostTier {
    if (complexity === 'routine') return 1;
    if (complexity === 'medium') return 2;
    return 3;
  }

  rankProvidersByCost(providers: AIProvider[], complexity: TaskComplexity): CostRoute[] {
    const targetTier = this.getTargetTier(complexity);
    const ranked: CostRoute[] = [];

    for (const provider of providers) {
      const route = this.selectForProvider(provider, targetTier);
      if (route) ranked.push(route);
    }

    return ranked.sort((a, b) => a.tier - b.tier || a.provider.id.localeCompare(b.provider.id));
  }

  private selectForProvider(provider: AIProvider, targetTier: CostTier): CostRoute | null {
    for (const tier of [targetTier, 2, 3] as const) {
      if (tier < targetTier) continue;
      const model = this.findModel(provider, tier);
      if (model) return { provider, model, tier };
    }
    return null;
  }

  private findModel(provider: AIProvider, tier: CostTier): string | null {
    const tierModels = new Set(TIER_MODELS[tier].map((model) => model.toLowerCase()));
    for (const model of provider.models) {
      if (tierModels.has(model.toLowerCase())) {
        return model;
      }
    }
    return null;
  }
}
