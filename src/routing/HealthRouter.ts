import { metrics } from '../observability/metrics';
import type { AIProvider } from './provider-router';

interface HealthSample {
  timestampMs: number;
  success: boolean;
}

export interface ProviderHealth {
  providerId: string;
  sampleSize: number;
  errorRate: number;
  healthy: boolean;
}

export class HealthRouter {
  private readonly outcomes = new Map<string, HealthSample[]>();

  constructor(
    private readonly errorRateThreshold = 0.1,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  recordOutcome(providerId: string, success: boolean): void {
    const providerOutcomes = this.outcomes.get(providerId) ?? [];
    providerOutcomes.push({ timestampMs: this.now(), success });
    this.outcomes.set(providerId, providerOutcomes);
    this.prune(providerId);

    metrics.increment('provider_request_total', { providerId });
    if (!success) {
      metrics.increment('provider_error_total', { providerId });
    }

    metrics.gauge('provider_error_rate', this.getErrorRate(providerId), { providerId });
  }

  isHealthy(providerId: string): boolean {
    return this.getErrorRate(providerId) <= this.errorRateThreshold;
  }

  filterHealthyProviders(providers: AIProvider[]): AIProvider[] {
    return providers.filter((provider) => this.isHealthy(provider.id));
  }

  getHealth(providerId: string): ProviderHealth {
    const samples = this.getWindowSamples(providerId);
    const failures = samples.reduce((count, sample) => count + (sample.success ? 0 : 1), 0);
    const errorRate = samples.length > 0 ? failures / samples.length : 0;

    return {
      providerId,
      sampleSize: samples.length,
      errorRate,
      healthy: errorRate <= this.errorRateThreshold,
    };
  }

  private getErrorRate(providerId: string): number {
    return this.getHealth(providerId).errorRate;
  }

  private getWindowSamples(providerId: string): HealthSample[] {
    this.prune(providerId);
    return this.outcomes.get(providerId) ?? [];
  }

  private prune(providerId: string): void {
    const samples = this.outcomes.get(providerId);
    if (!samples) return;

    const minTimestamp = this.now() - this.windowMs;
    const pruned = samples.filter((sample) => sample.timestampMs >= minTimestamp);
    this.outcomes.set(providerId, pruned);
  }
}
