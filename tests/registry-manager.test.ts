/**
 * tests/registry-manager.test.ts
 * Unit tests for src/discovery/registry-manager.ts
 * All network calls are mocked — tests are fully deterministic.
 */

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

// Disable real external registries so the module-level singleton is harmless
jest.mock('../src/discovery/github-registry', () => ({
  GithubRegistry: jest.fn().mockImplementation(() => ({
    name: 'github',
    search: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    isAvailable: jest.fn().mockResolvedValue(false),
  })),
}));

jest.mock('../src/discovery/official-registry', () => ({
  OfficialRegistry: jest.fn().mockImplementation(() => ({
    name: 'official',
    search: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    isAvailable: jest.fn().mockResolvedValue(false),
  })),
}));

jest.mock('../src/discovery/local-scanner', () => ({
  LocalScanner: jest.fn().mockImplementation(() => ({
    name: 'local',
    search: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    isAvailable: jest.fn().mockResolvedValue(false),
  })),
}));

import { RegistryManager } from '../src/discovery/registry-manager';
import type { Registry, ToolMetadata } from '../src/discovery/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTool(id: string, overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: `Tool ${id}`,
    source: 'official',
    capabilities: ['chat'],
    tags: ['test'],
    verified: true,
    downloadCount: 100,
    ...overrides,
  };
}

function makeRegistry(
  name: string,
  tools: ToolMetadata[],
  available = true,
): jest.Mocked<Registry> {
  return {
    name,
    search: jest.fn().mockResolvedValue(tools),
    getById: jest.fn().mockImplementation((id: string) =>
      Promise.resolve(tools.find((t) => t.id === id) ?? null),
    ),
    list: jest.fn().mockResolvedValue(tools),
    isAvailable: jest.fn().mockResolvedValue(available),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RegistryManager', () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
  });

  // ── Registry lifecycle ───────────────────────────────────────────────────

  describe('registerRegistry() / listRegistries()', () => {
    it('registers a registry and includes its name in listRegistries()', () => {
      manager.registerRegistry(makeRegistry('my-reg', []));
      expect(manager.listRegistries()).toContain('my-reg');
    });

    it('registers multiple registries and lists all of their names', () => {
      manager.registerRegistry(makeRegistry('reg-a', []));
      manager.registerRegistry(makeRegistry('reg-b', []));
      const names = manager.listRegistries();
      expect(names).toContain('reg-a');
      expect(names).toContain('reg-b');
    });

    it('returns the registered registry object from getRegistry()', () => {
      const reg = makeRegistry('named-reg', []);
      manager.registerRegistry(reg);
      expect(manager.getRegistry('named-reg')).toBe(reg);
    });

    it('returns undefined from getRegistry() for an unknown name', () => {
      expect(manager.getRegistry('unknown')).toBeUndefined();
    });
  });

  describe('removeRegistry()', () => {
    it('removes an existing registry and returns true', () => {
      manager.registerRegistry(makeRegistry('to-remove', []));
      expect(manager.removeRegistry('to-remove')).toBe(true);
      expect(manager.listRegistries()).not.toContain('to-remove');
    });

    it('returns false when removing a registry that does not exist', () => {
      expect(manager.removeRegistry('does-not-exist')).toBe(false);
    });
  });

  // ── search() ────────────────────────────────────────────────────────────

  describe('search()', () => {
    it('returns merged results from all available registries', async () => {
      const tool1 = makeTool('tool-alpha');
      const tool2 = makeTool('tool-beta');
      manager.registerRegistry(makeRegistry('reg-1', [tool1]));
      manager.registerRegistry(makeRegistry('reg-2', [tool2]));

      const results = await manager.search({ query: 'tool' });
      const ids = results.map((t) => t.id);
      expect(ids).toContain('tool-alpha');
      expect(ids).toContain('tool-beta');
    });

    it('excludes results from registries that report unavailable', async () => {
      const availableTool = makeTool('available-tool');
      const unavailableTool = makeTool('unavailable-tool');
      manager.registerRegistry(makeRegistry('online', [availableTool], true));
      manager.registerRegistry(makeRegistry('offline', [unavailableTool], false));

      const results = await manager.search({ query: '' });
      const ids = results.map((t) => t.id);
      expect(ids).toContain('available-tool');
      expect(ids).not.toContain('unavailable-tool');
    });

    it('does not propagate an error from a single failing registry to the caller', async () => {
      const goodTool = makeTool('good-tool');
      const goodReg = makeRegistry('good', [goodTool]);
      const badReg: Registry = {
        name: 'bad',
        search: jest.fn().mockRejectedValue(new Error('network failure')),
        getById: jest.fn().mockResolvedValue(null),
        list: jest.fn().mockRejectedValue(new Error('network failure')),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      manager.registerRegistry(goodReg);
      manager.registerRegistry(badReg);

      // Must not throw; good registry results still come through
      const results = await manager.search({ query: '' });
      expect(results.some((t) => t.id === 'good-tool')).toBe(true);
    });

    it('deduplicates tools with the same ID across registries, keeping the higher-trust source', async () => {
      const githubVersion = makeTool('shared-tool', { source: 'github' });
      const officialVersion = makeTool('shared-tool', { source: 'official' });
      manager.registerRegistry(makeRegistry('github-reg', [githubVersion]));
      manager.registerRegistry(makeRegistry('official-reg', [officialVersion]));

      const results = await manager.search({ query: '' });
      const matching = results.filter((t) => t.id === 'shared-tool');
      expect(matching).toHaveLength(1);
      // "official" has higher trust than "github"
      expect(matching[0]!.source).toBe('official');
    });

    it('limits results to the requested count via the limit option', async () => {
      const manyTools = Array.from({ length: 10 }, (_, i) => makeTool(`tool-${String(i)}`));
      manager.registerRegistry(makeRegistry('big-reg', manyTools));

      const results = await manager.search({ query: '', limit: 4 });
      expect(results).toHaveLength(4);
    });

    it('returns an empty array when no registries are registered', async () => {
      const results = await manager.search({ query: 'anything' });
      expect(results).toEqual([]);
    });

    it('returns an empty array when all registries are unavailable', async () => {
      manager.registerRegistry(makeRegistry('reg-offline', [makeTool('t1')], false));
      const results = await manager.search({ query: '' });
      expect(results).toEqual([]);
    });

    it('ranks verified tools above unverified ones with the same source', async () => {
      const verified = makeTool('v-tool', { verified: true, downloadCount: 10 });
      const unverified = makeTool('u-tool', { verified: false, downloadCount: 10 });
      manager.registerRegistry(makeRegistry('mixed-reg', [unverified, verified]));

      const results = await manager.search({ query: '' });
      const firstIdx = results.findIndex((t) => t.id === 'v-tool');
      const secondIdx = results.findIndex((t) => t.id === 'u-tool');
      expect(firstIdx).toBeLessThan(secondIdx);
    });
  });

  // ── getById() ────────────────────────────────────────────────────────────

  describe('getById()', () => {
    it('returns the tool when found in an available registry', async () => {
      const tool = makeTool('target-tool');
      manager.registerRegistry(makeRegistry('reg', [tool]));

      const result = await manager.getById('target-tool');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('target-tool');
    });

    it('returns null when the tool is not found in any registry', async () => {
      const emptyReg: Registry = {
        name: 'empty',
        search: jest.fn().mockResolvedValue([]),
        getById: jest.fn().mockResolvedValue(null),
        list: jest.fn().mockResolvedValue([]),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      manager.registerRegistry(emptyReg);

      const result = await manager.getById('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  // ── listAll() ────────────────────────────────────────────────────────────

  describe('listAll()', () => {
    it('aggregates tools across all registries and deduplicates by ID', async () => {
      const tool1 = makeTool('t1');
      const tool2 = makeTool('t2');
      const dupTool1 = makeTool('t1', { source: 'github' }); // lower trust than 'official'
      manager.registerRegistry(makeRegistry('r1', [tool1, tool2]));
      manager.registerRegistry(makeRegistry('r2', [dupTool1]));

      const all = await manager.listAll();
      const ids = all.map((t) => t.id);
      // t1 should appear exactly once
      expect(ids.filter((id) => id === 't1')).toHaveLength(1);
      expect(ids).toContain('t2');
    });

    it('returns an empty array when all registries are unavailable', async () => {
      manager.registerRegistry(makeRegistry('offline', [makeTool('t1')], false));
      const all = await manager.listAll();
      expect(all).toEqual([]);
    });
  });

  // ── discoverForCapability() ──────────────────────────────────────────────

  describe('discoverForCapability()', () => {
    it('returns tools whose capabilities array includes the search term', async () => {
      const chatTool = makeTool('chat-tool', { capabilities: ['chat', 'completion'] });
      const codeTool = makeTool('code-tool', { capabilities: ['code'] });
      manager.registerRegistry(makeRegistry('reg', [chatTool, codeTool]));

      const results = await manager.discoverForCapability('chat');
      expect(results.some((t) => t.id === 'chat-tool')).toBe(true);
    });

    it('returns tools whose tags contain the capability search term', async () => {
      const taggedTool = makeTool('tagged-tool', {
        capabilities: [],
        tags: ['embedding', 'search'],
      });
      manager.registerRegistry(makeRegistry('reg', [taggedTool]));

      const results = await manager.discoverForCapability('embedding');
      expect(results.some((t) => t.id === 'tagged-tool')).toBe(true);
    });

    it('returns tools whose name includes the capability search term', async () => {
      const namedTool = makeTool('vision-helper', {
        capabilities: [],
        tags: [],
        name: 'vision-helper',
      });
      manager.registerRegistry(makeRegistry('reg', [namedTool]));

      const results = await manager.discoverForCapability('vision');
      expect(results.some((t) => t.id === 'vision-helper')).toBe(true);
    });

    it('returns an empty array when no tools match the capability', async () => {
      const tool = makeTool('unrelated-tool', { capabilities: ['code'], tags: ['code'] });
      manager.registerRegistry(makeRegistry('reg', [tool]));

      const results = await manager.discoverForCapability('voice-synthesis');
      expect(results).toEqual([]);
    });
  });
});
