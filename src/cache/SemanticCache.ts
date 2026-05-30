import type { CacheSetOptions } from './types';
import type { CacheManager } from './CacheManager';
import { sha256 } from './utils';

interface SemanticEntry<T> {
  key: string;
  embedding: number[];
  value: T;
}

export interface SemanticCacheOptions {
  similarityThreshold?: number;
  embeddingDimensions?: number;
  embedder?: (input: string) => number[];
}

export class SemanticCache {
  private readonly threshold: number;
  private readonly dimensions: number;
  private readonly embedder: (input: string) => number[];

  constructor(
    private readonly cacheManager: CacheManager,
    options: SemanticCacheOptions = {},
  ) {
    this.threshold = options.similarityThreshold ?? 0.95;
    this.dimensions = options.embeddingDimensions ?? 64;
    this.embedder = options.embedder ?? ((input): number[] => this.defaultEmbed(input));
  }

  async get<T>(orgId: string, query: string): Promise<T | undefined> {
    const queryEmbedding = this.embedder(query);
    const index = await this.cacheManager.get<string[]>(orgId, 'semantic:index');
    if (!index || index.length === 0) {
      return undefined;
    }

    let bestScore = -1;
    let bestValue: T | undefined;
    const activeIndex: string[] = [];

    for (const key of index) {
      const entry = await this.cacheManager.get<SemanticEntry<T>>(orgId, key);
      if (!entry) {
        continue;
      }

      activeIndex.push(key);
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      if (score >= this.threshold && score > bestScore) {
        bestScore = score;
        bestValue = entry.value;
      }
    }

    if (activeIndex.length !== index.length) {
      await this.cacheManager.set(orgId, 'semantic:index', activeIndex);
    }

    return bestValue;
  }

  async set<T>(orgId: string, query: string, value: T, options?: CacheSetOptions): Promise<void> {
    const key = `semantic:entry:${sha256(query)}`;
    const entry: SemanticEntry<T> = {
      key,
      embedding: this.embedder(query),
      value,
    };

    await this.cacheManager.set(orgId, key, entry, options);

    const index = (await this.cacheManager.get<string[]>(orgId, 'semantic:index')) ?? [];
    if (!index.includes(key)) {
      await this.cacheManager.set(orgId, 'semantic:index', [...index, key]);
    }
  }

  private defaultEmbed(input: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const normalized = input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 0);

    for (const token of normalized) {
      const digest = sha256(token);
      const bucket = parseInt(digest.slice(0, 8), 16) % this.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }

    const magnitude = Math.sqrt(vector.reduce((sum, current) => sum + current * current, 0));
    if (magnitude === 0) {
      return vector;
    }

    return vector.map((value) => value / magnitude);
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let i = 0; i < left.length; i += 1) {
    const leftValue = left[i] ?? 0;
    const rightValue = right[i] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
