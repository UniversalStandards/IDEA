import { LRUCache } from 'lru-cache';
import { metrics } from '../../observability/metrics';
import type { CacheBackend, CacheSetOptions } from '../types';
import { TtlManager } from '../invalidation/TtlManager';

interface MemoryEntry {
  value: unknown;
  tags: string[];
  ttlMs?: number;
  slidingTtl: boolean;
}

export interface MemoryBackendOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
}

export class MemoryBackend implements CacheBackend {
  private readonly cache: LRUCache<string, MemoryEntry>;
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly ttlManager: TtlManager;

  constructor(options: MemoryBackendOptions = {}) {
    this.ttlManager = new TtlManager(options.defaultTtlMs);
    this.cache = new LRUCache<string, MemoryEntry>({
      max: options.maxEntries ?? 10_000,
      dispose: (entry, key): void => {
        this.removeKeyFromTags(key, entry.tags);
      },
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const startedAt = Date.now();
    const entry = this.cache.get(key);

    if (!entry) {
      metrics.increment('cache_operations_total', { backend: 'memory', operation: 'get', result: 'miss' });
      metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
        backend: 'memory',
        operation: 'get',
      });
      return undefined;
    }

    if (entry.slidingTtl && entry.ttlMs !== undefined) {
      this.cache.set(key, entry, { ttl: entry.ttlMs });
    }

    metrics.increment('cache_operations_total', { backend: 'memory', operation: 'get', result: 'hit' });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'memory',
      operation: 'get',
    });
    return entry.value as T;
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    const startedAt = Date.now();
    const ttlPolicy = this.ttlManager.resolve(options);
    const tags = [...new Set(options?.tags ?? [])];

    const existing = this.cache.get(key);
    if (existing) {
      this.removeKeyFromTags(key, existing.tags);
    }

    const entry: MemoryEntry = {
      value,
      tags,
      slidingTtl: ttlPolicy.slidingTtl,
    };
    if (ttlPolicy.ttlMs !== undefined) {
      entry.ttlMs = ttlPolicy.ttlMs;
    }

    if (ttlPolicy.ttlMs !== undefined) {
      this.cache.set(key, entry, { ttl: ttlPolicy.ttlMs });
    } else {
      this.cache.set(key, entry);
    }

    for (const tag of tags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>();
      keys.add(key);
      this.tagIndex.set(tag, keys);
    }

    metrics.increment('cache_operations_total', { backend: 'memory', operation: 'set', result: 'ok' });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'memory',
      operation: 'set',
    });
  }

  async delete(key: string): Promise<boolean> {
    const startedAt = Date.now();
    const existing = this.cache.get(key);
    if (existing) {
      this.removeKeyFromTags(key, existing.tags);
    }

    const deleted = this.cache.delete(key);
    metrics.increment('cache_operations_total', {
      backend: 'memory',
      operation: 'delete',
      result: deleted ? 'deleted' : 'miss',
    });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'memory',
      operation: 'delete',
    });
    return deleted;
  }

  async invalidateByTag(tag: string): Promise<number> {
    const startedAt = Date.now();
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) {
      metrics.increment('cache_operations_total', {
        backend: 'memory',
        operation: 'invalidate_by_tag',
        result: 'empty',
      });
      metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
        backend: 'memory',
        operation: 'invalidate_by_tag',
      });
      return 0;
    }

    let invalidated = 0;
    for (const key of keys) {
      if (this.cache.delete(key)) {
        invalidated += 1;
      }
    }
    this.tagIndex.delete(tag);

    metrics.increment('cache_operations_total', {
      backend: 'memory',
      operation: 'invalidate_by_tag',
      result: 'ok',
    });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'memory',
      operation: 'invalidate_by_tag',
    });

    return invalidated;
  }

  private removeKeyFromTags(key: string, tags: string[]): void {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) {
        continue;
      }

      keys.delete(key);
      if (keys.size === 0) {
        this.tagIndex.delete(tag);
      }
    }
  }
}
