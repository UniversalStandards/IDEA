import NodeCache from 'node-cache';
import { createClient } from 'redis';
import { config } from '../config';
import { createLogger } from '../observability/logger';

const logger = createLogger('redis-swr-cache');

interface CacheEnvelope<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

interface CacheOptions {
  namespace: string;
  ttlSeconds?: number;
  staleSeconds?: number;
}

export class RedisSwrCache {
  private readonly memory: NodeCache;
  private readonly namespace: string;
  private readonly ttlSeconds: number;
  private readonly staleSeconds: number;
  private readonly redis?: ReturnType<typeof createClient>;
  private readonly refreshInFlight = new Set<string>();

  constructor(options: CacheOptions) {
    this.namespace = options.namespace;
    this.ttlSeconds = options.ttlSeconds ?? 900;
    this.staleSeconds = options.staleSeconds ?? this.ttlSeconds;

    this.memory = new NodeCache({
      stdTTL: this.ttlSeconds + this.staleSeconds,
      checkperiod: Math.max(30, Math.floor((this.ttlSeconds + this.staleSeconds) / 2)),
      useClones: false,
    });

    let redisUrl: string | undefined;
    try {
      redisUrl = config.REDIS_URL;
    } catch {
      redisUrl = process.env['REDIS_URL'];
    }

    if (redisUrl) {
      const client = createClient({ url: redisUrl });
      client.on('error', (err: unknown) => {
        logger.warn('Redis cache unavailable; continuing with memory cache', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
      this.redis = client;
      void this.connectRedis();
    }
  }

  async getOrSet<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const namespaced = this.key(key);
    const cached = await this.readEnvelope<T>(namespaced);

    if (cached && cached.freshUntil > now) {
      return cached.value;
    }

    if (cached && cached.staleUntil > now) {
      this.revalidate(namespaced, loader);
      return cached.value;
    }

    const value = await loader();
    await this.writeEnvelope(namespaced, value);
    return value;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.writeEnvelope(this.key(key), value);
  }

  private async connectRedis(): Promise<void> {
    if (!this.redis || this.redis.isOpen) return;

    try {
      await this.redis.connect();
      logger.info('Redis cache connected');
    } catch (err) {
      logger.warn('Failed to connect Redis cache; using memory fallback only', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private async readEnvelope<T>(namespacedKey: string): Promise<CacheEnvelope<T> | null> {
    const inMemory = this.memory.get<CacheEnvelope<T>>(namespacedKey);
    if (inMemory) return inMemory;

    if (!this.redis || !this.redis.isOpen) return null;

    try {
      const raw = await this.redis.get(namespacedKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      this.memory.set(namespacedKey, parsed);
      return parsed;
    } catch (err) {
      logger.debug('Failed reading from Redis cache', {
        key: namespacedKey,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async writeEnvelope<T>(namespacedKey: string, value: T): Promise<void> {
    const now = Date.now();
    const envelope: CacheEnvelope<T> = {
      value,
      freshUntil: now + this.ttlSeconds * 1000,
      staleUntil: now + (this.ttlSeconds + this.staleSeconds) * 1000,
    };

    this.memory.set(namespacedKey, envelope);

    if (!this.redis || !this.redis.isOpen) return;

    try {
      await this.redis.set(namespacedKey, JSON.stringify(envelope), {
        EX: this.ttlSeconds + this.staleSeconds,
      });
    } catch (err) {
      logger.debug('Failed writing to Redis cache', {
        key: namespacedKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private revalidate<T>(namespacedKey: string, loader: () => Promise<T>): void {
    if (this.refreshInFlight.has(namespacedKey)) return;

    this.refreshInFlight.add(namespacedKey);
    void loader()
      .then((value) => this.writeEnvelope(namespacedKey, value))
      .catch((err: unknown) => {
        logger.debug('Background cache refresh failed', {
          key: namespacedKey,
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.refreshInFlight.delete(namespacedKey);
      });
  }
}
