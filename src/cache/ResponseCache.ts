import type { CacheSetOptions } from './types';
import type { CacheManager } from './CacheManager';
import { sha256, stableStringify } from './utils';

export interface ResponseCacheInput {
  model: string;
  prompt: string;
  params?: Record<string, unknown>;
}

export class ResponseCache {
  constructor(private readonly cacheManager: CacheManager) {}

  async get<T>(orgId: string, input: ResponseCacheInput): Promise<T | undefined> {
    return this.cacheManager.get<T>(orgId, this.keyFor(input));
  }

  async set<T>(orgId: string, input: ResponseCacheInput, value: T, options?: CacheSetOptions): Promise<void> {
    await this.cacheManager.set(orgId, this.keyFor(input), value, options);
  }

  private keyFor(input: ResponseCacheInput): string {
    const digest = sha256(
      stableStringify({
        model: input.model,
        prompt: input.prompt,
        params: input.params ?? {},
      }),
    );

    return `res:${digest}`;
  }
}
