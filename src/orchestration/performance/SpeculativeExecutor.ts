import { createHash } from 'crypto';

export interface SpeculativeAction {
  toolName: string;
  input: unknown;
}

export interface SpeculativePredictor {
  predictNextActions(history: SpeculativeAction[], currentAction: SpeculativeAction): Promise<SpeculativeAction[]>;
}

export interface SpeculativeToolRunner {
  run(toolName: string, input: unknown): Promise<unknown>;
}

export class SpeculativeExecutor {
  private readonly cache = new Map<string, unknown>();
  private totalPredictions = 0;
  private hits = 0;

  constructor(
    private readonly predictor: SpeculativePredictor,
    private readonly toolRunner: SpeculativeToolRunner,
    private readonly maxPredictions = 2,
  ) {}

  async prefetch(history: SpeculativeAction[], currentAction: SpeculativeAction): Promise<void> {
    const predictedActions = await this.predictor.predictNextActions(history, currentAction);
    const cappedPredictions = predictedActions.slice(0, this.maxPredictions);
    this.totalPredictions += cappedPredictions.length;

    await Promise.all(
      cappedPredictions.map(async (action) => {
        const key = SpeculativeExecutor.buildKey(action.toolName, action.input);
        if (this.cache.has(key)) {
          return;
        }
        const result = await this.toolRunner.run(action.toolName, action.input);
        this.cache.set(key, result);
      }),
    );
  }

  consume(toolName: string, input: unknown): { hit: boolean; result: unknown | null } {
    const key = SpeculativeExecutor.buildKey(toolName, input);
    if (!this.cache.has(key)) {
      return { hit: false, result: null };
    }
    this.hits += 1;
    const result = this.cache.get(key) ?? null;
    this.cache.delete(key);
    return { hit: true, result };
  }

  getAccuracy(): number {
    if (this.totalPredictions === 0) {
      return 0;
    }
    return this.hits / this.totalPredictions;
  }

  static buildKey(toolName: string, input: unknown): string {
    return createHash('sha256')
      .update(`${toolName}:${JSON.stringify(input) ?? 'null'}`)
      .digest('hex');
  }
}
