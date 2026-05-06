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

    await this.redisClient?.zRemRangeByScore(key, Number.NEGATIVE_INFINITY, windowStart);
    await this.redisClient?.zAdd(key, [{ score: now, value: randomUUID() }]);
    await this.redisClient?.pExpire(key, descriptor.windowMs);

    const count = (await this.redisClient?.zCard(key)) ?? 0;
    const allowed = count <= descriptor.maxRequests;
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
    filtered.push(now);

    this.inMemoryWindows.set(key, filtered);

    const allowed = filtered.length <= descriptor.maxRequests;
    const remaining = Math.max(0, descriptor.maxRequests - filtered.length);
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
