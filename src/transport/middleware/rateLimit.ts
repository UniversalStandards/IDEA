import rateLimit from 'express-rate-limit';
import type { Config } from '../../config';

export interface ConnectionRateLimiterOptions {
  readonly windowMs: number;
  readonly maxRequests: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class ConnectionRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(private readonly options: ConnectionRateLimiterOptions) {}

  consume(clientId: string): RateLimitDecision {
    const key = clientId.trim() || 'anonymous';
    const now = Date.now();
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.options.windowMs,
      });
      return {
        allowed: true,
        remaining: Math.max(this.options.maxRequests - 1, 0),
        retryAfterMs: 0,
      };
    }

    if (current.count >= this.options.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: current.resetAt - now,
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: Math.max(this.options.maxRequests - current.count, 0),
      retryAfterMs: 0,
    };
  }
}

export function createHttpRateLimitMiddleware(
  config: Pick<Config, 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_MAX_REQUESTS'>,
): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
}
