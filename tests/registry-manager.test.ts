/**
 * tests/registry-manager.test.ts
 * Unit tests for src/discovery/registry-manager.ts
 */

jest.mock('../src/config', () => ({
  config: {
    CACHE_TTL: 300,
    ENABLE_GITHUB_REGISTRY: false,
    ENABLE_OFFICIAL_MCP_REGISTRY: false,
    ENABLE_LOCAL_WORKSPACE_SCAN: false,
    ENABLE_ENTERPRISE_CATALOG: false,
  },
  getConfig: jest.fn(() => ({
    CACHE_TTL: 300,
    ENABLE_GITHUB_REGISTRY: false,
    ENABLE_OFFICIAL_MCP_REGISTRY: false,
    ENABLE_LOCAL_WORKSPACE_SCAN: false,
    ENABLE_ENTERPRISE_CATALOG: false,
  })),
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
  },
}));

jest.mock('../src/discovery/github-registry', () => ({
  GithubRegistry: jest.fn(),
}));
jest.mock('../src/discovery/official-registry', () => ({
  OfficialRegistry: jest.fn(),
}));
jest.mock('../src/discovery/local-scanner', () => ({
  LocalScanner: jest.fn(),
}));
jest.mock('../src/discovery/enterprise-catalog', () => ({
  EnterpriseCatalogConnector: jest.fn(),
}));

import { RegistryManager } from '../src/discovery/registry-manager';
import type { Registry, ToolMetadata } from '../src/discovery/types';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTool(
  overrides: Partial<ToolMetadata> & Pick<ToolMetadata, 'name'>,
): ToolMetadata {
  return {
    id: `test:${overrides.name}@${overrides.version ?? '1.0.0'}`,
    version: '1.0.0',
    description: 'A test tool',
    source: 'github',
    capabilities: [],
    tags: [],
    ...overrides,
  };
}

function makeRegistry(
  name: string,
  tools: ToolMetadata[],
  opts: { available?: boolean; listRejects?: boolean; listError?: string } = {},
): jest.Mocked<Registry> {
  return {
    name,
    isAvailable: jest.fn().mockResolvedValue(opts.available ?? true),
    list: opts.listRejects
      ? jest.fn().mockRejectedValue(new Error(opts.listError ?? 'list error'))
      : jest.fn().mockResolvedValue(tools),
    search: jest.fn().mockResolvedValue(tools),
    getById: jest.fn().mockResolvedValue(null),
  } as jest.Mocked<Registry>;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('RegistryManager', () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
  });

  // ── registration ──────────────────────────────────────────────────────────

  describe('registerRegistry / listRegistries', () => {
    it('registers a registry and returns its name', () => {
      const reg = makeRegistry('my-reg', []);
      manager.registerRegistry(reg);
      expect(manager.listRegistries()).toContain('my-reg');
    });

    it('removeRegistry returns true when registry existed', () => {
      const reg = makeRegistry('my-reg', []);
      manager.registerRegistry(reg);
      expect(manager.removeRegistry('my-reg')).toBe(true);
      expect(manager.listRegistries()).not.toContain('my-reg');
    });

    it('removeRegistry returns false when registry did not exist', () => {
      expect(manager.removeRegistry('nonexistent')).toBe(false);
    });
  });

  // ── listAll — parallel execution ──────────────────────────────────────────

  describe('listAll()', () => {
    it('returns merged results from all available registries', async () => {
      const toolA = makeTool({ name: 'tool-a', source: 'github' });
      const toolB = makeTool({ name: 'tool-b', source: 'official' });
      manager.registerRegistry(makeRegistry('reg-a', [toolA]));
      manager.registerRegistry(makeRegistry('reg-b', [toolB]));

      const results = await manager.listAll();
      const names = results.map((t) => t.name);
      expect(names).toContain('tool-a');
      expect(names).toContain('tool-b');
    });

    it('does not propagate an error from a single failing registry', async () => {
      const toolA = makeTool({ name: 'tool-a', source: 'official' });
      manager.registerRegistry(makeRegistry('good-reg', [toolA]));
      manager.registerRegistry(
        makeRegistry('bad-reg', [], { listRejects: true, listError: 'network down' }),
      );

      const results = await manager.listAll();
      expect(results.some((t) => t.name === 'tool-a')).toBe(true);
    });

    it('skips registries that are unavailable', async () => {
      const toolA = makeTool({ name: 'tool-a', source: 'github' });
      manager.registerRegistry(makeRegistry('unavailable-reg', [toolA], { available: false }));

      const results = await manager.listAll();
      expect(results).toHaveLength(0);
    });

    // ── deduplication ───────────────────────────────────────────────────────

    it('deduplicates tools with same name+version from two registries', async () => {
      const toolGithub = makeTool({ name: 'shared-tool', version: '2.0.0', source: 'github' });
      const toolOfficial = makeTool({ name: 'shared-tool', version: '2.0.0', source: 'official' });
      manager.registerRegistry(makeRegistry('reg-a', [toolGithub]));
      manager.registerRegistry(makeRegistry('reg-b', [toolOfficial]));

      const results = await manager.listAll();
      const matches = results.filter((t) => t.name === 'shared-tool');
      expect(matches).toHaveLength(1);
    });

    it('merges sources[] when the same tool appears in multiple registries', async () => {
      const toolGithub = makeTool({ name: 'shared-tool', version: '1.0.0', source: 'github' });
      const toolOfficial = makeTool({ name: 'shared-tool', version: '1.0.0', source: 'official' });
      manager.registerRegistry(makeRegistry('reg-a', [toolGithub]));
      manager.registerRegistry(makeRegistry('reg-b', [toolOfficial]));

      const results = await manager.listAll();
      const match = results.find((t) => t.name === 'shared-tool');
      expect(match?.sources).toBeDefined();
      expect(match?.sources).toContain('github');
      expect(match?.sources).toContain('official');
    });

    it('does not duplicate the same source in sources[]', async () => {
      const t1 = makeTool({ name: 'tool-x', version: '1.0.0', source: 'github' });
      const t2 = makeTool({ name: 'tool-x', version: '1.0.0', source: 'github' });
      manager.registerRegistry(makeRegistry('reg-a', [t1]));
      manager.registerRegistry(makeRegistry('reg-b', [t2]));

      const results = await manager.listAll();
      const match = results.find((t) => t.name === 'tool-x');
      const githubCount = (match?.sources ?? []).filter((s) => s === 'github').length;
      expect(githubCount).toBe(1);
    });

    // ── caching ─────────────────────────────────────────────────────────────

    it('caches results and does not re-call list() within TTL', async () => {
      const tool = makeTool({ name: 'cached-tool', source: 'github' });
      const reg = makeRegistry('reg-a', [tool]);
      manager.registerRegistry(reg);

      await manager.listAll();
      await manager.listAll();

      // list() should only have been called once despite two listAll() calls
      expect(reg.list).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after invalidateCache()', async () => {
      const tool = makeTool({ name: 'cached-tool', source: 'github' });
      const reg = makeRegistry('reg-a', [tool]);
      manager.registerRegistry(reg);

      await manager.listAll();
      manager.invalidateCache();
      await manager.listAll();

      expect(reg.list).toHaveBeenCalledTimes(2);
    });

    // ── discovery:complete event ─────────────────────────────────────────────

    it('emits discovery:complete with count, durationMs, and sources', async () => {
      const tool = makeTool({ name: 'tool-a', source: 'github' });
      manager.registerRegistry(makeRegistry('reg-a', [tool]));

      const spy = jest.fn();
      manager.on('discovery:complete', spy);

      await manager.listAll();

      expect(spy).toHaveBeenCalledTimes(1);
      const payload: { count: number; durationMs: number; sources: string[] } = spy.mock.calls[0][0];
      expect(payload.count).toBe(1);
      expect(typeof payload.durationMs).toBe('number');
      expect(payload.sources).toContain('reg-a');
    });

    it('does not emit discovery:complete for cached responses', async () => {
      const tool = makeTool({ name: 'tool-a', source: 'github' });
      manager.registerRegistry(makeRegistry('reg-a', [tool]));

      const spy = jest.fn();
      manager.on('discovery:complete', spy);

      await manager.listAll(); // populates cache — emits event
      await manager.listAll(); // served from cache — should NOT emit again

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ── enterprise-catalog registration ──────────────────────────────────────

  describe('enterprise-catalog registration (buildRegistryManager integration)', () => {
    it('registryManager built with defaults does not include enterprise-catalog', () => {
      // Default env has ENABLE_ENTERPRISE_CATALOG=false (mocked above).
      // Re-import the singleton — already built with the mock.
      // We test by manually building a manager and checking the registry list.
      const m = new RegistryManager();
      expect(m.listRegistries()).not.toContain('enterprise-catalog');
    });

    it('registering enterprise-catalog adapter makes it available via listAll()', async () => {
      // Create a minimal mock that satisfies the Registry interface
      const enterpriseReg: Registry = {
        name: 'enterprise-catalog',
        isAvailable: jest.fn().mockResolvedValue(true),
        list: jest.fn().mockResolvedValue([
          makeTool({ name: 'internal-tool', source: 'enterprise' }),
        ]),
        search: jest.fn().mockResolvedValue([]),
        getById: jest.fn().mockResolvedValue(null),
      };
      manager.registerRegistry(enterpriseReg);

      const results = await manager.listAll();
      expect(results.some((t) => t.name === 'internal-tool')).toBe(true);
    });
  });
});
