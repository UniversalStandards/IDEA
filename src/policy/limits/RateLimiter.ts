import { randomUUID } from 'crypto';
import { z } from 'zod';

export const RateLimitDescriptorSchema = z.object({
  windowMs: z.number().int().min(1),
  maxRequests: z.number().int().min(1),
});

export type RateLimitDescriptor = z.infer<typeof RateLimitDescriptorSchema>;

export interface RateLimitIdentity {
  orgId: string;
  userId: string;
  role: string;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

export interface RedisSlidingWindowClient {
  zAdd(key: string, values: Array<{ score: number; value: string }>): Promise<number>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;
  zCard(key: string): Promise<number>;
  pExpire(key: string, ttlMs: number): Promise<number>;
}

function bucketKey(identity: RateLimitIdentity): string {
  return `policy:rate:${identity.orgId}:${identity.userId}:${identity.role}`;
}

export class RateLimiter {
  private readonly inMemoryWindows = new Map<string, number[]>();

  constructor(private readonly redisClient?: RedisSlidingWindowClient) {}

  async check(identity: RateLimitIdentity, descriptor: RateLimitDescriptor): Promise<RateLimitResult> {
    const parsedDescriptor = RateLimitDescriptorSchema.parse(descriptor);
    const key = bucketKey(identity);

    if (this.redisClient) {
      return this.checkRedis(key, parsedDescriptor);
    }

    return this.checkInMemory(key, parsedDescriptor);
  }

  private async checkRedis(key: string, descriptor: RateLimitDescriptor): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - descriptor.windowMs;
    const client = this.redisClient;

    if (!client) {
      return this.checkInMemory(key, descriptor);
    }

    await client.zRemRangeByScore(key, Number.NEGATIVE_INFINITY, windowStart);
    const countBefore = await client.zCard(key);
    const allowed = countBefore < descriptor.maxRequests;

    if (allowed) {
      await client.zAdd(key, [{ score: now, value: randomUUID() }]);
      await client.pExpire(key, descriptor.windowMs);
    }

    const count = allowed ? countBefore + 1 : countBefore;
    const remaining = Math.max(0, descriptor.maxRequests - count);

    return {
      allowed,
      limit: descriptor.maxRequests,
      remaining,
      retryAfterMs: allowed ? 0 : descriptor.windowMs,
    };
  }

  private checkInMemory(key: string, descriptor: RateLimitDescriptor): RateLimitResult {
    const now = Date.now();
    const windowStart = now - descriptor.windowMs;
    const values = this.inMemoryWindows.get(key) ?? [];
    const filtered = values.filter((timestamp) => timestamp > windowStart);
    const allowed = filtered.length < descriptor.maxRequests;
    if (allowed) {
      filtered.push(now);
    }

    this.inMemoryWindows.set(key, filtered);

    const count = filtered.length;
    const remaining = Math.max(0, descriptor.maxRequests - count);
    const oldestTimestamp = filtered[0] ?? now;
    const retryAfterMs = allowed ? 0 : Math.max(1, descriptor.windowMs - (now - oldestTimestamp));

    return {
      allowed,
      limit: descriptor.maxRequests,
      remaining,
      retryAfterMs,
    };
  }
}
