/**
 * tests/registry-manager.test.ts
 * Unit tests for src/discovery/registry-manager.ts
 */

jest.mock('../src/config', () => ({
  config: {
    ENABLE_GITHUB_REGISTRY: false,
    ENABLE_OFFICIAL_MCP_REGISTRY: false,
    ENABLE_LOCAL_WORKSPACE_SCAN: false,
    ENABLE_ENTERPRISE_CATALOG: false,
    CACHE_TTL: 300,
  },
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: {
    increment: jest.fn(),
    histogram: jest.fn(),
    gauge: jest.fn(),
  },
}));

jest.mock('../src/discovery/github-registry', () => ({
  GithubRegistry: jest.fn().mockImplementation(() => ({
    name: 'github',
    search: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockResolvedValue(false),
  })),
}));

jest.mock('../src/discovery/official-registry', () => ({
  OfficialRegistry: jest.fn().mockImplementation(() => ({
    name: 'official',
    search: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockResolvedValue(false),
  })),
}));

jest.mock('../src/discovery/local-scanner', () => ({
  LocalScanner: jest.fn().mockImplementation(() => ({
    name: 'local',
    search: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockResolvedValue(false),
  })),
}));

import { RegistryManager } from '../src/discovery/registry-manager';
import type { Registry, ToolMetadata } from '../src/discovery/types';

function makeToolMetadata(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: 'tool-1',
    name: 'test-tool',
    version: '1.0.0',
    description: 'A test tool',
    source: 'official',
    capabilities: ['chat'],
    tags: ['test'],
    verified: true,
    ...overrides,
  };
}

function makeMockRegistry(name: string, tools: ToolMetadata[] = []): Registry {
  return {
    name,
    search: jest.fn().mockResolvedValue(tools),
    getById: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue(tools),
    isAvailable: jest.fn().mockResolvedValue(true),
  };
}

describe('RegistryManager', () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
    // Clear the TTL cache so each test starts fresh
    manager.clearCache();
  });

  it('initialization registers all enabled connectors via registerRegistry', () => {
    const reg1 = makeMockRegistry('reg-a');
    const reg2 = makeMockRegistry('reg-b');

    manager.registerRegistry(reg1);
    manager.registerRegistry(reg2);

    expect(manager.listRegistries()).toContain('reg-a');
    expect(manager.listRegistries()).toContain('reg-b');
  });

  it('search returns merged results from all connectors', async () => {
    const tool1 = makeToolMetadata({ id: 'tool-a', name: 'tool-a', source: 'official' });
    const tool2 = makeToolMetadata({ id: 'tool-b', name: 'tool-b', source: 'github' });

    manager.registerRegistry(makeMockRegistry('reg-1', [tool1]));
    manager.registerRegistry(makeMockRegistry('reg-2', [tool2]));

    const results = await manager.search({ query: 'tool' });

    const ids = results.map((t) => t.id);
    expect(ids).toContain('tool-a');
    expect(ids).toContain('tool-b');
  });

  it('single failing connector does not propagate error to caller', async () => {
    const goodTool = makeToolMetadata({ id: 'good-tool', name: 'good-tool' });

    const goodRegistry = makeMockRegistry('good-reg', [goodTool]);
    const badRegistry: Registry = {
      name: 'bad-reg',
      search: jest.fn().mockRejectedValue(new Error('network failure')),
      getById: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockRejectedValue(new Error('network failure')),
      isAvailable: jest.fn().mockResolvedValue(true),
    };

    manager.registerRegistry(goodRegistry);
    manager.registerRegistry(badRegistry);

    const results = await manager.search({ query: 'tool' });

    expect(results.some((t) => t.id === 'good-tool')).toBe(true);
  });

  it('duplicate tools across registries are deduplicated by highest-trust source', async () => {
    const githubVersion = makeToolMetadata({
      id: 'shared-tool',
      name: 'shared-tool',
      source: 'github',
    });
    const officialVersion = makeToolMetadata({
      id: 'shared-tool',
      name: 'shared-tool',
      source: 'official',
    });

    manager.registerRegistry(makeMockRegistry('github-reg', [githubVersion]));
    manager.registerRegistry(makeMockRegistry('official-reg', [officialVersion]));

    const results = await manager.search({ query: 'shared-tool' });

    const sharedTools = results.filter((t) => t.id === 'shared-tool');
    expect(sharedTools).toHaveLength(1);
    expect(sharedTools[0]?.source).toBe('official');
  });

  it('search aggregates results from all registered registries on every call (no cache)', async () => {
    const tool = makeToolMetadata({ id: 'tool-x', name: 'tool-x' });
    const registry = makeMockRegistry('reg-x', [tool]);
    manager.registerRegistry(registry);

    // Different queries so they don't share a cache key
    await manager.search({ query: 'query-a' });
    await manager.search({ query: 'query-b' });

    expect(registry.search).toHaveBeenCalledTimes(2);
  });

  it('results are cached and not re-fetched within TTL window', async () => {
    const tool = makeToolMetadata({ id: 'tool-c', name: 'tool-c' });
    const registry = makeMockRegistry('reg-c', [tool]);
    manager.registerRegistry(registry);

    const first = await manager.search({ query: 'tool-c' });
    const second = await manager.search({ query: 'tool-c' });

    // Same query: second call must return cached results without hitting the registry again
    expect(registry.search).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe('tool-c');
  });

  it('removeRegistry removes the registry from the manager', () => {
    const registry = makeMockRegistry('removable-reg');
    manager.registerRegistry(registry);
    expect(manager.listRegistries()).toContain('removable-reg');

    const removed = manager.removeRegistry('removable-reg');
    expect(removed).toBe(true);
    expect(manager.listRegistries()).not.toContain('removable-reg');
  });

  it('removeRegistry returns false when the registry does not exist', () => {
    expect(manager.removeRegistry('does-not-exist')).toBe(false);
  });

  it('getById returns the first matching tool across registries', async () => {
    const tool = makeToolMetadata({ id: 'unique-id', name: 'unique-tool' });
    const registry = makeMockRegistry('getbyid-reg');
    (registry.getById as jest.Mock).mockResolvedValueOnce(tool);

    manager.registerRegistry(registry);
    const found = await manager.getById('unique-id');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('unique-id');
  });

  it('getById returns null when no registry has the tool', async () => {
    manager.registerRegistry(makeMockRegistry('empty-reg'));
    const found = await manager.getById('not-there');
    expect(found).toBeNull();
  });

  it('listAll returns merged deduplicated tools from all registries', async () => {
    const t1 = makeToolMetadata({ id: 'a', name: 'alpha', source: 'github' });
    const t2 = makeToolMetadata({ id: 'b', name: 'beta', source: 'official' });
    manager.registerRegistry(makeMockRegistry('r1', [t1]));
    manager.registerRegistry(makeMockRegistry('r2', [t2]));

    const all = await manager.listAll();
    const ids = all.map((t) => t.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('discoverForCapability returns tools matching the requested capability', async () => {
    const chatTool = makeToolMetadata({
      id: 'chat-tool',
      name: 'chat-tool',
      capabilities: ['chat'],
      tags: ['messaging'],
    });
    const otherTool = makeToolMetadata({
      id: 'other',
      name: 'other',
      capabilities: ['translate'],
      tags: [],
    });
    manager.registerRegistry(makeMockRegistry('cap-reg', [chatTool, otherTool]));

    const results = await manager.discoverForCapability('chat');
    expect(results.some((t) => t.id === 'chat-tool')).toBe(true);
  });

  it('clearCache allows re-fetching from registries on next search', async () => {
    const tool = makeToolMetadata({ id: 'cacheable', name: 'cacheable' });
    const registry = makeMockRegistry('cache-reg', [tool]);
    manager.registerRegistry(registry);

    await manager.search({ query: 'cacheable' });
    manager.clearCache();
    await manager.search({ query: 'cacheable' });

    // Cache was cleared so registry is hit twice
    expect(registry.search).toHaveBeenCalledTimes(2);
  });
});
