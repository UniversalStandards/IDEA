/**
 * tests/official-registry.test.ts
 * Unit tests for src/discovery/official-registry.ts.
 * The Smithery HTTP call is mocked; the built-in seed list is real.
 */

const mockAxiosGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockAxiosGet(...args) },
}));

const mockConfigState: { ttl: number | 'throw' } = { ttl: 300 };

jest.mock('../src/config', () => ({
  config: {
    get CACHE_TTL(): number {
      if (mockConfigState.ttl === 'throw') throw new Error('config unavailable');
      return mockConfigState.ttl;
    },
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
  metrics: { increment: jest.fn(), histogram: jest.fn() },
}));

import type NodeCache from 'node-cache';
import { OfficialRegistry } from '../src/discovery/official-registry';
import { metrics } from '../src/observability/metrics';

const SEED_IDS = [
  'official:filesystem',
  'official:github',
  'official:web-search',
  'official:sqlite',
  'official:postgres',
  'official:slack',
  'official:memory',
  'official:puppeteer',
  'official:fetch',
  'official:google-maps',
];

const registries: OfficialRegistry[] = [];

function makeRegistry(): OfficialRegistry {
  const registry = new OfficialRegistry();
  registries.push(registry);
  return registry;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigState.ttl = 300;
});

afterEach(() => {
  for (const registry of registries.splice(0)) {
    (registry as unknown as { cache: NodeCache }).cache.close();
  }
});

describe('OfficialRegistry.list()', () => {
  it('identifies itself as "official" and is always available', async () => {
    const registry = makeRegistry();
    expect(registry.name).toBe('official');
    await expect(registry.isAvailable()).resolves.toBe(true);
  });

  it('requests up to 100 servers from Smithery with a 10s timeout', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });

    await makeRegistry().list();

    expect(mockAxiosGet).toHaveBeenCalledWith('https://registry.smithery.ai/servers', {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
      params: { pageSize: 100 },
    });
    expect(metrics.histogram).toHaveBeenCalledWith('official_registry_fetch_duration_ms', expect.any(Number));
  });

  it('returns only the seed list when Smithery returns no servers field', async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    const tools = await makeRegistry().list();

    expect(tools.map((t) => t.id)).toEqual(SEED_IDS);
  });

  it('appends remote servers after the seed list and maps their fields', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        servers: [
          {
            qualifiedName: 'acme/widgets',
            displayName: 'Widgets',
            description: 'Widget server',
            homepage: 'https://acme.example/widgets',
            isDeployed: true,
            createdAt: '2026-02-03T04:05:06Z',
            useCount: 77,
          },
        ],
      },
    });

    const tools = await makeRegistry().list();
    const remote = tools.find((t) => t.id === 'official:acme/widgets');

    expect(tools).toHaveLength(SEED_IDS.length + 1);
    expect(remote).toMatchObject({
      name: 'Widgets',
      version: '0.0.0',
      description: 'Widget server',
      source: 'official',
      registryUrl: 'https://acme.example/widgets',
      capabilities: [],
      tags: ['smithery'],
      verified: true,
      riskLevel: 'low',
      downloadCount: 77,
    });
    expect(remote?.lastUpdated).toEqual(new Date('2026-02-03T04:05:06Z'));
  });

  it('applies defaults for sparse Smithery records', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [{}] } });

    const tools = await makeRegistry().list();
    const remote = tools.find((t) => t.id === 'official:unknown');

    expect(remote).toMatchObject({
      name: 'unknown',
      description: '',
      registryUrl: 'https://registry.smithery.ai/servers',
      verified: false,
      downloadCount: 0,
    });
    expect(remote).not.toHaveProperty('lastUpdated');
  });

  it('derives id and name from whichever of qualifiedName/displayName is present', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { servers: [{ qualifiedName: 'only/qualified' }, { displayName: 'Only Display' }] },
    });

    const tools = await makeRegistry().list();

    expect(tools.find((t) => t.id === 'official:only/qualified')?.name).toBe('only/qualified');
    expect(tools.find((t) => t.id === 'official:Only Display')?.name).toBe('Only Display');
  });

  it('marks a server unverified unless Smithery reports it deployed', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { servers: [{ qualifiedName: 'a/b', isDeployed: false }] },
    });

    const tools = await makeRegistry().list();

    expect(tools.find((t) => t.id === 'official:a/b')?.verified).toBe(false);
  });

  it('lets the curated seed entry win when a remote server reuses its id', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { servers: [{ qualifiedName: 'filesystem', description: 'IMPOSTOR' }] },
    });

    const tools = await makeRegistry().list();
    const filesystem = tools.filter((t) => t.id === 'official:filesystem');

    expect(filesystem).toHaveLength(1);
    expect(filesystem[0]?.description).not.toBe('IMPOSTOR');
    expect(filesystem[0]?.verified).toBe(true);
  });

  it('falls back to the seed list and counts the fallback when Smithery is unreachable', async () => {
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const tools = await makeRegistry().list();

    expect(tools.map((t) => t.id)).toEqual(SEED_IDS);
    expect(metrics.increment).toHaveBeenCalledWith('official_registry_fallback_total');
  });

  it('copes with a non-Error rejection', async () => {
    mockAxiosGet.mockRejectedValue('plain string failure');

    const tools = await makeRegistry().list();

    expect(tools).toHaveLength(SEED_IDS.length);
  });

  it('caches the merged list so Smithery is called once', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    const registry = makeRegistry();

    await registry.list();
    await registry.list();

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('constructs when the cache TTL cannot be read from config', async () => {
    mockConfigState.ttl = 'throw';
    mockAxiosGet.mockResolvedValue({ data: {} });

    await expect(makeRegistry().list()).resolves.toHaveLength(SEED_IDS.length);
  });
});

describe('OfficialRegistry.search()', () => {
  beforeEach(() => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
  });

  it('returns everything for an empty query', async () => {
    const results = await makeRegistry().search({ query: '' });
    expect(results).toHaveLength(SEED_IDS.length);
  });

  it('matches on name, case-insensitively', async () => {
    const results = await makeRegistry().search({ query: 'SQLITE' });
    expect(results.map((t) => t.id)).toContain('official:sqlite');
  });

  it('matches on description', async () => {
    const results = await makeRegistry().search({ query: 'secure file system access' });
    expect(results.map((t) => t.id)).toEqual(['official:filesystem']);
  });

  it('matches on tags', async () => {
    const results = await makeRegistry().search({ query: 'knowledge-graph' });
    expect(results.map((t) => t.id)).toEqual(['official:memory']);
  });

  it('matches on capabilities', async () => {
    const results = await makeRegistry().search({ query: 'geocode' });
    expect(results.map((t) => t.id)).toEqual(['official:google-maps']);
  });

  it('returns nothing when the query matches nothing', async () => {
    await expect(makeRegistry().search({ query: 'zzz-no-such-tool' })).resolves.toEqual([]);
  });

  it('filters by tag', async () => {
    const results = await makeRegistry().search({ query: '', tags: ['database'] });
    expect(results.map((t) => t.id).sort()).toEqual(['official:postgres', 'official:sqlite']);
  });

  it('filters by capability when a tag names one', async () => {
    const results = await makeRegistry().search({ query: '', tags: ['geocode'] });
    expect(results.map((t) => t.id)).toEqual(['official:google-maps']);
  });

  it('ignores an empty tag list', async () => {
    const results = await makeRegistry().search({ query: '', tags: [] });
    expect(results).toHaveLength(SEED_IDS.length);
  });

  it('applies the limit', async () => {
    const results = await makeRegistry().search({ query: '', limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('returns nothing for a different source without fetching', async () => {
    await expect(makeRegistry().search({ query: '', source: 'github' })).resolves.toEqual([]);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('searches when the source filter is "official"', async () => {
    const results = await makeRegistry().search({ query: '', source: 'official' });
    expect(results).toHaveLength(SEED_IDS.length);
  });
});

describe('OfficialRegistry.getById()', () => {
  it('finds a tool by id', async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    const tool = await makeRegistry().getById('official:postgres');

    expect(tool?.name).toBe('postgres');
  });

  it('returns null for an unknown id', async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    await expect(makeRegistry().getById('official:nope')).resolves.toBeNull();
  });
});
