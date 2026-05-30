import { CacheManager } from '../src/cache/CacheManager';
import { MemoryBackend } from '../src/cache/backends/MemoryBackend';
import { ResponseCache } from '../src/cache/ResponseCache';
import { SemanticCache } from '../src/cache/SemanticCache';
import { ToolCache } from '../src/cache/ToolCache';
import type { CacheBackend, CacheSetOptions } from '../src/cache/types';
import { metrics } from '../src/observability/metrics';

class FailingBackend implements CacheBackend {
  async get<T>(_key: string): Promise<T | undefined> {
    throw new Error('primary unavailable');
  }

  async set<T>(_key: string, _value: T, _options?: CacheSetOptions): Promise<void> {
    throw new Error('primary unavailable');
  }

  async delete(_key: string): Promise<boolean> {
    throw new Error('primary unavailable');
  }

  async invalidateByTag(_tag: string): Promise<number> {
    throw new Error('primary unavailable');
  }
}

describe('cache module', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('caches responses by exact model+prompt+params hash and org scope', async () => {
    const manager = new CacheManager({ primary: new MemoryBackend() });
    const cache = new ResponseCache(manager);

    await cache.set(
      'org-1',
      {
        model: 'gpt-4o-mini',
        prompt: 'Hello',
        params: { temperature: 0.2, maxTokens: 64 },
      },
      { text: 'Hi there' },
    );

    const fromSameRequest = await cache.get<{ text: string }>('org-1', {
      model: 'gpt-4o-mini',
      prompt: 'Hello',
      params: { maxTokens: 64, temperature: 0.2 },
    });
    expect(fromSameRequest).toEqual({ text: 'Hi there' });

    const fromOtherOrg = await cache.get<{ text: string }>('org-2', {
      model: 'gpt-4o-mini',
      prompt: 'Hello',
      params: { maxTokens: 64, temperature: 0.2 },
    });
    expect(fromOtherOrg).toBeUndefined();
  });

  it('matches semantically equivalent queries at a 0.95 threshold', async () => {
    const manager = new CacheManager({ primary: new MemoryBackend() });
    const semantic = new SemanticCache(manager, {
      similarityThreshold: 0.95,
      embeddingDimensions: 2,
      embedder: (input: string) => {
        const normalized = input.toLowerCase();
        if (normalized.includes('create') || normalized.includes('make')) {
          return [1, 0];
        }
        return [0, 1];
      },
    });

    await semantic.set('org-1', 'Create deployment plan', { id: 'plan-1' });

    const match = await semantic.get<{ id: string }>('org-1', 'Make deployment plan');
    expect(match).toEqual({ id: 'plan-1' });

    const nonMatch = await semantic.get<{ id: string }>('org-1', 'Schedule payroll run');
    expect(nonMatch).toBeUndefined();
  });

  it('deduplicates deterministic tool calls', async () => {
    const manager = new CacheManager({ primary: new MemoryBackend() });
    const toolCache = new ToolCache(manager);

    let invocations = 0;
    const producer = async (): Promise<{ value: string }> => {
      invocations += 1;
      return { value: 'result' };
    };

    const [first, second] = await Promise.all([
      toolCache.getOrSet('org-1', { toolName: 'filesystem.read', inputArgs: { path: '/tmp/a' } }, producer),
      toolCache.getOrSet('org-1', { toolName: 'filesystem.read', inputArgs: { path: '/tmp/a' } }, producer),
    ]);

    expect(first).toEqual({ value: 'result' });
    expect(second).toEqual({ value: 'result' });
    expect(invocations).toBe(1);
  });

  it('invalidates entries by tag in org scope', async () => {
    const manager = new CacheManager({ primary: new MemoryBackend() });

    await manager.set('org-1', 'health:provider-a', true, { tags: ['org:org-1'] });
    await manager.set('org-2', 'health:provider-a', true, { tags: ['org:org-2'] });

    const removed = await manager.invalidateByTag('org-1', 'org:org-1');
    expect(removed).toBe(1);

    expect(await manager.get('org-1', 'health:provider-a')).toBeUndefined();
    expect(await manager.get('org-2', 'health:provider-a')).toBe(true);
  });

  it('falls back to memory backend when primary backend fails', async () => {
    const fallback = new MemoryBackend();
    const manager = new CacheManager({ primary: new FailingBackend(), fallback });

    await manager.set('org-1', 'tool:abc', { ok: true });
    const cached = await manager.get<{ ok: boolean }>('org-1', 'tool:abc');

    expect(cached).toEqual({ ok: true });
  });

  it('supports sliding TTL in memory backend', async () => {
    const backend = new MemoryBackend();
    await backend.set('org:test:key', 'value', { ttlMs: 30, slidingTtl: true });

    await wait(20);
    expect(await backend.get('org:test:key')).toBe('value');

    await wait(20);
    expect(await backend.get('org:test:key')).toBe('value');

    await wait(35);
    expect(await backend.get('org:test:key')).toBeUndefined();
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
