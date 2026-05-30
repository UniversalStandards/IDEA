import { metrics } from '../observability/metrics';
import { MemoryBackend, type MemoryBackendOptions } from './backends/MemoryBackend';
import { RedisBackend } from './backends/RedisBackend';
import { TagInvalidator } from './invalidation/TagInvalidator';
import type { CacheBackend, CacheSetOptions } from './types';

export interface CacheManagerOptions {
  primary: CacheBackend;
  fallback?: CacheBackend;
}

export class CacheManager {
  private readonly tagInvalidator: TagInvalidator;

  constructor(private readonly options: CacheManagerOptions) {
    this.tagInvalidator = new TagInvalidator(options.primary);
  }

  async get<T>(orgId: string, key: string): Promise<T | undefined> {
    const startedAt = Date.now();
    const scopedKey = this.scopeKey(orgId, key);

    try {
      const value = await this.options.primary.get<T>(scopedKey);
      metrics.increment('cache_manager_operations_total', {
        operation: 'get',
        result: value === undefined ? 'miss' : 'hit',
      });
      metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, { operation: 'get' });
      return value;
    } catch {
      if (!this.options.fallback) {
        throw new Error('Primary cache backend failed and no fallback backend was configured');
      }

      metrics.increment('cache_backend_fallback_total', { operation: 'get' });
      const fallbackValue = await this.options.fallback.get<T>(scopedKey);
      metrics.increment('cache_manager_operations_total', {
        operation: 'get',
        result: fallbackValue === undefined ? 'miss' : 'hit',
      });
      metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, { operation: 'get' });
      return fallbackValue;
    }
  }

  async set<T>(orgId: string, key: string, value: T, options?: CacheSetOptions): Promise<void> {
    const startedAt = Date.now();
    const scopedKey = this.scopeKey(orgId, key);

    const scopedTags = this.scopeTags(orgId, options?.tags);
    const setOptions = { ...options, tags: scopedTags };

    try {
      await this.options.primary.set(scopedKey, value, setOptions);
    } catch {
      if (!this.options.fallback) {
        throw new Error('Primary cache backend failed and no fallback backend was configured');
      }

      metrics.increment('cache_backend_fallback_total', { operation: 'set' });
      await this.options.fallback.set(scopedKey, value, setOptions);
    }

    metrics.increment('cache_manager_operations_total', { operation: 'set', result: 'ok' });
    metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, { operation: 'set' });
  }

  async delete(orgId: string, key: string): Promise<boolean> {
    const startedAt = Date.now();
    const scopedKey = this.scopeKey(orgId, key);

    try {
      const deleted = await this.options.primary.delete(scopedKey);
      metrics.increment('cache_manager_operations_total', {
        operation: 'delete',
        result: deleted ? 'deleted' : 'miss',
      });
      metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, { operation: 'delete' });
      return deleted;
    } catch {
      if (!this.options.fallback) {
        throw new Error('Primary cache backend failed and no fallback backend was configured');
      }

      metrics.increment('cache_backend_fallback_total', { operation: 'delete' });
      const deleted = await this.options.fallback.delete(scopedKey);
      metrics.increment('cache_manager_operations_total', {
        operation: 'delete',
        result: deleted ? 'deleted' : 'miss',
      });
      metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, { operation: 'delete' });
      return deleted;
    }
  }

  async invalidateByTag(orgId: string, tag: string): Promise<number> {
    const startedAt = Date.now();
    const scopedTag = this.scopeTag(orgId, tag);

    try {
      const removed = await this.tagInvalidator.invalidate(scopedTag);
      metrics.increment('cache_manager_operations_total', { operation: 'invalidate_by_tag', result: 'ok' });
      metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, {
        operation: 'invalidate_by_tag',
      });
      return removed;
    } catch {
      if (!this.options.fallback) {
        throw new Error('Primary cache backend failed and no fallback backend was configured');
      }

      metrics.increment('cache_backend_fallback_total', { operation: 'invalidate_by_tag' });
      const removed = await this.options.fallback.invalidateByTag(scopedTag);
      metrics.increment('cache_manager_operations_total', { operation: 'invalidate_by_tag', result: 'ok' });
      metrics.histogram('cache_manager_operation_latency_ms', Date.now() - startedAt, {
        operation: 'invalidate_by_tag',
      });
      return removed;
    }
  }

  private scopeKey(orgId: string, key: string): string {
    return `org:${orgId}:${key}`;
  }

  private scopeTag(orgId: string, tag: string): string {
    if (tag.startsWith(`org:${orgId}`)) {
      return tag;
    }
    return `org:${orgId}:${tag}`;
  }

  private scopeTags(orgId: string, tags?: string[]): string[] {
    if (!tags || tags.length === 0) {
      return [];
    }

    return [...new Set(tags.map((tag) => this.scopeTag(orgId, tag)))];
  }
}

export function createDefaultCacheManager(options: {
  redisUrl?: string;
  memoryOptions?: MemoryBackendOptions;
  redisPoolSize?: number;
  defaultTtlMs?: number;
} = {}): CacheManager {
  const memoryBackendOptions: MemoryBackendOptions = { ...(options.memoryOptions ?? {}) };
  const resolvedMemoryTtl = options.defaultTtlMs ?? options.memoryOptions?.defaultTtlMs;
  if (resolvedMemoryTtl !== undefined) {
    memoryBackendOptions.defaultTtlMs = resolvedMemoryTtl;
  }
  const memoryBackend = new MemoryBackend(memoryBackendOptions);

  if (!options.redisUrl) {
    return new CacheManager({ primary: memoryBackend });
  }

  const redisBackendOptions: ConstructorParameters<typeof RedisBackend>[0] = {
    url: options.redisUrl,
  };
  if (options.redisPoolSize !== undefined) {
    redisBackendOptions.poolSize = options.redisPoolSize;
  }
  if (options.defaultTtlMs !== undefined) {
    redisBackendOptions.defaultTtlMs = options.defaultTtlMs;
  }
  const redisBackend = new RedisBackend(redisBackendOptions);

  return new CacheManager({ primary: redisBackend, fallback: memoryBackend });
}
