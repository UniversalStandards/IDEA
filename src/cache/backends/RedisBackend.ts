import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { metrics } from '../../observability/metrics';
import type { CacheBackend, CacheSetOptions } from '../types';
import { TtlManager } from '../invalidation/TtlManager';

interface RedisEntry {
  value: unknown;
  tags: string[];
  ttlMs?: number;
  slidingTtl: boolean;
}

export interface RedisBackendOptions {
  url: string;
  poolSize?: number;
  keyPrefix?: string;
  defaultTtlMs?: number;
  redisOptions?: RedisOptions;
}

export class RedisBackend implements CacheBackend {
  private readonly clients: Redis[];
  private readonly ttlManager: TtlManager;
  private nextClientIndex = 0;

  constructor(private readonly options: RedisBackendOptions) {
    this.ttlManager = new TtlManager(options.defaultTtlMs);
    const poolSize = Math.max(1, options.poolSize ?? 4);

    this.clients = Array.from({ length: poolSize }, () =>
      new Redis(options.url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        retryStrategy: (attempt): number => Math.min(attempt * 50, 2000),
        ...options.redisOptions,
      }),
    );
  }

  async get<T>(key: string): Promise<T | undefined> {
    const startedAt = Date.now();
    const redisKey = this.buildDataKey(key);
    const client = this.pickClient();

    const payload = await client.get(redisKey);
    if (!payload) {
      metrics.increment('cache_operations_total', { backend: 'redis', operation: 'get', result: 'miss' });
      metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
        backend: 'redis',
        operation: 'get',
      });
      return undefined;
    }

    const entry = JSON.parse(payload) as RedisEntry;
    if (entry.slidingTtl && entry.ttlMs !== undefined) {
      await client.pexpire(redisKey, entry.ttlMs);
    }

    metrics.increment('cache_operations_total', { backend: 'redis', operation: 'get', result: 'hit' });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'redis',
      operation: 'get',
    });

    return entry.value as T;
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    const startedAt = Date.now();
    const redisKey = this.buildDataKey(key);
    const ttlPolicy = this.ttlManager.resolve(options);
    const tags = [...new Set(options?.tags ?? [])];
    const client = this.pickClient();

    const payload: RedisEntry = {
      value,
      tags,
      slidingTtl: ttlPolicy.slidingTtl,
    };
    if (ttlPolicy.ttlMs !== undefined) {
      payload.ttlMs = ttlPolicy.ttlMs;
    }

    const tx = client.multi();

    if (ttlPolicy.ttlMs !== undefined) {
      tx.set(redisKey, JSON.stringify(payload), 'PX', ttlPolicy.ttlMs);
    } else {
      tx.set(redisKey, JSON.stringify(payload));
    }

    for (const tag of tags) {
      const tagKey = this.buildTagKey(tag);
      tx.sadd(tagKey, redisKey);
      if (ttlPolicy.ttlMs !== undefined) {
        tx.pexpire(tagKey, ttlPolicy.ttlMs);
      }
    }

    await tx.exec();

    metrics.increment('cache_operations_total', { backend: 'redis', operation: 'set', result: 'ok' });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'redis',
      operation: 'set',
    });
  }

  async delete(key: string): Promise<boolean> {
    const startedAt = Date.now();
    const redisKey = this.buildDataKey(key);
    const client = this.pickClient();

    const payload = await client.get(redisKey);
    if (payload) {
      const entry = JSON.parse(payload) as RedisEntry;
      if (entry.tags.length > 0) {
        const tx = client.multi();
        for (const tag of entry.tags) {
          tx.srem(this.buildTagKey(tag), redisKey);
        }
        tx.del(redisKey);
        const result = await tx.exec();
        const deleted = (result?.at(-1)?.[1] as number | null) === 1;
        metrics.increment('cache_operations_total', {
          backend: 'redis',
          operation: 'delete',
          result: deleted ? 'deleted' : 'miss',
        });
        metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
          backend: 'redis',
          operation: 'delete',
        });
        return deleted;
      }
    }

    const deleted = (await client.del(redisKey)) === 1;
    metrics.increment('cache_operations_total', {
      backend: 'redis',
      operation: 'delete',
      result: deleted ? 'deleted' : 'miss',
    });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'redis',
      operation: 'delete',
    });
    return deleted;
  }

  async invalidateByTag(tag: string): Promise<number> {
    const startedAt = Date.now();
    const client = this.pickClient();
    const tagKey = this.buildTagKey(tag);
    const keys = await client.smembers(tagKey);

    if (keys.length === 0) {
      metrics.increment('cache_operations_total', {
        backend: 'redis',
        operation: 'invalidate_by_tag',
        result: 'empty',
      });
      metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
        backend: 'redis',
        operation: 'invalidate_by_tag',
      });
      return 0;
    }

    const tx = client.multi();
    tx.del(...keys);
    tx.del(tagKey);
    await tx.exec();

    metrics.increment('cache_operations_total', {
      backend: 'redis',
      operation: 'invalidate_by_tag',
      result: 'ok',
    });
    metrics.histogram('cache_operation_latency_ms', Date.now() - startedAt, {
      backend: 'redis',
      operation: 'invalidate_by_tag',
    });

    return keys.length;
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map(async (client) => client.quit()));
  }

  private pickClient(): Redis {
    const client = this.clients[this.nextClientIndex % this.clients.length];
    this.nextClientIndex += 1;
    if (!client) {
      throw new Error('Redis client pool is empty');
    }
    return client;
  }

  private buildDataKey(key: string): string {
    const prefix = this.options.keyPrefix ?? 'cache';
    return `${prefix}:data:${key}`;
  }

  private buildTagKey(tag: string): string {
    const prefix = this.options.keyPrefix ?? 'cache';
    return `${prefix}:tag:${tag}`;
  }
}
