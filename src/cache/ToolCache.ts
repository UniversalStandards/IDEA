import type { CacheSetOptions } from './types';
import type { CacheManager } from './CacheManager';
import { sha256, stableStringify } from './utils';

export interface ToolCacheInput {
  toolName: string;
  inputArgs: unknown;
}

export class ToolCache {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly cacheManager: CacheManager) {}

  async get<T>(orgId: string, input: ToolCacheInput): Promise<T | undefined> {
    return this.cacheManager.get<T>(orgId, this.keyFor(input));
  }

  async set<T>(orgId: string, input: ToolCacheInput, value: T, options?: CacheSetOptions): Promise<void> {
    await this.cacheManager.set(orgId, this.keyFor(input), value, options);
  }

  async getOrSet<T>(
    orgId: string,
    input: ToolCacheInput,
    producer: () => Promise<T>,
    options?: CacheSetOptions,
  ): Promise<T> {
    const key = this.keyFor(input);
    const cached = await this.cacheManager.get<T>(orgId, key);
    if (cached !== undefined) {
      return cached;
    }

    const scopedInflightKey = `${orgId}:${key}`;
    const existing = this.inFlight.get(scopedInflightKey);
    if (existing) {
      return existing as Promise<T>;
    }

    const pending = (async (): Promise<T> => {
      try {
        const produced = await producer();
        await this.cacheManager.set(orgId, key, produced, options);
        return produced;
      } finally {
        this.inFlight.delete(scopedInflightKey);
      }
    })();

    this.inFlight.set(scopedInflightKey, pending);
    return pending;
  }

  private keyFor(input: ToolCacheInput): string {
    const digest = sha256(
      stableStringify({
        toolName: input.toolName,
        inputArgs: input.inputArgs,
      }),
    );

    return `tool:${digest}`;
  }
}
