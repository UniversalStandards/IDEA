import type { CacheSetOptions } from '../types';

export interface TtlPolicy {
  ttlMs?: number;
  slidingTtl: boolean;
}

export class TtlManager {
  constructor(private readonly defaultTtlMs?: number) {}

  resolve(options?: CacheSetOptions): TtlPolicy {
    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    const policy: TtlPolicy = {
      slidingTtl: options?.slidingTtl ?? false,
    };
    if (ttlMs !== undefined) {
      policy.ttlMs = ttlMs;
    }
    return policy;
  }
}
