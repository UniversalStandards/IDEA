import type { AIProvider } from './provider-router';

export type LoadBalancingStrategy = 'wrr' | 'least-connections';

interface SelectOptions {
  strategy?: LoadBalancingStrategy;
  weights?: Map<string, number>;
}

export class LoadBalancer {
  private readonly staticWeights = new Map<string, number>();
  private readonly currentWeights = new Map<string, number>();
  private readonly activeConnections = new Map<string, number>();

  setWeight(providerId: string, weight: number): void {
    this.staticWeights.set(providerId, Math.max(0.01, weight));
  }

  getConnections(providerId: string): number {
    return this.activeConnections.get(providerId) ?? 0;
  }

  acquireConnection(providerId: string): void {
    this.activeConnections.set(providerId, this.getConnections(providerId) + 1);
  }

  releaseConnection(providerId: string): void {
    const current = this.getConnections(providerId);
    this.activeConnections.set(providerId, Math.max(0, current - 1));
  }

  selectProvider(providers: AIProvider[], options: SelectOptions = {}): AIProvider | null {
    if (providers.length === 0) return null;
    const strategy = options.strategy ?? 'wrr';
    if (strategy === 'least-connections') {
      return this.selectLeastConnections(providers, options.weights);
    }
    return this.selectWeightedRoundRobin(providers, options.weights);
  }

  private selectLeastConnections(
    providers: AIProvider[],
    dynamicWeights?: Map<string, number>,
  ): AIProvider {
    const firstProvider = providers[0];
    if (!firstProvider) {
      throw new Error('selectLeastConnections requires at least one provider');
    }

    let selected = firstProvider;
    let selectedScore = Number.POSITIVE_INFINITY;

    for (const provider of providers) {
      const connections = this.getConnections(provider.id);
      const weight = this.getWeight(provider.id, dynamicWeights);
      const score = connections / weight;
      if (score < selectedScore) {
        selected = provider;
        selectedScore = score;
      }
    }

    return selected;
  }

  private selectWeightedRoundRobin(
    providers: AIProvider[],
    dynamicWeights?: Map<string, number>,
  ): AIProvider {
    const firstProvider = providers[0];
    if (!firstProvider) {
      throw new Error('selectWeightedRoundRobin requires at least one provider');
    }

    let selected = firstProvider;
    let selectedCurrentWeight = Number.NEGATIVE_INFINITY;
    let totalWeight = 0;

    for (const provider of providers) {
      const effectiveWeight = this.getWeight(provider.id, dynamicWeights);
      const current = (this.currentWeights.get(provider.id) ?? 0) + effectiveWeight;
      this.currentWeights.set(provider.id, current);
      totalWeight += effectiveWeight;

      if (current > selectedCurrentWeight) {
        selected = provider;
        selectedCurrentWeight = current;
      }
    }

    const selectedId = selected.id;
    const selectedWeight = this.currentWeights.get(selectedId) ?? 0;
    this.currentWeights.set(selectedId, selectedWeight - totalWeight);

    return selected;
  }

  private getWeight(providerId: string, dynamicWeights?: Map<string, number>): number {
    const dynamicWeight = dynamicWeights?.get(providerId);
    if (dynamicWeight !== undefined) {
      return Math.max(0.01, dynamicWeight);
    }
    return this.staticWeights.get(providerId) ?? 1;
  }
}
