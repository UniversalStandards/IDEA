import { metrics } from '../observability/metrics';
import type { AIProvider } from './provider-router';

interface ProviderLatencyState {
  samples: number[];
  p50Ema: number;
  p95Ema: number;
  p99Ema: number;
}

export interface ProviderLatencyScore {
  providerId: string;
  p50: number;
  p95: number;
  p99: number;
  penalty: number;
  weightMultiplier: number;
}

export class LatencyScorer {
  private readonly states = new Map<string, ProviderLatencyState>();

  constructor(
    private readonly alpha = 0.2,
    private readonly maxSamples = 200,
  ) {}

  recordLatency(providerId: string, latencyMs: number): void {
    const sanitizedLatency = Math.max(0, latencyMs);
    const state = this.getOrInit(providerId);

    state.samples.push(sanitizedLatency);
    if (state.samples.length > this.maxSamples) {
      state.samples.shift();
    }

    const p50 = this.quantile(state.samples, 0.5);
    const p95 = this.quantile(state.samples, 0.95);
    const p99 = this.quantile(state.samples, 0.99);

    state.p50Ema = this.ema(state.p50Ema, p50);
    state.p95Ema = this.ema(state.p95Ema, p95);
    state.p99Ema = this.ema(state.p99Ema, p99);

    metrics.histogram('provider_latency_ms', sanitizedLatency, { providerId });
    metrics.gauge('provider_latency_p95_ema_ms', state.p95Ema, { providerId });
  }

  getWeightMultiplier(providerId: string): number {
    const score = this.getScore(providerId);
    return score.weightMultiplier;
  }

  scoreProviders(providers: AIProvider[]): Map<string, ProviderLatencyScore> {
    const scored = new Map<string, ProviderLatencyScore>();
    for (const provider of providers) {
      scored.set(provider.id, this.getScore(provider.id));
    }
    return scored;
  }

  getScore(providerId: string): ProviderLatencyScore {
    const state = this.getOrInit(providerId);
    const penalty = Math.min(0.9, state.p50Ema / 4000 + state.p95Ema / 3000 + state.p99Ema / 2000);

    return {
      providerId,
      p50: state.p50Ema,
      p95: state.p95Ema,
      p99: state.p99Ema,
      penalty,
      weightMultiplier: Math.max(0.1, 1 - penalty),
    };
  }

  private getOrInit(providerId: string): ProviderLatencyState {
    const existing = this.states.get(providerId);
    if (existing) return existing;

    const state: ProviderLatencyState = {
      samples: [],
      p50Ema: 0,
      p95Ema: 0,
      p99Ema: 0,
    };
    this.states.set(providerId, state);
    return state;
  }

  private ema(prev: number, current: number): number {
    if (prev === 0) return current;
    return this.alpha * current + (1 - this.alpha) * prev;
  }

  private quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.floor((sorted.length - 1) * q);
    return sorted[idx] ?? 0;
  }
}
