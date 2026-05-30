import { metrics } from '../observability/metrics';
import { type CachedToolResult, type ToolCache, toolCache } from '../cache/ToolCache';
import { config } from '../config';

export interface PredictedAction {
  stepId?: string;
  action: string;
  params: Record<string, unknown>;
  confidence: number;
}

export interface SpeculationContext {
  workflowId: string;
  stepId: string;
  action: string;
  params: Record<string, unknown>;
  nextActions: PredictedAction[];
}

export interface SpeculationSession {
  predicted: PredictedAction[];
  prefetchPromise: Promise<void>;
}

interface ConsumeResult {
  outcome: 'hit' | 'miss';
  cached?: CachedToolResult;
}

interface SpeculativeExecutorOptions {
  enabled?: boolean;
  predictor?: (context: SpeculationContext) => Promise<PredictedAction[]>;
  executor: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  cache?: ToolCache;
  maxPredictions?: number;
  predictionTimeoutMs?: number;
  tier1PredictionCostUsd?: number;
  prefetchCallCostUsd?: number;
  latencyValuePerMsUsd?: number;
  isPrefetchable?: (action: string, params: Record<string, unknown>) => boolean;
}

const DEFAULT_PREFETCHABLE_ACTIONS = new Set(['noop', 'sleep']);

export class SpeculativeExecutor {
  private readonly enabled: boolean;
  private readonly cache: ToolCache;
  private readonly predictor: (context: SpeculationContext) => Promise<PredictedAction[]>;
  private readonly executor: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  private readonly maxPredictions: number;
  private readonly predictionTimeoutMs: number;
  private readonly tier1PredictionCostUsd: number;
  private readonly prefetchCallCostUsd: number;
  private readonly latencyValuePerMsUsd: number;
  private readonly isPrefetchable: (action: string, params: Record<string, unknown>) => boolean;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly cancelledAt = new Map<string, number>();
  private hits = 0;
  private misses = 0;
  private netCostDelta = 0;

  constructor(options: SpeculativeExecutorOptions) {
    this.enabled = options.enabled ?? config.SPECULATION_ENABLED;
    this.cache = options.cache ?? toolCache;
    this.predictor = options.predictor ?? this.defaultPredictor;
    this.executor = options.executor;
    this.maxPredictions = options.maxPredictions ?? 2;
    this.predictionTimeoutMs = options.predictionTimeoutMs ?? 180;
    this.tier1PredictionCostUsd = options.tier1PredictionCostUsd ?? 0.000001;
    this.prefetchCallCostUsd = options.prefetchCallCostUsd ?? 0;
    this.latencyValuePerMsUsd = options.latencyValuePerMsUsd ?? 0;
    this.isPrefetchable = options.isPrefetchable
      ?? ((action: string): boolean => DEFAULT_PREFETCHABLE_ACTIONS.has(action));
  }

  async start(context: SpeculationContext): Promise<SpeculationSession | null> {
    if (!this.enabled) return null;
    const predicted = await this.predict(context);
    const prefetchPromise = this.prefetch(predicted);
    return { predicted, prefetchPromise };
  }

  async predict(context: SpeculationContext): Promise<PredictedAction[]> {
    if (!this.enabled) return [];
    const startedAt = Date.now();
    const timeout = new Promise<PredictedAction[]>((resolve) => {
      setTimeout(() => resolve([]), this.predictionTimeoutMs);
    });
    const predicted = await Promise.race([this.predictor(context), timeout]);
    metrics.histogram('speculation.predict_latency_ms', Date.now() - startedAt);
    return predicted
      .filter((candidate) => this.isPrefetchable(candidate.action, candidate.params))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.maxPredictions);
  }

  async prefetch(actions: PredictedAction[]): Promise<void> {
    if (!this.enabled || actions.length === 0) return;
    await Promise.all(actions.map((action) => this.prefetchAction(action)));
  }

  reconcile(
    actual: { action: string; params: Record<string, unknown> },
    predicted: PredictedAction[],
  ): 'hit' | 'miss' {
    const key = this.cache.keyFor(actual.action, actual.params);
    const predictedKeys = new Set(predicted.map((candidate) => this.cache.keyFor(candidate.action, candidate.params)));
    return predictedKeys.has(key) ? 'hit' : 'miss';
  }

  async consume(
    actual: { action: string; params: Record<string, unknown> },
    predicted: PredictedAction[],
  ): Promise<ConsumeResult> {
    if (!this.enabled) {
      return { outcome: 'miss' };
    }

    const outcome = this.reconcile(actual, predicted);
    const actualKey = this.cache.keyFor(actual.action, actual.params);
    const predictionCost = this.tier1PredictionCostUsd + predicted.length * this.prefetchCallCostUsd;

    if (outcome === 'hit') {
      await this.inFlight.get(actualKey);
      const cached = this.cache.take(actual.action, actual.params);
      if (cached) {
        this.hits += 1;
        const savedValue = cached.durationMs * this.latencyValuePerMsUsd;
        this.netCostDelta += savedValue - predictionCost;
        const wastedCalls = Math.max(predicted.length - 1, 0);
        if (wastedCalls > 0) {
          metrics.increment('speculation.wasted_calls', {}, wastedCalls);
        }
        metrics.histogram('speculation.latency_saved_ms', cached.durationMs);
        this.updateDerivedMetrics();
        this.discardPredictions(predicted, actualKey);
        return { outcome: 'hit', cached };
      }
    }

    this.misses += 1;
    this.netCostDelta -= predictionCost;
    if (predicted.length > 0) {
      metrics.increment('speculation.wasted_calls', {}, predicted.length);
    }
    this.updateDerivedMetrics();
    this.discardPredictions(predicted);
    return { outcome: 'miss' };
  }

  private readonly defaultPredictor = async (context: SpeculationContext): Promise<PredictedAction[]> => {
    return context.nextActions.slice(0, this.maxPredictions);
  };

  private async prefetchAction(prediction: PredictedAction): Promise<void> {
    const key = this.cache.keyFor(prediction.action, prediction.params);
    if (this.cache.get(prediction.action, prediction.params)) return;

    const existing = this.inFlight.get(key);
    if (existing) {
      await existing;
      return;
    }

    const prefetchPromise = (async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        const result = await this.executor(prediction.action, prediction.params);
        const cancelledAt = this.cancelledAt.get(key) ?? 0;
        if (cancelledAt <= startedAt) {
          this.cache.set(prediction.action, prediction.params, result, Date.now() - startedAt);
        }
      } catch {
        // Ignore speculative failures; normal path executes when needed.
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, prefetchPromise);
    await prefetchPromise;
  }

  private discardPredictions(predicted: PredictedAction[], keepKey?: string): void {
    for (const candidate of predicted) {
      const key = this.cache.keyFor(candidate.action, candidate.params);
      if (key === keepKey) continue;
      this.cancelledAt.set(key, Date.now());
      this.cache.delete(candidate.action, candidate.params);
    }
  }

  private updateDerivedMetrics(): void {
    const total = this.hits + this.misses;
    const hitRate = total === 0 ? 0 : (this.hits / total) * 100;
    metrics.gauge('speculation.hit_rate', hitRate);
    metrics.gauge('speculation.net_cost_delta', this.netCostDelta);
  }
}
