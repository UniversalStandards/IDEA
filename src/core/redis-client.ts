/**
 * src/core/redis-client.ts
 * Lazy-singleton Redis client backed by ioredis.
 *
 * Usage
 * -----
 *   import { getRedis } from './redis-client';
 *
 *   const redis = getRedis();      // null when REDIS_URL is not configured
 *   if (redis) {
 *     await redis.set('key', 'val');
 *   }
 *
 * Shutdown
 * --------
 * Register in lifecycle once at application startup:
 *   lifecycle.register('redis', () => shutdownRedis());
 */

import Redis from 'ioredis';
import { createLogger } from '../observability/logger';

const logger = createLogger('redis-client');

let _client: Redis | null = null;
let _connecting = false;

/**
 * Returns the shared Redis client, or `null` if `REDIS_URL` is not configured.
 * The client is created lazily on first call and reused for all subsequent calls.
 */
export function getRedis(): Redis | null {
  // Return the existing singleton if already created (also allows test injection).
  if (_client) return _client;

  const url = process.env['REDIS_URL'];
  if (!url) return null;

  // Prevent creating multiple clients if called concurrently before the first
  // client object is assigned to `_client`.  Any caller that arrives during
  // this brief window receives `null` and falls back to in-memory — this is
  // intentional: Redis is an optional performance layer, not a hard dependency.
  if (_connecting) return null;
  _connecting = true;

  logger.info('Creating Redis client', { url: url.replace(/:\/\/.*@/, '://***@') });

  _client = new Redis(url, {
    // Disable default auto-retry on startup errors so the hub can still start
    // without a reachable Redis instance.
    maxRetriesPerRequest: 3,
    // Reconnect with exponential back-off, capped at 10 s.
    retryStrategy(attemptNumber: number): number | null {
      if (attemptNumber > 10) {
        logger.error('Redis: max reconnect attempts exceeded — giving up');
        return null; // stop retrying
      }
      const delay = Math.min(attemptNumber * 200, 10_000);
      logger.warn(`Redis: reconnecting in ${delay}ms (attempt ${attemptNumber})`);
      return delay;
    },
    enableReadyCheck: true,
    // Connect eagerly so commands issued immediately after construction succeed.
    // The singleton is created lazily (on first getRedis() call), so the net
    // effect is still a lazy connection from the application's perspective.
    lazyConnect: false,
  });

  _client.on('connect', () => {
    _connecting = false;
    logger.info('Redis connection established');
  });

  _client.on('ready', () => {
    logger.info('Redis client ready');
  });

  _client.on('error', (err: Error) => {
    logger.error('Redis client error', { err: err.message });
  });

  _client.on('close', () => {
    logger.info('Redis connection closed');
  });

  _client.on('reconnecting', () => {
    logger.debug('Redis reconnecting...');
  });

  return _client;
}

/**
 * Gracefully shut down the Redis client.
 * Safe to call when REDIS_URL is not configured (no-op).
 */
export async function shutdownRedis(): Promise<void> {
  if (!_client) return;

  logger.info('Shutting down Redis client...');
  try {
    await _client.quit();
    logger.info('Redis client disconnected gracefully');
  } catch (err) {
    logger.warn('Redis quit failed, forcing disconnect', {
      err: err instanceof Error ? err.message : String(err),
    });
    _client.disconnect();
  } finally {
    _client = null;
    _connecting = false;
  }
}

/**
 * Replace the internal client instance — for testing purposes only.
 * @internal
 */
export function _setRedisClient(client: Redis | null): void {
  _client = client;
  _connecting = false;
}
