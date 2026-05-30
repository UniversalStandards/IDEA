import { RegistryManager } from '../../src/discovery/registry-manager';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../../src/discovery/types';

class FakeRegistry implements Registry {
  readonly name: string;

  constructor(
    name: string,
    private readonly results: ToolMetadata[],
    private readonly available = true,
    private readonly health?: boolean,
  ) {
    this.name = name;
  }

  search = jest.fn(async (_options: RegistrySearchOptions) => this.results);

  async getById(id: string): Promise<ToolMetadata | null> {
    return this.results.find((item) => item.id === id) ?? null;
  }

  async list(): Promise<ToolMetadata[]> {
    return this.results;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async healthCheck(): Promise<boolean> {
    return this.health ?? this.available;
  }
}

describe('RegistryManager', () => {
  it('deduplicates results using normalized package identifiers', async () => {
    const manager = new RegistryManager();

    const npmRegistry = new FakeRegistry('npm', [
      {
        id: 'npm:@scope/mcp-server',
        name: '@scope/mcp-server',
        version: '1.0.0',
        description: 'npm package',
        source: 'npm',
        capabilities: [],
        tags: ['mcp-server'],
        downloadCount: 100,
        metadata: { packageName: '@scope/mcp-server' },
      },
    ]);

    const dockerRegistry = new FakeRegistry('dockerhub', [
      {
        id: 'dockerhub:scope/mcp-server',
        name: 'scope/mcp-server',
        version: 'latest',
        description: 'docker image',
        source: 'dockerhub',
        capabilities: [],
        tags: ['mcp-server'],
        downloadCount: 1000,
        metadata: { packageName: '@scope/mcp-server' },
      },
    ]);

    manager.registerRegistry(npmRegistry);
    manager.registerRegistry(dockerRegistry);

    const results = await manager.search({ query: 'mcp-server' });

    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe('dockerhub');
  });

  it('uses cached connector search results for 15 minutes', async () => {
    const manager = new RegistryManager();

    const registry = new FakeRegistry('npm', [
      {
        id: 'npm:test',
        name: 'test',
        version: '1.0.0',
        description: 'test',
        source: 'npm',
        capabilities: [],
        tags: ['mcp-server'],
        metadata: {},
      },
    ]);

    manager.registerRegistry(registry);

    await manager.search({ query: 'test' });
    await manager.search({ query: 'test' });

    expect(registry.search).toHaveBeenCalledTimes(1);
  });

  it('skips unhealthy registries gracefully', async () => {
    const manager = new RegistryManager();

    const unhealthy = new FakeRegistry(
      'smithery',
      [
        {
          id: 'smithery:bad',
          name: 'bad',
          version: '1.0.0',
          description: 'bad',
          source: 'smithery',
          capabilities: [],
          tags: [],
          metadata: {},
        },
      ],
      true,
      false,
    );

    const healthy = new FakeRegistry('npm', [
      {
        id: 'npm:good',
        name: 'good',
        version: '1.0.0',
        description: 'good',
        source: 'npm',
        capabilities: [],
        tags: [],
        metadata: {},
      },
    ]);

    manager.registerRegistry(unhealthy);
    manager.registerRegistry(healthy);

    const results = await manager.search({ query: 'good' });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('npm:good');
    expect(unhealthy.search).not.toHaveBeenCalled();
  });
});
