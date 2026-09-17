import { RegistryManager } from '../src/discovery/registry-manager';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../src/discovery/types';

function makeTool(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: overrides.id ?? 'tool-a',
    name: overrides.name ?? 'Tool A',
    version: overrides.version ?? '1.0.0',
    description: overrides.description ?? 'A test tool',
    source: overrides.source ?? 'github',
    capabilities: overrides.capabilities ?? [],
    tags: overrides.tags ?? [],
    ...overrides,
  };
}

class MockRegistry implements Registry {
  constructor(
    public readonly name: string,
    protected readonly tools: ToolMetadata[],
    private readonly available = true,
    private readonly shouldFail = false,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async search(_options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    if (this.shouldFail) throw new Error(`${this.name} search failed`);
    return this.tools;
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    return this.tools.find((t) => t.id === id) ?? null;
  }

  async list(): Promise<ToolMetadata[]> {
    if (this.shouldFail) throw new Error(`${this.name} list failed`);
    return this.tools;
  }
}

describe('RegistryManager', () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
  });

  it('returns merged results from all registered registries', async () => {
    manager.registerRegistry(new MockRegistry('a', [makeTool({ id: 'a1', source: 'github' })]));
    manager.registerRegistry(new MockRegistry('b', [makeTool({ id: 'b1', source: 'official' })]));

    const results = await manager.search({ query: '' });
    expect(results.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
  });

  it('a single failing registry does not block results from others', async () => {
    manager.registerRegistry(new MockRegistry('good', [makeTool({ id: 'good1' })]));
    manager.registerRegistry(new MockRegistry('bad', [], true, true));

    const results = await manager.search({ query: '' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('good1');
  });

  it('deduplicates the same tool id across registries, keeping the higher-trust source', async () => {
    manager.registerRegistry(new MockRegistry('gh', [makeTool({ id: 'dup', source: 'github' })]));
    manager.registerRegistry(new MockRegistry('official', [makeTool({ id: 'dup', source: 'official' })]));

    const results = await manager.search({ query: '' });
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe('official');
  });

  it('skips registries that report themselves unavailable', async () => {
    manager.registerRegistry(new MockRegistry('down', [makeTool({ id: 'x' })], false));
    const results = await manager.search({ query: '' });
    expect(results).toHaveLength(0);
  });

  it('caches search results and does not re-invoke registries within the TTL', async () => {
    let callCount = 0;
    class CountingRegistry extends MockRegistry {
      override async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
        callCount++;
        return super.search(options);
      }
    }
    manager.registerRegistry(new CountingRegistry('counted', [makeTool({ id: 'c1' })]));

    await manager.search({ query: 'same' });
    await manager.search({ query: 'same' });

    expect(callCount).toBe(1);
  });

  it('emits discovery:complete after a search cycle', async () => {
    manager.registerRegistry(new MockRegistry('a', [makeTool({ id: 'a1' })]));
    const handler = jest.fn();
    manager.on('discovery:complete', handler);

    await manager.search({ query: '' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'search', resultCount: 1 }),
    );
  });

  it('listAll merges and deduplicates across registries', async () => {
    manager.registerRegistry(new MockRegistry('a', [makeTool({ id: 'a1' })]));
    manager.registerRegistry(new MockRegistry('b', [makeTool({ id: 'a1', source: 'official' })]));

    const results = await manager.listAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe('official');
  });

  it('removeRegistry clears the cache so subsequent searches reflect the change', async () => {
    manager.registerRegistry(new MockRegistry('a', [makeTool({ id: 'a1' })]));
    await manager.search({ query: '' });
    manager.removeRegistry('a');
    const results = await manager.search({ query: '' });
    expect(results).toHaveLength(0);
  });
});
