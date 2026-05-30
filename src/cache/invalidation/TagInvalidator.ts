import { metrics } from '../../observability/metrics';
import type { CacheBackend } from '../types';

export class TagInvalidator {
  constructor(private readonly backend: CacheBackend) {}

  async invalidate(tag: string): Promise<number> {
    const startedAt = Date.now();
    const removed = await this.backend.invalidateByTag(tag);

    metrics.increment('cache_invalidation_total', { strategy: 'tag', result: 'ok' });
    metrics.histogram('cache_invalidation_latency_ms', Date.now() - startedAt, { strategy: 'tag' });

    return removed;
  }
}
